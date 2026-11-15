import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_PANEL_ID, SettingsNav, settingsTabId } from './SettingsNav';
import type { SettingsTab } from './settingsTabs';

afterEach(cleanup);

const tab = (id: string, title: string, group: string): SettingsTab => ({ id, title, group, keywords: [] });
const TABS = [
	tab('general', 'General', 'Basics'),
	tab('interface', 'Interface', 'Basics'),
	tab('account', 'Account', 'You'),
	tab('admin:general', 'Server: General', 'Setup'),
	tab('admin:models', 'Models', 'AI')
];

/** The nav as the modal uses it: opening a tab selects it. */
function Nav({ onSelect = () => {} }: { onSelect?: (id: string) => void }) {
	const [selected, setSelected] = useState<string | null>('interface');
	return (
		<SettingsNav
			tabs={TABS}
			selected={selected}
			onSelect={(id) => {
				onSelect(id);
				setSelected(id);
			}}
		/>
	);
}

const tabNamed = (name: string) => screen.getByRole('tab', { name });

describe('SettingsNav (NAV-2, NAV-5)', () => {
	it('is one vertical tablist, the open tab selected and pointing at the panel', () => {
		render(<Nav />);
		const list = screen.getByRole('tablist', { name: 'Settings' });
		expect(list).toHaveAttribute('aria-orientation', 'vertical');
		expect(within(list).getAllByRole('tab')).toHaveLength(TABS.length);
		const open = tabNamed('Interface');
		expect(open).toHaveAttribute('aria-selected', 'true');
		expect(open).toHaveAttribute('aria-controls', SETTINGS_PANEL_ID);
		expect(open).toHaveAttribute('id', settingsTabId('interface'));
		expect(tabNamed('General')).not.toHaveAttribute('aria-controls');
		expect(settingsTabId('admin:general')).toBe('settings-tab-admin-general');
	});

	it('names a tab after its half where the name would repeat, showing only the short name', () => {
		render(<Nav />);
		const server = tabNamed('Server: General');
		expect(within(server).getByText('Server:', { exact: false })).toHaveClass('sr-only');
		expect(tabNamed('General')).toHaveTextContent(/^General$/);
		// Section and group captions are for the eye; the names carry them.
		for (const caption of ['Your settings', 'Server', 'Basics', 'You', 'Setup', 'AI'])
			expect(screen.getByText(caption, { selector: '[aria-hidden]' })).toBeInTheDocument();
	});

	it('lets Tab in on the open tab only (roving focus), and moves with the arrows, Home and End', () => {
		render(<Nav />);
		expect(tabNamed('Interface')).toHaveAttribute('tabindex', '0');
		expect(screen.getAllByRole('tab').filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
		act(() => tabNamed('Interface').focus());
		fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(tabNamed('Account'));
		expect(tabNamed('Account')).toHaveAttribute('tabindex', '0');
		expect(tabNamed('Interface')).toHaveAttribute('tabindex', '-1');
		fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
		expect(document.activeElement).toBe(tabNamed('Models'));
		fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(tabNamed('Models'));
		fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
		expect(document.activeElement).toBe(tabNamed('General'));
		fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
		expect(document.activeElement).toBe(tabNamed('General'));
		// Moving does not open anything (manual activation).
		expect(tabNamed('Interface')).toHaveAttribute('aria-selected', 'true');
	});

	it('ignores other keys', () => {
		render(<Nav />);
		act(() => tabNamed('Interface').focus());
		const event = fireEvent.keyDown(document.activeElement as Element, { key: 'a' });
		expect(event).toBe(true);
		expect(document.activeElement).toBe(tabNamed('Interface'));
	});

	it('opens the focused tab when pressed (Enter and Space press a button), and selects it', () => {
		const onSelect = vi.fn();
		render(<Nav onSelect={onSelect} />);
		act(() => tabNamed('Interface').focus());
		fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
		// jsdom does not turn Enter or Space into a click as a browser does for a button.
		fireEvent.click(document.activeElement as Element);
		expect(onSelect).toHaveBeenCalledWith('account');
		expect(tabNamed('Account')).toHaveAttribute('aria-selected', 'true');
		expect(tabNamed('Account').tagName).toBe('BUTTON');
		expect(tabNamed('Account')).toHaveAttribute('type', 'button');
	});

	it('enters on the first tab when none is open', () => {
		render(<SettingsNav tabs={TABS} selected={null} onSelect={() => {}} />);
		expect(tabNamed('General')).toHaveAttribute('tabindex', '0');
		expect(screen.queryByRole('tab', { selected: true })).toBeNull();
	});
});
