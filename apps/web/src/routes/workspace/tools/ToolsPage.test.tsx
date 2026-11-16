import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getToolList } from '@/lib/apis/tools';
import { useConfigStore } from '@/lib/stores/configStore';
import { useWorkspaceStore } from '@/lib/stores/workspaceStore';
import { usePageTitleStore } from '@/lib/ui/pageTitle';
import { ToolsPage } from './ToolsPage';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/tools', async (original) => ({ ...(await original<object>()), getToolList: vi.fn() }));

describe('ToolsPage', () => {
	it('shows a failed load in place of the list, with no toast, and names the tab (STA-4)', async () => {
		vi.mocked(getToolList).mockRejectedValue('Database is locked');
		useConfigStore.setState({ config: { features: { enable_plugins: true } } as never });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<TooltipProvider>
					<RouterProvider router={createMemoryRouter([{ path: '/', element: <ToolsPage /> }])} />
				</TooltipProvider>
			</QueryClientProvider>
		);

		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load tools");
		expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
		expect(toast.error).not.toHaveBeenCalled();
		expect(usePageTitleStore.getState().dynamic).toBe('Tools');

		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(vi.mocked(getToolList).mock.calls.length).toBeGreaterThan(1);
	});

	const renderRows = () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const router = createMemoryRouter(
			[
				{ path: '/workspace/tools', element: <ToolsPage /> },
				{ path: '*', element: <p>Elsewhere</p> }
			],
			{ initialEntries: ['/workspace/tools'] }
		);
		render(
			<QueryClientProvider client={client}>
				<TooltipProvider>
					<RouterProvider router={router} />
				</TooltipProvider>
			</QueryClientProvider>
		);
		return router;
	};

	it('opens a tool from a row button beside its controls, and gives a read-only tool none (ACT-7)', async () => {
		useConfigStore.setState({ config: { features: { enable_plugins: true } } as never });
		const tool = (id: string, name: string, writeAccess: boolean) => ({
			id,
			name,
			write_access: writeAccess,
			updated_at: 1_700_000_000,
			meta: { description: `About ${name}` },
			user: { name: 'Sam Rivera', email: 'sam@example.invalid' }
		});
		vi.mocked(getToolList).mockResolvedValue([
			tool('unit_convert', 'Unit converter', true),
			tool('shared', 'Shared calculator', false)
		] as never);
		const router = renderRows();
		await screen.findByText('Shared calculator');

		const rows = document.querySelectorAll('[data-slot="row-button"]');
		expect(rows).toHaveLength(1);
		expect(rows[0]).toHaveTextContent('Unit converter');
		expect(rows[0].querySelector('button, a, input, [role="switch"], [tabindex]')).toBeNull();
		expect(document.querySelector('div[role="button"]')).toBeNull();
		expect((rows[0].parentElement as HTMLElement).querySelector('[aria-label="Tool Menu"]')).not.toBeNull();
		// The read-only row is plain content: nothing in it takes focus.
		const readOnly = screen.getByText('Shared calculator').closest('.group') as HTMLElement;
		expect(readOnly.querySelector('button, a, [tabindex]')).toBeNull();

		fireEvent.click(rows[0]);
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/tools/edit'));
		expect(router.state.location.search).toBe('?id=unit_convert');
	});
});

describe('ToolsPage counts and empty states', () => {
	const renderList = () => {
		useConfigStore.setState({ config: { features: { enable_plugins: true } } as never });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const router = createMemoryRouter(
			[
				{ path: '/workspace/tools', element: <ToolsPage /> },
				{ path: '*', element: <p>Elsewhere</p> }
			],
			{ initialEntries: ['/workspace/tools'] }
		);
		render(
			<QueryClientProvider client={client}>
				<TooltipProvider>
					<RouterProvider router={router} />
				</TooltipProvider>
			</QueryClientProvider>
		);
		return router;
	};
	const tool = (id: string, name: string) => ({ id, name, write_access: true, updated_at: 1_700_000_000, meta: {} });

	it('counts every tool in the tab while a search narrows the list (#955)', async () => {
		vi.mocked(getToolList).mockResolvedValue([tool('a', 'Calculator'), tool('b', 'Web lookup')]);
		renderList();
		await screen.findByText('Calculator');
		fireEvent.change(screen.getByRole('textbox', { name: 'Search Tools' }), { target: { value: 'calc' } });
		expect(await screen.findByText('1 of 2 tools')).toBeVisible();
		expect(useWorkspaceStore.getState().counts.tools).toBe(2);
	});

	it('offers New tool on a fresh install (STA-3)', async () => {
		vi.mocked(getToolList).mockResolvedValue([]);
		const router = renderList();
		expect(await screen.findByRole('heading', { name: 'No tools yet' })).toBeVisible();
		fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/tools/create'));
	});

	it('confirms a JSON import by naming the file the code came from (S4-D4)', async () => {
		vi.mocked(getToolList).mockResolvedValue([tool('a', 'Calculator')]);
		renderList();
		await screen.findByText('Calculator');
		const input = document.getElementById('documents-import-input') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [new File(['[]'], 'tools.json', { type: 'application/json' })] } });
		const dialog = await screen.findByRole('alertdialog');
		expect(within(dialog).getByRole('heading')).toHaveTextContent('Import tools?');
		expect(dialog).toHaveTextContent('The code comes from the file tools.json');
		expect(within(dialog).getByRole('button', { name: 'Import tools' })).toBeVisible();
	});
});
