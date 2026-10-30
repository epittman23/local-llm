// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import {
	cancelPrescreen,
	getPrescreenDashboard,
	getPrescreenGrids,
	getPrescreenSweep,
	getPrescreenSweeps,
	startPrescreen,
	startPrescreenDashboard,
	stopPrescreenDashboard,
	streamPrescreen
} from './index';

const ok = (body: unknown) =>
	vi.fn(
		async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
	);

afterEach(() => vi.unstubAllGlobals());

describe('the pre-screen API helpers', () => {
	it.each([
		['getPrescreenGrids', () => getPrescreenGrids('t'), 'GET', '/benchmarks/prescreen/grids'],
		['getPrescreenSweeps', () => getPrescreenSweeps('t', 5), 'GET', '/benchmarks/prescreen/sweeps?limit=5'],
		['getPrescreenSweep', () => getPrescreenSweep('t', 'a/b'), 'GET', '/benchmarks/prescreen/sweeps/a%2Fb'],
		['cancelPrescreen', () => cancelPrescreen('t'), 'POST', '/benchmarks/prescreen/cancel'],
		['getPrescreenDashboard', () => getPrescreenDashboard('t'), 'GET', '/benchmarks/prescreen/dashboard'],
		['startPrescreenDashboard', () => startPrescreenDashboard('t'), 'POST', '/benchmarks/prescreen/dashboard/start'],
		['stopPrescreenDashboard', () => stopPrescreenDashboard('t'), 'POST', '/benchmarks/prescreen/dashboard/stop']
	])('%s calls its route and returns the JSON', async (_name, call, method, path) => {
		const fetch = ok({ answer: 42 });
		vi.stubGlobal('fetch', fetch);
		expect(await call()).toEqual({ answer: 42 });
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${WEBUI_API_BASE_URL}${path}`);
		expect(init.method).toBe(method);
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer t');
	});

	it('startPrescreen sends the form as it is', async () => {
		const fetch = ok({ started: true, sweep_id: 's' });
		vi.stubGlobal('fetch', fetch);
		const form = { profile: 'qwen38', sampler: 'tpe' as const, trials: 8, objective: 'both' as const };
		expect(await startPrescreen('t', form)).toEqual({ started: true, sweep_id: 's' });
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${WEBUI_API_BASE_URL}/benchmarks/prescreen/start`);
		expect(JSON.parse(init.body as string)).toEqual(form);
	});

	it('streamPrescreen returns the response and an abort controller for the sweep', async () => {
		const fetch = ok({});
		vi.stubGlobal('fetch', fetch);
		const [res, controller] = await streamPrescreen('t', 'sweep-1');
		expect(res?.ok).toBe(true);
		expect(controller).toBeInstanceOf(AbortController);
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${WEBUI_API_BASE_URL}/benchmarks/prescreen/stream?sweep_id=sweep-1`);
		expect(init.signal).toBe(controller.signal);
	});

	it('a refusal rejects with the server detail', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ detail: 'a pre-screen is already running' }), { status: 409 }))
		);
		await expect(startPrescreen('t', {})).rejects.toBe('a pre-screen is already running');
	});
});
