import { afterEach, describe, expect, it } from 'vitest';
import { useSettingsModalStore } from './settingsModalStore';

const s = () => useSettingsModalStore.getState();
afterEach(() => s().closeSettings());

describe('settingsModalStore (#951)', () => {
	it('opens on a request, with its state, and closes to nothing', () => {
		s().openSettings({ tab: 'admin:models', state: { model: 'm1' } });
		expect(s()).toMatchObject({ open: true, requestedTab: 'admin:models', tabState: { model: 'm1' } });
		s().setTab('admin:models');
		s().closeSettings();
		expect(s()).toMatchObject({ open: false, requestedTab: null, tab: null, dirty: false, pending: null });
	});

	it('switches tab at once while clean, and carries a setting to scroll to', () => {
		s().openSettings('general');
		s().setTab('general');
		s().requestTab('interface', 'widescreen-mode');
		expect(s()).toMatchObject({ tab: 'interface', setting: 'widescreen-mode', pending: null });
		s().clearSetting();
		expect(s().setting).toBeNull();
		s().requestTab('interface', 'font-family');
		expect(s()).toMatchObject({ tab: 'interface', setting: 'font-family' });
	});

	it('while dirty, holds a tab switch or a close until it is confirmed or cancelled', () => {
		s().openSettings('general');
		s().setTab('general');
		s().setDirty(true);
		s().requestTab('audio');
		expect(s()).toMatchObject({ tab: 'general', pending: { kind: 'tab', tab: 'audio', setting: null } });
		s().cancelLeave();
		expect(s()).toMatchObject({ tab: 'general', pending: null, dirty: true });
		s().requestTab('audio');
		s().confirmLeave();
		expect(s()).toMatchObject({ tab: 'audio', pending: null, dirty: false });

		s().setDirty(true);
		s().requestClose();
		expect(s().pending).toEqual({ kind: 'close' });
		expect(s().open).toBe(true);
		s().confirmLeave();
		expect(s().open).toBe(false);
		s().confirmLeave();
		expect(s().open).toBe(false);
	});

	it('closes at once when clean, and a new tab starts clean', () => {
		s().openSettings();
		s().setTab('general');
		s().setDirty(true);
		s().setTab('general');
		expect(s().dirty).toBe(true);
		s().setTab('audio');
		expect(s().dirty).toBe(false);
		s().requestClose();
		expect(s().open).toBe(false);
	});
});
