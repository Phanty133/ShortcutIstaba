const express = require("express");
const crypto = require("crypto");
const app = express();
const path = require("path");
const session = require("express-session");
const fs = require("fs");
const expressWs = require("express-ws")(app);
const cookieParser = require("cookie-parser");
const randomColor = require("randomcolor");
const nocache = require("nocache");

const rooms = [];
const users = {};

function genHexString(len){
	return new Promise((res, rej) => {
		crypto.randomBytes(len, (err, buffer) => {
			if(err) throw err;

			res(buffer.toString("hex"));
		});
	});
}

function nonRoomMiddleware(req, res, next){
	if(req.session.token) delete req.session.token;
	next();
}

app.use(session({
	secret: "thisisabsolutebullshit",
	cookie: { secure: false },
	resave: false,
	saveUninitialized: true
}));

app.use(cookieParser());
app.use(nocache());

class Room {
	id = null;
	filmId = null;
	members = [];
	CHUNK_SIZE = 10 ** 6;
	started = false;
	time = 0; // In seconds
	paused = false;
	stream = null;

	constructor(id, film){
		this.id = id;
		this.filmId = film;

		this.path = path.join(__dirname, "mp4", `${this.filmId}.mp4`);
	}

	startFilm(range){
		this.videoSize = fs.statSync(this.path).size;
		this.start = Number(range.replace(/\D/g, ""));
		this.end = Math.min(this.start + this.CHUNK_SIZE, this.videoSize - 1)

		this.stream = fs.createReadStream(this.path, { start: this.start, end: this.end });
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
}

class User {
	token = null;
	ws = null;
	room = null;
	name = null;

	constructor(token, room = null){
		this.token = token;
		this.room = room;

		this.color = randomColor();
	}

	connectSocket(ws){
		this.ws = ws;
	}

	setTime(time){
		this.ws.send(JSON.stringify({cmd: "time", time}));
	}

	pause(state){
		this.ws.send(JSON.stringify({cmd: "pause", state}));
	}

	message(name, msg, color){
		this.ws.send(JSON.stringify({cmd: "chat", name, msg, color }));
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
		req.session.token = await genHexString(16);

		// Add new client to room

		const room = rooms.find(el => el.id === id);

		if(!room){
			res.sendStatus(400);
			return;
		}

		const user = new User(req.session.token, room);
		res.cookie("token", req.session.token, {maxAge: 0});
		room.addMember(user);
		users[req.session.token] = user;

		res.redirect("/room");
	}
	else{
		res.sendStatus(400);
	}
});

app.get("/createroom", nonRoomMiddleware, async (req, res) => {
	const film = decodeURIComponent(req.query.film);
	const id = await genHexString(8);
	const newRoom = new Room(id, film);
	const userToken = await genHexString(16);
	const user = new User(userToken, newRoom);

	newRoom.addMember(user);
	req.session.token = userToken;
	res.cookie("token", userToken, {maxAge: 0})

	rooms.push(newRoom);
	users[userToken] = user;

	console.log("Room id: ", id);

	console.log(userToken);

	res.redirect("/room");
});

app.get("/films", nonRoomMiddleware, (req, res) => {
	res.sendFile(path.join(__dirname, "client", "films.html"));
});

app.get("/room", tokenCheckMiddleware, (req, res) => {
	res.sendFile(path.join(__dirname, "client", "room.html"));
});

app.get("/stream", tokenCheckMiddleware, (req, res) => {
	// Ensure there is a range given for the video
	const range = req.headers.range;

	if (!range) {
		res.status(400).send("Requires Range header");
	}

	if(!users[req.session.token]) {
		res.status(400).send("Requires an account");
		return;
	}

	console.log(rooms);
	const room = users[req.session.token].room;

	if(!room.started) room.startFilm(range);

	// Create headers
	const contentLength = room.end - room.start + 1;
	const headers = {
		"Content-Range": `bytes ${room.start}-${room.end}/${room.videoSize}`,
		"Accept-Ranges": "bytes",
		"Content-Length": contentLength,
		"Content-Type": "video/mp4",
	};
	
	// HTTP Status 206 for Partial Content
	res.writeHead(206, headers);

	// Stream the video chunk to the client
	room.stream.pipe(res);
});

let pendingUserSync = [];

app.ws("/socket", (ws, req) => {
	const user = users[req.session.token];
	user.connectSocket(ws);

	ws.on("message", (msg) => {
		const data = JSON.parse(msg);
		console.log(data);

		switch(data.cmd){
			case "name":
				user.name = data.username;

				if(user.name === ""){
					user.name = `Anonymous (${user.room.members.length})`;
				}

				if(user.room.members.length <= 1){
					if(user.room.members.length === 0){
						user.room.addMember(user);
					}

					ws.send(JSON.stringify({cmd: "initOK", host: true, color: user.color, room: user.room.id}));
				}
				else {
					user.room.members[0].ws.send(JSON.stringify({cmd: "getRoomTime"}));
					pendingUserSync.push(user);
				}
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
				user.setTime(user.room.time);
				break;
			case "syncRoomTime":
				user.room.time = data.time;

				for(const pending of pendingUserSync){
					pending.ws.send(JSON.stringify({cmd: "initOK", host: false, color: pending.color, room: pending.room.id}));
				}

				pendingUserSync = [];

				break;
		}
	});

	ws.on("close", () => {
		const user = users[req.session.token];
		const index = user.room.removeMember(user.token);
		const activeRoom = user.room;

		if(activeRoom.members.length === 0){
			activeRoom.stream.unpipe();
			activeRoom.stream.destroy();

			const index = rooms.findIndex(room => room === activeRoom);
			
			rooms.splice(index, 1);
		}

		if(activeRoom.members.length !== 0 && index === 0){ // If the host has been deleted, but there is still at least one person, delegate a new host
			activeRoom.members[0].setHost(true);
		}

		// delete users[req.session.token];
	});
});

app.listen(8080, function () {
	console.log("Listening on port 8080!");
});
