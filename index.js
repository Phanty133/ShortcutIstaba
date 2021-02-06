const express = require("express");
const crypto = require("crypto");
const app = express();
const path = require("path");
const session = require("express-session");
const fs = require("fs");
const randomColor = require("randomcolor");
const send = require("send");
const nocache = require("nocache");
const https = require("https");

const rooms = [];
const users = {};

/* 
	ERROR CODES
	0 - No error
	1 - No room with that ID exists
	2 - No film ID found
	3 - No session token found
	4 - No room type given
*/

// SSL

const privateKey = fs.readFileSync("ssl/key.pem");
const cert = fs.readFileSync("ssl/cert.pem");

function genHexString(len){
	return new Promise((res, rej) => {
		crypto.randomBytes(len / 2, (err, buffer) => {
			if(err) throw err;

			res(buffer.toString("hex"));
		});
	});
}

function nonRoomMiddleware(req, res, next){
	if(req.session.token) {
		req.session.destroy();
		res.redirect("/");
	}
	else{
		next();
	}
}

app.use(session({
	secret: "thisisabsolutebullshit",
	cookie: { secure: false },
	resave: false,
	saveUninitialized: true
}));

app.use(nocache());
app.set("etag", false);

class Room {
	id = null;
	filmId = null; // local ID or youtube ID
	members = [];
	time = 0; // In seconds
	stream = null;
	type = null; // local / youtube

	constructor(id, film, type){
		this.id = id;
		this.filmId = film;
		this.type = type;

		if(type === "local"){
			this.dir = path.join(__dirname, "client", "hls", this.filmId.toString());
			this.path = path.join(this.dir, `${this.filmId}.m3u8`);
		}
	}

	addMember(member){
		if(this.members.find(user => user === member)) return;
		this.members.push(member);
	}

	removeMember(memberToken){
		const index = this.members.findIndex(user => user.token === memberToken);
		this.members.splice(index, 1);
		return index;
	}

	eachMember(cb, ignore = null){
		for(const user of this.members){
			if(user === ignore) continue;

			cb(user);
		}
	}

	pause(origin, state){
		this.paused = state;

		this.eachMember(user => user.pause(state), origin);
	}

	setTime(origin, time){
		this.time = time;

		this.eachMember(user => user.setTime(time), origin);
	}

	message(sender, msg){
		this.eachMember(user => user.message(sender.name, msg, sender.color));
	}

	relayICECandidate(origin, data){
		const target = this.members.find(user => user.token === data.peer);

		if(target){
			target.iceCandidate(origin, data);
		}
	}

	relaySessionDesc(origin, data){
		const target = this.members.find(user => user.token === data.peer);

		if(target){
			target.sessionDesc(origin, data);
		}
	}

	addVoicePeer(origin){
		this.eachMember((user) => {
			user.addPeer(origin, false);
			origin.addPeer(user, true);
		}, origin);
	}

	removeVoicePeer(origin){
		this.eachMember((user) => {
			user.removePeer(origin, false);
			origin.removePeer(user, true);
		}, origin);
	}

	notifyJoin(newUser){
		this.eachMember(user => user.notifyNewUser(newUser), newUser);
	}

	notifyDisconnect(disconnectedUser){
		this.eachMember(user => user.notifyUserDisconnect(disconnectedUser), disconnectedUser);
	}

	getHost(){
		return this.members[0];
	}

	newHost(){
		this.eachMember(user => user.newHost(this.getHost()));
	}

	currentUsers(){
		return this.members.map(user => { return {name: user.name, color: user.color, isHost: this.getHost() === user, token: user.token}; });
	}

	newVideo(newVideo){
		this.filmId = newVideo;
		this.time = 0;

		this.eachMember(user => user.newVideo(newVideo));
	}

	changeID(newID){
		this.id = newID;
		this.eachMember(user => user.updateID(newID));
	}

	changeHost(origin, target){
		const targetIndex = this.members.findIndex(user => user === target);

		this.members[0] = target;
		this.members[targetIndex] = origin;

		this.newHost();
	}
}

class User {
	token = null;
	ws = null;
	room = null;
	name = null;
	voice = false;

	constructor(token, room = null){
		this.token = token;
		this.room = room;

		this.color = randomColor();
		this.room.addMember(this);
	}

	connectSocket(ws){
		this.ws = ws;
	}

	send(data){
		this.ws.send(JSON.stringify(data));
	}

	setTime(time, play = undefined){
		this.send({ cmd: "time", time, play });
	}

	pause(state){
		this.send({ cmd: "pause", state });
	}

	message(name, msg, color){
		this.send({ cmd: "chat", name, msg, color });
	}

	ok(){
		this.send({ 
			cmd: "initOK", 
			color: this.color, 
			room: this.room.id, 
			host: this.room.getHost().name, 
			users: this.room.currentUsers(),
			roomType: this.room.type,
			watchId: this.room.filmId
		});
	}

	addPeer(target, createOffer){
		this.send({ cmd: "addPeer", peer: target.token, createOffer });
	}

	iceCandidate(origin, data){
		this.send({ cmd: "iceCandidate", peer: origin.token, iceCandidate: data.iceCandidate });
	}

	sessionDesc(origin, data){
		this.send({ cmd: "sessionDesc", peer: origin.token, sessionDesc: data.sessionDesc });
	}

	removePeer(target){
		this.send({ cmd: "removePeer", peer: target.token });;
	}

	notifyNewUser(user){
		this.send({ cmd: "notifyNewUser", name: user.name, color: user.color, users: this.room.currentUsers() });
	}

	notifyUserDisconnect(user){
		this.send({ cmd: "notifyUserDisconnected", name: user.name, color: user.color, users: this.room.currentUsers() });
	}

	newHost(user){
		this.send({ cmd: "newHost", host: user.name, color: user.color });
	}

	newVideo(id){
		this.send({ cmd: "newVideo", id });
	}

	updateID(newID){
		this.send({ cmd: "newID", id: newID });
	}
}

function tokenCheckMiddleware(req, res, next){
	if(!req.session.token){
		res.redirect("/?error=3");
	}
	else{
		next();
	}
}

app.use(express.static(path.join(__dirname, "client")));

app.get("/", nonRoomMiddleware, (req, res) => {
	res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/join", async (req, res) => { // Join room via ID
	const id = decodeURIComponent(req.query.id);

	if(id){
		// Add new client to room

		const room = rooms.find(el => el.id === id);

		if(!room){
			res.redirect("/?error=1");
			return;
		}

		req.session.token = await genHexString(8);

		users[req.session.token] = new User(req.session.token, room);

		res.redirect("/room");
	}
	else{
		res.sendStatus(400);
	}
});

app.get("/createroom", async (req, res) => {
	const film = decodeURIComponent(req.query.film);
	const type = decodeURIComponent(req.query.type);

	if(!type || type === "undefined" || type === ""){
		res.redirect("/?error=4");
		return;
	}

	if(!film || film === "undefined" || film === ""){
		res.redirect("/?error=2");
		return;
	}

	const roomID = await genHexString(8);
	const newRoom = new Room(roomID, film, type);
	rooms.push(newRoom);

	req.session.token = await genHexString(8);
	const user = new User(req.session.token, newRoom);

	users[req.session.token] = user;

	res.redirect("/room");
});

app.get("/films", nonRoomMiddleware, (req, res) => {
	res.sendFile(path.join(__dirname, "client", "films.html"));
});

app.get("/room", tokenCheckMiddleware, (req, res) => {
	res.sendFile(path.join(__dirname, "client", "room.html"));
});

app.get(/\d+.ts/, tokenCheckMiddleware, (req, res) => {
	if(!users[req.session.token]) {
		res.status(400).send("Requires an account");
		return;
	}

	const room = users[req.session.token].room;
	res.sendFile(`${room.dir}/${req.path}`);
});

app.get("/stream", tokenCheckMiddleware, (req, res) => {
	if(!users[req.session.token]) {
		res.status(400).send("Requires an account");
		return;
	}

	const room = users[req.session.token].room;

	if(room.type !== "local") {
		res.status(400).send("Incompatible room type");
		return;
	}

	res.sendFile(room.path);
});

let pendingUserSync = [];

const httpsServer = https.createServer({
	key: privateKey,
	cert: cert,
	passphrase: ""
}, app);
httpsServer.listen(8080);

const expressWs = require("express-ws")(app, httpsServer);

app.ws("/socket", (ws, req) => {
	const user = users[req.session.token];
	user.connectSocket(ws);

	ws.on("message", (msg) => {
		const data = JSON.parse(msg);

		switch(data.cmd){
			case "name":
				user.name = data.username;

				if(user.name === ""){
					user.name = `Anonymous (${user.room.members.length})`;
				}

				if(user.room.members[0] === user){
					user.ok();
				}
				else {
					user.room.members[0].ws.send(JSON.stringify({cmd: "getRoomTime"}));
					pendingUserSync.push(user);
				}

				user.room.notifyJoin(user);

				break;
			case "chat":
				const isCommand = chatCommandHandler(user, data.msg);

				if(!isCommand){
					user.room.message(user, data.msg);
				}
				break;
			case "time":
				user.room.setTime(user, data.time);
				break;
			case "pause":
				user.room.pause(user, data.state);
				break;
			case "sync":
				user.setTime(user.room.time, true);
				break;
			case "syncRoomTime":
				user.room.time = data.time;

				for(const pending of pendingUserSync){
					pending.ok();
				}

				pendingUserSync = [];

				break;
			// VoIP
			case "relayICECandidate":
				user.room.relayICECandidate(user, data);
				break;
			case "relaySessionDesc":
				user.room.relaySessionDesc(user, data);
				break;
			case "joinVoice":
				if(user.voice) return;

				user.room.addVoicePeer(user);

				user.voice = true;
				break;
		}
	});

	ws.on("close", () => {
		console.log("Closing socket");

		const user = users[req.session.token];
		const activeRoom = user.room;
		const setNewHost = user === activeRoom.getHost();

		activeRoom.notifyDisconnect(user);
		activeRoom.removeMember(user.token);

		if(activeRoom.members.length === 0){
			const index = rooms.findIndex(room => room === activeRoom);
			rooms.splice(index, 1);
		}
		else if(setNewHost){
			activeRoom.newHost();
		}

		delete users[req.session.token];
	});
});

function chatCommandHandler(user, msg){
	if(msg.charAt(0) !== "!") return false;

	const args = msg.substring(1).split(" ");
	let error = null;
	let output = null;

	switch(args[0]){
		case "help":
			output = `
**Available chat commands**

!help - see the available chat commands
!users - see the current users

--- HOST ONLY ---

!video [YoutubeURL] - change the video in a YouTube room
!kick [UserToken] - kick a user with given Token
!setid [newID] - change the room ID
!sethost [UserToken] - set new host
			`;
			break;
		case "users":
			user.send({cmd: "currentUsers", users: user.room.currentUsers()});
			break;
		case "video":
			if(user.room.getHost() !== user){
				error = "You must be the host to use this command!";
				break;
			}

			if(user.room.type !== "youtube") {
				error = "Incompatible room type!";
				break;
			}

			const ytRegex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)(?<id>[^"&?\/\s]{11})/i;
			const match = args[1].match(ytRegex);

			if(match === null){
				error = "Invalid youtube URL!";
				break;
			}

			user.room.newVideo(match.groups.id);
			output = "OK";

			break;
		case "kick":
			if(user.room.getHost() !== user){
				error = "You must be the host to use this command!";
				break;
			}

			if(!args[1] || args[1] === "" || args[1].length !== 8){
				error = "Invalid user token!";
				break;
			}

			if(!users[args[1]]){
				error = "No user with given token exists!";
				break;
			}

			const target = users[args[1]];

			user.room.eachMember(user => user.send({cmd: "kickMessage", target: target.name, color: target.color}), target);
			target.send({cmd: "kick"});

			break;
		case "setid":
			if(user.room.getHost() !== user){
				error = "You must be the host to use this command!";
				break;
			}

			if(!args[1] || args[1] === ""){
				error = "Invalid room ID!";
				break;
			}

			if(args[1].length < 8){
				error = "Room ID must be atleast 8 characters long!";
				break;
			}

			if(rooms.find(room => room.id === args[1])){
				error = "A room with given ID already exists!";
				break;
			}

			user.room.changeID(args[1]);

			break;
		case "sethost":
			if(user.room.getHost() !== user){
				error = "You must be the host to use this command!";
				break;
			}

			if(!args[1] || args[1] === "" || args[1].length !== 8){
				error = "Invalid user token!";
				break;
			}

			if(!users[args[1]]){
				error = "No user with given token exists!";
				break;
			}

			user.room.changeHost(user, users[args[1]]);

			break;
		default:
			error = "Unknown command!\n **!help** to see the avaible commands";
			break;
	}

	if(error !== null){
		user.send({cmd: "cmdError", msg: error});
	}

	if(output !== null){
		user.send({cmd: "cmdOutput", msg: output});
	}

	return true;
}
