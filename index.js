const express = require("express");
const crypto = require("crypto");
const app = express();
const path = require("path");
const session = require("express-session");
const fs = require("fs");
const expressWs = require("express-ws")(app);
const randomColor = require("randomcolor");
const send = require("send");
const nocache = require("nocache");

const rooms = [];
const users = {};

function genHexString(len){
	return new Promise((res, rej) => {
		crypto.randomBytes(len / 2, (err, buffer) => {
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

		this.path = path.join(__dirname, "mp4", `${this.filmId}.mp4`);
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
		this.room.addMember(this);
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

	ok(){
		this.ws.send(JSON.stringify({cmd: "initOK", color: this.color, room: this.room.id}));
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

app.get("/stream", tokenCheckMiddleware, (req, res) => {
	if(!users[req.session.token]) {
		res.status(400).send("Requires an account");
		return;
	}

	const room = users[req.session.token].room;
	const path = room.path;
	room.stream = send(req, path);
	
	room.stream
	.on("error", (err) => {
		console.log(err);
	})
	.pipe(res);
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

				if(user.room.members[0] === user){
					user.ok();
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
					pending.ok();
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
			const index = rooms.findIndex(room => room === activeRoom);
			rooms.splice(index, 1);
		}

		delete users[req.session.token];
		console.log(users);
	});
});

app.listen(8080, function () {
	console.log("Listening on port 8080!");
});
