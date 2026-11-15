import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUIStore } from '@/lib/stores/uiStore';
import { usePageTitleStore } from '@/lib/ui/pageTitle';
import { AppShell } from './AppShell';
import { ShellBarPortal } from './ShellBarSlot';

const auth = vi.hoisted(() => ({ status: 'authenticated' as 'authenticated' | 'pending' | 'anonymous' }));
vi.mock('@/lib/auth/useAuthGate', () => ({ useAuthGate: () => auth.status }));
vi.mock('@/lib/settings/useSettingsUrl', () => ({ useSettingsUrl: () => {} }));
const account = vi.hoisted(() => ({ settings: {} as Record<string, unknown> | null }));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: account.settings }) }));
vi.mock('@/lib/socket/SocketProvider', () => ({ useSocketReady: () => {} }));
vi.mock('@/lib/useShortcuts', () => ({ useShortcuts: () => {} }));
vi.mock('@/routes/calendar/useCalendarAlerts', () => ({ useCalendarAlerts: () => {} }));
vi.mock('@/routes/channels/useChannels', () => ({ useChannelUnreadEvents: () => {} }));
vi.mock('@/components/settings/SettingsModal', () => ({ SettingsModal: () => null }));
vi.mock('@/routes/chat/sidebar/ChatDialogs', () => ({ SearchChatsDialog: () => null }));
vi.mock('@/routes/chat/PendingWorkspacesDialog', () => ({ PendingWorkspacesDialog: () => null }));
vi.mock('./Sidebar', () => ({
	SidebarContent: () => (
		<nav aria-label="Main">
			<a href="/workspace">Workspace</a>
		</nav>
	),
	SidebarRail: () => (
		<nav aria-label="Main">
			<button type="button">Open sidebar</button>
		</nav>
	)
}));

function renderAt(path: string) {
	const router = createMemoryRouter(
		[
			{
				element: <AppShell />,
				children: [
					{
						path: '/c/:id',
						element: (
							<>
								<button type="button">Send</button>
								<ShellBarPortal>
									<button type="button">Controls</button>
								</ShellBarPortal>
							</>
						),
						handle: { title: 'Chat', heading: 'sr', foldsBar: true }
					},
					{ path: '/notes', element: <h1>Notes</h1>, handle: { title: 'Notes', heading: 'page' } }
				]
			}
		],
		{ initialEntries: [path] }
	);
	return render(
		<TooltipProvider>
			<RouterProvider router={router} />
		</TooltipProvider>
	);
}

beforeEach(() => {
	auth.status = 'authenticated';
	account.settings = {};
	useUIStore.setState({ sidebarOpen: true, searchOpen: false } as never);
});
afterEach(() => {
	cleanup();
	usePageTitleStore.setState({ dynamic: null, owner: null });
});

describe('AppShell', () => {
	it('starts with a skip link that moves focus to the page (A11Y-3)', () => {
		renderAt('/notes');
		const skip = screen.getByRole('link', { name: 'Skip to content' });
		const focusable = document.querySelectorAll(
			'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])'
		);
		expect(focusable[0]).toBe(skip);
		fireEvent.click(skip);
		const main = screen.getByRole('main');
		expect(main.id).toBe('content');
		expect(document.activeElement).toBe(main);
	});

	it('has the Main navigation landmark beside the main region', () => {
		renderAt('/notes');
		expect(screen.getAllByRole('navigation', { name: 'Main' }).length).toBeGreaterThan(0);
		expect(screen.getByRole('main')).toBeInTheDocument();
		// Named, so a page's own aside (Calendar's) does not make two unnamed ones.
		expect(screen.getByRole('complementary', { name: 'Sidebar' })).toBeInTheDocument();
	});

	it('gives a page without a visible heading a hidden h1 with its name', () => {
		usePageTitleStore.setState({ dynamic: 'Sample variance walkthrough', owner: {} });
		renderAt('/c/1');
		const h1 = screen.getByRole('heading', { level: 1 });
		expect(h1.textContent).toBe('Sample variance walkthrough');
		expect(h1.className).toContain('sr-only');
	});

	it('adds no heading of its own where the page draws one', () => {
		renderAt('/notes');
		expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Notes']);
	});

	it('folds the phone bar to a floating menu button on short screens where the page makes room (A11Y-5)', () => {
		renderAt('/c/1');
		const menu = screen.getByRole('button', { name: 'Open navigation menu' });
		expect(menu.className).toContain('max-md:[@media(max-height:520px)]:fixed');
		expect(screen.getByRole('main').parentElement?.className).toContain('[--shell-menu-inset:2.25rem]');
		const bar = within(screen.getByRole('banner'));
		expect(bar.getByRole('img', { name: 'local-llm' }).getAttribute('class')).toContain(
			'[@media(max-height:520px)]:hidden'
		);
		expect(bar.getByText('Chat').className).toContain('[@media(max-height:520px)]:hidden');
		expect(bar.getByRole('link', { name: 'New chat' }).className).toContain('[@media(max-height:520px)]:hidden');
	});

	it('keeps the phone bar, with the mark and the page name, on pages that do not make room', () => {
		renderAt('/notes');
		const menu = screen.getByRole('button', { name: 'Open navigation menu' });
		expect(menu.className).not.toContain('520px');
		expect(screen.getByRole('main').parentElement?.className).not.toContain('--shell-menu-inset');
		const bar = within(screen.getByRole('banner'));
		expect(bar.getByRole('img', { name: 'local-llm' }).getAttribute('class')).not.toContain('520px');
		expect(bar.getByText('Notes').className).not.toContain('520px');
	});

	it('puts New chat at the end of the phone bar, after the menu button the top band measures (#1091)', () => {
		renderAt('/notes');
		const bar = screen.getByRole('banner');
		expect(bar.querySelector('button')).toBe(screen.getByRole('button', { name: 'Open navigation menu' }));
		const newChat = within(bar).getByRole('link', { name: 'New chat' });
		expect(newChat.getAttribute('href')).toBe('/');
		expect(bar.lastElementChild).toBe(newChat);
	});

	it("puts a page's own buttons in the phone bar after its name, before New chat (#1091)", () => {
		renderAt('/c/1');
		const bar = within(screen.getByRole('banner'));
		const slot = screen.getByTestId('shell-bar-slot');
		expect(slot).toContainElement(bar.getByRole('button', { name: 'Controls' }));
		expect(slot.previousElementSibling?.textContent).toBe('Chat');
		expect(slot.nextElementSibling).toBe(bar.getByRole('link', { name: 'New chat' }));
		// On a short screen they float at the top right, as the menu button floats at the left (A11Y-5).
		expect(slot.className).toContain('max-md:[@media(max-height:520px)]:fixed');
		expect(slot.className).toContain('max-md:[@media(max-height:520px)]:right-2');
	});

	it('keeps the slot in place, and empty, on a page that puts nothing there', () => {
		renderAt('/notes');
		const slot = screen.getByTestId('shell-bar-slot');
		expect(slot.childElementCount).toBe(0);
		expect(slot.className).toContain('empty:hidden');
		expect(slot.className).not.toContain('520px');
		expect(within(screen.getByRole('banner')).getByText('Notes').getAttribute('title')).toBe('Notes');
	});

	it('opens the drawer wide enough for the names of the destinations on touch, 320 px or 85% of a phone, not the sheet default', () => {
		renderAt('/notes');
		fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));
		const drawer = screen.getByRole('dialog', { name: 'Navigation' });
		expect(drawer.className).toContain('data-[side=left]:w-[min(20rem,85vw)]');
		expect(drawer.className).not.toContain('data-[side=left]:w-3/4');
	});

	it('collapses the sidebar to the 48 px rail, with no row of its own above the page (#930)', () => {
		useUIStore.setState({ sidebarOpen: false } as never);
		renderAt('/notes');
		const aside = screen.getByRole('complementary', { name: 'Sidebar' });
		expect(aside.className).toContain('w-12');
		expect(aside).toContainElement(screen.getByRole('button', { name: 'Open sidebar' }));
		expect(screen.getAllByRole('button', { name: 'Open sidebar' })).toHaveLength(1);
		expect(screen.queryByRole('link', { name: 'Workspace' })).toBeNull();
	});

	it('shows the whole sidebar, 256 px, when open', () => {
		renderAt('/notes');
		const aside = screen.getByRole('complementary', { name: 'Sidebar' });
		expect(aside.className).toContain('w-64');
		expect(within(aside).getByRole('link', { name: 'Workspace' })).toBeTruthy();
	});

	describe('the theme saved with the account (#1089)', () => {
		beforeEach(() => {
			localStorage.theme = 'dark';
			document.documentElement.className = 'dark';
		});

		it("applies and caches the account's theme when it differs from this browser's", () => {
			account.settings = { theme: 'light' };
			renderAt('/notes');
			expect(localStorage.theme).toBe('light');
			expect(document.documentElement.classList.contains('light')).toBe(true);
		});

		it('leaves the cached theme alone without a valid saved one, and before settings load', () => {
			for (const settings of [null, {}, { theme: 'her' }]) {
				account.settings = settings;
				renderAt('/notes');
				cleanup();
			}
			expect(localStorage.theme).toBe('dark');
			expect(document.documentElement.className).toBe('dark');
		});

		it('applies it once per load, so a later change of the saved value does not override this page', () => {
			account.settings = { theme: 'dark' };
			renderAt('/notes');
			account.settings = { theme: 'light' };
			// Any re-render of the shell reads the settings again.
			act(() => useUIStore.setState({ sidebarOpen: false } as never));
			expect(screen.getByRole('complementary', { name: 'Sidebar' }).className).toContain('w-12');
			expect(localStorage.theme).toBe('dark');
		});
	});

	it('keeps the shell exactly viewport-tall, so only the sidebar list scrolls (#903, LAY-7)', () => {
		renderAt('/notes');
		const aside = screen.getByRole('complementary', { name: 'Sidebar' });
		expect(aside.className).toContain('h-svh');
		expect(aside.parentElement?.className).toContain('overflow-hidden');
	});

	it('keeps the top band in --top-band-bottom on a phone, and drops it with the shell (FBK-2)', () => {
		vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
		const bar = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
			top: 0,
			bottom: 57,
			height: 57,
			left: 0,
			right: 0,
			width: 0,
			x: 0,
			y: 0,
			toJSON: () => ({})
		} as DOMRect);
		const view = renderAt('/notes');
		const root = document.documentElement;
		expect(root.style.getPropertyValue('--top-band-bottom')).toBe('57px');
		view.unmount();
		expect(root.style.getPropertyValue('--top-band-bottom')).toBe('');
		bar.mockRestore();
		vi.unstubAllGlobals();
	});

	it('shows the boot splash, not the shell, while the session is loading (STA-2)', () => {
		auth.status = 'pending';
		renderAt('/notes');
		expect(screen.getByText('local-llm')).toBeInTheDocument();
		expect(screen.queryByRole('main')).toBeNull();
		expect(screen.queryByText('Loading…')).toBeNull();
	});
});
