import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
	getExternalKnowledgeConnections,
	searchKnowledgeBases,
	testExternalKnowledgeSource,
	updateExternalKnowledgeConnection
} from '@/lib/apis/knowledge';
import { useAuthStore } from '@/lib/stores/authStore';
import { ExternalKnowledge } from './ExternalKnowledge';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/components/common/AccessControl', () => ({ AccessControl: () => <div>access control</div> }));
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
		expect(await screen.findByText('Edit Knowledge Connection')).toBeTruthy();
	});

	it('opens a blank add dialog from the plus button', async () => {
		await renderList();
		fireEvent.click(screen.getByRole('button', { name: 'Add Knowledge Connection' }));
		expect(await screen.findByText('Add Knowledge Connection', { selector: 'h2' })).toBeTruthy();
		expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
	});

	it('disables a source from its switch', async () => {
		vi.mocked(updateExternalKnowledgeConnection).mockResolvedValue({} as never);
		await renderList();
		fireEvent.click(screen.getByRole('switch', { name: 'Disable Research' }));
		await waitFor(() => expect(updateExternalKnowledgeConnection).toHaveBeenCalledTimes(1));
		expect(vi.mocked(updateExternalKnowledgeConnection).mock.calls[0][1]).toBe('c1');
	});

	it('shows the passing test result and enables Save after a good test query', async () => {
		vi.mocked(testExternalKnowledgeSource).mockResolvedValue({ documents: ['a', 'b'] } as never);
		await renderList();
		fireEvent.click(screen.getByRole('button', { name: 'Configure Research' }));
		fireEvent.change(await screen.findByLabelText('Test Query'), { target: { value: 'hello' } });
		const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		fireEvent.click(screen.getByRole('button', { name: 'Run test query' }));
		expect(await screen.findByText('Test passed: 2 result(s).')).toBeTruthy();
		expect(save.disabled).toBe(false);
	});
});
