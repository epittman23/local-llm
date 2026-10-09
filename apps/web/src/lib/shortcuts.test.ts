import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYBINDINGS, Shortcut, eventToChord, matchKeybinding, resolveKeybindings } from './shortcuts';

const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
	({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

describe('shortcuts', () => {
	it('turns a key event into a chord, with Ctrl as Cmd off the Mac', () => {
		expect(eventToChord(key('k', { ctrlKey: true }))).toBe('Cmd+K');
		expect(eventToChord(key('O', { ctrlKey: true, shiftKey: true }))).toBe('Cmd+Shift+O');
		expect(eventToChord(key('Shift', { shiftKey: true }))).toBe('');
	});
	it('matches the bound shortcut, honouring saved rebindings', () => {
		expect(matchKeybinding(key('k', { ctrlKey: true }), DEFAULT_KEYBINDINGS)).toBe(Shortcut.SEARCH);
		const rebound = resolveKeybindings({ search: 'Cmd+J', junk: 'x' } as never);
		expect(matchKeybinding(key('k', { ctrlKey: true }), rebound)).toBeNull();
		expect(matchKeybinding(key('j', { ctrlKey: true }), rebound)).toBe(Shortcut.SEARCH);
	});
});
