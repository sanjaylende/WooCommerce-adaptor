/* global document, window -- runs in the browser */
/* Flipick Video Generator: asks for confirmation before a button that carries data-confirm is submitted. */
document.addEventListener('click', function (event) {
	var link = event.target && event.target.closest ? event.target.closest('a[data-confirm]') : null;
	if (link && !window.confirm(link.getAttribute('data-confirm'))) {
		event.preventDefault();
	}
});
document.addEventListener('submit', function (event) {
	var form = event.target;
	if (form && form.getAttribute && form.getAttribute('data-confirm') && !window.confirm(form.getAttribute('data-confirm'))) {
		event.preventDefault();
	}
});
