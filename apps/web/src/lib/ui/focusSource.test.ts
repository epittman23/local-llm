import { afterEach, describe, expect, it } from 'vitest';
import { installFocusSource } from './focusSource';

describe('installFocusSource', () => {
	let stop: (() => void) | undefined;
	afterEach(() => stop?.());
	const source = () => document.documentElement.dataset.focus;

	it('marks focus as from the keyboard on Tab, and not on other keys', () => {
		stop = installFocusSource();
		expect(source()).toBeUndefined();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
		expect(source()).toBeUndefined();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
		expect(source()).toBe('keyboard');
	});

	it('clears the mark on the next pointer press', () => {
		stop = installFocusSource();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
		expect(source()).toBe('keyboard');
		window.dispatchEvent(new Event('pointerdown'));
		expect(source()).toBeUndefined();
	});

	it('sees Tab even when a component stops the event from bubbling', () => {
		stop = installFocusSource();
		const input = document.createElement('input');
		input.addEventListener('keydown', (event) => event.stopPropagation());
		document.body.append(input);
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
		expect(source()).toBe('keyboard');
		input.remove();
	});

	it('stops tracking and clears the mark when uninstalled', () => {
		const uninstall = installFocusSource();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
		uninstall();
		expect(source()).toBeUndefined();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
		expect(source()).toBeUndefined();
	});
});
