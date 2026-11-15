import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getModelItems } from '@/lib/apis/models';
import { ModelsPage } from './ModelsPage';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/apis/models', async (original) => ({
	...(await original<object>()),
	getModelItems: vi.fn(),
	getModelTags: vi.fn(async () => [])
}));

const model = (id: string, name: string, writeAccess: boolean) => ({
	id,
	name,
	base_model_id: 'qwen/qwen3.6-27b',
	is_active: true,
	write_access: writeAccess,
	updated_at: 1_700_000_000,
	meta: { description: `About ${name}` },
	user: { name: 'Sam Rivera', email: 'sam@example.invalid' }
});

function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const router = createMemoryRouter(
		[
			{ path: '/workspace/models', element: <ModelsPage /> },
			{ path: '*', element: <p>Elsewhere</p> }
		],
		{ initialEntries: ['/workspace/models'] }
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

describe('ModelsPage rows', () => {
	it('opens a model from a row button that holds no other control (ACT-7)', async () => {
		vi.mocked(getModelItems).mockResolvedValue({ items: [model('tutor', 'Statistics tutor', true)], total: 1 });
		const router = renderPage();
		await screen.findByText('Statistics tutor');

		const rows = document.querySelectorAll('[data-slot="row-button"]');
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.querySelector('button, a, input, [role="switch"], [tabindex]')).toBeNull();
		expect(document.querySelector('div[role="button"]')).toBeNull();
		// The controls are beside the button, in row then control order.
		const container = row.parentElement as HTMLElement;
		expect(container.id).toBe('model-item-tutor');
		const controls = [...container.querySelectorAll('a, button, [role="switch"]')];
		expect(controls[0]).toBe(row);
		expect(controls.map((c) => c.getAttribute('aria-label')).slice(1)).toEqual([
			'New chat with Statistics tutor',
			'Model Menu',
			'Enabled'
		]);

		fireEvent.click(row);
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/models/edit'));
		expect(router.state.location.search).toBe('?id=tutor');
	});

	it('keeps the new-chat link beside the row, and opens nothing from a read-only row', async () => {
		vi.mocked(getModelItems).mockResolvedValue({ items: [model('shared', 'Shared reviewer', false)], total: 1 });
		renderPage();
		await screen.findByText('Shared reviewer');

		expect(document.querySelector('[data-slot="row-button"]')).toBeNull();
		expect(screen.getByText('Read Only')).toBeInTheDocument();
		const link = screen.getByRole('link', { name: 'New chat with Shared reviewer' });
		expect(link.getAttribute('href')).toBe('/?model=shared');
		expect(screen.queryByRole('switch')).toBeNull();
	});
});
