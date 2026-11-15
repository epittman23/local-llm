import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getModelItems } from '@/lib/apis/models';
import { searchUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { useWorkspaceStore } from '@/lib/stores/workspaceStore';
import { ModelsPage } from './ModelsPage';

vi.mock('@/lib/apis/users', () => ({ searchUsers: vi.fn(async () => ({ users: [], total: 1 })) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/models', async (original) => ({
	...(await original<object>()),
	getModelItems: vi.fn(),
	getModelTags: vi.fn(async () => [])
}));

const model = (id: string, name: string, writeAccess: boolean) => ({
	id,
	name,
	base_model_id: 'qwen/qwen3.6-27b',
	is_active: true,
	write_access: writeAccess,
	updated_at: 1_700_000_000,
	meta: { description: `About ${name}` },
	user: { name: 'Sam Rivera', email: 'sam@example.invalid' }
});

function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const router = createMemoryRouter(
		[
			{ path: '/workspace/models', element: <ModelsPage /> },
			{ path: '*', element: <p>Elsewhere</p> }
		],
		{ initialEntries: ['/workspace/models'] }
	);
	render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return router;
}

describe('ModelsPage rows', () => {
	it('opens a model from a row button that holds no other control (ACT-7)', async () => {
		vi.mocked(getModelItems).mockResolvedValue({ items: [model('tutor', 'Statistics tutor', true)], total: 1 });
		const router = renderPage();
		await screen.findByText('Statistics tutor');

		const rows = document.querySelectorAll('[data-slot="row-button"]');
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.querySelector('button, a, input, [role="switch"], [tabindex]')).toBeNull();
		expect(document.querySelector('div[role="button"]')).toBeNull();
		// The controls are beside the button, in row then control order.
		const container = row.parentElement as HTMLElement;
		expect(container.id).toBe('model-item-tutor');
		const controls = [...container.querySelectorAll('a, button, [role="switch"]')];
		expect(controls[0]).toBe(row);
		expect(controls.map((c) => c.getAttribute('aria-label')).slice(1)).toEqual([
			'New chat with Statistics tutor',
			'Model Menu',
			'Enable Statistics tutor'
		]);

		fireEvent.click(row);
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/models/edit'));
		expect(router.state.location.search).toBe('?id=tutor');
	});

	it('keeps the new-chat link beside the row, and opens nothing from a read-only row', async () => {
		vi.mocked(getModelItems).mockResolvedValue({ items: [model('shared', 'Shared reviewer', false)], total: 1 });
		renderPage();
		await screen.findByText('Shared reviewer');

		expect(document.querySelector('[data-slot="row-button"]')).toBeNull();
		expect(screen.getByText('Read only')).toBeInTheDocument();
		const link = screen.getByRole('link', { name: 'New chat with Shared reviewer' });
		expect(link.getAttribute('href')).toBe('/?model=shared');
		expect(screen.queryByRole('switch')).toBeNull();
	});
});

describe('ModelsPage counts and empty states', () => {
	it('keeps the tab count while a search narrows the list, and says how many of the whole it shows (#955)', async () => {
		useWorkspaceStore.setState({ counts: { models: null, knowledge: null, prompts: null, skills: null, tools: null } });
		vi.mocked(getModelItems).mockImplementation(async (_t, query) =>
			query
				? { items: [model('tutor', 'Statistics tutor', true)], total: 1 }
				: { items: [model('tutor', 'Statistics tutor', true), model('coder', 'Coder', true)], total: 2 }
		);
		renderPage();
		await screen.findByText('Coder');
		await waitFor(() => expect(useWorkspaceStore.getState().counts.models).toBe(2));
		expect(screen.queryByRole('status')).toBeNull();

		fireEvent.change(screen.getByRole('textbox', { name: 'Search Models' }), { target: { value: 'tutor' } });
		expect(await screen.findByRole('status')).toHaveTextContent('1 of 2 models');
		expect(useWorkspaceStore.getState().counts.models).toBe(2);
	});

	it('offers the first step on a fresh install (STA-3)', async () => {
		vi.mocked(getModelItems).mockResolvedValue({ items: [], total: 0 });
		const router = renderPage();
		expect(await screen.findByRole('heading', { name: 'No models yet' })).toBeVisible();
		fireEvent.click(screen.getByRole('link', { name: 'New model' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/models/create'));
	});

	it('names the search that matched nothing and clears it (STA-3)', async () => {
		vi.mocked(getModelItems).mockImplementation(async (_t, query) =>
			query ? { items: [], total: 0 } : { items: [model('tutor', 'Statistics tutor', true)], total: 1 }
		);
		renderPage();
		await screen.findByText('Statistics tutor');
		fireEvent.change(screen.getByRole('textbox', { name: 'Search Models' }), { target: { value: 'zzzz' } });
		expect(await screen.findByRole('heading', { name: 'Nothing matches “zzzz”' })).toBeVisible();
		const empty = screen.getByRole('heading', { name: 'Nothing matches “zzzz”' }).parentElement
			?.parentElement as HTMLElement;
		fireEvent.click(within(empty).getByRole('button', { name: 'Clear search' }));
		expect(await screen.findByText('Statistics tutor')).toBeVisible();
		expect(screen.getByRole('textbox', { name: 'Search Models' })).toHaveValue('');
	});
});

describe('ModelsPage with one account or several (WRD-4, S4-D1)', () => {
	beforeEach(() => useAuthStore.setState({ token: 't' }));
	afterEach(() => useAuthStore.setState({ token: null }));

	it('hides owners and the View filter while the install has one account, and ignores a stored view', async () => {
		localStorage.workspaceViewOption = 'created';
		vi.mocked(searchUsers).mockResolvedValue({ users: [], total: 1 });
		vi.mocked(getModelItems).mockResolvedValue({ items: [model('tutor', 'Statistics tutor', true)], total: 1 });
		renderPage();
		await screen.findByText('Statistics tutor');
		await waitFor(() => expect(searchUsers).toHaveBeenCalled());
		expect(screen.queryByText('Sam Rivera')).toBeNull();
		expect(screen.queryByRole('button', { name: /^View:/ })).toBeNull();
		expect(vi.mocked(getModelItems).mock.calls.every((call) => call[2] === '')).toBe(true);
		localStorage.removeItem('workspaceViewOption');
	});

	it('shows them again once a second account exists, with the owner kept out of the row name', async () => {
		vi.mocked(searchUsers).mockResolvedValue({ users: [], total: 2 });
		vi.mocked(getModelItems).mockResolvedValue({ items: [model('tutor', 'Statistics tutor', true)], total: 1 });
		renderPage();
		expect(await screen.findByText('Sam Rivera')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'View: All' })).toBeVisible();
		const row = document.querySelector('[data-slot="row-button"]') as HTMLElement;
		expect(screen.getByText('Sam Rivera').closest('[aria-hidden]')).not.toBeNull();
		expect(row).toContainElement(screen.getByText('Sam Rivera'));
	});
});

describe('ModelsPage delete (ACT-3, #1012)', () => {
	it('confirms in the danger colour, naming the model and what is kept, with Delete last in the menu', async () => {
		vi.mocked(getModelItems).mockResolvedValue({ items: [model('tutor', 'Statistics tutor', true)], total: 1 });
		renderPage();
		await screen.findByText('Statistics tutor');
		// No Shift shortcut: holding Shift leaves the row's menu in place (S4-D5).
		fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Model Menu' }), { button: 0, pointerType: 'mouse' });
		const menu = await screen.findByRole('menu');
		const items = within(menu).getAllByRole('menuitem');
		const last = items[items.length - 1];
		expect(last).toHaveTextContent('Delete');
		expect(last).toHaveAttribute('data-variant', 'destructive');
		fireEvent.click(last);

		const dialog = await screen.findByRole('alertdialog');
		expect(within(dialog).getByRole('heading')).toHaveTextContent('Delete “Statistics tutor”?');
		expect(dialog).toHaveTextContent('Chats that used it keep their messages.');
		expect(within(dialog).getByRole('button', { name: 'Delete model' })).toHaveAttribute('data-variant', 'destructive');
	});
});

describe('ModelsPage row content (#1097, #908)', () => {
	it('shows the base model, up to three tags, and state badges instead of dimming the row', async () => {
		vi.mocked(getModelItems).mockResolvedValue({
			items: [
				{
					...model('tutor', 'Statistics tutor', true),
					is_active: false,
					meta: { hidden: true, tags: [{ name: 'stats' }, { name: 'math' }, { name: 'r' }, { name: 'teaching' }] }
				}
			],
			total: 1
		});
		renderPage();
		await screen.findByText('Statistics tutor');
		const row = document.getElementById('model-item-tutor') as HTMLElement;
		expect(row.className).not.toMatch(/opacity/);
		const dimmed = [...row.querySelectorAll('*')].filter((el) =>
			(el.getAttribute('class') ?? '').split(/\s+/).some((c) => /^opacity-\d+$/.test(c))
		);
		expect(dimmed).toEqual([]);
		expect(within(row).getByText('Hidden')).toBeInTheDocument();
		expect(within(row).getByText('Off')).toBeInTheDocument();
		expect(within(row).getByText('qwen/qwen3.6-27b')).toHaveClass('font-mono');
		expect(within(row).getByText('stats')).toBeInTheDocument();
		expect(within(row).queryByText('teaching')).toBeNull();
		expect(within(row).getByText('+1')).toBeInTheDocument();
		expect(within(row).getByRole('switch', { name: 'Enable Statistics tutor' })).not.toBeChecked();
	});

	it('names the row by its name, state and second line, not its id or time (A11Y-2)', async () => {
		vi.mocked(getModelItems).mockResolvedValue({ items: [model('tutor', 'Statistics tutor', true)], total: 1 });
		renderPage();
		await screen.findByText('Statistics tutor');
		const button = document.querySelector('[data-slot="row-button"]') as HTMLElement;
		const hidden = [...button.querySelectorAll('[aria-hidden]')].map((el) => el.textContent ?? '');
		expect(hidden).toEqual(expect.arrayContaining(['tutor', expect.stringMatching(/ago$/)]));
		// New chat is in the menu too, for phones, where the row keeps only the menu and the switch.
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Model Menu' }), { button: 0, pointerType: 'mouse' });
		const menu = await screen.findByRole('menu');
		expect(within(menu).getByRole('menuitem', { name: 'New chat' })).toHaveAttribute('href', '/?model=tutor');
	});
});
