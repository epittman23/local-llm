import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { figure, LivePage, Sparkline, throughput } from './LivePage';

vi.mock('@/lib/apis/benchmarks', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks')>();
	return { ...real, getLive: vi.fn(), killLive: vi.fn() };
});

const now = Math.floor(Date.now() / 1000);
const samples = (from: number) =>
	Array.from({ length: 12 }, (_, i) => ({
		sample_id: from + i,
		at: now - 120 + (from + i) * 5,
		util_pct: 90 + (i % 5),
		mem_used_mib: 5571 + i,
		mem_total_mib: 6144,
		power_w: 71.25 + i,
		sm_mhz: 1650,
		temp_c: 68 + (i % 3)
	}));
const recording = (from = 0) => ({
	run: { run_id: 12, model: 'qwen3.8-27b', config_id: 'c98ef02c', port: 8090, started_at: now - 4000 },
	summary: {
		samples: 804,
		temp_avg: 70.31,
		temp_max: 77,
		util_avg: 61.2,
		util_active_avg: 94.12,
		util_p50: 93,
		util_p95: 98,
		util_max: 99,
		mem_avg: 5568.2,
		mem_max: 5604,
		power_avg: 78.44,
		power_max: 96.2,
		vram_headroom_mib: 540,
		throttle: ''
	},
	deltas: {
		'llamacpp:prompt_tokens_total': 48211,
		'llamacpp:prompt_seconds_total': 642.1,
		'llamacpp:tokens_predicted_total': 131077,
		'llamacpp:tokens_predicted_seconds_total': 36410.5,
		'llamacpp:spec_decode_num_draft_tokens_total': 1000,
		'llamacpp:spec_decode_num_accepted_tokens_total': 640,
		'llamacpp:something_new': 3
	},
	requests: 37,
	recent_samples: samples(from),
	warning: 'run qwen3.8-27b (c98ef02c) peaked at 540 MiB of free VRAM'
});

const renderPage = (client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) => {
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<LivePage />
			</MemoryRouter>
		</QueryClientProvider>
	);
	return client;
};

describe('LivePage', () => {
	beforeEach(() => useAuthStore.setState({ token: 'test-token' }));
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	it('says nothing is being recorded, with the way to Serve', async () => {
		vi.mocked(api.getLive).mockResolvedValue({ run: null } as never);
		renderPage();
		expect(await screen.findByText('Nothing is being recorded')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Open Serve' }).getAttribute('href')).toBe('/benchmarks/serve');
		expect(screen.queryByRole('button', { name: 'Kill server' })).toBeNull();
	});

	it('shows a failed load in place of the page, with the reason and Try again, never the empty state (#1050)', async () => {
		vi.mocked(api.getLive).mockRejectedValue('database unavailable');
		renderPage();
		expect(await screen.findByText("Couldn't load live telemetry")).toBeInTheDocument();
		expect(screen.getByText('database unavailable')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
		expect(screen.queryByText('Nothing is being recorded')).toBeNull();
	});

	it('leads with four figures with units, worked-out speeds and named counters (#1049)', async () => {
		vi.mocked(api.getLive).mockResolvedValue(recording() as never);
		renderPage();
		expect(await screen.findByText('5,604 / 6,144 MiB')).toBeInTheDocument();
		expect(screen.getByText('540 MiB to spare at the peak')).toBeInTheDocument();
		expect(screen.getByText('94.1 %')).toBeInTheDocument();
		expect(screen.getByText('78.4 W')).toBeInTheDocument();
		expect(screen.getByText('70.3 °C')).toBeInTheDocument();
		expect(screen.getByText('1 h 06 min')).toBeInTheDocument();
		expect(screen.getByText('75.1 tokens/s')).toBeInTheDocument();
		expect(screen.getByText('3.60 tokens/s')).toBeInTheDocument();
		expect(screen.getByText('Prompt tokens')).toBeInTheDocument();
		expect(screen.getByText('48,211')).toBeInTheDocument();
		expect(screen.getByText('llamacpp:something_new')).toBeInTheDocument();
		expect(screen.getByText('64.0')).toBeInTheDocument();
		expect(screen.getByText(/Throttling: none seen/)).toBeInTheDocument();
		expect(screen.getByText('Little VRAM to spare')).toBeInTheDocument();
		expect(screen.getByRole('region', { name: 'Latest samples' })).toBeInTheDocument();
		expect(screen.getByRole('img', { name: /GPU utilisation over 12 samples/ })).toBeInTheDocument();
	});

	it('gathers the samples of each poll into the lines, without repeats', async () => {
		vi.mocked(api.getLive).mockResolvedValue(recording(0) as never);
		const client = renderPage();
		await screen.findByRole('img', { name: /VRAM used over 12 samples/ });
		vi.mocked(api.getLive).mockResolvedValue(recording(6) as never);
		await act(() => client.refetchQueries({ queryKey: ['live'] }));
		expect(await screen.findByRole('img', { name: /VRAM used over 18 samples/ })).toBeInTheDocument();
	});

	it('keeps the last figures under a notice when a refresh fails', async () => {
		vi.mocked(api.getLive).mockResolvedValue(recording() as never);
		const client = renderPage();
		await screen.findByText('5,604 / 6,144 MiB');
		vi.mocked(api.getLive).mockRejectedValue('timed out');
		await act(() => client.refetchQueries({ queryKey: ['live'] }));
		expect(await screen.findByText("Couldn't refresh")).toBeInTheDocument();
		expect(screen.getByText('5,604 / 6,144 MiB')).toBeInTheDocument();
	});

	it('kills only after the confirmation, with a danger button that names the action (ACT-3)', async () => {
		vi.mocked(api.getLive).mockResolvedValue(recording() as never);
		vi.mocked(api.killLive).mockResolvedValue({ killed: true } as never);
		renderPage();
		const trigger = await screen.findByRole('button', { name: 'Kill server' });
		// An outline danger button, set apart from Open Serve; the confirm is the filled one.
		expect(trigger.getAttribute('data-variant')).toBe('outline');
		expect(trigger.className).toContain('text-danger');
		fireEvent.click(trigger);
		expect(await screen.findByText('Kill the recorded server?')).toBeInTheDocument();
		expect(api.killLive).not.toHaveBeenCalled();
		const confirm = screen.getAllByRole('button', { name: 'Kill server' }).at(-1) as HTMLElement;
		expect(confirm.getAttribute('data-variant')).toBe('destructive');
		fireEvent.click(confirm);
		await waitFor(() => expect(api.killLive).toHaveBeenCalledWith('test-token'));
	});
});

describe('Live helpers', () => {
	it('formats figures and missing values', () => {
		expect(figure(5568.2)).toBe('5,568');
		expect(figure(3.6, 2)).toBe('3.60');
		expect(figure(null)).toBe('–');
	});

	it('works out the speeds only when their time is known', () => {
		expect(throughput({})).toEqual({ prompt: null, generation: null, acceptance: null });
		expect(throughput({ 'llamacpp:prompt_tokens_total': 10, 'llamacpp:prompt_seconds_total': 2 }).prompt).toBe(5);
	});

	it('waits for two samples before drawing', () => {
		render(<Sparkline values={[1]} label="Power" unit="W" tone={3} />);
		expect(screen.getByText('Waiting for samples to draw a line.')).toBeInTheDocument();
		cleanup();
	});
});
