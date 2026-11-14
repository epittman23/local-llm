import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { AnswersPage } from './AnswersPage';

vi.mock('@/lib/apis/benchmarks', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks')>();
	return { ...real, getAnswerRuns: vi.fn(), getAnswers: vi.fn(), getAnswerOne: vi.fn() };
});

beforeEach(() => {
	useAuthStore.setState({ token: 'test-token' });
	vi.mocked(api.getAnswerRuns).mockResolvedValue({ runs: [] } as never);
	vi.mocked(api.getAnswers).mockResolvedValue({ rows: [] } as never);
});

describe('AnswersPage', () => {
	it('keeps its content from widening the page and labels its table (#1062)', async () => {
		const { container } = render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<AnswersPage />
			</QueryClientProvider>
		);
		expect((container.firstElementChild as HTMLElement).className).toContain('min-w-0');
		const table = await screen.findByRole('table', { name: 'Answers' });
		expect(table.parentElement?.getAttribute('data-slot')).toBe('table-container');
	});
});
