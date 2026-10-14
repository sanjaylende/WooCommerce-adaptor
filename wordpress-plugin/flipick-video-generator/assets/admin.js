/* global document, window -- runs in the browser */
/* Flipick Video Generator: asks for confirmation before a button that carries data-confirm is submitted. */
document.addEventListener('submit', function (event) {
	var form = event.target;
	if (form && form.getAttribute && form.getAttribute('data-confirm') && !window.confirm(form.getAttribute('data-confirm'))) {
		event.preventDefault();
	}
});
