import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getSkillItems } from '@/lib/apis/skills';
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
		expect(document.title).toMatch(/^Skills \/ /);

		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(vi.mocked(getSkillItems).mock.calls.length).toBeGreaterThan(1);
	});
});
