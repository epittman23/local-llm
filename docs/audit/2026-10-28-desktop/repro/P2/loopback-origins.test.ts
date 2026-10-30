// A-01: `[::1]` and `https:` loopback addresses count as local, but the
// backend `make backend` starts (plain HTTP on 127.0.0.1) never answers them,
// so startup decides "own" even with a backend already up on 127.0.0.1.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isLocalOrigin, localPort, normalizeServerUrl } from '../../../../../apps/desktop/src/config';
import { decideStart, makeBackendCommand, probe } from '../../../../../apps/desktop/src/stack';

describe('loopback origins the started backend cannot serve', () => {
	it('[::1] and https loopback count as local, but a 127.0.0.1-bound backend never answers them', async () => {
		// Stand-in for `uvicorn --host 127.0.0.1` (Makefile LLLM_BACKEND_HOST default).
		const server = createServer((_q, r) => {
			r.writeHead(200);
			r.end('ok');
		});
		await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
		const port = (server.address() as AddressInfo).port;
		const results: Record<string, { origin: string; local: boolean; health: number | null; mode: string }> = {};
		for (const input of [
			`http://127.0.0.1:${port}`,
			`http://localhost:${port}`,
			`http://[::1]:${port}`,
			`https://127.0.0.1:${port}`
		]) {
			const origin = normalizeServerUrl(input) as string;
			const health = await probe(`${origin}/health`);
			const plan = decideStart({
				origin,
				local: isLocalOrigin(origin),
				backendUp: health !== null,
				devServerUp: false,
				adoptable: false,
				uiStale: false,
				port: localPort(origin)
			});
			results[input] = { origin, local: isLocalOrigin(origin), health, mode: plan.mode };
		}
		server.close();
		console.log(JSON.stringify(results, null, 1));
		expect(results[`http://[::1]:${port}`]?.mode).toBe('own');
		expect(results[`https://127.0.0.1:${port}`]?.mode).toBe('own');
		console.log(makeBackendCommand('/r', localPort(`http://[::1]:${port}`)));
	});
});
