import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createNewFunction, getFunctionById, updateFunctionById } from '@/lib/apis/functions';
import { FunctionCreatePage, FunctionEditPage } from './FunctionPages';

vi.mock('@/lib/apis/functions', () => ({
	createNewFunction: vi.fn(async () => ({})),
	getFunctionById: vi.fn(),
	updateFunctionById: vi.fn(async () => ({}))
}));
vi.mock('@/components/common/CodeEditor', () => ({ default: () => null }));

const open = (path: string, route: string, element: ReactNode) =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<RouterProvider
					router={createMemoryRouter(
						[
							{ path: route, element },
							{ path: '/admin/functions', element: <p>Functions list</p> }
						],
						{ initialEntries: [path] }
					)}
				/>
			</TooltipProvider>
		</QueryClientProvider>
	);

afterEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
});

describe('FunctionCreatePage (S4-D4, #905)', () => {
	it('creates an imported function after the acknowledgement naming its link, then returns to the list', async () => {
		const success = vi.spyOn(toast, 'success');
		sessionStorage.function = JSON.stringify({
			id: 'f',
			name: 'F',
			meta: { description: 'd' },
			content: 'class Filter: pass',
			source: { kind: 'link', from: 'https://example.com/f.py' }
		});
		open('/admin/functions/create', '/admin/functions/create', <FunctionCreatePage />);
		fireEvent.click(await screen.findByRole('button', { name: 'Create function' }));
		const ack = await screen.findByRole('alertdialog', { name: 'Create function?' });
		expect(ack).toHaveTextContent('https://example.com/f.py');
		fireEvent.click(screen.getAllByRole('button', { name: 'Create function' }).at(-1) as HTMLElement);
		expect(await screen.findByText('Functions list')).toBeInTheDocument();
		expect(createNewFunction).toHaveBeenCalledOnce();
		expect(success).toHaveBeenCalledWith('Function created');
	});
});

describe('FunctionEditPage (#905)', () => {
	it('saves changes and stays', async () => {
		vi.mocked(getFunctionById).mockResolvedValue({
			id: 'f',
			name: 'F',
			meta: { description: 'd' },
			content: 'x'
		} as never);
		open('/admin/functions/edit?id=f', '/admin/functions/edit', <FunctionEditPage />);
		fireEvent.change(await screen.findByLabelText('Function name'), { target: { value: 'G' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
		await waitFor(() => expect(updateFunctionById).toHaveBeenCalledOnce());
		expect(await screen.findByText('All changes saved')).toBeInTheDocument();
	});
});

describe('FunctionEditPage when the function cannot be loaded (#1095, NAV-3, STA-4)', () => {
	it('says in place that a function no longer exists', async () => {
		vi.mocked(getFunctionById).mockRejectedValueOnce("We could not find what you're looking for :/");
		open('/admin/functions/edit?id=gone', '/admin/functions/edit', <FunctionEditPage />);
		expect(await screen.findByRole('heading', { name: 'This function no longer exists.' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Functions' })).toHaveAttribute('href', '/admin/functions');
	});

	it('offers to try again when the function failed to load', async () => {
		vi.mocked(getFunctionById)
			.mockRejectedValueOnce('Internal error')
			.mockResolvedValueOnce({ id: 'f', name: 'F', meta: { description: 'd' }, content: 'x' } as never);
		open('/admin/functions/edit?id=f', '/admin/functions/edit', <FunctionEditPage />);
		fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
		await waitFor(() => expect(getFunctionById).toHaveBeenCalledTimes(2));
		expect(await screen.findByLabelText('Function name')).toHaveValue('F');
	});

	it('offers to try again on an empty answer, as the tool page does', async () => {
		vi.mocked(getFunctionById).mockResolvedValueOnce(null as never);
		open('/admin/functions/edit?id=f', '/admin/functions/edit', <FunctionEditPage />);
		expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
	});
});
