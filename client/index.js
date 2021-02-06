const errors = {
	1: "Room with given ID not found",
	2: "No film ID found",
	3: "No session token found",
	4: "No room type given"
};

function init(){
	document.getElementById("joinbtn").addEventListener("click", () => {
		Cookies.set("username", document.getElementById("usernameInput").value);
		window.location.href = `/join?id=${encodeURIComponent(document.getElementById("inputId").value)}`;
	});

	document.getElementById("createroom").addEventListener("click", () => {
		Cookies.set("username", document.getElementById("usernameInput").value);
		window.location.href = `/films`;
	});

	const error = findGetParameter("error");

	if(error !== null && error !== 0){
		document.getElementById("indexErrMsg").textContent = errors[error];
	}
}

function findGetParameter(parameterName) {
    var result = null,
        tmp = [];
    var items = location.search.substr(1).split("&");
    for (var index = 0; index < items.length; index++) {
        tmp = items[index].split("=");
        if (tmp[0] === parameterName) result = decodeURIComponent(tmp[1]);
    }
    return result;
}
