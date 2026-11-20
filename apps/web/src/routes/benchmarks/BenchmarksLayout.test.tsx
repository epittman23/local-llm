import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { BenchmarksLayout, chipState } from './BenchmarksLayout';

vi.mock('@/lib/apis/benchmarks', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks')>();
	return {
		...real,
		checkServe: vi.fn(),
		getLive: vi.fn(),
		getLiveStatus: vi.fn(),
		getRecentSweeps: vi.fn(),
		getPrescreenSweeps: vi.fn()
	};
});

const renderAt = (path: string) => {
	const router = createMemoryRouter(
		[{ path: '/benchmarks', element: <BenchmarksLayout />, children: [{ path: '*', element: <p>bench page</p> }] }],
		{ initialEntries: [path] }
	);
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
};

const signIn = () => {
	useAuthStore.setState({ status: 'authenticated', token: 't', user: { id: 'u1', role: 'admin' } } as never);
	useConfigStore.setState({ config: { name: 'local-llm', version: '0', features: { enable_benchmarks: true } } });
};

beforeEach(() => {
	vi.mocked(api.checkServe).mockResolvedValue({ port: 8090, model: null, profile: 'qwen38', running: false });
	vi.mocked(api.getLiveStatus).mockResolvedValue({ run: null });
	vi.mocked(api.getRecentSweeps).mockResolvedValue({ sweeps: [] });
	vi.mocked(api.getPrescreenSweeps).mockResolvedValue({ sweeps: [], running: false, active: null, last_error: null });
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe('BenchmarksLayout', () => {
	it('opens with the Benchmarks heading and the eight tabs in workflow order, the open one current (LAY-5, NAV-1, NAV-2)', async () => {
		signIn();
		renderAt('/benchmarks/prescreen');
		expect(screen.getByRole('heading', { level: 1, name: 'Benchmarks' })).toBeInTheDocument();
		const nav = screen.getByRole('navigation', { name: 'Benchmarks' });
		const links = within(nav).getAllByRole('link');
		expect(links.map((l) => l.textContent)).toEqual([
			'Pre-screen',
			'Tune',
			'Serve',
			'Live',
			'Tests',
			'Compare',
			'Answers',
			'Report'
		]);
		// Configure | Run | Analyse.
		expect(nav.querySelectorAll('[data-slot="tab-group-separator"]')).toHaveLength(2);
		expect(within(nav).getByRole('link', { name: 'Pre-screen' }).getAttribute('aria-current')).toBe('page');
		expect(screen.getByText('bench page')).toBeInTheDocument();
		expect(await screen.findByText('Nothing running')).toBeInTheDocument();
	});

	it('shows a skeleton, not "Loading…", while the session loads (STA-2)', () => {
		useAuthStore.setState({ status: 'pending', user: null } as never);
		useConfigStore.setState({ config: null });
		renderAt('/benchmarks/serve');
		expect(screen.getByRole('status').textContent).toBe('Loading benchmarks');
		expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
		expect(api.checkServe).not.toHaveBeenCalled();
	});

	it("says what is served, with the recorded run's config, and links to Serve (B-D2)", async () => {
		vi.mocked(api.checkServe).mockResolvedValue({ port: 8090, model: 'qwen3.8-27b', profile: 'qwen38', running: true });
		vi.mocked(api.getLiveStatus).mockResolvedValue({
			run: { run_id: 'r1', config_id: 'c98ef02c11aa', model: 'qwen3.8-27b' }
		});
		signIn();
		renderAt('/benchmarks/compare');
		const chip = await screen.findByRole('link', { name: 'Serving qwen38 · c98ef02c' });
		expect(chip.getAttribute('href')).toBe('/benchmarks/serve');
		expect(chip.textContent).toContain('c98ef02c');
		expect(chip.textContent).not.toContain('11aa');
		// The chip is beside the strip, not one of its tabs.
		expect(within(screen.getByRole('navigation', { name: 'Benchmarks' })).queryByText(/Serving/)).toBeNull();
		// The light read, never Live's sample summary, on every tab.
		expect(api.getLiveStatus).toHaveBeenCalledWith('t');
		expect(api.getLive).not.toHaveBeenCalled();
	});

	it('says the status is unavailable when a read fails and nothing else is known (STA-4)', async () => {
		vi.mocked(api.checkServe).mockRejectedValue('backend restarting');
		signIn();
		renderAt('/benchmarks/serve');
		expect(await screen.findByText('Status unavailable')).toBeInTheDocument();
	});
});

describe('chipState', () => {
	it('puts a pre-screen first, then a tune sweep, then a served model, then a recorded run, else nothing', () => {
		const serving = { running: true, profile: 'qwen38' };
		const sweeps = { sweeps: [{ sweep_id: 't-1', verdict: 'running' }], running: true };
		expect(
			chipState({ check: serving, tune: sweeps, prescreen: { running: true, active: { sweep_id: 'p 1' } } })
		).toEqual({ label: 'Pre-screen running', to: '/benchmarks/prescreen?sweep=p+1' });
		expect(chipState({ check: serving, tune: sweeps, prescreen: { running: true } })?.to).toBe('/benchmarks/prescreen');
		expect(chipState({ check: serving, tune: sweeps })).toEqual({
			label: 'Tune sweep running',
			to: '/benchmarks/tune?sweep=t-1'
		});
		expect(chipState({ check: serving, tune: { sweeps: [{ sweep_id: 't-1', verdict: 'adopted' }] } })).toEqual({
			label: 'Serving qwen38',
			detail: undefined,
			to: '/benchmarks/serve'
		});
		expect(chipState({ check: { running: true, profile: null } })?.label).toBe('Serving a model');
		expect(
			chipState({ check: { running: false }, live: { run: { config_id: 'bd04a851', model: 'qwen3.8-27b' } } })
		).toEqual({ label: 'Recording qwen3.8-27b', detail: 'bd04a851', to: '/benchmarks/live' });
		expect(chipState({ live: { run: { config_id: null, model: null } } })?.label).toBe('Recording a run');
		expect(chipState({ check: { running: false }, live: { run: null }, tune: { sweeps: [] } })).toBeNull();
	});

	it('does not call a sweep running when no sweep task is alive, however its row reads (#1053)', () => {
		// A backend that died mid-sweep leaves the row without a verdict, which the list reads as 'running'.
		const dead = { sweeps: [{ sweep_id: 't-dead', verdict: 'running' }], running: false };
		expect(chipState({ tune: dead })).toBeNull();
		expect(chipState({ tune: { sweeps: dead.sweeps } })).toBeNull();
		// A resumed older sweep is the open one, not the newest row.
		const resumed = {
			sweeps: [
				{ sweep_id: 't-new', verdict: 'adopted' },
				{ sweep_id: 't-old', verdict: 'running' }
			],
			running: true
		};
		expect(chipState({ tune: resumed })?.to).toBe('/benchmarks/tune?sweep=t-old');
		expect(chipState({ tune: { sweeps: [], running: true } })?.to).toBe('/benchmarks/tune');
	});
});
