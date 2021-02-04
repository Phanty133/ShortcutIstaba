function init(){
	document.getElementById("joinbtn").addEventListener("click", () => {
		Cookies.set("username", document.getElementById("usernameInput").value);
		window.location.href = `/join?id=${encodeURIComponent(document.getElementById("inputId").value)}`;
	});

	document.getElementById("createroom").addEventListener("click", () => {
		Cookies.set("username", document.getElementById("usernameInput").value);
		window.location.href = `/films`;
	});
}