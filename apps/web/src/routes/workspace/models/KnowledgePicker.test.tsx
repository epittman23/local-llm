import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { searchKnowledgeBases, searchKnowledgeFiles } from '@/lib/apis/knowledge';
import { searchNotes } from '@/lib/apis/notes';
import { useAuthStore } from '@/lib/stores/authStore';
import { KnowledgePicker } from './KnowledgePicker';

vi.mock('@/lib/apis/knowledge', () => ({ searchKnowledgeBases: vi.fn(), searchKnowledgeFiles: vi.fn() }));
vi.mock('@/lib/apis/notes', () => ({ searchNotes: vi.fn() }));
vi.mock('@/lib/apis/files', () => ({ uploadFile: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const renderPicker = (onChange = vi.fn()) => {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<KnowledgePicker items={[]} onChange={onChange} />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return onChange;
};

describe('KnowledgePicker', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'jwt', user: { id: 'u1', role: 'admin' } } as never);
		vi.mocked(searchNotes).mockResolvedValue({ items: [] } as never);
		vi.mocked(searchKnowledgeFiles).mockResolvedValue({ items: [] } as never);
		vi.mocked(searchKnowledgeBases).mockResolvedValue({ items: [{ id: 'k1', name: 'Handbook' }] } as never);
	});

	it('attaches the knowledge base that is picked', async () => {
		const onChange = renderPicker();
		fireEvent.click(screen.getByRole('button', { name: 'Select Knowledge' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Handbook' }));
		expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'k1', type: 'collection' })]);
	});

	it('says so when nothing matches', async () => {
		vi.mocked(searchKnowledgeBases).mockResolvedValue({ items: [] } as never);
		renderPicker();
		fireEvent.click(screen.getByRole('button', { name: 'Select Knowledge' }));
		await waitFor(() => expect(screen.getByText('No knowledge found')).toBeInTheDocument());
	});
});
