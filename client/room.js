let ws;
let username = "";
let ignoreSeekEvent = false;
let syncInterval;
let roomID;
const peers = {};
const peerMedia = {};
const ICE_SERVERS = [{url: "stun:stun.l.google.com:19302"}];
let audioStream;

const syncTime = 1000;
const path = "ws://localhost:8080/socket";

async function init(){
	username = Cookies.get("username");

	await initSocket();

	ws.onmessage = msgHandler;
	syncVideo();
	initVideoEvents();
	initChat();

	document.getElementById("topOverlayTop").style.display = "none";
	initVideo();

	await accessMicrophone();
	joinVoice();
}

function initVideo(){
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
	const videoEl = document.getElementById("videoPlayer");

	switch(data.cmd){
		case "time":
			ignoreSeekEvent = true;

			videoEl.currentTime = data.time;

			if(data.play){
				videoEl.play();
			}
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
