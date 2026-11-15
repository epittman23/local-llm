import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { ReportPage } from './ReportPage';

vi.mock('@/lib/apis/benchmarks', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks')>();
	return { ...real, getTestOptions: vi.fn(), generateReport: vi.fn(), getReportFileText: vi.fn() };
});

describe('ReportPage', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
		vi.mocked(api.getTestOptions).mockResolvedValue({
			tiers: ['smoke'],
			benchmarks: ['humaneval'],
			systems: []
		} as never);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	it('names its selects by their visible labels (A11Y-2, #987)', async () => {
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<ReportPage />
			</QueryClientProvider>
		);
		expect(await screen.findByRole('combobox', { name: 'Tier' })).toBeTruthy();
		expect(screen.getByRole('combobox', { name: 'Benchmark' })).toBeTruthy();
		expect(screen.getByLabelText('Model')).toBeTruthy();
	});
});
