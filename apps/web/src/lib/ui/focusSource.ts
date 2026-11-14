// Whether focus last moved because of the keyboard (the interface standard,
// A11Y-1). The focus outline is for someone finding their place with Tab; a
// field that was clicked, tapped or focused by the app shows its caret and
// needs no outline. CSS cannot tell these apart for text fields, which match
// `:focus-visible` however they were focused, so this marks <html> with
// data-focus="keyboard" from a Tab press until the next pointer press, and
// styles/standard.css draws the outline only under that attribute.

const ATTRIBUTE = 'focus';

function onKeyDown(event: KeyboardEvent) {
	if (event.key === 'Tab') document.documentElement.dataset[ATTRIBUTE] = 'keyboard';
}

function onPointerDown() {
	delete document.documentElement.dataset[ATTRIBUTE];
}

/** Starts tracking; returns a function that stops it. Safe to call more than once. */
export function installFocusSource(): () => void {
	// Capture phase: a component that stops propagation must not hide the key from this.
	window.addEventListener('keydown', onKeyDown, true);
	window.addEventListener('pointerdown', onPointerDown, true);
	return () => {
		window.removeEventListener('keydown', onKeyDown, true);
		window.removeEventListener('pointerdown', onPointerDown, true);
		delete document.documentElement.dataset[ATTRIBUTE];
	};
}
