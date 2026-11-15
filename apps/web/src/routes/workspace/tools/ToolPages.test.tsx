import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getToolById } from '@/lib/apis/tools';
import { ToolCreatePage, ToolEditPage } from './ToolPages';

vi.mock('@/lib/apis/tools', () => ({
	createNewTool: vi.fn(async () => ({})),
	getToolById: vi.fn(),
	updateToolById: vi.fn(),
	updateToolAccessGrants: vi.fn()
}));
vi.mock('@/lib/apis/users', () => ({ searchUsers: vi.fn(async () => ({ total: 1 })) }));
vi.mock('@/components/common/CodeEditor', () => ({ default: () => null }));

const open = (path: string, element: ReactNode, route = '/workspace/tools/edit') =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<RouterProvider
					router={createMemoryRouter(
						[
							{ path: route, element },
							{ path: '/workspace/tools', element: <p>Tools list</p> }
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

describe('ToolEditPage (#1095, NAV-3, STA-4)', () => {
	it('says in place that a tool no longer exists', async () => {
		vi.mocked(getToolById).mockRejectedValueOnce("We could not find what you're looking for :/");
		open('/workspace/tools/edit?id=gone', <ToolEditPage />);
		expect(await screen.findByRole('heading', { name: 'This tool no longer exists.' })).toBeInTheDocument();
	});

	it('offers to try again when the tool failed to load', async () => {
		vi.mocked(getToolById)
			.mockRejectedValueOnce('Internal error')
			.mockResolvedValueOnce({
				id: 't',
				name: 'T',
				meta: { description: 'd' },
				content: 'x',
				write_access: true
			} as never);
		open('/workspace/tools/edit?id=t', <ToolEditPage />);
		fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
		expect(await screen.findByLabelText('Tool name')).toHaveValue('T');
	});

	it('sends a tool this account may not edit back to the list, saying why', async () => {
		const error = vi.spyOn(toast, 'error');
		vi.mocked(getToolById).mockResolvedValueOnce({ id: 't', name: 'T', write_access: false } as never);
		open('/workspace/tools/edit?id=t', <ToolEditPage />);
		expect(await screen.findByText('Tools list')).toBeInTheDocument();
		expect(error).toHaveBeenCalledWith('You can open this tool but not edit it.');
	});
});

describe('ToolCreatePage (S4-D4)', () => {
	it('reads a stash and where its code came from, once', async () => {
		sessionStorage.tool = JSON.stringify({
			id: 'calc_clone',
			name: 'Calc (Clone)',
			meta: { description: 'd' },
			content: 'x = 1',
			source: { kind: 'clone', from: 'Calc' }
		});
		open('/workspace/tools/create', <ToolCreatePage />, '/workspace/tools/create');
		expect(await screen.findByLabelText('Tool name')).toHaveValue('Calc (Clone)');
		expect(sessionStorage.tool).toBeUndefined();
		fireEvent.click(screen.getByRole('button', { name: 'Create tool' }));
		expect(await screen.findByRole('alertdialog', { name: 'Create tool?' })).toHaveTextContent('copied from "Calc"');
	});
});
