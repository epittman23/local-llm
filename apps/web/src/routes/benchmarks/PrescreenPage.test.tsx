import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/apis/benchmarks';
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

const renderPage = () =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<PrescreenPage />
		</QueryClientProvider>
	);

describe('PrescreenPage', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
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

	it('shows the latest sweep, labelled as raw llama-bench throughput', async () => {
		renderPage();
		expect(
			await screen.findByText(
				'Candidates, raw llama-bench throughput (not a serving measurement): confirm with a full Tests run'
			)
		).toBeTruthy();
		expect(api.getPrescreenSweep).toHaveBeenCalledWith('test-token', '1793-abc');
		expect(screen.getByText('(profile defaults)')).toBeTruthy();
		expect(screen.getByText('6.04')).toBeTruthy();
		expect(screen.getByText('(912 MiB free)')).toBeTruthy();
		expect(screen.getByText('f0fb5984b (11875)')).toBeTruthy();
		expect(screen.getByText('— needs more VRAM than point 2, which ran out')).toBeTruthy();
		expect(screen.getByText('Points (3)')).toBeTruthy();
		expect(api.streamPrescreen).not.toHaveBeenCalled();
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

		fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '7' } });
		fireEvent.click(screen.getByRole('button', { name: 'Start' }));

		await waitFor(() => expect(api.startPrescreen).toHaveBeenCalled());
		expect(vi.mocked(api.startPrescreen).mock.calls[0][1]).toEqual({
			profile: undefined,
			grid: undefined,
			sampler: 'auto',
			objective: 'tg',
			trials: 40,
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
		fireEvent.click(screen.getByRole('button', { name: 'Start' }));
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
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
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
});
