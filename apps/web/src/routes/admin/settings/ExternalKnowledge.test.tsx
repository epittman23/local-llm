import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toastFailure } from '@/components/common/failureToast';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
	createExternalKnowledgeSource,
	getExternalKnowledgeConnections,
	searchKnowledgeBases,
	testExternalKnowledgeSource,
	updateExternalKnowledgeConnection,
	updateExternalKnowledgeSource
} from '@/lib/apis/knowledge';
import { useAuthStore } from '@/lib/stores/authStore';
import { ExternalKnowledge } from './ExternalKnowledge';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/components/common/failureToast', () => ({ toastFailure: vi.fn() }));
vi.mock('@/components/common/AccessControl', () => ({ AccessControl: () => <div>access control</div> }));
const visibility = vi.hoisted(() => ({ single: false }));
vi.mock('@/routes/admin/adminVisibility', () => ({ useAdminSingleUser: () => visibility.single }));
vi.mock('@/lib/apis/knowledge', () => ({
	createExternalKnowledgeSource: vi.fn(),
	getExternalKnowledgeConnections: vi.fn(),
	searchKnowledgeBases: vi.fn(),
	testExternalKnowledgeSource: vi.fn(),
	updateExternalKnowledgeConnection: vi.fn(),
	updateExternalKnowledgeSource: vi.fn()
}));

const CONNECTION = { id: 'c1', name: 'Q', provider: 'qdrant', endpoint: 'https://q.example.com', enabled: true };
const ITEM = {
	id: 'k1',
	name: 'Research',
	meta: { external: { connection_id: 'c1', provider: 'qdrant', source: { name: 'docs' } } }
};

beforeEach(() => {
	visibility.single = false;
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'tok' } as never);
	vi.mocked(getExternalKnowledgeConnections).mockResolvedValue({ items: [CONNECTION] } as never);
	vi.mocked(searchKnowledgeBases).mockResolvedValue({ items: [ITEM] } as never);
});

const renderList = async () => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<ExternalKnowledge />
			</TooltipProvider>
		</QueryClientProvider>
	);
	await screen.findByRole('button', { name: 'Configure Research' });
};

describe('ExternalKnowledge', () => {
	it('opens the edit dialog from a source configure button', async () => {
		await renderList();
		fireEvent.click(screen.getByRole('button', { name: 'Configure Research' }));
		expect(await screen.findByRole('heading', { name: 'Edit knowledge source' })).toBeTruthy();
		expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Research');
	});

	it('shows who may search a source while there is more than one account, and not for one (S5-D2)', async () => {
		await renderList();
		fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
		expect(await screen.findByText('access control')).toBeInTheDocument();
		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		visibility.single = true;
		fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
		await screen.findByRole('heading', { name: 'Add knowledge source' });
		expect(screen.queryByText('access control')).toBeNull();
	});

	it('opens a blank add dialog from Add source, on the shared fields (#933)', async () => {
		await renderList();
		fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
		expect(await screen.findByRole('heading', { name: 'Add knowledge source' })).toBeTruthy();
		const name = screen.getByLabelText('Name') as HTMLInputElement;
		expect(name.value).toBe('');
		expect(name.getAttribute('data-slot')).toBe('input');
		expect(screen.getByRole('combobox', { name: 'Vector store' })).toBeTruthy();
		expect(document.querySelector('form')?.noValidate).toBe(true);
		// OVL-1: the fields scroll in DialogBody; the title and Add source stay pinned.
		const body = document.querySelector('[data-slot="dialog-body"]') as HTMLElement;
		expect(body).toContainElement(name);
		expect(body).not.toContainElement(screen.getByRole('button', { name: 'Add source' }));
		expect(body.parentElement?.parentElement).toHaveAttribute('data-slot', 'dialog-content');
	});

	it('turns a source off from its switch and says so; an off source says Off rather than fading', async () => {
		const { toast } = await import('sonner');
		vi.mocked(updateExternalKnowledgeConnection).mockResolvedValue({} as never);
		await renderList();
		fireEvent.click(screen.getByRole('switch', { name: 'Enable Research' }));
		await waitFor(() => expect(updateExternalKnowledgeConnection).toHaveBeenCalledTimes(1));
		expect(vi.mocked(updateExternalKnowledgeConnection).mock.calls[0][1]).toBe('c1');
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('“Research” is off'));
		cleanup();
		vi.mocked(getExternalKnowledgeConnections).mockResolvedValue({
			items: [{ ...CONNECTION, enabled: false }]
		} as never);
		await renderList();
		expect(screen.getByText('Off')).toBeTruthy();
		expect(screen.getByRole('switch', { name: 'Enable Research' }).getAttribute('data-state')).toBe('unchecked');
		const row = document.querySelector('li') as HTMLElement;
		expect(row.className).not.toMatch(/opacity/);
		expect(screen.getByText('Research').parentElement?.className).not.toMatch(/opacity/);
	});

	it('says under each empty field what a test needs, and saves only after a test finds documents', async () => {
		vi.mocked(testExternalKnowledgeSource).mockResolvedValueOnce({ documents: [] } as never);
		vi.mocked(testExternalKnowledgeSource).mockResolvedValueOnce({ documents: ['a', 'b'] } as never);
		vi.mocked(updateExternalKnowledgeSource).mockResolvedValue({} as never);
		await renderList();
		fireEvent.click(screen.getByRole('button', { name: 'Configure Research' }));
		const query = await screen.findByLabelText('Test query');
		fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
		await waitFor(() => expect(query).toHaveAccessibleDescription('Enter a test query.'));
		fireEvent.change(query, { target: { value: 'hello' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() =>
			expect(query).toHaveAccessibleDescription('Run the test first: a source is saved only once it finds documents.')
		);
		fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
		await waitFor(() =>
			expect(query).toHaveAccessibleDescription(
				'The test found no documents. Check the collection and the field names.'
			)
		);
		fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
		expect(await screen.findByText('Found 2 documents.')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(updateExternalKnowledgeSource).toHaveBeenCalledTimes(1));
	});

	it('shows a list that fails to load in place, with Try again', async () => {
		vi.mocked(getExternalKnowledgeConnections).mockRejectedValueOnce(new Error('down'));
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<ExternalKnowledge />
				</TooltipProvider>
			</QueryClientProvider>
		);
		expect(await screen.findByText("Couldn't load the knowledge sources")).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('button', { name: 'Configure Research' })).toBeTruthy();
	});

	it('says a refused add, keeping the dialog open', async () => {
		vi.mocked(searchKnowledgeBases).mockResolvedValue({ items: [] } as never);
		vi.mocked(testExternalKnowledgeSource).mockResolvedValue({ documents: ['a'] } as never);
		vi.mocked(createExternalKnowledgeSource).mockRejectedValue('Name taken');
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<ExternalKnowledge />
				</TooltipProvider>
			</QueryClientProvider>
		);
		expect(await screen.findByText(/None yet/)).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
		const fill = (label: string, value: string) =>
			fireEvent.change(screen.getByLabelText(label), { target: { value } });
		fill('Name', 'Papers');
		fill('Endpoint', 'https://q.example.com');
		fill('Collection', 'papers');
		fill('Test query', 'hello');
		fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
		expect(await screen.findByText('Found 1 document.')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Add source', hidden: false }));
		await waitFor(() => expect(toastFailure).toHaveBeenCalledWith("Couldn't add “Papers”.", 'Name taken'));
		expect(screen.getByRole('dialog')).toBeTruthy();
	});
});
