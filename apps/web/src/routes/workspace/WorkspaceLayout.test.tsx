import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useWorkspaceStore } from '@/lib/stores/workspaceStore';
import { countLabel, WorkspaceLayout } from './WorkspaceLayout';

const apis = vi.hoisted(() => ({
	getModelItems: vi.fn(),
	searchKnowledgeBases: vi.fn(),
	getPromptItems: vi.fn(),
	getSkillItems: vi.fn(),
	getToolList: vi.fn()
}));
vi.mock('@/lib/apis/models', () => ({ getModelItems: apis.getModelItems }));
vi.mock('@/lib/apis/knowledge', () => ({ searchKnowledgeBases: apis.searchKnowledgeBases }));
vi.mock('@/lib/apis/prompts', () => ({ getPromptItems: apis.getPromptItems }));
vi.mock('@/lib/apis/skills', () => ({ getSkillItems: apis.getSkillItems }));
vi.mock('@/lib/apis/tools', () => ({ getToolList: apis.getToolList }));

function renderAt(path: string) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const router = createMemoryRouter(
		[
			{
				path: '/workspace',
				element: <WorkspaceLayout />,
				children: [
					{ path: 'models', element: <p>models page</p> },
					{ path: 'tools', element: <p>tools page</p> },
					{ path: 'models/edit', element: <p>model editor</p> },
					{ path: 'prompts/:id', element: <p>prompt editor</p> }
				]
			},
			{ path: '/', element: <p>home</p> }
		],
		{ initialEntries: [path] }
	);
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
	return { client, router };
}

const tab = (name: string) => screen.getByRole('link', { name: new RegExp(`^${name}`) });

beforeEach(() => {
	useAuthStore.setState({
		status: 'authenticated',
		token: 't',
		user: { id: 'u1', name: 'Ada', role: 'admin' }
	} as never);
	useConfigStore.setState({ config: { name: 'local-llm', version: '0', features: { enable_plugins: true } } });
	useWorkspaceStore.setState({
		counts: { models: null, knowledge: null, prompts: null, skills: null, tools: null },
		actions: []
	});
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe('countLabel (DAT-2)', () => {
	it('writes a missing count as an en dash, never 0', () => {
		expect(countLabel(null)).toBe('–');
		expect(countLabel(undefined)).toBe('–');
		expect(countLabel(0)).toBe('0');
		expect(countLabel(1234)).toBe('1.2k');
	});
});

describe('WorkspaceLayout', () => {
	it('opens with the Workspace heading and its tab strip, the open tab current', async () => {
		apis.getModelItems.mockResolvedValue({ total: 3 });
		renderAt('/workspace/models');
		expect(screen.getByRole('heading', { level: 1, name: 'Workspace' })).toBeInTheDocument();
		expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeInTheDocument();
		expect(tab('Models').getAttribute('aria-current')).toBe('page');
		expect(screen.getByText('models page')).toBeInTheDocument();
	});

	it('gives an editor the height on a phone: the header and tabs hide below sm, the h1 stays for screen readers (LAY-4)', () => {
		renderAt('/workspace/models/edit?id=m');
		const nav = screen.getByRole('navigation', { name: 'Workspace' });
		expect(nav.closest('.max-sm\\:hidden')).not.toBeNull();
		expect(document.querySelector('h1.sr-only')).toHaveTextContent('Workspace');
		cleanup();
		renderAt('/workspace/prompts/p1');
		expect(screen.getByRole('navigation', { name: 'Workspace' }).closest('.max-sm\\:hidden')).not.toBeNull();
		cleanup();
		renderAt('/workspace/models');
		expect(screen.getByRole('navigation', { name: 'Workspace' }).closest('.max-sm\\:hidden')).toBeNull();
		expect(document.querySelector('h1.sr-only')).toBeNull();
	});

	it('shows an en dash for every count while they load, not 0 (STA-2)', () => {
		for (const fn of Object.values(apis)) fn.mockReturnValue(new Promise(() => {}));
		renderAt('/workspace/models');
		for (const name of ['Models', 'Knowledge', 'Prompts', 'Skills', 'Tools'])
			expect(tab(name).textContent).toBe(`${name}–`);
	});

	it('shows the counts once loaded, and an en dash for one that failed', async () => {
		apis.getModelItems.mockResolvedValue({ total: 3 });
		apis.searchKnowledgeBases.mockResolvedValue({ total: 0 });
		apis.getPromptItems.mockRejectedValue(new Error('offline'));
		apis.getSkillItems.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
		apis.getToolList.mockResolvedValue(null);
		renderAt('/workspace/models');
		await waitFor(() => expect(tab('Models').textContent).toBe('Models3'));
		expect(tab('Knowledge').textContent).toBe('Knowledge0');
		expect(tab('Prompts').textContent).toBe('Prompts–');
		expect(tab('Skills').textContent).toBe('Skills2');
		expect(tab('Tools').textContent).toBe('Tools–');
		expect(useWorkspaceStore.getState().counts.models).toBe(3);
	});

	it('fetches the counts again when they are invalidated (reconnecting)', async () => {
		apis.getModelItems.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ total: 5 });
		const { client } = renderAt('/workspace/models');
		await waitFor(() => expect(apis.getModelItems).toHaveBeenCalledTimes(1));
		expect(tab('Models').textContent).toBe('Models–');
		await act(() => client.invalidateQueries({ queryKey: ['workspace-counts'] }));
		await waitFor(() => expect(tab('Models').textContent).toBe('Models5'));
	});

	it('shows a skeleton, not "Loading…", until the session settles', () => {
		useConfigStore.setState({ config: null });
		renderAt('/workspace/models');
		expect(screen.getByRole('status').textContent).toBe('Loading the workspace');
		expect(screen.queryByText('Loading…')).toBeNull();
	});

	it('sends someone who may not see a section home', async () => {
		useAuthStore.setState({
			status: 'authenticated',
			token: 't',
			user: { id: 'u2', role: 'user', permissions: {} }
		} as never);
		const { router } = renderAt('/workspace/tools');
		await waitFor(() => expect(router.state.location.pathname).toBe('/'));
	});
});
