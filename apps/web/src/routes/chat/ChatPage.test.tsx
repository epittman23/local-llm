import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellBarSlotContext } from '@/components/layout/ShellBarSlot';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getChatById } from '@/lib/apis/chats';
import { getFolderById } from '@/lib/apis/folders';
import { useAuthStore } from '@/lib/stores/authStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { useUIStore } from '@/lib/stores/uiStore';
import { usePageTitleStore } from '@/lib/ui/pageTitle';
import { ChatPage } from './ChatPage';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }) }));
vi.mock('./useModels', () => ({
	useModels: () => ({ models: [{ id: 'm1', name: 'Model One' }], loaded: true, failed: false })
}));
vi.mock('./ChatControls', () => ({ ChatControls: () => <div data-testid="controls-panel" /> }));
vi.mock('@/lib/settings/userSettings', () => ({
	useUserSettings: () => ({ settings: {}, update: vi.fn(async () => undefined) })
}));
vi.mock('@/lib/apis/configs', () => ({ getBanners: vi.fn(async () => []) }));
vi.mock('@/lib/apis/tools', () => ({ getTools: vi.fn(async () => []) }));
vi.mock('@/lib/apis/chats', async (orig) => ({
	...(await orig<object>()),
	getChatById: vi.fn(),
	getChatListByFolderId: vi.fn(async () => []),
	getPinnedChatList: vi.fn(async () => []),
	getTagsById: vi.fn(async () => [])
}));
vi.mock('@/lib/apis/folders', async (orig) => ({ ...(await orig<object>()), getFolderById: vi.fn() }));

function show() {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<MemoryRouter>
					<ChatPage />
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	useUIStore.setState({ controlsOpen: false });
	useAuthStore.setState({
		status: 'authenticated',
		token: 't',
		user: { id: 'u1', name: 'Ada', role: 'admin' }
	} as never);
});
afterEach(cleanup);

describe('ChatPage header', () => {
	it('toggles Temporary chat on a new chat, its icon changing with it (#1080)', () => {
		show();
		const toggle = screen.getByRole('button', { name: 'Temporary chat' });
		expect(toggle.getAttribute('aria-pressed')).toBe('false');
		expect(screen.getByTestId('temporary-off')).toBeInTheDocument();
		fireEvent.click(toggle);
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByTestId('temporary-on')).toBeInTheDocument();
	});

	it('names a new chat "New chat" in the tab and the phone bar, in sentence case (WRD-1, #1091)', async () => {
		show();
		await waitFor(() => expect(usePageTitleStore.getState().dynamic).toBe('New chat'));
	});

	it('marks its model row as the top of the page, which toasts start below on a phone (FBK-2)', () => {
		show();
		const row = screen.getByRole('button', { name: 'Controls' }).closest('header');
		expect(row?.hasAttribute('data-page-top')).toBe(true);
	});

	it('shows the drop zone while files are dragged over the chat, and clears it on a drop (#1084)', () => {
		show();
		const column = screen.getByRole('textbox', { name: 'Message' }).closest('.isolate') as HTMLElement;
		const drag = (type: 'dragEnter' | 'drop') => {
			const event = createEvent[type](column);
			Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [] } });
			fireEvent(column, event);
		};
		drag('dragEnter');
		expect(screen.getByText('Drop files to attach them to your message')).toBeInTheDocument();
		drag('drop');
		expect(screen.queryByText('Drop files to attach them to your message')).toBeNull();
	});

	it('toggles the Controls panel', () => {
		show();
		const controls = screen.getByRole('button', { name: 'Controls' });
		expect(controls.getAttribute('aria-pressed')).toBe('false');
		expect(controls.querySelector('[data-testid="controls-changed"]')).toBeNull();
		fireEvent.click(controls);
		expect(controls.getAttribute('aria-pressed')).toBe('true');
	});

	it('shows Controls in the side panel, which closes back to the chat (canvas C2)', () => {
		show();
		fireEvent.click(screen.getByRole('button', { name: 'Controls' }));
		const panel = screen.getByRole('complementary', { name: 'Controls' });
		expect(panel).toContainElement(screen.getByTestId('controls-panel'));
		expect(screen.getByRole('heading', { level: 2, name: 'Controls' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Close controls' }));
		expect(screen.queryByRole('complementary', { name: 'Controls' })).toBeNull();
		expect(useUIStore.getState().controlsOpen).toBe(false);
	});
});

const NOT_FOUND = "We could not find what you're looking for :/";
const Where = () => <div data-testid="where">{useLocation().pathname}</div>;

function showAt(path: string) {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<MemoryRouter initialEntries={[path]}>
					<Routes>
						<Route path="/" element={<Where />} />
						<Route path="/c/:id" element={<ChatPage />} />
						<Route path="/folders/:folderId" element={<ChatPage />} />
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);
}

const SAVED = {
	id: 'c1',
	title: 'Arithmetic',
	chat: {
		title: 'Arithmetic',
		models: ['m1'],
		history: {
			currentId: 'a1',
			messages: {
				u1: { id: 'u1', parentId: null, childrenIds: ['a1'], role: 'user', content: 'What is 2+2?' },
				a1: {
					id: 'a1',
					parentId: 'u1',
					childrenIds: [],
					role: 'assistant',
					content: 'It is 4',
					model: 'm1',
					done: true
				}
			}
		}
	}
};

describe('ChatPage: a saved chat', () => {
	it('shows its title in the header, and a rename there names the tab at once (#928)', async () => {
		vi.mocked(getChatById).mockResolvedValueOnce(SAVED as never);
		showAt('/c/c1');
		const title = await screen.findByRole('button', { name: 'Chat title: Arithmetic. Rename' });
		await waitFor(() => expect(usePageTitleStore.getState().dynamic).toBe('Arithmetic'));
		fireEvent.click(title);
		expect(screen.getByRole('textbox', { name: 'Chat title' })).toBeInTheDocument();
	});

	it('marks Controls with a dot while the chat has parameters of its own (#996)', async () => {
		vi.mocked(getChatById).mockResolvedValueOnce({
			...SAVED,
			chat: { ...SAVED.chat, params: { temperature: 0.2 } }
		} as never);
		showAt('/c/c1');
		await screen.findByRole('button', { name: 'Chat title: Arithmetic. Rename' });
		const controls = screen.getByRole('button', { name: 'Controls' });
		expect(controls.querySelector('[data-testid="controls-changed"]')).not.toBeNull();
		expect(controls.getAttribute('aria-description')).toBe('1 changed');
	});

	it('offers Jump to latest when scrolled up, which goes back to the end (#929)', async () => {
		vi.mocked(getChatById).mockResolvedValueOnce(SAVED as never);
		showAt('/c/c1');
		const scroller = await screen.findByTestId('chat-messages');
		expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
		Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 3000 });
		Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
		scroller.scrollTop = 1000;
		fireEvent.scroll(scroller);
		fireEvent.click(await screen.findByRole('button', { name: 'Jump to latest' }));
		expect(scroller.scrollTop).toBe(3000);
		expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
	});
});

describe('ChatPage on a phone (#1091)', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('has no header row of its own: Controls goes in the app bar, the model picker in the composer', () => {
		vi.stubGlobal(
			'matchMedia',
			vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
		);
		const slot = document.createElement('div');
		document.body.append(slot);
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<ShellBarSlotContext.Provider value={slot}>
						<MemoryRouter>
							<ChatPage />
						</MemoryRouter>
					</ShellBarSlotContext.Provider>
				</TooltipProvider>
			</QueryClientProvider>
		);
		expect(document.querySelector('header[data-page-top]')).toBeNull();
		expect(slot).toContainElement(screen.getByRole('button', { name: 'Controls' }));
		expect(slot).toContainElement(screen.getByRole('button', { name: 'Temporary chat' }));
		// The compact picker, in the composer's toolbar.
		const picker = screen.getByRole('button', { name: /^Model:/ });
		expect(slot.contains(picker)).toBe(false);
		expect(document.getElementById('model-selector-model-button')).toBeNull();
		slot.remove();
	});
});

describe('ChatPage: a link to something that is not there (NAV-3, #953)', () => {
	it('says a missing chat no longer exists, in place, and offers the ways onward', async () => {
		vi.mocked(getChatById).mockRejectedValueOnce(NOT_FOUND);
		showAt('/c/gone');

		expect(await screen.findByRole('heading', { level: 2, name: 'This chat no longer exists.' })).toBeInTheDocument();
		expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
		expect(usePageTitleStore.getState().dynamic).toBe('Chat not found');

		fireEvent.click(screen.getByRole('button', { name: 'Search chats' }));
		expect(useUIStore.getState().searchOpen).toBe(true);
		fireEvent.click(screen.getByRole('button', { name: 'Archived chats' }));
		expect(useSettingsModalStore.getState()).toMatchObject({ open: true, requestedTab: 'archived_chats' });
		fireEvent.click(screen.getByRole('link', { name: 'New chat' }));
		expect(screen.getByTestId('where').textContent).toBe('/');
	});

	it('offers to try again when the chat failed to load, keeping the page (STA-4)', async () => {
		vi.mocked(getChatById).mockRejectedValueOnce('Database is locked');
		showAt('/c/c1');
		expect(await screen.findByText("Couldn't load this chat")).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
	});

	it('says a missing folder no longer exists, as the page heading, with no toast', async () => {
		vi.mocked(getFolderById).mockRejectedValueOnce(NOT_FOUND);
		showAt('/folders/gone');
		expect(await screen.findByRole('heading', { level: 1, name: 'This folder no longer exists.' })).toBeInTheDocument();
		expect(usePageTitleStore.getState().dynamic).toBe('Folder not found');
		expect(screen.queryByTestId('where')).toBeNull();
	});

	it('offers to try again when the folder failed to load', async () => {
		vi.mocked(getFolderById).mockRejectedValueOnce('Database is locked');
		showAt('/folders/f1');
		expect(await screen.findByText("Couldn't load this folder")).toBeInTheDocument();
	});
});

describe('ChatPage: a folder’s page (#998)', () => {
	it('is headed by the folder, once, names the tab after it, and says where a new chat goes', async () => {
		vi.mocked(getFolderById).mockResolvedValueOnce({ id: 'f1', name: 'Statistics', data: {} });
		showAt('/folders/f1');
		expect(await screen.findByRole('heading', { level: 1, name: 'Statistics' })).toBeInTheDocument();
		expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
		await waitFor(() => expect(usePageTitleStore.getState().dynamic).toBe('Statistics'));
		expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', 'New chat in Statistics');
		expect(screen.queryByTestId('chat-folder')).toBeNull();
	});
});
