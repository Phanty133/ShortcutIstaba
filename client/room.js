let ws;
let username = "";
let ignoreSeekEvent = false;
let isHost = false;
let syncInterval;
let roomID;

const syncTime = 1000;
const path = "ws://localhost:8080/socket";

async function init(){
	username = Cookies.get("username");

	await initSocket();

	ws.onmessage = msgHandler;
	syncVideo();
	initVideoEvents();
	initChat();

	const chat = document.getElementById("chat");
	chat.style.maxHeight = (chat.clientHeight - 60).toString() + "px";
}

function showID(){
	document.getElementById("roomid").innerHTML = `Istabas kods: <b>${roomID}</b>`;
}

function initSocket(){
	return new Promise((res, rej) => {
		ws = new WebSocket(path);
	
		ws.onopen = () => {
			connectRoom();
		};
	
		ws.onmessage = (e) => {
			const data = JSON.parse(e.data);

			if(data.cmd === "initOK"){
				roomID = data.room;
				isHost = data.host;

				showID();

				res();
			}
			else{
				rej("Bad init response: " + e.data);
			}
		};
	});
}

function connectRoom(){
	ws.send(JSON.stringify({ cmd: "name", username }));
}

function syncVideo(){
	ws.send(JSON.stringify({cmd: "sync"}));
}


function msgHandler(e){
	const data = JSON.parse(e.data);
	const videoEl = document.getElementById("videoPlayer");

	switch(data.cmd){
		case "time":
			ignoreSeekEvent = true;

			videoEl.currentTime = data.time;
			break;
		case "pause":
			if(data.state){
				videoEl.pause();
			}
			else{
				videoEl.play();
			}
			break;
		case "chat":
			addChatMessage(data.name, data.msg, data.color);
			break;
		case "getRoomTime":
			ws.send(JSON.stringify({cmd: "syncRoomTime", time: videoEl.currentTime}));
			break;
	}
}

function sendData(data){
	ws.send(JSON.stringify(data));
}

function initVideoEvents(){
	const videoEl = document.getElementById("videoPlayer");

	videoEl.addEventListener("pause", () => {
		if(videoEl.seeking) return;
		sendData({cmd: "pause", state: true});
	});

	videoEl.addEventListener("play", () => {
		if(videoEl.seeking) return;
		sendData({cmd: "pause", state: false});
	});

	videoEl.addEventListener("seeked", () => {
		if(ignoreSeekEvent) {
			ignoreSeekEvent = false;
			return;
		}

		sendData({cmd: "time", time: videoEl.currentTime});
	});
}

function initChat(){
	document.getElementById("inputChat").addEventListener("keydown", (e) => {
		if(e.key === "Enter"){
			sendMessageHandler();
		}
	});

	document.getElementById("submitChat").addEventListener("click", sendMessageHandler);
}

function sendMessageHandler(){
	const inputEl = document.getElementById("inputChat");
	const val = inputEl.value;

	if(val === "" || val === "\n") {
		inputEl.value = "";
		return;
	}

	ws.send(JSON.stringify({cmd: "chat", msg: val}));
	inputEl.value = "";
	// inputEl.blur();
}

function addChatMessage(author, msg, color = "#000000"){
	const container = document.getElementById("chat");

	const li = document.createElement("li");
	container.appendChild(li);

	const authorEl = document.createElement("span");
	authorEl.textContent = `${author}`;
	authorEl.className = "chatAuthor";
	authorEl.style.color = color;
	li.appendChild(authorEl);

	const msgEl = document.createElement("span");
	msgEl.textContent = `: ${msg}`;
	msgEl.className = "chatMsg";
	li.appendChild(msgEl);

	container.scrollTop = container.scrollHeight;
}
