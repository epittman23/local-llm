import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { useUIStore } from '@/lib/stores/uiStore';
import { SidebarContent, SidebarRail } from './Sidebar';

vi.mock('@/routes/chat/sidebar/ChatSidebar', () => ({ ChatSidebar: () => <div /> }));
vi.mock('@/routes/channels/SidebarChannels', () => ({ SidebarChannels: () => <div /> }));
const account = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ update: account.update }) }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));

beforeEach(() => {
	useAuthStore.setState({
		status: 'authenticated',
		token: 't',
		user: { id: 'u1', name: 'Ada', role: 'user' }
	} as never);
	useUIStore.setState({ searchOpen: false } as never);
	account.update.mockReset().mockResolvedValue({});
	toastError.mockReset();
});
afterEach(cleanup);

function show(props: { showCollapseToggle?: boolean; onNavigate?: () => void } = {}, path = '/') {
	return render(
		<TooltipProvider>
			<MemoryRouter initialEntries={[path]}>
				<SidebarContent {...props} />
			</MemoryRouter>
		</TooltipProvider>
	);
}

/** Opens a Radix menu the way a mouse does (jsdom has no pointer capture). */
function press(el: HTMLElement) {
	fireEvent.pointerDown(el, { button: 0, ctrlKey: false, pointerType: 'mouse' });
}

describe('SidebarContent Search', () => {
	it('opens the chat search when the Search button is pressed', () => {
		show();
		expect(useUIStore.getState().searchOpen).toBe(false);
		fireEvent.click(screen.getByRole('button', { name: 'Search' }));
		expect(useUIStore.getState().searchOpen).toBe(true);
	});
});

describe('SidebarContent landmark', () => {
	it('is the Main navigation, headed by the instance name (A11Y-3, WRD-3)', () => {
		useConfigStore.setState({ config: { name: 'local-llm', version: '0' } });
		show();
		const nav = screen.getByRole('navigation', { name: 'Main' });
		expect(nav).toHaveTextContent('local-llm');
		expect(screen.getAllByRole('navigation')).toHaveLength(1);
		// The mark beside the name is decorative there: the name is the text (#1065).
		expect(nav.querySelector('[data-slot="app-mark"]')?.getAttribute('aria-hidden')).toBe('true');
		useConfigStore.setState({ config: null });
	});
});

describe('SidebarContent layout', () => {
	it('scrolls only the chat list, inside itself and never sideways (#903, #904, LAY-7)', () => {
		const { container } = show();
		const nav = screen.getByRole('navigation', { name: 'Main' });
		expect(nav.className).toContain('h-full');
		expect(nav.className).toContain('min-h-0');
		const list = container.querySelector('[data-slot="sidebar-list"]') as HTMLElement;
		expect(list.className).toContain('min-h-0');
		expect(list.className).toContain('flex-1');
		expect(list.className).toContain('overflow-y-auto');
		expect(list.className).toContain('overflow-x-hidden');
		// The user row and the destinations sit after the list, outside it.
		const destinations = screen.getByRole('list', { name: 'Destinations' });
		expect(list.compareDocumentPosition(destinations) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(list.contains(destinations)).toBe(false);
	});

	it('puts New chat and Search first, in sentence case (TYP-7)', () => {
		show();
		const newChat = screen.getByRole('link', { name: 'New chat' });
		expect(newChat.getAttribute('href')).toBe('/');
		expect(screen.queryByText('New Chat')).toBeNull();
	});

	it('lists the destinations an admin may open, each named, below the chats (#931)', () => {
		useAuthStore.setState({ user: { id: 'u1', name: 'Ada', role: 'admin' } } as never);
		useConfigStore.setState({
			config: { name: 'local-llm', version: '0', features: { enable_notes: true } } as never
		});
		show();
		const group = within(screen.getByRole('list', { name: 'Destinations' }));
		for (const name of ['Home', 'Workspace', 'Benchmarks', 'Admin'])
			expect(group.getByRole('link', { name })).toBeTruthy();
		// Eight columns, one per destination; two on touch.
		expect(screen.getByRole('list', { name: 'Destinations' }).className).toContain('grid-cols-8');
		// The name is hidden with a pointer, where the tooltip shows it, and shown on touch (OVL-4).
		expect(group.getByText('Workspace').className).toContain('pointer-fine:sr-only');
		// On touch nothing cuts a name off without a tooltip to show the rest: it wraps instead (TYP-7).
		expect(group.getByText('Benchmarks')).not.toHaveClass('truncate');
		expect(group.getByText('Benchmarks')).toHaveClass('wrap-break-word');
		expect(screen.getByRole('list', { name: 'Destinations' }).className).toContain('pointer-coarse:grid-cols-2');
		useConfigStore.setState({ config: null });
	});

	it('offers every feature the server turns on, and closes the drawer when one is chosen', () => {
		useAuthStore.setState({ user: { id: 'u1', name: 'Ada', role: 'admin' } } as never);
		useConfigStore.setState({
			config: {
				name: 'local-llm',
				version: '0',
				features: { enable_notes: true, enable_calendar: true, enable_automations: true }
			} as never
		});
		const onNavigate = vi.fn();
		show({ onNavigate });
		const group = within(screen.getByRole('list', { name: 'Destinations' }));
		expect(group.getAllByRole('link').map((a) => a.textContent)).toEqual([
			'Home',
			'Workspace',
			'Notes',
			'Automations',
			'Calendar',
			'Playground',
			'Benchmarks',
			'Admin'
		]);
		fireEvent.click(group.getByRole('link', { name: 'Calendar' }));
		expect(onNavigate).toHaveBeenCalled();
		useConfigStore.setState({ config: null });
	});

	it('leads with Home, the start page, marked when it is open (#1093)', () => {
		show({}, '/home');
		const group = within(screen.getByRole('list', { name: 'Destinations' }));
		const home = group.getAllByRole('link')[0];
		expect(home).toHaveAccessibleName('Home');
		expect(home.getAttribute('href')).toBe('/home');
		expect(home).toHaveAttribute('aria-current', 'page');
	});

	it('marks the destination that is open', () => {
		show({}, '/workspace/models');
		const link = within(screen.getByRole('list', { name: 'Destinations' })).getByRole('link', { name: 'Workspace' });
		expect(link).toHaveAttribute('aria-current', 'page');
		expect(link.className).toContain('aria-[current=page]:bg-accent');
		// Real classes: the tooltip's trigger joins class names as strings, so a
		// function className would arrive as its own source text.
		expect(link.className).not.toContain('=>');
		expect(link.className.split(' ')).toContain('h-8');
	});

	it('closes the sidebar from its header when asked to offer that, remembering it', () => {
		useUIStore.setState({ sidebarOpen: true } as never);
		show({ showCollapseToggle: true });
		fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));
		expect(useUIStore.getState().sidebarOpen).toBe(false);
		expect(localStorage.sidebar).toBe('false');
	});
});

describe('SidebarContent user menu', () => {
	beforeEach(() => {
		useSettingsModalStore.setState({ open: false, requestedTab: null } as never);
		localStorage.removeItem('theme');
		document.documentElement.className = '';
	});

	it('opens Archived chats in Settings (#1002)', async () => {
		show();
		press(screen.getByRole('button', { name: /Ada/ }));
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Archived chats' }));
		expect(useSettingsModalStore.getState()).toMatchObject({ open: true, requestedTab: 'archived_chats' });
	});

	it('opens Settings', async () => {
		show();
		press(screen.getByRole('button', { name: /Ada/ }));
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }));
		expect(useSettingsModalStore.getState()).toMatchObject({ open: true, requestedTab: null });
	});

	it('chooses the theme from a submenu with words and icons, no emoji (#1089, WRD-6)', async () => {
		show();
		press(screen.getByRole('button', { name: /Ada/ }));
		const theme = await screen.findByRole('menuitem', { name: 'Theme' });
		fireEvent.keyDown(theme, { key: 'ArrowRight' });
		const choices = await screen.findAllByRole('menuitemradio');
		expect(choices.map((c) => c.textContent)).toEqual(['System', 'Dark', 'Black', 'Light']);
		expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
		fireEvent.click(screen.getByRole('menuitemradio', { name: 'Light' }));
		expect(localStorage.theme).toBe('light');
		expect(document.documentElement.classList.contains('light')).toBe(true);
		// Saved with the account too (S2-D4), through the settings merge.
		expect(account.update).toHaveBeenCalledWith({ theme: 'light' });
	});

	it('keeps the theme in this browser and says so when the account save fails', async () => {
		account.update.mockRejectedValue(new Error('offline'));
		show();
		press(screen.getByRole('button', { name: /Ada/ }));
		fireEvent.keyDown(await screen.findByRole('menuitem', { name: 'Theme' }), { key: 'ArrowRight' });
		fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Black' }));
		expect(localStorage.theme).toBe('oled-dark');
		await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(toastError.mock.calls[0][0]).toContain('could not be saved to your account');
	});
});

/** AppShell's aside: the rail when closed, the sidebar when open. */
function Aside() {
	const open = useUIStore((state) => state.sidebarOpen);
	return open ? <SidebarContent showCollapseToggle /> : <SidebarRail />;
}

describe('SidebarRail', () => {
	function rail() {
		return render(
			<TooltipProvider>
				<MemoryRouter>
					<SidebarRail />
				</MemoryRouter>
			</TooltipProvider>
		);
	}

	it('offers Open sidebar, New chat, Search and the account menu, each named (#930, ACT-4)', () => {
		rail();
		const nav = screen.getByRole('navigation', { name: 'Main' });
		const named = [...nav.querySelectorAll('a, button')].map((el) => el.getAttribute('aria-label'));
		// Home is a destination of the open sidebar, not of the rail.
		expect(named).toEqual(['Open sidebar', 'New chat', 'Search', 'Ada']);
		expect(screen.getByRole('link', { name: 'New chat' }).getAttribute('href')).toBe('/');
		fireEvent.click(screen.getByRole('button', { name: 'Search' }));
		expect(useUIStore.getState().searchOpen).toBe(true);
	});

	it('opens the sidebar, remembers it, and moves focus to the toggle that replaces it (NAV-4)', async () => {
		useUIStore.setState({ sidebarOpen: false } as never);
		render(
			<TooltipProvider>
				<MemoryRouter>
					<Aside />
				</MemoryRouter>
			</TooltipProvider>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
		expect(localStorage.sidebar).toBe('true');
		await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close sidebar' })));
		fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));
		expect(localStorage.sidebar).toBe('false');
		await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open sidebar' })));
	});

	it('opens the account menu beside the rail, with the same items', async () => {
		useAuthStore.setState({ user: { id: 'u1', name: 'Ada', role: 'user', email: 'ada@example.com' } } as never);
		rail();
		press(screen.getByRole('button', { name: 'Ada' }));
		expect(await screen.findByRole('menuitem', { name: 'Theme' })).toBeTruthy();
		expect(screen.getByText('ada@example.com')).toBeTruthy();
		expect(screen.getByRole('menu').getAttribute('data-side')).toBe('right');
	});
});
