import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createNewFunction, getFunctionList } from '@/lib/apis/functions';
import { usePageTitleStore } from '@/lib/ui/pageTitle';
import { FunctionsPage } from './FunctionsPage';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/apis/functions', async (original) => ({
	...(await original<object>()),
	getFunctionList: vi.fn(),
	createNewFunction: vi.fn()
}));

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

	it('says which function a refused import create was, with the server words behind Details (FBK-4)', async () => {
		vi.mocked(getFunctionList).mockResolvedValue([]);
		vi.mocked(createNewFunction)
			.mockRejectedValueOnce('Database is locked')
			.mockResolvedValueOnce({ id: 'b' } as never);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<TooltipProvider>
					<RouterProvider router={createMemoryRouter([{ path: '/', element: <FunctionsPage /> }])} />
				</TooltipProvider>
			</QueryClientProvider>
		);
		await waitFor(() => expect(document.getElementById('documents-import-input')).not.toBeNull());
		const input = document.getElementById('documents-import-input') as HTMLInputElement;
		const text = JSON.stringify([
			{ id: 'a', name: 'A', content: 'class Filter: pass' },
			{ id: 'b', name: 'B', content: 'class Filter: pass' }
		]);
		fireEvent.change(input, { target: { files: [new File([text], 'filters.json', { type: 'application/json' })] } });
		const dialog = await screen.findByRole('alertdialog');
		expect(within(dialog).getByRole('heading')).toHaveTextContent('Import functions?');
		expect(dialog).toHaveTextContent('The code comes from the file filters.json');
		fireEvent.click(within(dialog).getByRole('button', { name: 'Import functions' }));
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("Couldn't import “A”.", {
				description: expect.objectContaining({ props: { detail: 'Database is locked' } })
			})
		);
		expect(createNewFunction).toHaveBeenCalledTimes(2);
	});
});
