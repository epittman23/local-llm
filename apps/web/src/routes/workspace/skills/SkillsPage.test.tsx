import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getSkillItems } from '@/lib/apis/skills';
import { usePageTitleStore } from '@/lib/ui/pageTitle';
import { SkillsPage } from './SkillsPage';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/skills', async (original) => ({ ...(await original<object>()), getSkillItems: vi.fn() }));

describe('SkillsPage', () => {
	it('shows a failed load in place of the list, with no toast, and names the tab (STA-4)', async () => {
		vi.mocked(getSkillItems).mockRejectedValue('Database is locked');
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<TooltipProvider>
					<RouterProvider router={createMemoryRouter([{ path: '/', element: <SkillsPage /> }])} />
				</TooltipProvider>
			</QueryClientProvider>
		);

		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load skills");
		expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
		expect(toast.error).not.toHaveBeenCalled();
		expect(usePageTitleStore.getState().dynamic).toBe('Skills');

		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(vi.mocked(getSkillItems).mock.calls.length).toBeGreaterThan(1);
	});

	const renderRows = () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const router = createMemoryRouter(
			[
				{ path: '/workspace/skills', element: <SkillsPage /> },
				{ path: '*', element: <p>Elsewhere</p> }
			],
			{ initialEntries: ['/workspace/skills'] }
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

	it('opens a skill from a row button that holds no other control (ACT-7)', async () => {
		vi.mocked(getSkillItems).mockResolvedValue({
			items: [
				{
					id: 'tidy-data',
					name: 'Tidy data',
					description: 'One observation per row',
					is_active: true,
					write_access: true,
					created_at: 1_700_000_000,
					updated_at: 1_700_000_000,
					user: { name: 'Sam Rivera', email: 'sam@example.invalid' }
				}
			],
			total: 1
		} as never);
		const router = renderRows();
		await screen.findByText('Tidy data');

		const rows = document.querySelectorAll('[data-slot="row-button"]');
		expect(rows).toHaveLength(1);
		expect(rows[0].querySelector('button, a, input, [role="switch"], [tabindex]')).toBeNull();
		expect(document.querySelector('div[role="button"]')).toBeNull();
		const controls = [...(rows[0].parentElement as HTMLElement).querySelectorAll('button, [role="switch"]')];
		expect(controls[0]).toBe(rows[0]);
		expect(controls.length).toBeGreaterThan(1);

		fireEvent.click(rows[0]);
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/skills/edit'));
		expect(router.state.location.search).toBe('?id=tidy-data');
	});
});
