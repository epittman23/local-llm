import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
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
		runOneItem: vi.fn(),
		streamTestRun: vi.fn(),
		runSelfcheck: vi.fn(),
		checkServe: vi.fn(),
		getLive: vi.fn()
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

const renderPage = (url = '/benchmarks/tests') =>
	render(
		<MemoryRouter initialEntries={[url]}>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TestsPage />
			</QueryClientProvider>
		</MemoryRouter>
	);

const serving = () => {
	vi.mocked(api.checkServe).mockResolvedValue({ port: 8090, model: 'qwen3.8-27b', profile: 'qwen38', running: true });
	vi.mocked(api.getLive).mockResolvedValue({ run: { config_id: 'c98ef02c', model: 'qwen3.8-27b' } });
};

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
		serving();
	});

	afterEach(() => {
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	it('names every select by its visible label (#987)', async () => {
		renderPage();
		expect(await screen.findByRole('combobox', { name: 'Tier' })).toBeTruthy();
		expect(screen.getByRole('combobox', { name: 'Benchmark' })).toBeTruthy();
		expect(screen.getByRole('combobox', { name: 'System prompt' })).toBeTruthy();
		expect(screen.getByRole('combobox', { name: 'Item benchmark' })).toBeTruthy();
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
		fireEvent.click(await screen.findByRole('button', { name: 'Run smoke' }));

		await waitFor(() =>
			expect(api.startTestRun).toHaveBeenCalledWith('test-token', { suite: 'smoke', window_min: '2025-01-05' })
		);
		expect(await screen.findByText(/release-date window 2025-01-05\.\./)).toBeInTheDocument();
		expect(screen.getByText(/holds 3 problems, fewer than 8/)).toBeInTheDocument();
	});

	it('names the increment a window still needs, and refuses a window that ends first', async () => {
		renderPage();
		const from = await screen.findByLabelText('Window from');
		fireEvent.change(from, { target: { value: '2024-12-01' } });
		expect(screen.getByText('This window needs test5.jsonl: fetch it first.')).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText('Window to'), { target: { value: '2024-11-01' } });
		expect(screen.getByText('The window ends before it starts.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Run smoke' })).toBeDisabled();
	});

	it('fetches the increments ticked', async () => {
		vi.mocked(api.streamTestRun).mockResolvedValue(stream([{ type: 'done', cancelled: false }]));
		renderPage();
		const box = await screen.findByLabelText(/test5\.jsonl: 167 problems, 2024-09-22 to 2025-01-04, 532 MiB/);
		fireEvent.click(box);
		fireEvent.click(screen.getByRole('button', { name: 'Fetch 1 increment · 532 MiB' }));
		await waitFor(() => expect(api.fetchDatasets).toHaveBeenCalledWith('test-token', { increments: ['test5.jsonl'] }));

		fireEvent.click(box);
		expect(screen.getByLabelText(/test6\.jsonl: .* \(fetched\)/)).toBeInTheDocument();
	});
});

describe('TestsPage datasets and item result', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
		serving();
		vi.mocked(api.getTestOptions).mockResolvedValue({
			tiers: ['smoke'],
			benchmarks: ['ds1000'],
			systems: []
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	it('shows why a dataset calibration no longer applies, in the warning colour', async () => {
		vi.mocked(api.getDatasets).mockResolvedValue([
			{
				benchmark: 'ds1000',
				name: 'DS-1000',
				fetched: true,
				vendored: true,
				n_items: 1000,
				revision: 'abc123',
				fetched_at: null,
				calibrated_at: null,
				n_checked: null,
				n_ungradeable: null,
				calibration_stale: 'the file changed since it was calibrated'
			},
			{
				benchmark: 'humaneval',
				name: 'HumanEval+',
				fetched: true,
				vendored: true,
				n_items: 164,
				revision: 'def456',
				fetched_at: null,
				calibrated_at: null,
				n_checked: 164,
				n_ungradeable: 4,
				calibration_stale: ''
			}
		]);
		renderPage();
		const table = await screen.findByRole('region', { name: 'Dataset status' });
		const stale = await within(table).findByText('the file changed since it was calibrated');
		expect(stale.className).toContain('text-warning');
		expect(within(table).getByText('160/164 gradeable').className).not.toContain('text-warning');
		// DAT-6: below sm the same facts are label and value pairs, one block per dataset (the table is hidden there).
		const blocks = screen.getByRole('list', { name: 'Dataset status' });
		expect(blocks.className).toContain('sm:hidden');
		expect(table.closest('.hidden.sm\\:block')).not.toBeNull();
		const ds1000 = within(blocks).getAllByRole('listitem')[0];
		expect(within(ds1000).getByText('DS-1000')).toBeInTheDocument();
		expect(within(ds1000).getByText('Revision').nextElementSibling?.textContent).toBe('abc123');
		expect(within(ds1000).getByText('Items').nextElementSibling?.textContent).toBe('1000');
		expect(within(ds1000).getByText('the file changed since it was calibrated').className).toContain('text-warning');
	});

	it('shows a single item result with the suites that leave it out', async () => {
		vi.mocked(api.getDatasets).mockResolvedValue([]);
		vi.mocked(api.runOneItem).mockResolvedValue({ started: true });
		vi.mocked(api.streamTestRun).mockResolvedValue(
			stream([
				{
					type: 'result',
					benchmark: 'ds1000',
					item_id: 'Pandas/1',
					outcome: 'passed',
					wall_ms: 1500,
					excluded: 'smoke',
					content: 'print(1)'
				},
				{ type: 'done', passed: 1, attempted: 1, cancelled: false }
			])
		);
		renderPage();
		fireEvent.change(await screen.findByLabelText('Item id'), { target: { value: 'Pandas/1' } });
		fireEvent.click(await screen.findByRole('button', { name: 'Run item' }));
		const result = await screen.findByTestId('item-result');
		expect(result.textContent).toContain('ds1000/Pandas/1');
		expect(result.textContent).toContain('1.5 s');
		expect(screen.getByText('A suite here leaves this item out: smoke').className).toContain('text-warning');
		expect(screen.getByText('print(1)')).toBeInTheDocument();
	});
});

describe('TestsPage target, tiers, progress and datasets (#918, #938, #1047, #1048)', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
		vi.mocked(api.getTestOptions).mockResolvedValue({
			tiers: ['full', 'smoke', 'standard'],
			benchmarks: ['humanevalplus', 'mbppplus'],
			systems: ['assistant']
		});
		vi.mocked(api.getDatasets).mockResolvedValue([
			{
				benchmark: 'humanevalplus',
				name: 'HumanEval+',
				fetched: true,
				vendored: true,
				n_items: 164,
				revision: 'v0.1.10',
				fetched_at: null,
				calibrated_at: null,
				n_checked: null,
				n_ungradeable: null,
				calibration_stale: 'not calibrated yet'
			}
		]);
		vi.mocked(api.startTestRun).mockResolvedValue({ started: true });
		vi.mocked(api.fetchDatasets).mockResolvedValue({ started: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	it('orders the tiers by cost, opens on smoke and names it on Run (B-D1)', async () => {
		serving();
		renderPage();
		const run = await screen.findByRole('button', { name: 'Run smoke' });
		expect(run).toBeEnabled();
		expect(screen.getByRole('combobox', { name: 'Tier' }).textContent).toContain('smoke · 8 items per benchmark');
	});

	it('reads the tier, benchmark and system prompt from the address (NAV-1)', async () => {
		serving();
		renderPage('/benchmarks/tests?tier=standard&benchmark=mbppplus&system=assistant');
		fireEvent.click(await screen.findByRole('button', { name: 'Run standard' }));
		await waitFor(() =>
			expect(api.startTestRun).toHaveBeenCalledWith('test-token', {
				suite: 'standard',
				benchmark: 'mbppplus',
				system: 'assistant'
			})
		);
	});

	it('names what is served, with its profile, configuration and port', async () => {
		serving();
		renderPage();
		expect(await screen.findByText('Serving qwen3.8-27b')).toBeInTheDocument();
		const notice = screen.getByText(/Tests run against this server/);
		expect(notice.textContent).toBe(
			'Tests run against this server · profile qwen38 · configuration c98ef02c · port 8090.'
		);
		expect(screen.getByRole('link', { name: 'Open Live' }).getAttribute('href')).toBe('/benchmarks/live');
	});

	it('says nothing is served and holds Run and Run item, but not Selfcheck', async () => {
		vi.mocked(api.checkServe).mockResolvedValue({
			port: 8090,
			model: 'qwen3.8-27b',
			profile: 'qwen38',
			running: false
		});
		vi.mocked(api.getLive).mockResolvedValue({ run: null });
		renderPage();
		expect(await screen.findByText('Nothing is being served')).toBeInTheDocument();
		const run = screen.getByRole('button', { name: 'Run smoke' });
		expect(run).toBeDisabled();
		expect(run.getAttribute('aria-describedby')).toBe('tests-run-reason');
		fireEvent.change(screen.getByLabelText('Item id'), { target: { value: 'HumanEval/1' } });
		expect(screen.getByRole('button', { name: 'Run item' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Selfcheck' })).toBeEnabled();
		// B-D11 holds Run only; the notice says why Selfcheck stays on.
		expect(
			screen.getByText(/Selfcheck, under Datasets, grades the reference solutions and needs no model/)
		).toBeInTheDocument();
	});

	it('shows a failure to start beside Run (FBK-1)', async () => {
		serving();
		vi.mocked(api.startTestRun).mockRejectedValue('a run is already in progress');
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'Run smoke' }));
		expect((await screen.findByRole('alert')).textContent).toBe("Couldn't start the run: a run is already in progress");
	});

	it('marks a vendored dataset and offers selfcheck where the calibration is missing', async () => {
		serving();
		vi.mocked(api.runSelfcheck).mockResolvedValue({ started: true });
		vi.mocked(api.streamTestRun).mockResolvedValue(stream([]));
		renderPage();
		const table = await screen.findByRole('region', { name: 'Dataset status' });
		expect(await within(table).findByText('In the repository')).toBeInTheDocument();
		fireEvent.click(within(table).getByRole('button', { name: 'Run selfcheck' }));
		await waitFor(() => expect(api.runSelfcheck).toHaveBeenCalled());
	});

	it('refetches only after a confirmation that names the action (ACT-2, ACT-3)', async () => {
		serving();
		vi.mocked(api.streamTestRun).mockResolvedValue(stream([]));
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'Refetch datasets' }));
		expect(await screen.findByText('Refetch every dataset?')).toBeInTheDocument();
		expect(api.fetchDatasets).not.toHaveBeenCalled();
		const buttons = screen.getAllByRole('button', { name: 'Refetch datasets' });
		fireEvent.click(buttons[buttons.length - 1]);
		await waitFor(() => expect(api.fetchDatasets).toHaveBeenCalledWith('test-token', { force: true }));
	});

	it('follows a run with a progress bar, counts, a link to Answers and a failures-only view', async () => {
		serving();
		vi.mocked(api.streamTestRun).mockResolvedValue(
			stream([
				{ type: 'start', suite_run_id: 'smoke-1', total: 4, skipped: 0 },
				{
					type: 'item',
					benchmark: 'humanevalplus',
					item_id: 'HumanEval/0',
					outcome: 'pass',
					i: 1,
					total: 4,
					passed: 1,
					attempted: 1
				},
				{
					type: 'item',
					benchmark: 'humanevalplus',
					item_id: 'HumanEval/1',
					outcome: 'fail_assert',
					reason: 'assert add(2, 2) == 4',
					i: 2,
					total: 4,
					passed: 1,
					attempted: 2
				},
				{ type: 'done', passed: 1, attempted: 2, cancelled: true }
			])
		);
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'Run smoke' }));
		const bar = await screen.findByRole('progressbar', { name: 'Run progress' });
		await waitFor(() => expect(bar.getAttribute('aria-valuenow')).toBe('2'));
		expect(bar.getAttribute('aria-valuetext')).toBe('2 of 4 items');
		// One pass rate, skipped items left out, in the progress line and the final line alike.
		expect(screen.getByText(/2 of 4 items · 1 of 2 passed \(50%\)/)).toBeInTheDocument();
		expect(screen.getByText('Final: 1 of 2 passed (50%)')).toBeInTheDocument();
		expect(screen.getByText('Cancelled')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Open in Answers' }).getAttribute('href')).toBe(
			'/benchmarks/answers?run=smoke-1'
		);
		const log = screen.getByRole('region', { name: 'Item log' });
		expect(log.textContent).toContain('assert add(2, 2) == 4');
		expect(log.textContent).toContain('passed');
		fireEvent.click(screen.getByLabelText('Show failures only'));
		expect(log.textContent).not.toContain('HumanEval/0');
		expect(log.textContent).toContain('HumanEval/1');
	});
});
