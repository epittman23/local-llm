import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useAuthStore } from '@/lib/stores/authStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { SettingRow, SettingsForm } from './controls';
import { SettingsModal } from './SettingsModal';

// #836: opening a tab whose code was never loaded while the server was down
// crashed the whole page (an uncaught dynamic-import rejection).

const loaders = vi.hoisted(() => ({
	general: vi.fn(),
	interface: vi.fn(),
	notifications: vi.fn(),
	data_controls: vi.fn(),
	'admin:general': vi.fn()
}));

vi.mock('./adminTabComponents', () => ({
	tabLoaders: loaders,
	implementedTabIds: new Set(['general', 'interface', 'notifications', 'data_controls', 'admin:general'])
}));

const tab = (text: string) => ({ default: () => <p>{text}</p> });

/** A tab that saves on request: a field, its dirty state, and the SaveBar. */
function DirtyTab() {
	const [value, setValue] = useState('');
	return (
		<SettingsForm title="General" dirty={value !== ''} onDiscard={() => setValue('')}>
			<SettingRow label="Theme">
				<input aria-label="Draft" value={value} onChange={(e) => setValue(e.target.value)} />
			</SettingRow>
		</SettingsForm>
	);
}

/** A tab with a confirmation of its own (Data controls' Archive all). */
function NestedDialogTab() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Archive all chats
			</button>
			<ConfirmDialog open={open} onOpenChange={setOpen} title="Archive all chats?" onConfirm={() => {}} />
		</>
	);
}

const store = () => useSettingsModalStore.getState();
const openOn = (id?: string) => act(() => store().openSettings(id));

beforeEach(() => {
	for (const l of Object.values(loaders)) l.mockReset();
	loaders.general.mockResolvedValue({ default: DirtyTab });
	loaders.interface.mockResolvedValue(tab('Interface tab body'));
	loaders.notifications.mockResolvedValue(tab('Notifications tab body'));
	loaders.data_controls.mockResolvedValue({ default: NestedDialogTab });
	loaders['admin:general'].mockResolvedValue(tab('Server general body'));
	useAuthStore.setState({ user: { id: 'u', name: 'U', email: 'u@x', role: 'admin' } as never });
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	act(() => store().closeSettings());
	cleanup();
	vi.restoreAllMocks();
});

describe('a Settings tab whose import fails (#836)', () => {
	it('shows a recoverable message, retries, and leaves other tabs working', async () => {
		// Its own tab: a lazy component is kept per tab and attempt, so a failed one would linger into other tests.
		loaders['admin:general'].mockReset();
		loaders['admin:general'].mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'));
		render(<SettingsModal />);
		openOn('admin:general');

		expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');

		fireEvent.click(screen.getByRole('tab', { name: 'Notifications' }));
		expect(await screen.findByText('Notifications tab body')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('tab', { name: 'Server: General' }));
		expect(await screen.findByRole('alert')).toBeInTheDocument();

		loaders['admin:general'].mockResolvedValue(tab('Server general body'));
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(await screen.findByText('Server general body')).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
	});
});

describe('the Settings dialog (#999, #1000)', () => {
	it('has a visible title and a close button, and starts focus on the open tab', async () => {
		render(<SettingsModal />);
		openOn('notifications');
		const dialog = await screen.findByRole('dialog', { name: 'Settings' });
		expect(within(dialog).getByRole('heading', { name: 'Settings' })).not.toHaveClass('sr-only');
		expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
		expect(within(dialog).queryByRole('button', { name: 'Back' })).toBeNull();
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Notifications' })));
	});

	it('is one tablist in two halves, a repeated name carrying its half', async () => {
		render(<SettingsModal />);
		openOn('general');
		const list = await screen.findByRole('tablist', { name: 'Settings' });
		expect(list).toHaveAttribute('aria-orientation', 'vertical');
		const server = within(list).getByRole('tab', { name: 'Server: General' });
		expect(server).toHaveTextContent('Server: General');
		expect(within(server).getByText('Server:', { exact: false })).toHaveClass('sr-only');
		expect(within(list).getByText('Your settings')).toHaveAttribute('aria-hidden', 'true');
	});

	it('moves with the arrow keys, Home and End (roving focus), and opens a tab with Enter', async () => {
		render(<SettingsModal />);
		openOn('general');
		const general = await screen.findByRole('tab', { name: 'General' });
		expect(general).toHaveAttribute('tabindex', '0');
		expect(screen.getByRole('tab', { name: 'Interface' })).toHaveAttribute('tabindex', '-1');
		act(() => general.focus());
		fireEvent.keyDown(general, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Interface' }));
		fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
		expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Server: General' }));
		fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
		expect(document.activeElement).toBe(general);
		fireEvent.keyDown(general, { key: 'ArrowUp' });
		expect(document.activeElement).toBe(general);
		fireEvent.keyDown(general, { key: 'ArrowDown' });
		fireEvent.click(document.activeElement as Element);
		expect(screen.getByRole('tab', { name: 'Interface' })).toHaveAttribute('aria-selected', 'true');
		expect(store().tab).toBe('interface');
		expect(await screen.findByText('Interface tab body')).toBeInTheDocument();
	});

	it('on a phone, opens on the requested tab with a way back to the list', async () => {
		render(<SettingsModal />);
		openOn('interface');
		const back = await screen.findByRole('button', { name: 'All settings' });
		expect(screen.getByRole('navigation', { name: 'Settings tabs' })).toHaveClass('max-md:hidden');
		fireEvent.click(back);
		expect(screen.getByRole('navigation', { name: 'Settings tabs' })).not.toHaveClass('max-md:hidden');
		expect(screen.getByRole('tabpanel').parentElement).toHaveClass('max-md:hidden');
	});
});

describe('Escape (#950, NAV-4)', () => {
	it('closes a confirmation inside Settings, and leaves Settings open', async () => {
		render(<SettingsModal />);
		openOn('data_controls');
		fireEvent.click(await screen.findByRole('button', { name: 'Archive all chats' }));
		const confirm = await screen.findByRole('alertdialog', { name: 'Archive all chats?' });
		fireEvent.keyDown(confirm, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
		expect(store().open).toBe(true);
	});
});

describe('Escape meant for another layer (#950)', () => {
	it('is ignored by Settings while focus is in a layer outside it, and closes Settings from inside', async () => {
		const outside = document.createElement('button');
		document.body.appendChild(outside);
		render(<SettingsModal />);
		openOn('notifications');
		const tab = await screen.findByRole('tab', { name: 'Notifications' });
		// Focus in a portal-rendered confirmation or menu, before Radix knows it is on top
		// (the focus trap would pull a real focus() back inside, so it is stubbed).
		const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(outside);
		const pressedAgain = vi.fn();
		outside.addEventListener('keydown', pressedAgain);
		fireEvent.keyDown(tab, { key: 'Escape' });
		expect(store().open).toBe(true);
		// Pressed again for that layer, once it has had the chance to register.
		await waitFor(() => expect(pressedAgain).toHaveBeenCalled());
		active.mockRestore();
		expect(store().open).toBe(true);
		act(() => tab.focus());
		fireEvent.keyDown(tab, { key: 'Escape' });
		expect(store().open).toBe(false);
		outside.remove();
	});
});

describe('unsaved changes (#951, FRM-3)', () => {
	it('asks before another tab, keeps editing on Keep editing, and leaves on Discard changes', async () => {
		render(<SettingsModal />);
		openOn('general');
		fireEvent.change(await screen.findByRole('textbox', { name: 'Draft' }), { target: { value: 'x' } });
		expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
		expect(store().dirty).toBe(true);

		fireEvent.click(screen.getByRole('tab', { name: 'Interface' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(store().tab).toBe('general');
		expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('x');

		fireEvent.click(screen.getByRole('tab', { name: 'Interface' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		expect(await screen.findByText('Interface tab body')).toBeInTheDocument();
		expect(store().dirty).toBe(false);
	});

	it('asks before closing, and Escape on the question closes only the question', async () => {
		render(<SettingsModal />);
		openOn('general');
		fireEvent.change(await screen.findByRole('textbox', { name: 'Draft' }), { target: { value: 'x' } });
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		const ask = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
		fireEvent.keyDown(ask, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
		expect(store().open).toBe(true);
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
		expect(store().open).toBe(false);
	});

	it('closes at once when nothing changed', async () => {
		render(<SettingsModal />);
		openOn('general');
		await screen.findByRole('textbox', { name: 'Draft' });
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(store().open).toBe(false);
	});
});

describe('search (#1001)', () => {
	it('finds a setting by its description, opens its tab and flashes the row', async () => {
		render(<SettingsModal />);
		openOn('notifications');
		const search = await screen.findByRole('combobox', { name: 'Search settings' });
		fireEvent.change(search, { target: { value: 'dark mode' } });
		const option = screen.getByRole('option', { name: 'General › Theme' });
		expect(option).toHaveAttribute('aria-selected', 'true');
		expect(search).toHaveAttribute('aria-activedescendant', option.id);
		// The open tab stays while searching.
		expect(screen.getByText('Notifications tab body')).toBeInTheDocument();
		fireEvent.keyDown(search, { key: 'Enter' });
		const row = await screen.findByText('Theme');
		await waitFor(() => expect(row.closest('[data-setting]')).toHaveAttribute('data-flash'));
		expect(store().tab).toBe('general');
		expect(search).toHaveValue('');
	});

	it('lists tabs first, then settings, and moves through them with the arrow keys', async () => {
		render(<SettingsModal />);
		openOn('general');
		const search = await screen.findByRole('combobox', { name: 'Search settings' });
		fireEvent.change(search, { target: { value: 'notification' } });
		const options = screen.getAllByRole('option');
		expect(options[0]).toHaveTextContent(/^Notifications$/);
		expect(options.length).toBeGreaterThan(1);
		fireEvent.keyDown(search, { key: 'ArrowDown' });
		expect(options[1]).toHaveAttribute('aria-selected', 'true');
		fireEvent.keyDown(search, { key: 'ArrowUp' });
		fireEvent.keyDown(search, { key: 'ArrowUp' });
		expect(options.at(-1)).toHaveAttribute('aria-selected', 'true');
		fireEvent.click(options[0]);
		expect(await screen.findByText('Notifications tab body')).toBeInTheDocument();
	});

	it('says what found nothing, keeps the open tab, and offers to clear', async () => {
		render(<SettingsModal />);
		openOn('interface');
		const search = await screen.findByRole('combobox', { name: 'Search settings' });
		fireEvent.change(search, { target: { value: 'zzqx' } });
		expect(screen.getByText('No settings match ‘zzqx’.')).toBeInTheDocument();
		expect(await screen.findByText('Interface tab body')).toBeInTheDocument();
		fireEvent.keyDown(search, { key: 'Enter' });
		fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(search).toHaveValue('');
		expect(screen.getByRole('tablist')).toBeInTheDocument();
	});
});
