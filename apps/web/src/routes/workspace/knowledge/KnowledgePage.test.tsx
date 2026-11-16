import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createNewKnowledge, deleteKnowledgeById, searchKnowledgeBases } from '@/lib/apis/knowledge';
import { useAuthStore } from '@/lib/stores/authStore';
import { KnowledgePage } from './KnowledgePage';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/knowledge', async (original) => ({
	...(await original<object>()),
	searchKnowledgeBases: vi.fn(),
	deleteKnowledgeById: vi.fn(),
	createNewKnowledge: vi.fn()
}));

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

describe('KnowledgePage create and delete (#1011, #1012, STA-3)', () => {
	beforeAll(() => {
		vi.stubGlobal(
			'IntersectionObserver',
			class {
				observe() {}
				disconnect() {}
			}
		);
	});

	it('offers New knowledge base on a fresh install; the dialog says the same and asks for a name at the field', async () => {
		vi.mocked(searchKnowledgeBases).mockResolvedValue({ items: [], total: 0 });
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'New knowledge base' }));
		const dialog = await screen.findByRole('dialog', { name: 'New knowledge base' });
		expect(within(dialog).getByLabelText('Description (optional)')).toBeVisible();
		fireEvent.click(within(dialog).getByRole('button', { name: 'Create knowledge base' }));
		const name = within(dialog).getByLabelText('Name');
		expect(name).toHaveAttribute('aria-invalid', 'true');
		expect(within(dialog).getByText('Give the knowledge base a name.')).toBeVisible();
		expect(toast.error).not.toHaveBeenCalled();
		fireEvent.change(name, { target: { value: 'Textbooks' } });
		expect(name).not.toHaveAttribute('aria-invalid');

		vi.mocked(createNewKnowledge).mockResolvedValueOnce({ id: 'kb9' });
		fireEvent.click(within(dialog).getByRole('button', { name: 'Create knowledge base' }));
		await waitFor(() => expect(createNewKnowledge).toHaveBeenCalledWith(expect.anything(), 'Textbooks', '', []));
		expect(toast.success).toHaveBeenCalledWith('Knowledge base created');
		expect(await screen.findByText('Opened')).toBeVisible();
	});

	it('confirms a delete by name, saying how many files and their embeddings go', async () => {
		vi.mocked(searchKnowledgeBases).mockResolvedValue({ items: [base('kb1', 'Textbooks')], total: 1 });
		renderPage();
		await screen.findByText('Textbooks');
		fireEvent.pointerDown(screen.getByRole('button', { name: 'More Options' }), { button: 0, pointerType: 'mouse' });
		const menu = await screen.findByRole('menu');
		fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }));
		const confirm = await screen.findByRole('alertdialog');
		expect(within(confirm).getByRole('heading')).toHaveTextContent('Delete “Textbooks”?');
		expect(confirm).toHaveTextContent('Its 2 files, their extracted text and embeddings are deleted.');
		vi.mocked(deleteKnowledgeById).mockRejectedValueOnce({ detail: 'Database is locked' });
		fireEvent.click(within(confirm).getByRole('button', { name: 'Delete knowledge base' }));
		// FBK-4: plain words naming it, the server's own words as the detail.
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("Couldn't delete “Textbooks”.", {
				// FBK-4: the server's words sit behind Details.
				description: expect.objectContaining({ props: { detail: 'Database is locked' } })
			})
		);
	});
});
