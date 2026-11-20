// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { getLiveStatus, listReports } from './index';

const answer = (body: unknown, status = 200) =>
	vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

afterEach(() => vi.unstubAllGlobals());

describe('the light status and saved-report reads', () => {
	it('getLiveStatus reads the run identity, and throws the server detail', async () => {
		const run = { run_id: 'r1', model: 'qwen38', config_id: 'c98ef02c' };
		const fetchMock = answer({ run });
		vi.stubGlobal('fetch', fetchMock);
		expect(await getLiveStatus('t')).toEqual({ run });
		expect(fetchMock).toHaveBeenCalledWith(`${WEBUI_API_BASE_URL}/benchmarks/live/status`, expect.anything());
		vi.stubGlobal('fetch', answer({ detail: 'no' }, 500));
		await expect(getLiveStatus('t')).rejects.toBe('no');
	});

	it('listReports asks for one report by id, encoded, or for the newest without one', async () => {
		const fetchMock = answer({ reports: [] });
		vi.stubGlobal('fetch', fetchMock);
		await listReports('t', '2026-11-14 a&b');
		await listReports('t');
		expect(fetchMock.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
			`${WEBUI_API_BASE_URL}/benchmarks/report/?id=2026-11-14+a%26b`,
			`${WEBUI_API_BASE_URL}/benchmarks/report/`
		]);
	});
});
