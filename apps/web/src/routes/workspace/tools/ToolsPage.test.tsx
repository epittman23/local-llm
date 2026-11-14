import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getToolList } from '@/lib/apis/tools';
import { useConfigStore } from '@/lib/stores/configStore';
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
		expect(document.title).toMatch(/^Tools \/ /);

		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(vi.mocked(getToolList).mock.calls.length).toBeGreaterThan(1);
	});
});
