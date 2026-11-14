import { usePageTitleStore } from '@/lib/ui/pageTitle';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getFunctionList } from '@/lib/apis/functions';
import { FunctionsPage } from './FunctionsPage';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/functions', async (original) => ({ ...(await original<object>()), getFunctionList: vi.fn() }));

describe('FunctionsPage', () => {
	it('shows a failed load in place of the list, with no toast, and names the tab (STA-4)', async () => {
		vi.mocked(getFunctionList).mockRejectedValue('Database is locked');
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<TooltipProvider>
					<RouterProvider router={createMemoryRouter([{ path: '/', element: <FunctionsPage /> }])} />
				</TooltipProvider>
			</QueryClientProvider>
		);

		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load functions");
		expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
		expect(toast.error).not.toHaveBeenCalled();
		expect(usePageTitleStore.getState().dynamic).toBe('Functions');

		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(vi.mocked(getFunctionList).mock.calls.length).toBeGreaterThan(1);
	});
});
