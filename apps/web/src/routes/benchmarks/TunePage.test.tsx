import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/apis/benchmarks';
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

const renderPage = () =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TunePage />
		</QueryClientProvider>
	);

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

	it('a refused start', async () => {
		vi.mocked(api.startTune).mockRejectedValue('a sweep is already running');
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
		expect(await screen.findByText('a sweep is already running')).toBeTruthy();
	});

	it('a status stream that cannot reach the server', async () => {
		vi.mocked(api.streamTuneLog).mockRejectedValue(new ServerUnreachableError());
		renderPage();
		expect(await screen.findByText('Could not reach the server')).toBeTruthy();
	});

	it('a refused resume', async () => {
		vi.mocked(api.resumeTune).mockRejectedValue('no sweep to resume');
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
		expect(await screen.findByText('no sweep to resume')).toBeTruthy();
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
		const stop = await screen.findByRole('button', { name: 'Stop' });
		await vi.waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(stop);
		const dialog = await screen.findByRole('alertdialog');
		fireEvent.click(within(dialog).getByRole('button', { name: 'Stop' }));
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

		fireEvent.change(screen.getByPlaceholderText('Latest'), { target: { value: 'sweep-new' } });
		fireEvent.click(screen.getByRole('button', { name: 'View' }));
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
});
