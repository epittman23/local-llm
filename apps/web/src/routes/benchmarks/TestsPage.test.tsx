import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { TestsPage } from './TestsPage';

vi.mock('@/lib/apis/benchmarks', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks')>();
	return {
		...real,
		getTestOptions: vi.fn(),
		getDatasets: vi.fn(),
		fetchDatasets: vi.fn(),
		startTestRun: vi.fn(),
		streamTestRun: vi.fn()
	};
});

const increments = [
	{ name: 'test5.jsonl', bytes: 557699297, items: 167, first: '2024-09-22', last: '2025-01-04', fetched: false },
	{ name: 'test6.jsonl', bytes: 134303240, items: 175, first: '2025-01-04', last: '2025-04-06', fetched: true }
];

const stream = (events: object[]) => {
	const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
	return [new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), new AbortController()] as [
		Response,
		AbortController
	];
};

const renderPage = () =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TestsPage />
		</QueryClientProvider>
	);

describe('TestsPage release-date window', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
		vi.mocked(api.getTestOptions).mockResolvedValue({
			tiers: ['smoke'],
			benchmarks: ['ds1000', 'livecodebench'],
			systems: [],
			windows: { livecodebench: { increments, date_range: ['2025-01-04', '2025-04-06'] } }
		});
		vi.mocked(api.getDatasets).mockResolvedValue([]);
		vi.mocked(api.fetchDatasets).mockResolvedValue({ started: true });
		vi.mocked(api.startTestRun).mockResolvedValue({ started: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	it('sends the window with a run, and shows it and the notes on the stream', async () => {
		vi.mocked(api.streamTestRun).mockResolvedValue(
			stream([
				{
					type: 'start',
					suite_run_id: 'run-1',
					total: 8,
					skipped: 0,
					window: '2025-01-05..',
					notes: ['livecodebench: the window holds 3 problems, fewer than 8; using all']
				},
				{ type: 'done', passed: 0, attempted: 0, cancelled: false }
			])
		);
		renderPage();
		const from = await screen.findByLabelText('Window from');
		expect(
			screen.getByText(/Without a window, livecodebench is left out · fetched problems: 2025-01-04 to 2025-04-06/)
		).toBeInTheDocument();

		fireEvent.change(from, { target: { value: '2025-01-05' } });
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));

		await waitFor(() =>
			expect(api.startTestRun).toHaveBeenCalledWith('test-token', { suite: 'smoke', window_min: '2025-01-05' })
		);
		expect(await screen.findByText('Release-date window: 2025-01-05..')).toBeInTheDocument();
		expect(screen.getByText(/holds 3 problems, fewer than 8/)).toBeInTheDocument();
	});

	it('names the increment a window still needs, and refuses a window that ends first', async () => {
		renderPage();
		const from = await screen.findByLabelText('Window from');
		fireEvent.change(from, { target: { value: '2024-12-01' } });
		expect(screen.getByText('This window needs test5.jsonl: fetch it first.')).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText('Window to'), { target: { value: '2024-11-01' } });
		expect(screen.getByText('The window ends before it starts.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
	});

	it('fetches the increments ticked', async () => {
		vi.mocked(api.streamTestRun).mockResolvedValue(stream([{ type: 'done', cancelled: false }]));
		renderPage();
		const box = await screen.findByLabelText(/test5\.jsonl: 167 problems, 2024-09-22 to 2025-01-04, 532 MiB/);
		fireEvent.click(box);
		fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
		await waitFor(() => expect(api.fetchDatasets).toHaveBeenCalledWith('test-token', { increments: ['test5.jsonl'] }));

		fireEvent.click(box);
		expect(screen.getByLabelText(/test6\.jsonl: .* \(fetched\)/)).toBeInTheDocument();
	});
});
