import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/apis/benchmarks';
import * as profilesApi from '@/lib/apis/benchmarks/profiles';
import { ServerUnreachableError } from '@/lib/apis/errors';
import { useAuthStore } from '@/lib/stores/authStore';
import { TunePage } from './TunePage';

// The API helpers throw the server's `detail` as a string (and a network
// failure as ServerUnreachableError). The page read `.detail` of that string,
// so a 409 "a sweep is already running" or a 404 always showed the generic
// fallback instead (#143).

vi.mock('@/lib/apis/benchmarks', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks')>();
	return {
		...real,
		getServeProfiles: vi.fn(),
		getTestOptions: vi.fn(),
		getTuneGrids: vi.fn(),
		getRecentSweeps: vi.fn(),
		getTuneStatus: vi.fn(),
		startTune: vi.fn(),
		stopTune: vi.fn(),
		resumeTune: vi.fn(),
		streamTuneLog: vi.fn()
	};
});
vi.mock('@/lib/apis/benchmarks/profiles', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks/profiles')>();
	return { ...real, listProfiles: vi.fn() };
});

beforeAll(() => {
	// Radix Select measures and captures the pointer, which jsdom does not do.
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
	vi.mocked(profilesApi.listProfiles).mockResolvedValue([]);
});

/** A status stream sending `events` and then, if `fail`, breaking off. */
function stream(events: object[], fail = false): [Response, AbortController] {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
			if (fail) controller.error('the backend restarted');
			else controller.close();
		}
	});
	return [new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), new AbortController()];
}

/** The page at `path`, in a router so `?sweep=` and the result links work; returns the router. */
let router: ReturnType<typeof createMemoryRouter>;
const renderPage = (path = '/benchmarks/tune') => {
	router = createMemoryRouter([{ path: '/benchmarks/*', element: <TunePage /> }], { initialEntries: [path] });
	const view = render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
	return view;
};
/** Opens another sweep the way the picker or Back does: by the address. */
const viewSweep = (id: string) => act(() => router.navigate(`/benchmarks/tune?sweep=${id}`));

describe('TunePage errors show what the server said', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
		vi.mocked(api.getServeProfiles).mockResolvedValue({ profiles: [] });
		vi.mocked(api.getTestOptions).mockResolvedValue({ tiers: ['smoke'], benchmarks: [], systems: [] });
		vi.mocked(api.getTuneGrids).mockResolvedValue({ grids: [] });
		vi.mocked(api.getRecentSweeps).mockResolvedValue({ sweeps: [] });
		vi.mocked(api.streamTuneLog).mockResolvedValue(stream([{ running: false }]));
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	it('names every select by its visible label (A11Y-2, #987)', async () => {
		renderPage();
		await screen.findByRole('button', { name: 'Start sweep' });
		for (const name of ['Profile', 'Tier', 'Benchmark', 'System prompt', 'Grid', 'Budget', 'Sweep'])
			expect(screen.getByRole('combobox', { name })).toBeTruthy();
	});

	it('a refused start', async () => {
		vi.mocked(api.startTune).mockRejectedValue('a sweep is already running');
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'Start sweep' }));
		expect(await screen.findByText('a sweep is already running')).toBeTruthy();
	});

	it('a status stream that cannot reach the server', async () => {
		vi.mocked(api.streamTuneLog).mockRejectedValue(new ServerUnreachableError());
		renderPage();
		expect(await screen.findByText('Could not reach the server')).toBeTruthy();
	});

	it('a refused resume', async () => {
		vi.mocked(api.streamTuneLog).mockResolvedValue(stream([{ sweep_id: 's1', running: false, resumable: true }]));
		vi.mocked(api.resumeTune).mockRejectedValue('no sweep to resume');
		renderPage();
		const resume = await screen.findByRole('button', { name: 'Resume sweep' });
		await vi.waitFor(() => expect((resume as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(resume);
		expect(await screen.findByText('no sweep to resume')).toBeTruthy();
		expect(api.resumeTune).toHaveBeenCalledWith('test-token', 's1');
	});

	it('a status stream the server refuses, and a refresh that cannot reach it', async () => {
		vi.mocked(api.streamTuneLog).mockResolvedValue([
			new Response(JSON.stringify({ detail: 'Your session has expired' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' }
			}),
			new AbortController()
		]);
		vi.mocked(api.getTuneStatus).mockRejectedValue(new ServerUnreachableError());
		renderPage();
		expect(await screen.findByText('Your session has expired')).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(await screen.findByText('Could not reach the server')).toBeTruthy();
	});

	it('a status stream that breaks off', async () => {
		vi.mocked(api.streamTuneLog).mockResolvedValue(stream([{ running: true }], true));
		renderPage();
		expect(await screen.findByText('the backend restarted')).toBeTruthy();
	});

	it('a refused stop', async () => {
		vi.mocked(api.streamTuneLog).mockResolvedValue(stream([{ running: true }]));
		vi.mocked(api.stopTune).mockRejectedValue('no sweep is running');
		renderPage();
		const stop = await screen.findByRole('button', { name: 'Stop sweep' });
		await vi.waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(stop);
		const dialog = await screen.findByRole('alertdialog');
		fireEvent.click(within(dialog).getByRole('button', { name: 'Stop sweep' }));
		expect(await screen.findByText('no sweep is running')).toBeTruthy();
	});
});

// The live-status stream belongs to the page (#144): the page owns its
// controller from before the request is sent, so leaving the page or switching
// sweeps while /tune/log has not answered yet aborts it, and a stream that a
// newer one replaced neither shows its status nor clears the newer one's state.
describe('TunePage live-status stream lifecycle', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
		vi.mocked(api.getServeProfiles).mockResolvedValue({ profiles: [] });
		vi.mocked(api.getTestOptions).mockResolvedValue({ tiers: ['smoke'], benchmarks: [], systems: [] });
		vi.mocked(api.getTuneGrids).mockResolvedValue({ grids: [] });
		vi.mocked(api.getRecentSweeps).mockResolvedValue({ sweeps: [] });
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	/** streamTuneLog held until `answer`, recording the controller each call was given. */
	function held() {
		const calls: {
			sweepId: string | null;
			controller?: AbortController;
			answer: (r: [Response, AbortController]) => void;
		}[] = [];
		vi.mocked(api.streamTuneLog).mockImplementation(
			(_token, sweepId = null, controller) =>
				new Promise((resolve) => calls.push({ sweepId, controller, answer: resolve }))
		);
		return calls;
	}

	it('leaving the page before the stream answers aborts it', async () => {
		const calls = held();
		const { unmount } = renderPage();
		await vi.waitFor(() => expect(calls).toHaveLength(1));

		unmount();

		expect(calls[0]?.controller?.signal.aborted).toBe(true);
	});

	it('switching sweeps before the first stream answers aborts it, and its late answer is ignored', async () => {
		const calls = held();
		renderPage();
		await vi.waitFor(() => expect(calls).toHaveLength(1));

		await viewSweep('sweep-new');
		await vi.waitFor(() => expect(calls).toHaveLength(2));
		expect(calls[0]?.controller?.signal.aborted).toBe(true);

		calls[1]?.answer(stream([{ sweep_id: 'sweep-new', verdict: 'adopted' }]));
		expect(await screen.findByText('sweep-new')).toBeTruthy();
		// The first request answers late, for the sweep that is no longer viewed.
		calls[0]?.answer(stream([{ sweep_id: 'sweep-old', verdict: 'rejected' }]));
		await new Promise((r) => setTimeout(r, 50));

		expect(screen.queryByText('sweep-old')).toBeNull();
		expect(screen.getByText('sweep-new')).toBeTruthy();
	});

	it('switching sweeps mid-stream stops the old stream showing its events', async () => {
		let push: (event: object) => void = () => {};
		const encoder = new TextEncoder();
		const slow = new ReadableStream<Uint8Array>({
			start(controller) {
				push = (e) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
			}
		});
		vi.mocked(api.streamTuneLog)
			.mockResolvedValueOnce([new Response(slow), new AbortController()])
			.mockResolvedValueOnce(stream([{ sweep_id: 'sweep-new' }]));
		renderPage();
		push({ sweep_id: 'sweep-old' });
		expect(await screen.findByText('sweep-old')).toBeTruthy();

		await viewSweep('sweep-new');
		expect(await screen.findByText('sweep-new')).toBeTruthy();
		// The old body keeps sending: the mock ignores the abort, as a buffered body would.
		push({ sweep_id: 'sweep-old-late' });
		await new Promise((r) => setTimeout(r, 50));

		expect(screen.queryByText('sweep-old-late')).toBeNull();
	});

	it('a refusal that arrives after switching sweeps does not show under the new one', async () => {
		const calls = held();
		renderPage();
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		let release: () => void = () => {};
		const late = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					release = () => {
						controller.enqueue(new TextEncoder().encode(JSON.stringify({ detail: 'Session expired' })));
						controller.close();
					};
				}
			}),
			{ status: 401 }
		);
		calls[0]?.answer([late, new AbortController()]);
		// The first stream is now reading its refusal's body when the switch comes.
		await new Promise((r) => setTimeout(r, 20));

		await viewSweep('sweep-new');
		await vi.waitFor(() => expect(calls).toHaveLength(2));
		release();
		await new Promise((r) => setTimeout(r, 50));

		expect(screen.queryByText('Session expired')).toBeNull();
	});

	it('a Start that answers after leaving the page opens no stream', async () => {
		vi.mocked(api.streamTuneLog).mockResolvedValue(stream([{ running: false }]));
		let started: (value: unknown) => void = () => {};
		vi.mocked(api.startTune).mockImplementation(() => new Promise((resolve) => (started = resolve)));
		const { unmount } = renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'Start sweep' }));
		await vi.waitFor(() => expect(api.startTune).toHaveBeenCalled());
		const before = vi.mocked(api.streamTuneLog).mock.calls.length;

		unmount();
		started({ started: true });
		await new Promise((r) => setTimeout(r, 50));

		expect(vi.mocked(api.streamTuneLog).mock.calls.length).toBe(before);
	});
});

describe('TunePage guard tiles', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
		vi.mocked(api.getServeProfiles).mockResolvedValue({ profiles: [] });
		vi.mocked(api.getTestOptions).mockResolvedValue({ tiers: ['smoke'], benchmarks: [], systems: [] });
		vi.mocked(api.getTuneGrids).mockResolvedValue({ grids: [] });
		vi.mocked(api.getRecentSweeps).mockResolvedValue({ sweeps: [] });
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	const tile = (label: string) => screen.getByText(label).parentElement as HTMLElement;

	it('warns on the Regressed tile when the guard found a regression', async () => {
		vi.mocked(api.streamTuneLog).mockResolvedValue(stream([{ sweep_id: 's1', guard: { n: 40, regressed: true } }]));
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: /^Correctness guard/ }));
		expect(await screen.findByText('Regressed?')).toBeTruthy();
		expect(tile('Regressed?').className).toContain('bg-danger/10');
		expect(within(tile('Regressed?')).getByText('Yes')).toBeTruthy();
		expect(tile('Only the winner passed').className).toContain('bg-muted/50');
	});

	it('leaves the Regressed tile plain when nothing regressed', async () => {
		vi.mocked(api.streamTuneLog).mockResolvedValue(stream([{ sweep_id: 's1', guard: { n: 40, regressed: false } }]));
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: /^Correctness guard/ }));
		expect(await screen.findByText('Regressed?')).toBeTruthy();
		expect(tile('Regressed?').className).toContain('bg-muted/50');
		expect(within(tile('Regressed?')).getByText('No')).toBeTruthy();
	});
});

// P4: the empty state (#919), the result banner and its links (#1055, B-D8),
// the one sweep picker in the address (#1054, NAV-1) and the form's help and checks.
describe('TunePage sweeps, results and form', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
		vi.mocked(api.getServeProfiles).mockResolvedValue({ profiles: ['qwen38', 'qwen36'] });
		vi.mocked(api.getTestOptions).mockResolvedValue({
			tiers: ['full', 'smoke', 'standard'],
			benchmarks: ['humanevalplus'],
			systems: []
		});
		vi.mocked(api.getTuneGrids).mockResolvedValue({ grids: ['qwen38'] });
		vi.mocked(api.getRecentSweeps).mockResolvedValue({ sweeps: [] });
		vi.mocked(api.streamTuneLog).mockResolvedValue(stream([{ running: false }]));
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	const finished = {
		sweep_id: '20261113T201502Z-7c1d',
		running: false,
		verdict: 'adopted',
		verdict_reason: '',
		profile: 'qwen38',
		tier: 'smoke',
		benchmark: null,
		budget_mode: 'interactive',
		item_count: 24,
		resumable: false,
		time: { cooling_share: 0.1175, pauses: 1 },
		rounds: [
			{ round: 1, stage: 'explore', item_from: 1, item_to: 6, survivors: 3, baseline_gen_tps: 3.61, drift_ratio: 1 }
		],
		candidates: [
			{ candidate_sha: 'a1', config_id: 'bd04a851', is_baseline: true, score: 0, score_pct: '+0.0%', status: 'active' },
			{
				candidate_sha: 'b2',
				config_id: '47714ce1',
				score: 0.2898,
				score_pct: '+33.6%',
				paired_items: 24,
				status: 'winner',
				overrides: { LLAMA_NGL: '22', LLAMA_UBATCH: '256' }
			},
			{
				candidate_sha: 'c3',
				config_id: 'c98ef02c',
				score: -0.05,
				score_pct: '-',
				paired_items: 6,
				status: 'eliminated',
				status_reason: 'bottom half of round 1'
			}
		],
		pauses: [],
		not_measured: [],
		blocked: [],
		guard: { n: 24, winner_passed: 19, incumbent_passed: 18, p: 1, regressed: false },
		design_audit: '### Checks\n\n| check | result |\n|---|---|\n| paired items | 24 |',
		adoption: { overrides: { LLAMA_NGL: '22', LLAMA_UBATCH: '256', LLAMA_FA: 'on' }, config_id: '47714ce1' }
	};

	it('says there are no sweeps yet, with no tiles, tables or phantom verdict, and opens the form (#919)', async () => {
		vi.mocked(api.streamTuneLog).mockResolvedValue(stream([{ error: 'llama-tune: no sweeps recorded' }]));
		renderPage();
		expect(await screen.findByText('No sweeps yet')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Start sweep' })).toBeTruthy();
		expect(screen.queryByRole('heading', { name: 'Rounds' })).toBeNull();
		expect(screen.queryByText(/running/i)).toBeNull();
		expect(screen.queryByText('llama-tune: no sweeps recorded')).toBeNull();
		expect((screen.getByRole('combobox', { name: 'Sweep' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('treats a refresh that finds no sweeps as the empty state, not a failure', async () => {
		vi.mocked(api.getTuneStatus).mockRejectedValue('llama-tune: no sweeps recorded');
		renderPage();
		await screen.findByRole('button', { name: 'Start sweep' });
		await vi.waitFor(() =>
			expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false)
		);
		fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(await screen.findByText('No sweeps yet')).toBeTruthy();
		expect(screen.queryByText("Couldn't follow the sweep")).toBeNull();
	});

	it('says a linked sweep is gone and offers the latest (NAV-3)', async () => {
		vi.mocked(api.streamTuneLog).mockResolvedValue(stream([{ error: "llama-tune: no sweep 'gone'" }]));
		renderPage('/benchmarks/tune?sweep=gone');
		expect(await screen.findByText('No sweep gone')).toBeTruthy();
		expect(api.streamTuneLog).toHaveBeenCalledWith('test-token', 'gone', expect.any(AbortController));
		fireEvent.click(screen.getByRole('button', { name: 'Show the latest sweep' }));
		await vi.waitFor(() => expect(router.state.location.search).toBe(''));
		await vi.waitFor(() =>
			expect(api.streamTuneLog).toHaveBeenLastCalledWith('test-token', null, expect.any(AbortController))
		);
	});

	it('leads a finished sweep with its outcome and the links that act on it (#1055, B-D8)', async () => {
		vi.mocked(api.streamTuneLog).mockResolvedValue(stream([finished]));
		renderPage();
		const result = await screen.findByRole('region', { name: 'Result' });
		expect(within(result).getByText('Adopted')).toBeTruthy();
		expect(within(result).getByRole('heading', { name: 'Adopt ngl 22, ubatch 256, fa on' })).toBeTruthy();
		expect(result.textContent).toContain('Generation +33.6% against the profile');
		expect(result.textContent).toContain('19 passed against the baseline');
		const serve = within(result).getByRole('link', { name: 'Serve with these overrides' });
		expect(serve.getAttribute('href')).toBe('/benchmarks/serve?profile=qwen38&ngl=22');
		const version = new URL(
			within(result).getByRole('link', { name: 'Create profile version' }).getAttribute('href') ?? '',
			'http://x'
		);
		expect(version.pathname).toBe('/benchmarks/serve');
		expect(Object.fromEntries(version.searchParams)).toEqual({
			edit: 'qwen38',
			'def.ngl': '22',
			'def.ubatch': '256',
			note: 'From Tune sweep 20261113T201502Z-7c1d: ngl 22, ubatch 256, fa on'
		});
		expect(within(result).getByRole('link', { name: 'Compare' }).getAttribute('href')).toBe(
			'/benchmarks/compare?by=config&baseline=bd04a851'
		);
		expect(result.textContent).toContain('Serve takes GPU layers only; micro-batch needs a new profile version.');
		expect(result.textContent).toContain('flash attention has no profile field');
		// The form folds away once a sweep is shown (#1114); statuses are badges, cooling a percentage.
		expect(screen.queryByRole('button', { name: 'Start sweep' })).toBeNull();
		expect(screen.getByText('Winner')).toBeTruthy();
		expect(screen.getByText('Eliminated')).toBeTruthy();
		expect(screen.getByText('bottom half of round 1')).toBeTruthy();
		expect(screen.getByText('11.8%')).toBeTruthy();
		expect(screen.getByRole('region', { name: 'Rounds' })).toBeTruthy();
		expect(screen.getByRole('region', { name: 'Candidates' })).toBeTruthy();
		// The sweep picker shows the sweep in view, though the recent list does not hold it.
		expect(screen.getByRole('combobox', { name: 'Sweep' }).textContent).toContain('20261113T201502Z-7c1d');
	});

	it('shows the design audit as rendered text, and the pauses table, inside their disclosures (#917)', async () => {
		const pause = {
			pause_id: 3,
			trigger_kind: 'drift',
			round: 2,
			temp_before: 86,
			temp_after: 71,
			resolution: 'recovered'
		};
		vi.mocked(api.streamTuneLog).mockResolvedValue(stream([{ ...finished, pauses: [pause] }]));
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: /^Design audit/ }));
		await vi.waitFor(() => expect(document.querySelector('.rich-text table')).not.toBeNull());
		expect(document.querySelector('.rich-text')?.innerHTML).toContain('Checks');
		fireEvent.click(screen.getByRole('button', { name: /^Pauses/ }));
		expect(screen.getByRole('region', { name: 'Pauses' })).toBeTruthy();
		expect(screen.getByText('86.0 → 71.0')).toBeTruthy();
	});

	it('names every verdict in words, never a phantom "running"', async () => {
		const cases: [Record<string, unknown>, string, string][] = [
			[{ running: true, verdict: null }, 'In progress', 'The sweep is running'],
			[
				{ verdict: 'rejected', verdict_reason: 'no candidate beat the profile defaults' },
				'No change',
				"Keep the profile's settings"
			],
			[{ verdict: 'incomplete', resumable: true }, 'Incomplete', 'The sweep stopped before the end'],
			[{ verdict: 'indeterminate' }, 'No verdict', 'The sweep could not decide'],
			[{ verdict: null }, 'In progress', 'No verdict recorded']
		];
		for (const [over, badge, headline] of cases) {
			vi.mocked(api.streamTuneLog).mockResolvedValue(
				stream([{ ...finished, adoption: null, guard: null, candidates: [], ...over }])
			);
			renderPage();
			const result = await screen.findByRole('region', { name: 'Result' });
			expect(within(result).getByText(badge)).toBeTruthy();
			expect(within(result).getByRole('heading', { name: headline })).toBeTruthy();
			expect(within(result).queryByRole('link')).toBeNull();
			cleanup();
		}
	});

	it('shows the candidate being measured while a sweep runs', async () => {
		vi.mocked(api.streamTuneLog).mockResolvedValue(
			stream([
				{
					...finished,
					running: true,
					verdict: null,
					adoption: null,
					current_visit: { candidate_sha: 'b2', elapsed_seconds: 412, tokens_per_second: 3.87, n_gen: 1594 }
				}
			])
		);
		renderPage();
		expect(await screen.findByText('Measuring b2')).toBeTruthy();
		expect(screen.getByText('6m 52s · 3.9 tokens/s, 1,594 tokens generated')).toBeTruthy();
		expect(screen.getByText('Measuring, 6m 52s')).toBeTruthy();
	});

	it('opens a sweep from the one picker, in the address, and Back returns to the latest (#1054, NAV-1)', async () => {
		vi.mocked(api.getRecentSweeps).mockResolvedValue({
			sweeps: [
				{ sweep_id: 's-new', started_at: 1794600000, profile: 'qwen38', tier: 'smoke', verdict: 'running' },
				{ sweep_id: 's-old', started_at: 1794500000, profile: 'qwen36', tier: 'standard', verdict: 'rejected' }
			]
		});
		vi.mocked(api.streamTuneLog).mockResolvedValue(stream([{ ...finished, sweep_id: 's-new' }]));
		renderPage();
		const picker = await screen.findByRole('combobox', { name: 'Sweep' });
		await vi.waitFor(() => expect(picker.textContent).toContain('qwen38 / smoke · In progress'));
		fireEvent.keyDown(picker, { key: 'Enter' });
		fireEvent.click(await screen.findByRole('option', { name: /qwen36 \/ standard · No change/ }));
		await vi.waitFor(() => expect(router.state.location.search).toBe('?sweep=s-old'));
		await vi.waitFor(() =>
			expect(api.streamTuneLog).toHaveBeenLastCalledWith('test-token', 's-old', expect.any(AbortController))
		);

		await act(() => router.navigate(-1));
		await vi.waitFor(() =>
			expect(api.streamTuneLog).toHaveBeenLastCalledWith('test-token', null, expect.any(AbortController))
		);
	});

	it('resolves the defaults in the labels and says what each budget allows (#1054)', async () => {
		vi.mocked(profilesApi.listProfiles).mockResolvedValue([
			{ profile: { name: 'qwen38', is_default: true } },
			{ profile: { name: 'qwen36', is_default: false } }
		] as never);
		renderPage();
		await vi.waitFor(() =>
			expect(screen.getByRole('combobox', { name: 'Profile' }).textContent).toBe('Default (qwen38)')
		);
		expect(screen.getByRole('combobox', { name: 'Benchmark' }).textContent).toBe('All benchmarks');
		expect(screen.getByRole('combobox', { name: 'System prompt' }).textContent).toBe('No system prompt');
		expect(screen.getByRole('combobox', { name: 'Grid' }).textContent).toBe("The profile's (qwen38)");
		expect(screen.getByText('Up to 2 hours, 6 candidates.')).toBeTruthy();
		expect(screen.getByLabelText('Candidates (optional)').getAttribute('placeholder')).toBe('Auto: 6');

		// Tiers by cost, whatever order the server lists them in (B-D1).
		fireEvent.keyDown(screen.getByRole('combobox', { name: 'Tier' }), { key: 'Enter' });
		const tiers = (await screen.findAllByRole('option')).map((o) => o.textContent);
		expect(tiers).toEqual(['smoke', 'standard', 'full']);
		fireEvent.keyDown(screen.getByRole('option', { name: 'smoke' }), { key: 'Escape' });

		fireEvent.keyDown(screen.getByRole('combobox', { name: 'Budget' }), { key: 'Enter' });
		fireEvent.click(await screen.findByRole('option', { name: 'Overnight' }));
		expect(await screen.findByText('Up to 8 hours, 16 candidates.')).toBeTruthy();
		expect(screen.getByLabelText('Candidates (optional)').getAttribute('placeholder')).toBe('Auto: 16');
	});

	it('checks the numbers on leaving a field and on Start, and sends explore alone without refine (FRM-2)', async () => {
		vi.mocked(api.startTune).mockResolvedValue({ started: true });
		renderPage();
		const eta = await screen.findByLabelText('Keep 1 in (eta)');
		fireEvent.change(eta, { target: { value: '1' } });
		expect(eta.getAttribute('aria-invalid')).toBeNull();
		fireEvent.blur(eta);
		expect(await screen.findByText('Enter a whole number of at least 2.')).toBeTruthy();
		expect(eta.getAttribute('aria-invalid')).toBe('true');

		fireEvent.change(screen.getByLabelText('Candidates (optional)'), { target: { value: 'six' } });
		fireEvent.click(screen.getByRole('button', { name: 'Start sweep' }));
		expect(api.startTune).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(screen.getByLabelText('Candidates (optional)'));

		fireEvent.change(screen.getByLabelText('Candidates (optional)'), { target: { value: '' } });
		fireEvent.change(eta, { target: { value: '3' } });
		fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '' } });
		fireEvent.click(screen.getByRole('button', { name: 'Start sweep' }));
		expect(await screen.findByText('Enter a seed, a whole number of at least 0.')).toBeTruthy();
		fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '4' } });
		fireEvent.click(screen.getByLabelText('Refine the leader after exploring'));
		fireEvent.click(screen.getByRole('button', { name: 'Start sweep' }));
		await vi.waitFor(() => expect(api.startTune).toHaveBeenCalled());
		expect(vi.mocked(api.startTune).mock.calls[0][1]).toMatchObject({
			tier: 'smoke',
			budget: 'interactive',
			eta: 3,
			seed: 4,
			candidates: undefined,
			stages: ['explore']
		});
	});
});
