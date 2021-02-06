let ws;
let username = "";
let ignoreSeekEvent = false;
let syncInterval;
let roomID;
const peers = {};
const peerMedia = {};
const ICE_SERVERS = [{urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}, {"urls": "turn:45.9.188.93:5349", "username": "guest", "credential": "somepassword"}];
let audioStream;
let host;
let participants = [];
let muted = false;
const volumeAveraging = 20;
const volumeOffset = 15;
let roomType;
let watchId;
let ytPlayer;
let synced = false;
let skipNextAction = false;

const seekStates = [[2, 3, 1], [3, 1]];

const syncTime = 1000;
const path = `wss://${window.location.host}/socket`;

async function init(){
	username = Cookies.get("username");

	await initSocket();
	ws.onmessage = msgHandler;

	initRoomVideo();

	initChat();
	updateRoomTitle(host);
	showCurrentParticipants(participants);

	document.getElementById("topOverlayTop").style.display = "none";

	await accessMicrophone();
	joinVoice();
	await bindVoiceVolume();

	document.getElementById("muteMic").addEventListener("click", muteBtnHandler);
}

function initHLSVideo(){
	const video = document.getElementById('videoPlayer');

	if(Hls.isSupported()) {
		const hls = new Hls();

		hls.loadSource(`/stream`);
		hls.attachMedia(video);
		hls.on(Hls.Events.MANIFEST_PARSED,function() {
			video.play();
		});
	}
}

function showID(){
	document.getElementById("inpTopId").value = `${roomID}`;
}

function updateRoomTitle(host){
	document.getElementById("hostName").textContent = host.toUpperCase();
}

function showCurrentParticipants(data, showToken){ // a tad janky
	addChatMessage(null, "Pašreizējie skatītāji", "#FFFFFF");
	for(const user of data){
		addChatMessage(null, `${user.name} ${user.isHost ? "(HOST)" : ""}${showToken ? ` - ${user.token}` : ""}`, user.color);
	}
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
				host = data.host;
				participants = data.users;
				roomType = data.roomType;
				watchId = data.watchId;

				showID();
				res();
			}
			else{
				rej("Bad init response: " + e.data);
			}
		};
	});
}

function joinVoice(){
	sendData({ cmd: "joinVoice" });
}

function connectRoom(){
	sendData({ cmd: "name", username });
}

function syncVideo(){
	sendData({cmd: "sync"});
}

function msgHandler(e){
	const data = JSON.parse(e.data);

	switch(data.cmd){
		case "time":
			ignoreSeekEvent = true;

			setVideoTime(data.time, data.play || !synced);
			break;
		case "pause":
			playVideo(!data.state);
			break;
		case "chat":
			addChatMessage(data.name, data.msg, data.color);
			break;
		case "getRoomTime":
			ws.send(JSON.stringify({cmd: "syncRoomTime", time: getVideoTime()}));
			break;
		case "addPeer":
			addPeer(data);
			break;
		case "sessionDesc":
			remoteSessionDesc(data);
			break;
		case "iceCandidate":
			const peer = peers[data.peer];
			const iceCandidate = data.iceCandidate;
			peer.addIceCandidate(new RTCIceCandidate(iceCandidate));
			break;
		case "removePeer":
			console.log("Signaling server said to remove peer: ", data);

			const peerToken = data.peer;

			if(peerToken in peerMedia){
				peerMedia[peerToken].remove();
			}

			if(peerToken in peers){
				peers[peerToken].close();
			}

			delete peers[peerToken];
			delete peerMedia[peerToken];

			break;
		case "notifyNewUser":
			addChatMessage(null, `${data.name} ir klāt!`, data.color);
			participants = data.users;
			break;
		case "notifyUserDisconnected":
			addChatMessage(null, `${data.name} izgāja!`, data.color);
			participants = data.users;
			break;
		case "newHost":
			host = data.host;
			updateRoomTitle(host);
			addChatMessage(null, `${host} is the new host!`, data.color);
			break;
		case "newID":
			roomID = data.id;
			showID();
			addChatMessage(null, `The room's ID has been changed to ${data.id}`, "#deda0b");
			break;
		case "newVideo":
			watchId = data.id;
			ytPlayer.loadVideoById(data.id, 0);
			ytPlayer.playVideo();
			break;
		case "kick":
			window.location.href = "/"; // very crude
			break;
		case "kickMessage":
			addChatMessage(null, `User ${data.target} has been kicked!`, data.color);
			break;
		case "cmdError":
			addChatMessage(null, data.msg, "#FF0000");
			break;
		case "cmdOutput":
			addChatMessage(null, data.msg, "#deda0b");
			break;
		case "currentUsers":
			participants = data.users;
			showCurrentParticipants(data.users, true);
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
		console.log(e);
		if(e.key === "Enter" && !e.shiftKey){
			e.preventDefault();
			sendMessageHandler();

			return false;
		}
	});

	document.getElementById("submitChat").addEventListener("click", sendMessageHandler);
}

function sendMessageHandler(){
	const inputEl = document.getElementById("inputChat");
	const val = inputEl.value;

	if(val === "" || val === "\n" ) {
		inputEl.value = "";
		return;
	}

	ws.send(JSON.stringify({cmd: "chat", msg: val}));
	inputEl.value = "";
	// inputEl.blur();
}

function replaceWithTags(text, matchChar, openTag, closeTag){
	let safeMatchChar = matchChar.replace(/(.)/g, "[$1]");
	const regex = new RegExp(`(${safeMatchChar}.+?${safeMatchChar})`, "gmsu");
	const regexMatch = text.match(regex);

	if(regexMatch === null) return text;

	let temp = text;

	for(const match of regexMatch){
		const matchWithOpenTag = match.replace(matchChar, openTag); // Replace first occurence
		const matchWithBothTags = matchWithOpenTag.replace(matchChar, closeTag); // Replace second occurence

		temp = temp.replace(match, matchWithBothTags);
	}

	return temp;
}

function escapeHtml(unsafe){
	return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function renderFormatting(text){
	const bold = "**"; 
	const italic = "*"; 
	const underline = "__";
	const strikethrough = "~~";
	
	let temp = text;

	temp = replaceWithTags(temp, bold, "<b>", "</b>"); // Check for bold
	temp = replaceWithTags(temp, italic, "<i>", "</i>"); // Check for italic
	temp = replaceWithTags(temp, underline, "<u>", "</u>"); // Check for underline
	temp = replaceWithTags(temp, strikethrough, "<strike>", "</strike>"); // Check for strikethrough

	temp = temp.replace(/\n/g, "<br>"); // Check for line breaks

	return temp;
}

let test;

function addChatMessage(author, msg, color = "#000000"){
	const container = document.getElementById("chat");

	const li = document.createElement("li");
	container.appendChild(li);

	test = msg;

	if(author !== null){
		const authorEl = document.createElement("span");
		authorEl.textContent = `${author}`;
		authorEl.className = "chatAuthor";
		authorEl.style.color = color;
		li.appendChild(authorEl);
	}

	const msgEl = document.createElement("span");
	msgEl.className = "chatMsg";

	const msgFormatted = renderFormatting(escapeHtml(msg));

	if(author === null) {
		msgEl.style.color = color;
		msgEl.innerHTML = msgFormatted;
	}
	else{
		msgEl.innerHTML = `: ${msgFormatted}`;
	}

	li.appendChild(msgEl);

	container.scrollTop = container.scrollHeight;
}

document.getElementById("clickFriends").addEventListener("click", () => {
	document.getElementById("topOverlayTop").style.display = document.getElementById("topOverlayTop").style.display == "none" ? "grid" : "none";
})

// https://github.com/anoek/webrtc-group-chat-example/blob/master/client.html

async function accessMicrophone(){
	try{
		audioStream = await navigator.mediaDevices.getUserMedia({"audio": true, "video": false});

		const mediaEl = createStreamAudioEl(audioStream);
		mediaEl.muted = true;
	}
	catch(err){
		console.warn("Error accessing media devices. ", err);
	}
}

function addPeer(data){
	const peerToken = data.peer;

	if(peerToken in peers){
		console.log("Already connected to peer ", peerToken);
		return;
	}

	const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS }, { optional: [{DtlsSrtpKeyAgreement: true}] });
	peers[peerToken] = peerConnection;

	peerConnection.onicecandidate = function(e) {
		if(e.candidate){
			sendData({ 
				cmd: "relayICECandidate", 
				peer: peerToken, 
				iceCandidate: { 
					sdpMLineIndex: e.candidate.sdpMLineIndex,
					candidate: e.candidate.candidate
				}
			});
		}	
	};

	peerConnection.onaddstream = function(e) {
		console.log("onAddStream", e);

		peerMedia[peerToken] = createStreamAudioEl(e.stream);
	};

	peerConnection.addStream(audioStream);

	if(data.createOffer){
		console.log("Creating an RTC offer to ", peerToken);

		peerConnection.createOffer(
			(localDesc) => {
				console.log("Local offer description is: ", localDesc);

				peerConnection.setLocalDescription(localDesc, () => {
					sendData({
						cmd: "relaySessionDesc",
						peer: peerToken,
						sessionDesc: localDesc
					});

					console.log("Offser setLocalDescription succeeded");
				}, () => { console.warn("Offer setLocalDescription failed!"); });
			},
			(err) => {
				console.warn("Error sending offer: ", err);
			}
		);
	}
}

function remoteSessionDesc(data){
	console.log("Remote desc received: ", data);
	const peerToken = data.peer;
	const peer = peers[peerToken];
	const remoteDesc = data.sessionDesc;

	const desc = new RTCSessionDescription(remoteDesc);

	const stuff = peer.setRemoteDescription(desc, () => {
		console.log("setRemoteDescription succeeded!");

		if(remoteDesc.type === "offer"){
			console.log("Creating answer");

			peer.createAnswer((localDesc) => {
				console.log("Answer description is: ", localDesc);

				peer.setLocalDescription(localDesc, () => {
					sendData({
						cmd: "relaySessionDesc",
						peer: peerToken,
						sessionDesc: localDesc
					});

					console.log("Offser setLocalDescription succeeded");
				}, () => { console.warn("Offer setLocalDescription failed!"); });
			}, (err) => { console.warn("Error creating answer: ", err, "; ", peer); });
		}
	}, (err) => { console.warn("setRemoteDescription error: ", err); });

	console.log("Description object: ", desc);
}

function attachMediaStream(el, stream){
	el.srcObject = stream;
}

function createStreamAudioEl(stream){
	const mediaEl = document.createElement("audio");

	mediaEl.setAttribute("autoplay", "autoplay");
	mediaEl.setAttribute("controls", "");
	document.body.appendChild(mediaEl);
	attachMediaStream(mediaEl, stream);

	return mediaEl;
}

async function bindVoiceVolume(){
	const audioContext = new AudioContext();
	const audioWorklet = audioContext.audioWorklet;
	const audioStreamSource = audioContext.createMediaStreamSource(audioStream);

	await audioWorklet.addModule("volumeProcessor.js");

	const volumeNode = new AudioWorkletNode(audioContext, "volume-processor");
	audioStreamSource.connect(volumeNode);

	volumeNode.port.onmessage = (e) => {
		updateVolumeIndicator(e.data);
	};
}

let updateVolumeTotal = 0;
let updateVolumeCount = 0;

function updateVolumeIndicator(volume){
	updateVolumeTotal+= Math.floor(volume);
	updateVolumeCount++;

	if(updateVolumeCount >= volumeAveraging){
		const val = Math.floor(updateVolumeTotal / updateVolumeCount) + volumeOffset;
		const grad = document.querySelector("#muteMic svg").children[0].children[0];

		grad.children[0].setAttribute("offset", `${val}%`);
		grad.children[1].setAttribute("offset", `${val}%`);

		updateVolumeTotal = 0;
		updateVolumeCount = 0;
	}
}

function muteBtnHandler(){
	muted = !muted;
	const path = document.querySelector("#muteMic svg").children[1];
	const selfAudioTrack = audioStream.getAudioTracks()[0];

	if(muted){
		path.setAttribute("fill", "red");
		selfAudioTrack.enabled = false;
	}
	else{
		path.setAttribute("fill", "url(#volumeGradient)");
		selfAudioTrack.enabled = true;
	}
}

function initRoomVideo(){
	const container = document.getElementById("videoContainer");

	switch(roomType){
		case "local":
			const videoEl = document.createElement("video");
			videoEl.setAttribute("controls", "controls");
			videoEl.id = "videoPlayer";
			container.appendChild(videoEl);

			initVideoEvents();
			initHLSVideo();

			syncVideo();
			break;
		case "youtube":
			const ytEl = document.createElement("div");
			ytEl.style.width = "80vw";
			ytEl.id = "videoPlayer";

			initYoutubeAPI();

			container.appendChild(ytEl);
			break;
	}
}

function initYoutubeAPI(){
	const tag = document.createElement("script");
	tag.src = "https://www.youtube.com/player_api";
	const firstScriptTag = document.getElementsByTagName("script")[0];
	firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
}

function onYouTubePlayerAPIReady() {
	const options = {
		events: {
			// call this function when player is ready to use
			"onReady": onPlayerReady
		},
		playerVars: {
			origin: location.host
		},
		videoId: watchId,
		width: "80vw",
		height: "100vw"
	};

	// create the global player from the specific iframe (#video)
	ytPlayer = new YT.Player("videoPlayer", options);
}

function arrEquals(a, b){
	if(a === b) return true;
	if(a?.length !== b?.length) return false;
	if(a === null || b === null) return false;
	if(a === undefined || b === undefined) return false;

	for(let i = 0; i < a.length; i++){
		if(a[i] !== b[i]) return false;
	}

	return true;
}

let prevTime = 0;

function onPlayerReady() {
	syncVideo();
	createSeekInterval();

	ytPlayer.addEventListener("onStateChange", (e) => {
		const state = e.data;
		
		if(state === 1){
			playVideo(true);
			sendData({cmd: "pause", state: false});
		}
		else if(state === 2){
			playVideo(false);
			sendData({cmd: "pause", state: true});
		}
		
		prevStates.push(state);
	});
}

function createSeekInterval(){
	return setInterval(() => {
		const cur = ytPlayer.getCurrentTime();
		
		if(cur - prevTime < 0 || cur - prevTime >= 2){
			console.log("seeked");
			sendData({cmd: "time", time: ytPlayer.getCurrentTime()});
		}

		prevTime = cur;
	}, 1000);
}

function setVideoTime(time, play = false){
	switch(roomType){
		case "local":
			document.getElementById("videoPlayer").currentTime = time;
			playVideo(play);
			break;
		case "youtube":
			ytPlayer.seekTo(time, true);
			if(play){
				ytPlayer.playVideo();
			}
			else{
				ytPlayer.pauseVideo();
			}
			break;
	}
}

function playVideo(state){
	switch(roomType){
		case "local":
			const videoEl = document.getElementById("videoPlayer");

			if(!state) {
				videoEl.pause();
			}
			else{
				videoEl.play();
			}
			break;
		case "youtube":
			if(!state){
				ytPlayer.pauseVideo();
			}
			else{
				ytPlayer.playVideo();
			}
			break;
	}
}

function getVideoTime(){
	switch(roomType){
		case "local":
			return document.getElementById("videoPlayer").currentTime;
			break;
		case "youtube":
			return ytPlayer.getCurrentTime();
			break;
	}
}
