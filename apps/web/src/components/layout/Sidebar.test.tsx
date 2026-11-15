import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { useUIStore } from '@/lib/stores/uiStore';
import { SidebarContent } from './Sidebar';

vi.mock('@/routes/chat/sidebar/ChatSidebar', () => ({ ChatSidebar: () => <div /> }));
vi.mock('@/routes/channels/SidebarChannels', () => ({ SidebarChannels: () => <div /> }));

beforeEach(() => {
	useAuthStore.setState({
		status: 'authenticated',
		token: 't',
		user: { id: 'u1', name: 'Ada', role: 'user' }
	} as never);
	useUIStore.setState({ searchOpen: false } as never);
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
		for (const name of ['Workspace', 'Benchmarks', 'Admin']) expect(group.getByRole('link', { name })).toBeTruthy();
		// The name is hidden with a pointer, where the tooltip shows it, and shown on touch (OVL-4).
		expect(group.getByText('Workspace').className).toContain('pointer-fine:sr-only');
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

	it('marks the destination that is open', () => {
		show({}, '/workspace/models');
		const link = within(screen.getByRole('list', { name: 'Destinations' })).getByRole('link', { name: 'Workspace' });
		expect(link).toHaveAttribute('aria-current', 'page');
		expect(link.className).toContain('bg-accent');
	});

	it('closes the sidebar from its header when asked to offer that', () => {
		useUIStore.setState({ sidebarOpen: true } as never);
		show({ showCollapseToggle: true });
		fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));
		expect(useUIStore.getState().sidebarOpen).toBe(false);
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
	});
});
