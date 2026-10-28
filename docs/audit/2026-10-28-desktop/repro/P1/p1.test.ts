import { mkdtempSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLocalOrigin, localPort } from '../../../../../apps/desktop/src/config';
import {
	createProgress,
	reduce,
	SHUTDOWN
} from '../../../../../apps/desktop/src/progress';
import {
	decideStart,
	isUiStale,
	makeBackendCommand,
	parseProcStat,
	probe
} from '../../../../../apps/desktop/src/stack';

const SCRATCH = tmpdir();

function listen(server: Server, host: string): Promise<number> {
	return new Promise((resolve) => server.listen(0, host, () => resolve((server.address() as { port: number }).port)));
}

test('F2: a backend that accepts but answers after 1.5 s is decided "own"', async () => {
	// Models uvicorn --reload: the supervisor holds the socket, the worker is
	// still in its lifespan startup, so connections queue and nothing answers.
	const sockets: import('node:net').Socket[] = [];
	const server = createServer((s) => sockets.push(s));
	const port = await listen(server, '127.0.0.1');
	const origin = `http://127.0.0.1:${port}`;
	const t0 = Date.now();
	const health = await probe(`${origin}/health`);
	const elapsed = Date.now() - t0;
	const plan = decideStart({
		origin,
		local: true,
		backendUp: health !== null,
		devServerUp: false,
		adoptable: false,
		uiStale: false,
		port
	});
	console.log('F2 probe ->', health, `after ${elapsed} ms; plan ->`, JSON.stringify(plan));
	for (const s of sockets) s.destroy();
	server.close();
	expect(health).toBeNull();
	expect(plan.mode).toBe('own');
});

test('F3: [::1] is local, but make backend is never told the host, and a 127.0.0.1 listener is unreachable at [::1]', async () => {
	const server = createServer((s) => s.end('HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n'));
	const port = await listen(server, '127.0.0.1');
	const at127 = await probe(`http://127.0.0.1:${port}/ready`);
	const atV6 = await probe(`http://[::1]:${port}/ready`);
	const origin = `http://[::1]:${port}`;
	console.log('F3 isLocalOrigin', isLocalOrigin(origin), 'probe 127.0.0.1 ->', at127, 'probe [::1] ->', atV6);
	console.log('F3 command:', makeBackendCommand('/repo', localPort(origin)));
	server.close();
	expect(isLocalOrigin(origin)).toBe(true);
	expect(at127).toBe(200);
	expect(atV6).toBeNull();
	expect(makeBackendCommand('/repo', port)).not.toContain('HOST');
	// https on loopback is also "local", but make backend serves plain http.
	console.log('F3 https local?', isLocalOrigin('https://127.0.0.1:4000'), 'port', localPort('https://localhost'));
});

test('F5: a timeout during "requests" marks the job and model steps "skipped: none running"', () => {
	let p = createProgress('shutdown', 'Stopping Local LLM', SHUTDOWN, 0);
	p = reduce(p, { type: 'begin', step: 'window', at: 1 });
	p = reduce(p, { type: 'begin', step: 'requests', at: 2 });
	// What main.ts onTimeout dispatches, then the forced path's offer.
	p = reduce(p, { type: 'timeout', step: 'requests', at: 90_000 });
	p = reduce(p, { type: 'begin', step: 'force', at: 90_001, detail: 'killing the process group' });
	p = reduce(p, { type: 'offer-stop-llama' });
	p = reduce(p, { type: 'complete', at: 95_000 });
	const view = p.steps.map((s) => `${s.id}=${s.state}${s.detail ? ` (${s.detail})` : ''}`);
	console.log('F5', view.join(', '), 'offerStopLlama', p.offerStopLlama);
	expect(p.steps.find((s) => s.id === 'model')).toMatchObject({ state: 'skipped', detail: 'none running' });
	expect(p.offerStopLlama).toBe(true);
});

test('F7: renaming or deleting a file in a nested apps/web dir is not seen as newer than dist/', async () => {
	const web = mkdtempSync(join(SCRATCH, 'web-'));
	mkdirSync(join(web, 'src', 'pages'), { recursive: true });
	mkdirSync(join(web, 'dist'));
	writeFileSync(join(web, 'src', 'pages', 'old.astro'), 'x');
	writeFileSync(join(web, 'src', 'pages', 'gone.astro'), 'x');
	utimesSync(join(web, 'src', 'pages', 'old.astro'), 1000, 1000);
	utimesSync(join(web, 'src', 'pages', 'gone.astro'), 1000, 1000);
	writeFileSync(join(web, 'dist', 'index.html'), '');
	utimesSync(join(web, 'dist', 'index.html'), 2000, 2000);
	utimesSync(join(web, 'src'), 1000, 1000);
	expect(await isUiStale(web)).toBe(false);
	// A rename keeps the file's mtime; a deletion leaves no file to stat.
	renameSync(join(web, 'src', 'pages', 'old.astro'), join(web, 'src', 'pages', 'new.astro'));
	const { rmSync } = await import('node:fs');
	rmSync(join(web, 'src', 'pages', 'gone.astro'));
	utimesSync(join(web, 'src'), 1000, 1000); // only src/pages changed, as with a real edit there
	const stale = await isUiStale(web);
	console.log('F7 stale after rename+delete under src/pages:', stale);
	expect(stale).toBe(false);
	// tsconfig.json is a build input that is not watched.
	writeFileSync(join(web, 'tsconfig.json'), '{}');
	console.log('F7 stale after a new tsconfig.json:', await isUiStale(web));
});

test('parseProcStat agrees with a real /proc/self/stat', () => {
	const text = readFileSync('/proc/self/stat', 'utf8');
	const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
	expect(parseProcStat(text)?.startTicks).toBe(fields[19]);
});
