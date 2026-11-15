import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { searchKnowledgeBases } from '@/lib/apis/knowledge';
import { useAuthStore } from '@/lib/stores/authStore';
import { KnowledgePage } from './KnowledgePage';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/knowledge', async (original) => ({ ...(await original<object>()), searchKnowledgeBases: vi.fn() }));

const base = (id: string, name: string, o: Record<string, unknown> = {}) => ({
	id,
	name,
	description: `About ${name}`,
	updated_at: 1_700_000_000,
	file_count: 2,
	write_access: true,
	access_grants: [],
	meta: null,
	user: { name: 'Sam Rivera', email: 'sam@example.invalid' },
	...o
});

function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const router = createMemoryRouter(
		[
			{ path: '/workspace/knowledge', element: <KnowledgePage /> },
			{ path: '/workspace/knowledge/:id', element: <p>Opened</p> }
		],
		{ initialEntries: ['/workspace/knowledge'] }
	);
	render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return router;
}

describe('KnowledgePage rows', () => {
	beforeAll(() => {
		vi.stubGlobal(
			'IntersectionObserver',
			class {
				observe() {}
				disconnect() {}
			}
		);
	});

	it('opens a knowledge base from a row button that holds no other control (ACT-7)', async () => {
		useAuthStore.setState({ user: { id: 'u1', role: 'user' } as never });
		vi.mocked(searchKnowledgeBases).mockImplementation(async (_t, _q, _v, page) =>
			page === 1
				? { items: [base('kb1', 'Course notes'), base('kb2', 'Handbook', { write_access: false })], total: 2 }
				: { items: [], total: 2 }
		);
		const router = renderPage();
		await screen.findByText('Course notes');

		const rows = [...document.querySelectorAll('[data-slot="row-button"]')];
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row.querySelector('button, a, input, [role="switch"], [tabindex]')).toBeNull();
		expect(document.querySelector('div[role="button"]')).toBeNull();
		// The menu sits beside the button of a base the person may change, and not on one they may not.
		expect(rows[0].parentElement?.querySelector('[aria-label="More Options"]')).not.toBeNull();
		expect(rows[1].parentElement?.querySelector('[aria-label="More Options"]')).toBeNull();

		fireEvent.click(rows[0]);
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/knowledge/kb1'));
	});

	it('explains why a single document cannot be opened', async () => {
		useAuthStore.setState({ user: { id: 'u1', role: 'user' } as never });
		vi.mocked(searchKnowledgeBases).mockImplementation(async (_t, _q, _v, page) =>
			page === 1
				? { items: [base('doc1', 'Loose file', { meta: { document: true } })], total: 1 }
				: { items: [], total: 1 }
		);
		const router = renderPage();
		fireEvent.click((await screen.findByText('Loose file')).closest('[data-slot="row-button"]') as HTMLElement);
		expect(toast.error).toHaveBeenCalled();
		expect(router.state.location.pathname).toBe('/workspace/knowledge');
	});
});
