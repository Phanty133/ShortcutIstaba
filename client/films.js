function init(){
	for(const el of document.getElementById("selectContainer").children){
		el.addEventListener("click", (e) => {
			let el = e.target;

			while (!el.hasAttribute("data-id")) {
				el = el.parentElement;
			}

			if(el.hasAttribute("data-yt")) return;
			
			window.location.href = `/createroom?film=${el.getAttribute("data-id")}&type=local`;
		});
	}

	document.getElementById("inputYoutube").addEventListener("keydown", (e) => {
		if(e.key === "Enter"){
			youtubeInputHandler();
		}
	});

	document.getElementById("inputYoutubeSubmit").addEventListener("click", youtubeInputHandler);
}

function youtubeInputHandler(){
	const val = document.getElementById("inputYoutube").value;
	const ytRegex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)(?<id>[^"&?\/\s]{11})/i;
	const match = val.match(ytRegex);

	if(!match){
		console.warn("Failed to match youtube ID in given URL!");
		return;
	}

	window.location.href = `/createroom?film=${match.groups.id}&type=youtube`;
}
