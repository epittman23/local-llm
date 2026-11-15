import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getFunctionList } from '@/lib/apis/functions';
import { FunctionsPage } from './FunctionsPage';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/functions', async (original) => ({ ...(await original<object>()), getFunctionList: vi.fn() }));

describe('FunctionsPage rows', () => {
	it('opens a function from a row button that holds no other control (ACT-7)', async () => {
		vi.mocked(getFunctionList).mockResolvedValue([
			{
				id: 'rate_limit',
				name: 'Rate limit filter',
				type: 'filter',
				updated_at: 1_700_000_000,
				is_active: true,
				is_global: false,
				meta: { description: 'Limits requests per minute' },
				user: { name: 'Sam Rivera', email: 'sam@example.invalid' }
			}
		] as never);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const router = createMemoryRouter(
			[
				{ path: '/admin/functions', element: <FunctionsPage /> },
				{ path: '*', element: <p>Elsewhere</p> }
			],
			{ initialEntries: ['/admin/functions'] }
		);
		render(
			<QueryClientProvider client={client}>
				<TooltipProvider>
					<RouterProvider router={router} />
				</TooltipProvider>
			</QueryClientProvider>
		);
		await screen.findByText('Rate limit filter');

		const rows = document.querySelectorAll('[data-slot="row-button"]');
		expect(rows).toHaveLength(1);
		expect(rows[0].querySelector('button, a, input, [role="switch"], [tabindex]')).toBeNull();
		expect(document.querySelector('div[role="button"]')).toBeNull();
		const container = rows[0].parentElement as HTMLElement;
		expect(container.querySelector('[role="switch"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Function Menu"]')).not.toBeNull();

		fireEvent.click(rows[0]);
		await waitFor(() => expect(router.state.location.pathname).toBe('/admin/functions/edit'));
		expect(router.state.location.search).toBe('?id=rate_limit');
	});
});
