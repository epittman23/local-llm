import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import * as functionsApi from '@/lib/apis/functions';
import * as knowledgeApi from '@/lib/apis/knowledge';
import * as modelsApi from '@/lib/apis/models';
import * as promptsApi from '@/lib/apis/prompts';
import * as skillsApi from '@/lib/apis/skills';
import * as toolsApi from '@/lib/apis/tools';
import { searchUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useWorkspaceStore } from '@/lib/stores/workspaceStore';
import { FunctionsPage } from '@/routes/admin/functions/FunctionsPage';
import { KnowledgePage } from './knowledge/KnowledgePage';
import { ModelsPage } from './models/ModelsPage';
import { PromptsPage } from './prompts/PromptsPage';
import { SkillsPage } from './skills/SkillsPage';
import { ToolsPage } from './tools/ToolsPage';

// Every list page shares the same chrome (#955, #959, #1007, #1012, #1013, #1097): one table of cases runs the
// same walk on each. Every API is a mock; nothing is sent anywhere.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('file-saver', () => ({ default: vi.fn() }));
vi.mock('@/lib/apis/users', () => ({ searchUsers: vi.fn() }));
vi.mock('@/lib/apis/models');
vi.mock('@/lib/apis/prompts');
vi.mock('@/lib/apis/skills');
vi.mock('@/lib/apis/tools');
vi.mock('@/lib/apis/functions');
vi.mock('@/lib/apis/knowledge');

const user = { id: 'u1', name: 'Sam Rivera', email: 'sam@example.invalid' };
const base = { write_access: true, is_active: true, updated_at: 1_700_000_000, created_at: 1_700_000_000, user };
const row = (o: Record<string, unknown>) => ({ ...base, ...o });

type Case = {
	name: string;
	Page: ComponentType;
	path: string;
	menu: string;
	item: string;
	switchName?: string;
	confirm: string;
	deleted: () => unknown;
	empty: string;
	firstStep: string;
	seed: (items: Record<string, unknown>[]) => void;
	items: Record<string, unknown>[];
};

const paged = (items: unknown[]) => ({ items, total: items.length });
const cases: Case[] = [
	{
		name: 'Models',
		Page: ModelsPage,
		path: '/workspace/models',
		menu: 'Model Menu',
		item: 'Statistics tutor',
		switchName: 'Enable Statistics tutor',
		confirm: 'Delete model',
		deleted: () => modelsApi.deleteModelById,
		empty: 'No models yet',
		firstStep: 'New model',
		seed: (items) => {
			vi.mocked(modelsApi.getModelItems).mockResolvedValue(paged(items));
			vi.mocked(modelsApi.getModelTags).mockResolvedValue(['stats']);
		},
		items: [row({ id: 'tutor', name: 'Statistics tutor', base_model_id: 'qwen/qwen3.6-27b', meta: {} })]
	},
	{
		name: 'Prompts',
		Page: PromptsPage,
		path: '/workspace/prompts',
		menu: 'Prompt Menu',
		item: 'Summarise a table',
		switchName: 'Enable Summarise a table',
		confirm: 'Delete prompt',
		deleted: () => promptsApi.deletePromptById,
		empty: 'No prompts yet',
		firstStep: 'New prompt',
		seed: (items) => {
			vi.mocked(promptsApi.getPromptItems).mockResolvedValue(paged(items));
			vi.mocked(promptsApi.getPromptTags).mockResolvedValue(['stats']);
		},
		items: [row({ id: 'p1', name: 'Summarise a table', command: 'summarise', content: 'Summarise this.' })]
	},
	{
		name: 'Skills',
		Page: SkillsPage,
		path: '/workspace/skills',
		menu: 'Skill Menu',
		item: 'SQL style',
		switchName: 'Enable SQL style',
		confirm: 'Delete skill',
		deleted: () => skillsApi.deleteSkillById,
		empty: 'No skills yet',
		firstStep: 'New skill',
		seed: (items) => vi.mocked(skillsApi.getSkillItems).mockResolvedValue(paged(items)),
		items: [row({ id: 'sql', name: 'SQL style', description: 'How to write SQL.' })]
	},
	{
		name: 'Tools',
		Page: ToolsPage,
		path: '/workspace/tools',
		menu: 'Tool Menu',
		item: 'Calculator',
		confirm: 'Delete tool',
		deleted: () => toolsApi.deleteToolById,
		empty: 'No tools yet',
		firstStep: 'New tool',
		seed: (items) => vi.mocked(toolsApi.getToolList).mockResolvedValue(items),
		items: [row({ id: 'calc', name: 'Calculator', user_id: 'u1', meta: { description: 'Adds things.' } })]
	},
	{
		name: 'Functions',
		Page: FunctionsPage,
		path: '/admin/functions',
		menu: 'Function Menu',
		item: 'Rate limit filter',
		switchName: 'Enable Rate limit filter',
		confirm: 'Delete function',
		deleted: () => functionsApi.deleteFunctionById,
		empty: 'No functions yet',
		firstStep: 'New function',
		seed: (items) => vi.mocked(functionsApi.getFunctionList).mockResolvedValue(items),
		items: [
			row({ id: 'rate', name: 'Rate limit filter', type: 'filter', user_id: 'u1', meta: { description: 'Limits.' } })
		]
	},
	{
		name: 'Knowledge',
		Page: KnowledgePage,
		path: '/workspace/knowledge',
		menu: 'More Options',
		item: 'Textbooks',
		confirm: 'Delete knowledge base',
		deleted: () => knowledgeApi.deleteKnowledgeById,
		empty: 'No knowledge bases yet',
		firstStep: 'New knowledge base',
		seed: (items) => vi.mocked(knowledgeApi.searchKnowledgeBases).mockResolvedValue(paged(items)),
		items: [row({ id: 'kb1', name: 'Textbooks', description: 'Stats books.', file_count: 3, meta: null })]
	}
];

function renderAt(c: Case) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const router = createMemoryRouter(
		[
			{ path: c.path, element: <c.Page /> },
			{ path: '*', element: <p>Elsewhere</p> }
		],
		{ initialEntries: [c.path] }
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

beforeAll(() => {
	vi.stubGlobal(
		'IntersectionObserver',
		class {
			observe() {}
			disconnect() {}
		}
	);
});
beforeEach(() => {
	localStorage.clear();
	useAuthStore.setState({
		token: 't',
		user: { ...user, role: 'admin', profile_image_url: '', permissions: {} } as never
	});
	useConfigStore.setState({ config: { features: { enable_plugins: true } } as never });
	vi.mocked(searchUsers).mockResolvedValue({ users: [], total: 2 });
	// An automocked API answers undefined; the pages chain .catch on some, so every call answers null instead.
	for (const api of [functionsApi, knowledgeApi, modelsApi, promptsApi, skillsApi, toolsApi])
		for (const fn of Object.values(api)) if (vi.isMockFunction(fn)) fn.mockResolvedValue(null);
});
afterEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: null, user: null });
});

describe.each(cases)('$name list', (c) => {
	it('with several accounts shows owners and a View filter that narrows the list (S4-D1)', async () => {
		c.seed(c.items);
		renderAt(c);
		await screen.findByText(c.item);
		const [view] = await screen.findAllByRole('button', { name: 'View: All' });
		expect(screen.getByText('Sam Rivera')).toBeInTheDocument();
		fireEvent.pointerDown(view, { button: 0, pointerType: 'mouse' });
		fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: 'Created by you' }));
		await waitFor(() => expect(localStorage.workspaceViewOption).toBe('created'));
	});

	it('walks the row menu, Delete last, and confirms a delete in plain words (#1012)', async () => {
		c.seed(c.items);
		vi.mocked(c.deleted() as () => unknown).mockResolvedValue(true);
		renderAt(c);
		await screen.findByText(c.item);
		if (c.switchName) fireEvent.click(screen.getByRole('switch', { name: c.switchName }));
		// ACT-4: a row's gear is named for the row; it opens that row's settings.
		const gear = screen.queryByRole('button', { name: `Settings for ${c.item}` });
		if (gear) {
			fireEvent.click(gear);
			fireEvent.keyDown(await screen.findByRole('dialog', { name: `Settings for ${c.item}` }), { key: 'Escape' });
			await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		}
		const open = async () => {
			fireEvent.pointerDown(screen.getAllByRole('button', { name: c.menu, exact: true } as never)[0], {
				button: 0,
				pointerType: 'mouse'
			});
			return screen.findByRole('menu');
		};
		const items = within(await open()).getAllByRole('menuitem');
		expect(items[items.length - 1]).toHaveAttribute('data-variant', 'destructive');
		// Every item but Edit and Clone (which leave the page), the Global switch and Delete runs here.
		for (const label of items.map((item) => item.textContent ?? '').slice(0, -1)) {
			if (/^Edit$|^Clone$|New chat|Global/.test(label)) continue;
			const menu = screen.queryByRole('menu') ?? (await open());
			fireEvent.click(within(menu).getByRole('menuitem', { name: label }));
			await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
			if (screen.queryByRole('dialog')) fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
		}
		fireEvent.click(within(await open()).getByRole('menuitem', { name: 'Delete' }));
		const dialog = await screen.findByRole('alertdialog');
		expect(within(dialog).getByRole('heading')).toHaveTextContent(`Delete “${c.item}”?`);
		fireEvent.click(within(dialog).getByRole('button', { name: c.confirm }));
		await waitFor(() => expect(c.deleted()).toHaveBeenCalled());
	});

	it('offers the first step when empty, and clears a filter that matched nothing (STA-3)', async () => {
		c.seed([]);
		renderAt(c);
		expect(await screen.findByRole('heading', { name: c.empty })).toBeVisible();
		fireEvent.click(screen.getByText(c.firstStep));

		cleanup();
		localStorage.workspaceViewOption = 'shared';
		renderAt(c);
		await waitFor(() => expect(screen.getByRole('heading', { name: 'Nothing matches these filters' })).toBeVisible());
		fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
		await waitFor(() => expect(screen.getByRole('heading', { name: c.empty })).toBeVisible());
		expect(localStorage.workspaceViewOption).toBe('');
	});
});

describe('code from elsewhere says where it came from (S4-D4)', () => {
	const toolCase = cases.find((c) => c.name === 'Tools') as Case;
	const functionCase = cases.find((c) => c.name === 'Functions') as Case;

	it.each([
		[toolCase, 'tool', () => vi.mocked(toolsApi.getToolById)],
		[functionCase, 'function', () => vi.mocked(functionsApi.getFunctionById)]
	] as const)('a cloned %s carries its source to the editor', async (c, key, getById) => {
		c.seed(c.items);
		getById().mockResolvedValue({ id: 'x', name: c.item, content: 'class Tools: pass', meta: {} } as never);
		renderAt(c);
		await screen.findByText(c.item);
		fireEvent.pointerDown(screen.getByRole('button', { name: c.menu }), { button: 0, pointerType: 'mouse' });
		fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Clone' }));
		expect(await screen.findByText('Elsewhere')).toBeVisible();
		expect(JSON.parse(sessionStorage[key]).source).toEqual({ kind: 'clone', from: c.item });
		sessionStorage.removeItem(key);
	});

	it.each([
		[toolCase, 'tool', () => vi.mocked(toolsApi.loadToolByUrl)],
		[functionCase, 'function', () => vi.mocked(functionsApi.loadFunctionByUrl)]
	] as const)('a %s imported from a link carries the link', async (c, key, load) => {
		c.seed(c.items);
		load().mockResolvedValue({ name: 'Fetched', content: 'x' } as never);
		renderAt(c);
		await screen.findByText(c.item);
		if (key === 'tool') {
			const action = useWorkspaceStore.getState().actions.find((a) => a.id === 'tools-import-link');
			act(() => void action?.onClick?.());
		} else {
			fireEvent.pointerDown(screen.getByRole('button', { name: 'Open create menu' }), {
				button: 0,
				pointerType: 'mouse'
			});
			fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Import from link' }));
		}
		const dialog = await screen.findByRole('dialog');
		fireEvent.change(within(dialog).getByLabelText('URL'), { target: { value: 'https://example.com/x.py' } });
		fireEvent.submit(within(dialog).getByLabelText('URL').closest('form') as HTMLFormElement);
		await waitFor(() =>
			expect(JSON.parse(sessionStorage[key] ?? '{}').source).toEqual({ kind: 'link', from: 'https://example.com/x.py' })
		);
		sessionStorage.removeItem(key);
	});
});
