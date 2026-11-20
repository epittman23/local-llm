import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { CompareBlock, CompareRow } from '@/lib/apis/benchmarks';
import * as api from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { ComparePage } from './ComparePage';

vi.mock('@/lib/apis/benchmarks', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks')>();
	return { ...real, getCompare: vi.fn(), getTestOptions: vi.fn(), exportAnswers: vi.fn() };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const BLOCK = 'tier smoke | humanevalplus | adapter a1 | system -';

const row = (over: Partial<CompareRow>): CompareRow => ({
	block: BLOCK,
	model: 'qwen3.8-27b',
	config_id: '47714ce1',
	tier: 'smoke',
	benchmark: 'humanevalplus',
	system: '-',
	adapter: 'a1',
	item_window: null,
	flags: { ngl: '22', batch: '1024', fa: 'on', moe: '(unset)' },
	dataset_revision: 'rev',
	group: 'a',
	passed: 47,
	attempted: 60,
	n_problems: 60,
	n_samples: 60,
	n_clusters: null,
	se_kind: 'iid',
	pass_rate: 0.783333,
	pass_rate_se: 0.0536,
	pass_rate_ci: [0.6638, 0.86877],
	prefill_tps: 75.9259,
	gen_tps: 3.4726,
	acceptance: null,
	passes_per_minute: 0.201232,
	passes_per_minute_ci: [0.16933, 0.239145],
	note: '',
	last_run: '2026-11-15T06:05:20Z',
	...over
});

const block: CompareBlock = {
	key: BLOCK,
	tier: 'smoke',
	benchmark: 'humanevalplus',
	adapter: 'a1',
	system: '-',
	item_window: null,
	dataset_revision: 'rev',
	levels: [],
	letters: {},
	holm_m: 1,
	alpha: 0.05,
	pairs: [
		{
			a: 'qwen3.8-27b @ 47714ce1',
			b: 'qwen3.8-27b @ bd04a851',
			n_shared: 60,
			mean_diff: 0.033,
			se: 0.02,
			ci: [-0.013, 0.08],
			corr: 0.91,
			test: 'exact McNemar',
			statistic: 1,
			discordant: [3, 1],
			p: 0.5,
			p_holm: 0.5,
			significant: false,
			mde: 0.076,
			mde_holm: 0.076,
			underpowered: true,
			n_clusters: null,
			note: ''
		}
	]
};

const configBody = (over: Partial<CompareRow>[] = [{}, {}]) => ({
	rows: [
		row(over[0] ?? {}),
		row({
			config_id: 'bd04a851',
			flags: { ngl: '18', batch: '512', fa: 'on', moe: '(unset)' },
			passed: 41,
			pass_rate: 0.683333,
			...(over[1] ?? {})
		})
	],
	blocks: [block],
	notes: [
		'> warning: `bd04a851` and `47714ce1` differ in 2 flags (batch, ngl).',
		'> note: 1 block. Rates are compared only inside a block.'
	]
});

let location = '';
function Probe() {
	const loc = useLocation();
	location = `${loc.pathname}${loc.search}`;
	return null;
}

function renderPage(path = '/benchmarks/compare') {
	return render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<MemoryRouter initialEntries={[path]}>
					<Routes>
						<Route
							path="/benchmarks/compare"
							element={
								<>
									<ComparePage />
									<Probe />
								</>
							}
						/>
						<Route path="/benchmarks/answers" element={<Probe />} />
					</Routes>
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 'test-token' });
	vi.mocked(api.getTestOptions).mockResolvedValue({ tiers: ['smoke'], benchmarks: [], systems: [] } as never);
	vi.mocked(api.getCompare).mockResolvedValue(configBody() as never);
});

describe('ComparePage', () => {
	it('labels its selects visibly and names them by those labels (#987, #1044)', async () => {
		renderPage();
		expect(await screen.findByRole('combobox', { name: 'Compare by' })).toBeTruthy();
		expect(screen.getByRole('combobox', { name: 'Tier' })).toHaveTextContent('All tiers');
		expect(screen.getByRole('combobox', { name: 'Baseline' })).toHaveTextContent('None');
		expect(screen.getByText('Compare by').tagName).toBe('LABEL');
	});

	it('gives the flags that differ their own columns and lists the shared ones once (#939)', async () => {
		renderPage();
		const region = await screen.findByRole('region', { name: 'Configurations, HumanEval+, smoke' });
		const heads = within(region)
			.getAllByRole('columnheader')
			.map((th) => th.textContent);
		expect(heads.slice(0, 4)).toEqual(['Configuration', 'Group', 'ngl', 'batch']);
		expect(heads).toContain('Pass rate, % [95% CI]');
		expect(heads).not.toContain('Flags');
		// Note is hidden while every note is empty (#1112).
		expect(heads).not.toContain('Note');
		const first = within(region).getAllByRole('row')[1];
		expect(first).toHaveTextContent('78.3 [66.4, 86.9]');
		expect(first).toHaveTextContent('3.47');
		expect(first).toHaveTextContent('75.9');
		expect(screen.getByText('Shared flags (1): every configuration here')).toBeTruthy();
		// The block runs one model, so its rows and pairs drop the model.
		expect(within(region).queryByText(/qwen3\.8-27b @/)).toBeNull();
		const pairs = screen.getByRole('region', { name: 'Paired comparisons, HumanEval+, smoke' });
		expect(within(pairs).getByText('+3.3 [-1.3, 8.0]')).toBeTruthy();
		expect(within(pairs).getByText('underpowered')).toBeTruthy();
		expect(screen.getByText(/MDE: the smallest difference detectable/)).toBeTruthy();
	});

	it('names the model on each row when a block runs several, and shows notes that exist', async () => {
		vi.mocked(api.getCompare).mockResolvedValue(
			configBody([{ note: 'cluster-robust' }, { model: 'qwen25c', se_kind: 'cluster', n_clusters: 12 }]) as never
		);
		renderPage();
		const region = await screen.findByRole('region', { name: 'Configurations, HumanEval+, smoke' });
		expect(within(region).getByText('qwen25c @')).toBeTruthy();
		expect(within(region).getByRole('columnheader', { name: 'Note' })).toBeTruthy();
		expect(within(region).getByRole('columnheader', { name: 'SE, pp' })).toBeTruthy();
		expect(within(region).getByText('(12 clusters)')).toBeTruthy();
		expect(within(region).getByText('cluster-robust')).toBeTruthy();
	});

	it('puts warnings above the tables without their markdown, and notes behind How to read this (#1043)', async () => {
		renderPage();
		const notice = await screen.findByText('Read this comparison with care');
		const strip = notice.closest('[data-slot=status-notice]') as HTMLElement;
		expect(strip).toHaveTextContent('bd04a851 and 47714ce1 differ in 2 flags (batch, ngl).');
		expect(strip).not.toHaveTextContent('warning:');
		expect(within(strip).getByText('bd04a851').tagName).toBe('CODE');
		expect(screen.getByText('How to read this (1)')).toBeTruthy();
		expect(screen.getByText('1 block. Rates are compared only inside a block.')).toBeTruthy();
	});

	it('reads the baseline from the address, marks its row and sets another from a row (#1044, NAV-1)', async () => {
		vi.mocked(api.getCompare).mockResolvedValue(configBody([{ vs_baseline: 0.1 }, { vs_baseline: 0 }]) as never);
		renderPage('/benchmarks/compare?baseline=bd04a851');
		const region = await screen.findByRole('region', { name: 'Configurations, HumanEval+, smoke' });
		expect(api.getCompare).toHaveBeenCalledWith('test-token', { by: 'config', tier: null, baseline: 'bd04a851' });
		expect(screen.getByRole('combobox', { name: 'Baseline' })).toHaveTextContent(
			'qwen3.8-27b @ bd04a851 · ngl 18, batch 512'
		);
		const rows = within(region).getAllByRole('row');
		expect(rows[2]).toHaveAttribute('data-baseline');
		expect(within(rows[2]).getByText('Baseline')).toBeTruthy();
		expect(rows[1]).toHaveTextContent('+10.0');
		fireEvent.click(within(rows[1]).getByRole('button', { name: 'Set as baseline, 47714ce1' }));
		await waitFor(() => expect(location).toBe('/benchmarks/compare?baseline=47714ce1'));
		// The pressed button goes away with its row's new state; focus lands on the baseline select (A11Y-1).
		const select = screen.getByRole('combobox', { name: 'Baseline' });
		expect(document.activeElement).toBe(select);
		// The rows stay while the new baseline loads, so the select stays usable.
		expect(select).not.toBeDisabled();
		expect(screen.queryByText('Loading the comparison')).toBeNull();
	});

	it('falls back to all tiers for a tier the server does not offer, and rewrites the address (NAV-3)', async () => {
		renderPage('/benchmarks/compare?tier=nightly&by=serving');
		await waitFor(() => expect(location).toBe('/benchmarks/compare?by=serving'));
		expect(screen.getByRole('combobox', { name: 'Tier' })).toHaveTextContent('All tiers');
	});

	it("never shows the old baseline's differences under a new one while it loads", async () => {
		vi.mocked(api.getCompare).mockResolvedValueOnce(configBody([{ vs_baseline: 0.1 }, { vs_baseline: 0 }]) as never);
		let land: (value: unknown) => void = () => {};
		vi.mocked(api.getCompare).mockReturnValueOnce(new Promise((resolve) => (land = resolve)) as never);
		renderPage('/benchmarks/compare?baseline=bd04a851');
		const region = await screen.findByRole('region', { name: 'Configurations, HumanEval+, smoke' });
		fireEvent.click(within(region).getByRole('button', { name: 'Set as baseline, 47714ce1' }));
		await waitFor(() => expect(location).toBe('/benchmarks/compare?baseline=47714ce1'));
		let rows = within(region).getAllByRole('row');
		expect(rows[1]).toHaveAttribute('data-baseline');
		// bd04a851's 0.0 was against itself: while the new numbers load, it shows none.
		expect(within(rows[2]).getByText('Loading')).toBeTruthy();
		expect(rows[1]).not.toHaveTextContent('+10.0');
		land(configBody([{ vs_baseline: 0 }, { vs_baseline: -0.1 }]));
		await waitFor(() => expect(within(region).getAllByRole('row')[2]).toHaveTextContent('-10.0'));
		rows = within(region).getAllByRole('row');
		expect(within(rows[2]).queryByText('Loading')).toBeNull();
	});

	it('says when the baseline in the address is not in the results, and clears it (#1044)', async () => {
		renderPage('/benchmarks/compare?baseline=nope');
		expect(await screen.findByText('No configuration nope in these results')).toBeTruthy();
		expect(screen.queryByRole('columnheader', { name: 'Vs baseline, pp' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Clear baseline' }));
		await waitFor(() => expect(location).toBe('/benchmarks/compare'));
	});

	it('opens the view and tier in the address, with headings in words and units (#1042, #1045)', async () => {
		vi.mocked(api.getCompare).mockResolvedValue({
			rows: [
				{
					config_id: '47714ce1',
					alias: 'qwen3.8-27b',
					model: 'qwen3.8-27b',
					ngl: '22',
					gen_tps: 3.88,
					peak_vram_mib: 5658,
					started_at: 1794718000
				}
			],
			derived: [{ config_id: '47714ce1', ms_per_token: 257.73, cpu_bandwidth_gib_s: '31.7' }],
			notes: []
		} as never);
		renderPage('/benchmarks/compare?by=serving&tier=smoke');
		const region = await screen.findByRole('region', { name: 'Serving measurements' });
		expect(api.getCompare).toHaveBeenCalledWith('test-token', { by: 'serving', tier: 'smoke', baseline: null });
		const heads = within(region)
			.getAllByRole('columnheader')
			.map((th) => th.textContent);
		expect(heads).toEqual(['Configuration', 'Model', 'GPU layers', 'Gen, t/s', 'Peak VRAM, MiB', 'Started']);
		expect(within(region).getByText('5,658')).toBeTruthy();
		expect(within(region).getByText('5,658').closest('td')).toHaveClass('text-right');
		expect(screen.getByText(/Worked out from the measurements above/)).toBeTruthy();
		const derived = screen.getByRole('region', { name: 'Derived from the serving measurements' });
		expect(within(derived).getByRole('columnheader', { name: 'CPU bandwidth, GiB/s' })).toBeTruthy();
		expect(within(derived).getByText('257.7')).toBeTruthy();
	});

	it('sorts from a heading button and says so in aria-sort (#974)', async () => {
		vi.mocked(api.getCompare).mockResolvedValue({
			columns: ['model', 'config_id', 'ds1000_passed', 'ds1000_pass_rate'],
			rows: [
				{ model: 'qwen38', config_id: 'aaa111', ds1000_passed: '18/25', ds1000_pass_rate: 0.72 },
				{ model: 'qwen25c', config_id: 'bbb222', ds1000_passed: '23/25', ds1000_pass_rate: 0.92 }
			],
			notes: []
		} as never);
		renderPage('/benchmarks/compare?by=benchmark');
		const region = await screen.findByRole('region', { name: 'Pass rate by benchmark' });
		const heading = within(region).getByRole('columnheader', { name: 'DS-1000 pass rate, %' });
		expect(heading).not.toHaveAttribute('aria-sort');
		fireEvent.click(within(heading).getByRole('button'));
		expect(heading).toHaveAttribute('aria-sort', 'descending');
		expect(within(region).getAllByRole('row')[1]).toHaveTextContent('bbb222');
		fireEvent.click(within(heading).getByRole('button'));
		expect(heading).toHaveAttribute('aria-sort', 'ascending');
		expect(within(region).getAllByRole('row')[1]).toHaveTextContent('aaa111');
		expect(within(region).getByText('72.0')).toBeTruthy();
	});

	it('lists failures under a header that stays in view, each outcome a status badge (#1114, DAT-3)', async () => {
		vi.mocked(api.getCompare).mockResolvedValue({
			rows: [
				{
					config_id: 'aaa111',
					model: 'qwen38',
					item_id: 'Mbpp/7',
					outcome: 'fail_timeout',
					reason: 'timed out after 20 s'
				}
			],
			notes: []
		} as never);
		renderPage('/benchmarks/compare?by=failures');
		const region = await screen.findByRole('region', { name: 'Failures' });
		expect(within(region).getByRole('table')).toHaveAttribute('data-sticky-header');
		expect(within(region).getByText('timed out').closest('[data-slot=badge]')).toHaveAttribute(
			'data-outcome',
			'fail_timeout'
		);
	});

	it('opens a failure in Answers from its item link or a click on its row (B-D9, DAT-6)', async () => {
		const failure = {
			config_id: 'aaa111',
			model: 'qwen38',
			benchmark: 'mbppplus',
			item_id: 'Mbpp/7',
			outcome: 'fail_assert',
			reason: 'assertion failed',
			suite_run_id: '20261116T120000Z-abc123'
		};
		vi.mocked(api.getCompare).mockResolvedValue({ rows: [failure], notes: [] } as never);
		const answers = '/benchmarks/answers?run=20261116T120000Z-abc123&benchmark=mbppplus&item=Mbpp%2F7';

		const first = renderPage('/benchmarks/compare?by=failures');
		let region = await screen.findByRole('region', { name: 'Failures' });
		expect(within(region).getByRole('columnheader', { name: /Suite run/ })).toBeTruthy();
		const link = within(region).getByRole('link', { name: 'Mbpp/7' });
		expect(link).toHaveAttribute('href', answers);
		fireEvent.click(link);
		await waitFor(() => expect(location).toBe(answers));
		first.unmount();

		renderPage('/benchmarks/compare?by=failures');
		region = await screen.findByRole('region', { name: 'Failures' });
		fireEvent.click(within(region).getByText('assertion failed'));
		await waitFor(() => expect(location).toBe(answers));
	});

	it('leaves a failure without a suite run as plain text', async () => {
		vi.mocked(api.getCompare).mockResolvedValue({
			rows: [{ config_id: 'aaa111', benchmark: 'mbppplus', item_id: 'Mbpp/7', outcome: 'fail_assert' }],
			notes: []
		} as never);
		renderPage('/benchmarks/compare?by=failures');
		const region = await screen.findByRole('region', { name: 'Failures' });
		expect(within(region).getByText('Mbpp/7')).toBeTruthy();
		expect(within(region).queryByRole('link')).toBeNull();
		expect(within(region).getAllByRole('row')[1]).not.toHaveAttribute('data-opens');
	});

	it("shows a failed load in place with the server's words and Try again (#1050, STA-4)", async () => {
		vi.mocked(api.getCompare).mockRejectedValueOnce("unknown tier 'nightly'");
		renderPage();
		expect(await screen.findByText("Couldn't load the comparison")).toBeTruthy();
		expect(screen.getByText("unknown tier 'nightly'")).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByRole('region', { name: 'Configurations, HumanEval+, smoke' })).toBeTruthy();
	});

	it('says what belongs here when nothing has been measured, and clears a tier that hides everything (STA-3)', async () => {
		vi.mocked(api.getCompare).mockResolvedValue({ rows: [], blocks: [], notes: [] } as never);
		const { unmount } = renderPage();
		expect(await screen.findByText('No results to compare yet')).toBeTruthy();
		expect(screen.getByRole('link', { name: 'Open Tests' })).toHaveAttribute('href', '/benchmarks/tests');
		unmount();
		renderPage('/benchmarks/compare?tier=smoke');
		fireEvent.click(await screen.findByRole('button', { name: 'Clear filters' }));
		await waitFor(() => expect(location).toBe('/benchmarks/compare'));
	});

	it('reports an export in a toast, and a failed one with the reason behind Details (#1050, FBK-4)', async () => {
		vi.mocked(api.exportAnswers)
			.mockResolvedValueOnce({ exported: 12, directory: 'answers/run1' } as never)
			.mockRejectedValueOnce('no such run');
		renderPage();
		const input = await screen.findByLabelText('Run id');
		fireEvent.change(input, { target: { value: 'run1' } });
		fireEvent.click(screen.getByRole('button', { name: 'Export' }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Exported 12 answers to answers/run1'));
		fireEvent.click(screen.getByRole('button', { name: 'Export' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(vi.mocked(toast.error).mock.calls[0][0]).toBe(
			"Couldn't export the answers. Check the run id and try again."
		);
	});
});
