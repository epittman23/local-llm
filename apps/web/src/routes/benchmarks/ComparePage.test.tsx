import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { ComparePage } from './ComparePage';

vi.mock('@/lib/apis/benchmarks', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks')>();
	return { ...real, getCompare: vi.fn(), getTestOptions: vi.fn(), exportAnswers: vi.fn() };
});

beforeEach(() => {
	useAuthStore.setState({ token: 'test-token' });
	vi.mocked(api.getTestOptions).mockResolvedValue({ tiers: ['smoke'], benchmarks: [], systems: [] } as never);
	vi.mocked(api.getCompare).mockResolvedValue({ rows: [] } as never);
});

describe('ComparePage', () => {
	it('labels its two selects visibly and names them by those labels (#987)', async () => {
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<ComparePage />
			</QueryClientProvider>
		);
		expect(await screen.findByRole('combobox', { name: 'Compare by' })).toBeTruthy();
		expect(screen.getByRole('combobox', { name: 'Tier' })).toBeTruthy();
		expect(screen.getByText('Compare by').tagName).toBe('LABEL');
	});
});
