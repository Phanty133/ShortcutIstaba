function init(){
	for(const el of document.getElementById("selectContainer").children){
		el.addEventListener("click", (e) => {
			let el = e.target;

			while (!el.hasAttribute("data-id")) {
				el = el.parentElement;
			}
			
			window.location.href = `/createroom?film=${el.getAttribute("data-id")}`
		});
	}
}
