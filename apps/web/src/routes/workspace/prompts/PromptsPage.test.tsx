import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createNewPrompt, getPromptItems } from '@/lib/apis/prompts';
import { usePageTitleStore } from '@/lib/ui/pageTitle';
import { PromptsPage } from './PromptsPage';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const prompt = {
	id: 'p1',
	name: 'Summarise a table',
	command: 'summarise',
	content: 'Summarise this table in three sentences.',
	is_active: true,
	write_access: true,
	created_at: 1_700_000_000,
	updated_at: 1_700_000_000,
	user: { name: 'Sam Rivera', email: 'sam@example.invalid' }
};

vi.mock('@/lib/apis/prompts', () => ({
	getPromptItems: vi.fn(),
	getPromptTags: vi.fn(async () => []),
	createNewPrompt: vi.fn(),
	deletePromptById: vi.fn(),
	togglePromptById: vi.fn()
}));

function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const router = createMemoryRouter(
		[
			{ path: '/workspace/prompts', element: <PromptsPage /> },
			{ path: '/workspace/prompts/:id', element: <p>Editing prompt</p> }
		],
		{ initialEntries: ['/workspace/prompts'] }
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

describe('PromptsPage', () => {
	afterEach(() => vi.mocked(getPromptItems).mockReset());

	it('shows a failed load in place, with no spinner and no toast, and loads on Try again (STA-4)', async () => {
		vi.mocked(getPromptItems)
			.mockRejectedValueOnce('Database is locked')
			.mockResolvedValue({ items: [prompt], total: 1 });
		renderPage();

		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load prompts");
		expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
		expect(screen.queryByText('No prompts yet')).toBeNull();
		expect(toast.error).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByText('Summarise a table')).toBeInTheDocument();
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('names the tab', async () => {
		vi.mocked(getPromptItems).mockResolvedValue({ items: [prompt], total: 1 });
		renderPage();
		await screen.findByText('Summarise a table');
		expect(usePageTitleStore.getState().dynamic).toBe('Prompts');
	});

	it('opens a prompt from a row button that holds no other control (ACT-7)', async () => {
		vi.mocked(getPromptItems).mockResolvedValue({ items: [prompt], total: 1 });
		const router = renderPage();
		await screen.findByText('Summarise a table');

		const rows = document.querySelectorAll('[data-slot="row-button"]');
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.querySelector('button, a, input, [role="switch"], [tabindex]')).toBeNull();
		// The controls are still in the row, beside the button.
		const container = row.parentElement as HTMLElement;
		expect(container.querySelector('[role="switch"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Prompt Menu"]')).not.toBeNull();

		fireEvent.click(row);
		await waitFor(() => expect(router.state.location.pathname).toBe('/workspace/prompts/p1'));
	});
});

describe('PromptsPage rows and delete', () => {
	afterEach(() => vi.mocked(getPromptItems).mockReset());

	it('shows the command once-slashed on line 2, names the switch, and confirms a delete by name (#908, #1097, #1012)', async () => {
		vi.mocked(getPromptItems).mockResolvedValue({ items: [{ ...prompt, command: '/summarise' }], total: 1 });
		renderPage();
		await screen.findByText('Summarise a table');
		expect(screen.getByText('/summarise')).toHaveClass('font-mono');
		expect(screen.getByRole('switch', { name: 'Enable Summarise a table' })).toBeChecked();

		fireEvent.pointerDown(screen.getByRole('button', { name: 'Prompt Menu' }), { button: 0, pointerType: 'mouse' });
		const menu = await screen.findByRole('menu');
		expect(within(menu).getByRole('menuitem', { name: 'Copy prompt' })).toHaveClass('sm:hidden');
		fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }));
		const dialog = await screen.findByRole('alertdialog');
		expect(within(dialog).getByRole('heading')).toHaveTextContent('Delete “Summarise a table”?');
		expect(dialog).toHaveTextContent('/summarise stops working.');
		expect(within(dialog).getByRole('button', { name: 'Delete prompt' })).toBeVisible();
	});

	it('offers New prompt on a fresh install (STA-3)', async () => {
		vi.mocked(getPromptItems).mockResolvedValue({ items: [], total: 0 });
		renderPage();
		expect(await screen.findByRole('heading', { name: 'No prompts yet' })).toBeVisible();
		fireEvent.click(screen.getByRole('button', { name: 'New prompt' }));
		expect(await screen.findByRole('dialog')).toBeVisible();
	});

	it('says a created prompt plainly and closes the dialog (#1095)', async () => {
		vi.mocked(getPromptItems).mockResolvedValue({ items: [], total: 0 });
		vi.mocked(createNewPrompt).mockResolvedValueOnce({ id: 'p9' });
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'New prompt' }));
		const dialog = await screen.findByRole('dialog');
		fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Summarise' } });
		fireEvent.change(within(dialog).getByLabelText('Command'), { target: { value: 'summarise' } });
		fireEvent.change(within(dialog).getByLabelText('Prompt Content'), { target: { value: 'Summarise this.' } });
		fireEvent.submit(within(dialog).getByLabelText('Name').closest('form') as HTMLFormElement);
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Prompt created'));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('throws a failed create to the dialog, which says it and stays open (#1095)', async () => {
		vi.mocked(getPromptItems).mockResolvedValue({ items: [], total: 0 });
		vi.mocked(createNewPrompt).mockRejectedValueOnce('Command already in use');
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'New prompt' }));
		const dialog = await screen.findByRole('dialog');
		fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Summarise' } });
		fireEvent.change(within(dialog).getByLabelText('Command'), { target: { value: 'summarise' } });
		fireEvent.change(within(dialog).getByLabelText('Prompt Content'), { target: { value: 'Summarise this.' } });
		fireEvent.submit(within(dialog).getByLabelText('Name').closest('form') as HTMLFormElement);
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Command already in use'));
		expect(toast.success).not.toHaveBeenCalled();
		expect(screen.getByRole('dialog')).toBeVisible();
	});
});
