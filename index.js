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
	filmId = null;
	members = [];
	time = 0; // In seconds
	stream = null;

	constructor(id, film){
		this.id = id;
		this.filmId = film;

		this.dir = path.join(__dirname, "client", "hls", this.filmId.toString());
		this.path = path.join(this.dir, `${this.filmId}.m3u8`);
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

	pause(origin, state){
		this.paused = state;

		for(const user of this.members){
			if(user === origin) continue;
			user.pause(state);
		}
	}

	setTime(origin, time){
		this.time = time;

		for(const user of this.members){
			if(user === origin) continue;
			user.setTime(time);
		}
	}

	message(sender, msg){
		for(const user of this.members){
			user.message(sender.name, msg, sender.color);
		}
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

	addVoicePeer(user){
		for(const member of this.members){
			if(member === user) continue;

			member.addPeer(user, false);
			user.addPeer(member, true);
		}
	}

	removeVoicePeer(user){
		for(const member of this.members){
			if(member === user) continue;

			member.removePeer(user);
			user.removePeer(member);
		}
	}

	notifyJoin(newUser){
		for(const member of this.members){
			if(member === newUser) continue;

			user.notifyNewUser(newUser);
		}	
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

	setTime(time, play = undefined){
		this.ws.send(JSON.stringify({cmd: "time", time, play}));
	}

	pause(state){
		this.ws.send(JSON.stringify({cmd: "pause", state}));
	}

	message(name, msg, color){
		this.ws.send(JSON.stringify({cmd: "chat", name, msg, color }));
	}

	ok(){
		this.ws.send(JSON.stringify({cmd: "initOK", color: this.color, room: this.room.id}));
	}

	addPeer(target, createOffer){
		this.ws.send(JSON.stringify({ cmd: "addPeer", peer: target.token, createOffer}));
	}

	iceCandidate(origin, data){
		this.ws.send(JSON.stringify({ cmd: "iceCandidate", peer: origin.token, iceCandidate: data.iceCandidate }));
	}

	sessionDesc(origin, data){
		this.ws.send(JSON.stringify({ cmd: "sessionDesc", peer: origin.token, sessionDesc: data.sessionDesc }));
	}

	removePeer(target){
		this.ws.send(JSON.stringify({cmd: "removePeer", peer: target.token}));
	}

	notifyNewUser(user){
		this.ws.send(JSON.stringify({cmd: "notifyNewUser", name: user.name, color: user.color}));
	}
}

function tokenCheckMiddleware(req, res, next){
	if(!req.session.token){
		res.sendStatus(400);
	}
	else{
		next();
	}
}

app.use(express.static(path.join(__dirname, "client")));

app.get("/", nonRoomMiddleware, (req, res) => {
	res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/join", nonRoomMiddleware, async (req, res) => { // Join room via ID
	const id = decodeURIComponent(req.query.id);

	if(id){
		// Add new client to room

		const room = rooms.find(el => el.id === id);

		if(!room){
			res.sendStatus(400);
			return;
		}

		req.session.token = await genHexString(16);

		users[req.session.token] = new User(req.session.token, room);

		res.redirect("/room");
	}
	else{
		res.sendStatus(400);
	}
});

app.get("/createroom", nonRoomMiddleware, async (req, res) => {
	const film = decodeURIComponent(req.query.film);

	if(!film){
		res.sendStatus(400);
		return;
	}

	const roomID = await genHexString(8);
	const newRoom = new Room(roomID, film);
	rooms.push(newRoom);

	req.session.token = await genHexString(16);
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
				user.room.message(user, data.msg);
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
		user.room.removeMember(user.token);
		const activeRoom = user.room;

		if(activeRoom.members.length === 0){
			const index = rooms.findIndex(room => room === activeRoom);
			rooms.splice(index, 1);
		}

		delete users[req.session.token];
	});
});
