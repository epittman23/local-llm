import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/apis/benchmarks';
import * as profilesApi from '@/lib/apis/benchmarks/profiles';
import { useAuthStore } from '@/lib/stores/authStore';
import { PrescreenPage } from './PrescreenPage';

vi.mock('@/lib/apis/benchmarks', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks')>();
	return {
		...real,
		getServeProfiles: vi.fn(),
		getPrescreenGrids: vi.fn(),
		getPrescreenSweeps: vi.fn(),
		getPrescreenSweep: vi.fn(),
		getPrescreenDashboard: vi.fn(),
		startPrescreen: vi.fn(),
		cancelPrescreen: vi.fn(),
		startPrescreenDashboard: vi.fn(),
		stopPrescreenDashboard: vi.fn(),
		streamPrescreen: vi.fn()
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

const sweep = (status: string) => ({
	sweep_id: '1793-abc',
	status,
	status_reason: status === 'cancelled' ? 'cancelled' : null,
	profile: 'qwen38',
	sampler: 'grid',
	objective: 'tg',
	study_name: 'prescreen-1793-abc',
	grid_path: 'data/prescreen/qwen38.toml',
	model_file: 'Qwen3.8-27B-UD-Q3_K_XL.gguf',
	build_commit: 'f0fb5984b',
	build_number: 11875,
	gpu_info: 'Synthetic GPU',
	driver_version: '590.48.01',
	n_prompt: 512,
	n_gen: 128,
	reps: 5
});

const point = (id: number, status: string, over: Record<string, unknown> = {}) => ({
	point_id: id,
	phase: 'search',
	optuna_trial_number: id - 1,
	remeasure_of: null,
	overrides: { LLAMA_NGL: String(18 + id * 2) },
	status,
	reason: status === 'pruned' ? 'needs more VRAM than point 2, which ran out' : null,
	tg_avg_ts: status === 'ok' ? 5 + id : null,
	tg_stddev_ts: status === 'ok' ? 0.1 : null,
	pp_avg_ts: status === 'ok' ? 100 : null,
	pp_stddev_ts: status === 'ok' ? 2 : null,
	peak_vram_mib: status === 'ok' ? 5100 : null,
	...over
});

const detail = (status: string, extra: Record<string, unknown> = {}) => ({
	sweep: sweep(status),
	points: [point(1, 'ok'), point(2, 'oom'), point(3, 'pruned')],
	candidates: [
		{
			point_id: 1,
			rank: 1,
			is_baseline: true,
			changes: {},
			tg: 6.04,
			pp: 100,
			measurements: 2,
			peak_vram_mib: 5100,
			ctx_check: 'ok',
			ctx_check_free_mib: 912,
			ctx_check_reason: null
		}
	],
	running: false,
	active: null,
	last_error: null,
	...extra
});

const stream = (events: object[]) => {
	const body = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}event: done\ndata: {}\n\n`;
	return [new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), new AbortController()] as [
		Response,
		AbortController
	];
};

/** The page at `path`, in a router so `?sweep=` and the candidate links work. */
let router: ReturnType<typeof createMemoryRouter>;
const renderPage = (path = '/benchmarks/prescreen') => {
	router = createMemoryRouter([{ path: '/benchmarks/*', element: <PrescreenPage /> }], { initialEntries: [path] });
	return render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
};
/** Opens the folded New pre-screen form. */
const openForm = () => fireEvent.click(screen.getByRole('button', { name: /^New pre-screen/ }));

describe('PrescreenPage', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
		vi.mocked(profilesApi.listProfiles).mockResolvedValue([
			{ profile: { name: 'qwen38', is_default: true } },
			{ profile: { name: 'qwen36', is_default: false } }
		] as never);
		vi.mocked(api.getServeProfiles).mockResolvedValue({ profiles: ['qwen38', 'qwen36'] });
		vi.mocked(api.getPrescreenGrids).mockResolvedValue({
			grids: [{ name: 'qwen38', profile: 'qwen38', knobs: { LLAMA_NGL: [16, 20] }, combinations: 40 }]
		});
		vi.mocked(api.getPrescreenSweeps).mockResolvedValue({
			sweeps: [sweep('done')],
			running: false,
			active: null,
			last_error: null
		});
		vi.mocked(api.getPrescreenSweep).mockResolvedValue(detail('done'));
		vi.mocked(api.getPrescreenDashboard).mockResolvedValue({
			running: false,
			url: 'http://127.0.0.1:8091/dashboard',
			port: 8091
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	it('names a sweep the address asks for that does not exist, and offers the latest (NAV-3)', async () => {
		vi.mocked(api.getPrescreenSweep).mockImplementation(async (_token, id) => (id === 'gone' ? null : detail('done')));
		renderPage('/benchmarks/prescreen?sweep=gone');
		// NAV-3: the in-place Gone panel, naming the id it was asked for.
		expect(await screen.findByRole('heading', { name: 'This pre-screen no longer exists' })).toBeTruthy();
		expect(screen.getByText('gone').closest('[data-slot="gone"]')).toBeTruthy();
		expect(screen.queryByText("Couldn't load the pre-screen")).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Show the latest pre-screen' }));
		await waitFor(() => expect(api.getPrescreenSweep).toHaveBeenCalledWith('test-token', '1793-abc'));
		expect(router.state.location.search).toBe('');
		expect(await screen.findByText("The profile's settings")).toBeTruthy();
		expect(screen.queryByRole('heading', { name: 'This pre-screen no longer exists' })).toBeNull();
	});

	it('treats a sweep that vanishes while streaming as missing', async () => {
		const running = detail('running');
		vi.mocked(api.getPrescreenSweep)
			.mockResolvedValueOnce({ ...running, running: true })
			.mockResolvedValue(null);
		vi.mocked(api.streamPrescreen).mockResolvedValue(stream([]));
		renderPage('/benchmarks/prescreen?sweep=1793-abc');
		expect(await screen.findByRole('heading', { name: 'This pre-screen no longer exists' })).toBeTruthy();
		expect(screen.getByText('1793-abc').closest('[data-slot="gone"]')).toBeTruthy();
	});

	it('shows the latest sweep, labelled as raw llama-bench throughput', async () => {
		renderPage();
		expect(
			await screen.findByText(
				'Candidates, raw llama-bench throughput (not a serving measurement): confirm with a full Tests run'
			)
		).toBeTruthy();
		expect(api.getPrescreenSweep).toHaveBeenCalledWith('test-token', '1793-abc');
		expect(screen.getByText("The profile's settings")).toBeTruthy();
		expect(screen.getByText('6.04')).toBeTruthy();
		expect(screen.getByText('(912 MiB free)')).toBeTruthy();
		expect(screen.getByText('f0fb5984b (11875)')).toBeTruthy();
		expect(screen.getByText('needs more VRAM than point 2, which ran out')).toBeTruthy();
		expect(screen.getByText('Points (3)')).toBeTruthy();
		// Both tables scroll in the shared, labelled container on a narrow screen (#1062).
		for (const name of ['Candidates', 'Points']) {
			expect(screen.getByRole('region', { name }).getAttribute('data-slot')).toBe('table-container');
		}
		expect(api.streamPrescreen).not.toHaveBeenCalled();
		expect(screen.getByText('Cancel pre-screen is for one that is running.')).toBeTruthy();
	});

	it('starts a pre-screen with the form, and follows it live', async () => {
		vi.mocked(api.startPrescreen).mockResolvedValue({ started: true, sweep_id: '1793-abc' });
		vi.mocked(api.getPrescreenSweep)
			.mockResolvedValueOnce(detail('done'))
			.mockResolvedValueOnce(detail('running', { running: true }))
			.mockResolvedValue(detail('done'));
		const current = { point_id: 4, phase: 'search', overrides: { LLAMA_NGL: '22', LLAMA_THREADS: '8' } };
		vi.mocked(api.streamPrescreen).mockResolvedValue(
			stream([detail('running', { running: true, active: { sweep_id: '1793-abc', current } })])
		);
		renderPage();
		await screen.findByText('Points (3)');

		openForm();
		fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '7' } });
		fireEvent.click(screen.getByRole('button', { name: 'Start pre-screen' }));

		await waitFor(() => expect(api.startPrescreen).toHaveBeenCalled());
		expect(vi.mocked(api.startPrescreen).mock.calls[0][1]).toEqual({
			profile: undefined,
			grid: undefined,
			sampler: 'auto',
			objective: 'tg',
			trials: undefined,
			seed: 7,
			ctx_checks: 3,
			point_timeout: 900,
			n_prompt: 512,
			n_gen: 128,
			reps: 5
		});
		await waitFor(() => expect(api.streamPrescreen).toHaveBeenCalledWith('test-token', '1793-abc'));
		// The stream ends, and the page reads the sweep's final state.
		await waitFor(() => expect(api.getPrescreenSweep).toHaveBeenCalledTimes(3));
	});

	it('shows a refusal from the backend', async () => {
		vi.mocked(api.startPrescreen).mockRejectedValue('a model is being served from the Serve page');
		renderPage();
		await screen.findByText('Points (3)');
		openForm();
		fireEvent.click(screen.getByRole('button', { name: 'Start pre-screen' }));
		expect(await screen.findByText('a model is being served from the Serve page')).toBeTruthy();
	});

	it('cancels a running pre-screen only after confirming', async () => {
		const running = detail('running', {
			running: true,
			active: { sweep_id: '1793-abc', current: { point_id: 4, phase: 'ctx_check', overrides: { LLAMA_NGL: '22' } } }
		});
		vi.mocked(api.getPrescreenSweeps).mockResolvedValue({
			sweeps: [sweep('running')],
			running: true,
			active: running.active,
			last_error: null
		});
		vi.mocked(api.getPrescreenSweep).mockResolvedValue(running);
		vi.mocked(api.streamPrescreen).mockResolvedValue([null, new AbortController()]);
		vi.mocked(api.cancelPrescreen).mockResolvedValue({ cancelling: true });
		renderPage();

		expect(await screen.findByText('Load-checking point 4: ngl 22', { exact: false })).toBeTruthy();
		expect(await screen.findByText('Failed to start the live stream')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel pre-screen' }));
		expect(api.cancelPrescreen).not.toHaveBeenCalled();
		const dialog = await screen.findByRole('alertdialog');
		fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel pre-screen' }));
		await waitFor(() => expect(api.cancelPrescreen).toHaveBeenCalledWith('test-token'));
	});

	it('starts and stops the loopback dashboard', async () => {
		vi.mocked(api.startPrescreenDashboard).mockResolvedValue({
			running: true,
			url: 'http://127.0.0.1:8091/dashboard',
			port: 8091
		});
		renderPage();
		expect(await screen.findByText('stopped')).toBeTruthy();
		expect(screen.getByText('ssh -L 8091:127.0.0.1:8091')).toBeTruthy();

		vi.mocked(api.getPrescreenDashboard).mockResolvedValue({
			running: true,
			url: 'http://127.0.0.1:8091/dashboard',
			port: 8091
		});
		fireEvent.click(screen.getByRole('button', { name: 'Start dashboard' }));
		await waitFor(() => expect(api.startPrescreenDashboard).toHaveBeenCalled());
		const link = await screen.findByRole('link', { name: 'http://127.0.0.1:8091/dashboard' });
		expect(link.getAttribute('href')).toBe('http://127.0.0.1:8091/dashboard');

		vi.mocked(api.stopPrescreenDashboard).mockRejectedValue('port 8091 is already in use');
		fireEvent.click(screen.getByRole('button', { name: 'Stop dashboard' }));
		expect(await screen.findByText('port 8091 is already in use')).toBeTruthy();
	});

	it('reconnects while the sweep still runs, and stops once it ends', async () => {
		const running = detail('running', { running: true });
		vi.mocked(api.getPrescreenSweeps).mockResolvedValue({
			sweeps: [sweep('running')],
			running: true,
			active: null,
			last_error: null
		});
		vi.mocked(api.getPrescreenSweep)
			.mockResolvedValueOnce(running) // on arrival
			.mockResolvedValueOnce(running) // after the first response ends: still running
			.mockResolvedValue(detail('done')); // after the second
		const reconnect = () =>
			[
				new Response(`data: ${JSON.stringify(running)}\n\nevent: reconnect\ndata: {}\n\n`, {
					headers: { 'Content-Type': 'text/event-stream' }
				}),
				new AbortController()
			] as [Response, AbortController];
		vi.mocked(api.streamPrescreen)
			.mockImplementationOnce(async () => reconnect())
			.mockResolvedValue(stream([]));
		renderPage();
		await waitFor(() => expect(api.streamPrescreen).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(api.getPrescreenSweep).toHaveBeenCalledTimes(3));
		expect(await screen.findByText('Done')).toBeTruthy();
		expect(api.streamPrescreen).toHaveBeenCalledTimes(2);
	});

	it("shows a stopped dashboard's last output", async () => {
		vi.mocked(api.getPrescreenDashboard).mockResolvedValue({
			running: false,
			url: 'http://127.0.0.1:8091/dashboard',
			port: 8091,
			last_output: 'RuntimeError: password authentication failed'
		});
		renderPage();
		expect(await screen.findByText('Its last output: RuntimeError: password authentication failed')).toBeTruthy();
	});

	it("shows a point's status as a badge, and an unknown status as an error (DAT-3)", async () => {
		vi.mocked(api.getPrescreenSweep).mockResolvedValue({
			...detail('done'),
			points: [point(1, 'ok'), point(2, 'oom'), point(3, 'pruned'), point(4, 'exploded')]
		});
		renderPage();
		await screen.findByText('Points (4)');
		const badge = (name: string) => within(screen.getByRole('region', { name: 'Points' })).getByText(name);
		expect(badge('Measured').getAttribute('data-variant')).toBe('success');
		expect(badge('Out of memory').getAttribute('data-variant')).toBe('danger');
		expect(badge('Skipped: pruned').getAttribute('data-variant')).toBe('secondary');
		expect(badge('exploded').getAttribute('data-variant')).toBe('danger');
	});
});

// P4: the default grid's summary, the sampler's fields and help (#1113), the
// load-check badges and candidate links (B-D8), and ?sweep= (NAV-1).
describe('PrescreenPage form, candidates and address', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
		vi.mocked(profilesApi.listProfiles).mockResolvedValue([{ profile: { name: 'qwen38', is_default: true } }] as never);
		vi.mocked(api.getServeProfiles).mockResolvedValue({ profiles: ['qwen38', 'qwen36'] });
		vi.mocked(api.getPrescreenGrids).mockResolvedValue({
			grids: [
				{
					name: 'qwen38',
					profile: 'qwen38',
					knobs: { LLAMA_NGL: [16, 20], LLAMA_BATCH: [512, 1024] },
					combinations: 40
				},
				{ name: 'qwen36', profile: 'qwen36', knobs: { LLAMA_NGL: [1] }, combinations: 400 },
				{ name: 'broken', error: 'this grid is invalid; the backend log has the reason' }
			]
		});
		vi.mocked(api.getPrescreenSweeps).mockResolvedValue({ sweeps: [], running: false, active: null, last_error: null });
		vi.mocked(api.getPrescreenSweep).mockResolvedValue(detail('done'));
		vi.mocked(api.getPrescreenDashboard).mockResolvedValue({ running: false, url: '', port: 8091 });
	});

	afterEach(() => {
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	const choose = async (field: string, option: string | RegExp) => {
		fireEvent.keyDown(screen.getByRole('combobox', { name: field }), { key: 'Enter' });
		fireEvent.click(await screen.findByRole('option', { name: option }));
	};

	it('says there is nothing yet, opens the form, and resolves the default grid with its summary (#1113)', async () => {
		renderPage();
		expect(await screen.findByText('No pre-screens yet')).toBeTruthy();
		await waitFor(() => expect(screen.getByRole('combobox', { name: 'Profile' }).textContent).toBe('Default (qwen38)'));
		expect(screen.getByRole('combobox', { name: 'Grid' }).textContent).toBe("The profile's (qwen38)");
		expect(
			screen.getByText('40 combinations before constraints, over ngl, batch; each point runs 5 times.')
		).toBeTruthy();
		expect(screen.getByRole('combobox', { name: 'Sampler' }).textContent).toBe('Auto');
		// Auto measures a 40-point grid point by point: no trial budget applies.
		const trials = screen.getByLabelText('Trials') as HTMLInputElement;
		expect(trials.disabled).toBe(true);
		expect(screen.getByText('Not used: this grid has 40 points, so Auto measures them all.')).toBeTruthy();

		fireEvent.change(screen.getByLabelText('Repetitions (-r)'), { target: { value: '1' } });
		expect(
			screen.getByText('40 combinations before constraints, over ngl, batch; each point runs 1 time.')
		).toBeTruthy();

		await choose('Grid', 'qwen36');
		expect(trials.disabled).toBe(false);
		expect(screen.getByText('How many points TPE measures.')).toBeTruthy();
		await choose('Sampler', 'Grid');
		expect(trials.disabled).toBe(true);
		expect(screen.getByText('Not used: Grid measures every point.')).toBeTruthy();
		await choose('Sampler', 'TPE');
		expect(trials.disabled).toBe(false);
		expect(screen.getByText("Optuna's TPE sampler proposes the number of trials set below.")).toBeTruthy();
		await choose('Objective', 'Both');
		expect(screen.getByText('Ranks candidates by both, as a Pareto front.')).toBeTruthy();
		await choose('Grid', 'broken');
		expect(screen.getByText('broken: this grid is invalid; the backend log has the reason')).toBeTruthy();
	});

	it('does not let a disabled Trials stop Start, and sends Trials only when TPE uses it', async () => {
		vi.mocked(api.startPrescreen).mockResolvedValue({ started: true, sweep_id: '1794-new' });
		renderPage();
		await screen.findByText('No pre-screens yet');
		await choose('Sampler', 'TPE');
		fireEvent.change(screen.getByLabelText('Trials'), { target: { value: 'abc' } });
		await choose('Sampler', 'Auto');
		fireEvent.click(screen.getByRole('button', { name: 'Start pre-screen' }));
		await waitFor(() => expect(api.startPrescreen).toHaveBeenCalledTimes(1));
		expect(vi.mocked(api.startPrescreen).mock.calls[0][1]).toMatchObject({ sampler: 'auto', trials: undefined });

		// A start folds the form; open it again for the next.
		await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Sampler' })).toBeNull());
		openForm();
		await choose('Sampler', 'TPE');
		fireEvent.change(screen.getByLabelText('Trials'), { target: { value: '60' } });
		fireEvent.click(screen.getByRole('button', { name: 'Start pre-screen' }));
		await waitFor(() => expect(api.startPrescreen).toHaveBeenCalledTimes(2));
		expect(vi.mocked(api.startPrescreen).mock.calls[1][1]).toMatchObject({ sampler: 'tpe', trials: 60 });
	});

	it('checks the numbers before starting (FRM-2)', async () => {
		renderPage();
		await screen.findByText('No pre-screens yet');
		fireEvent.change(screen.getByLabelText('Repetitions (-r)'), { target: { value: '0' } });
		fireEvent.click(screen.getByRole('button', { name: 'Start pre-screen' }));
		expect(await screen.findByText('Enter a whole number of at least 1.')).toBeTruthy();
		expect(screen.getByLabelText('Repetitions (-r)').getAttribute('aria-invalid')).toBe('true');
		expect(api.startPrescreen).not.toHaveBeenCalled();
	});

	it('shows load checks as badges and offers each candidate to Serve or as a profile version (B-D8)', async () => {
		vi.mocked(api.getPrescreenSweeps).mockResolvedValue({
			sweeps: [{ ...sweep('done'), started_at: 1794780600 }],
			running: false,
			active: null,
			last_error: null
		});
		const cand = (rank: number, changes: Record<string, string>, ctx_check: string | null, reason: string | null) => ({
			point_id: rank + 10,
			rank,
			is_baseline: false,
			changes,
			tg: 3.9,
			pp: 79.4,
			measurements: 3,
			peak_vram_mib: 5790,
			ctx_check,
			ctx_check_free_mib: null,
			ctx_check_reason: reason
		});
		vi.mocked(api.getPrescreenSweep).mockResolvedValue({
			...detail('done'),
			candidates: [
				cand(1, { ngl: '22', batch: '1024' }, 'oom_at_ctx', 'out of memory at -c 16384'),
				cand(2, { batch: '512' }, null, null),
				cand(3, { ngl: '18' }, 'timeout', null)
			]
		});
		renderPage();
		const table = await screen.findByRole('region', { name: 'Candidates' });
		expect(within(table).getByText('Out of memory').getAttribute('data-variant')).toBe('danger');
		expect(within(table).getByText('out of memory at -c 16384')).toBeTruthy();
		expect(within(table).getByText('Not checked')).toBeTruthy();
		expect(within(table).getByText('Timed out').getAttribute('data-variant')).toBe('warning');
		expect(within(table).getAllByText('5,790')).toHaveLength(3);

		const serve = within(table).getByRole('link', { name: 'Serve with these overrides, candidate 1' });
		expect(serve.getAttribute('href')).toBe('/benchmarks/serve?profile=qwen38&ngl=22');
		const version = new URL(
			within(table).getByRole('link', { name: 'Create version of qwen38, candidate 1' }).getAttribute('href') ?? '',
			'http://x'
		);
		expect(Object.fromEntries(version.searchParams)).toEqual({
			edit: 'qwen38',
			'def.ngl': '22',
			'def.batch': '1024',
			note: 'From pre-screen 1793-abc, candidate 1: ngl 22, batch 1024'
		});
		// Batch alone is not a Serve override.
		expect(within(table).queryByRole('link', { name: 'Serve with these overrides, candidate 2' })).toBeNull();
		expect(within(table).getByRole('link', { name: 'Create version of qwen38, candidate 2' })).toBeTruthy();
		expect(screen.getByRole('combobox', { name: 'Pre-screen' }).textContent).toContain(
			'qwen38 · Grid / Generation · Done'
		);
		// In the row the actions are short, on one line, and keep the whole action in their names.
		expect(serve.textContent).toBe('Serve');
		expect(within(table).getAllByText('Create version')).toHaveLength(3);
		// WRD-2: the tiles say how it searched in words, and the long tables keep their headings in view (#1114).
		expect(screen.getByText('Grid / Generation', { selector: 'dd, dd *, p, span, div' })).toBeTruthy();
		expect(table.querySelector('table')?.getAttribute('data-sticky-header')).toBe('true');
		expect(
			screen.getByRole('region', { name: 'Points' }).querySelector('table')?.getAttribute('data-sticky-header')
		).toBe('true');
	});

	it('shows the sweep in the address, and a pick adds a history entry (NAV-1, #1045)', async () => {
		vi.mocked(api.getPrescreenSweeps).mockResolvedValue({
			sweeps: [sweep('done'), { ...sweep('cancelled'), sweep_id: '1792-old' }],
			running: false,
			active: null,
			last_error: null
		});
		renderPage('/benchmarks/prescreen?sweep=1792-old');
		await waitFor(() => expect(api.getPrescreenSweep).toHaveBeenCalledWith('test-token', '1792-old'));
		expect(api.getPrescreenSweep).not.toHaveBeenCalledWith('test-token', '1793-abc');

		await act(() => router.navigate('/benchmarks/prescreen'));
		await waitFor(() => expect(api.getPrescreenSweep).toHaveBeenCalledWith('test-token', '1793-abc'));

		vi.mocked(api.getPrescreenSweep).mockResolvedValue({
			...detail('done'),
			sweep: { ...sweep('cancelled'), sweep_id: '1792-old' }
		});
		await screen.findByText('Points (3)');
		await choose('Pre-screen', /Cancelled/);
		await waitFor(() => expect(router.state.location.search).toBe('?sweep=1792-old'));
	});
});

describe('Pre-screen words', () => {
	it('names a point phase and the search in words (WRD-2)', async () => {
		const { phaseText, searchText } = await import('./PrescreenPage');
		expect(phaseText('search')).toBe('Search');
		expect(phaseText('remeasure', 4)).toBe('Again (point 4)');
		expect(phaseText('later')).toBe('later');
		expect(searchText('tpe', 'both')).toBe('TPE / Both');
		expect(searchText('new', 'pp')).toBe('new / Prompt processing');
	});
});
