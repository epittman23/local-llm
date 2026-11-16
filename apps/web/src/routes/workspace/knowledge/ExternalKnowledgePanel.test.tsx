import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { testExternalKnowledgeRetrieval } from '@/lib/apis/knowledge';
import { ExternalKnowledgePanel } from './ExternalKnowledgePanel';

vi.mock('@/lib/apis/knowledge', () => ({ testExternalKnowledgeRetrieval: vi.fn() }));

describe('ExternalKnowledgePanel', () => {
	const ask = () => {
		render(<ExternalKnowledgePanel external={{ connection_id: 'c1', provider: 'Drive' }} />);
		fireEvent.change(screen.getByLabelText('Test Query'), { target: { value: 'what is a t-test?' } });
		fireEvent.click(screen.getByRole('button', { name: 'Test' }));
	};

	it('shows what the connected source returned', async () => {
		vi.mocked(testExternalKnowledgeRetrieval).mockResolvedValueOnce({
			documents: ['A t-test compares two means.'],
			metadatas: [{ source: 'stats.pdf' }]
		});
		ask();
		expect(await screen.findByText('A t-test compares two means.')).toBeInTheDocument();
		expect(screen.getByText('stats.pdf')).toBeInTheDocument();
	});

	it('says the source did not answer, with its words behind Details (FBK-4)', async () => {
		const error = vi.spyOn(toast, 'error');
		vi.mocked(testExternalKnowledgeRetrieval).mockRejectedValueOnce('401 Unauthorized');
		ask();
		await waitFor(() =>
			expect(error).toHaveBeenCalledWith("The connected source didn't answer the test query.", {
				description: expect.objectContaining({ props: { detail: '401 Unauthorized' } })
			})
		);
	});
});
