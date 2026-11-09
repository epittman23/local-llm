import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { type AddressInfo, createServer as createTcpServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	childEnv,
	composeRunningCommand,
	composeUpCommand,
	countRunning,
	DEV_SERVER_IDENTITY_PATH,
	DEV_SERVER_URL,
	decideStart,
	fetchText,
	isAdoptable,
	isOwnDevServer,
	isUiStale,
	LogTail,
	makeBackendCommand,
	newestMtime,
	ownedAction,
	parseListenerPid,
	parseOwned,
	parseProcStat,
	portState,
	probe,
	recordedLlamaPids,
	refuseMessage,
	type StartInput,
	servedLlama,
	shellQuote,
	stopGroup,
	UI_SOURCES,
	uiBuildIsStale,
	waitUntilReady
} from './stack';

const base: StartInput = {
	origin: 'http://127.0.0.1:4000',
	local: true,
	backendUp: false,
	devServerUp: false,
	adoptable: false,
	uiStale: false,
	port: 4000
};

describe('decideStart', () => {
	it('starts the stack when nothing is running, building a stale UI first', () => {
		expect(decideStart({ ...base, uiStale: true })).toEqual({
			mode: 'own',
			loadUrl: 'http://127.0.0.1:4000',
			buildUi: true
		});
		expect(decideStart(base).buildUi).toBe(false);
	});

	it('attaches to a backend started elsewhere, without building anything', () => {
		expect(decideStart({ ...base, backendUp: true, uiStale: true })).toEqual({
			mode: 'attach',
			loadUrl: 'http://127.0.0.1:4000',
			buildUi: false
		});
	});

	it('adopts the stack it started before a crash, up yet or not', () => {
		expect(decideStart({ ...base, adoptable: true, backendUp: true }).mode).toBe('adopt');
		expect(decideStart({ ...base, adoptable: true }).mode).toBe('adopt');
	});

	it('uses a running dev server instead of the build, and skips the build', () => {
		expect(decideStart({ ...base, devServerUp: true, uiStale: true })).toEqual({
			mode: 'own',
			loadUrl: DEV_SERVER_URL,
			buildUi: false
		});
		expect(decideStart({ ...base, devServerUp: true, backendUp: true }).loadUrl).toBe(DEV_SERVER_URL);
	});

	it('ignores the dev server for a backend on another port, which it does not proxy to', () => {
		const plan = decideStart({ ...base, origin: 'http://127.0.0.1:4100', port: 4100, devServerUp: true });
		expect(plan.loadUrl).toBe('http://127.0.0.1:4100');
	});

	it('only connects to a remote server', () => {
		expect(decideStart({ ...base, local: false, origin: 'https://llm.example.ts.net', uiStale: true })).toEqual({
			mode: 'remote',
			loadUrl: 'https://llm.example.ts.net',
			buildUi: false
		});
	});
});

describe('a port held without an answer (#422)', () => {
	it('starts the stack only when nothing holds the port and the services are down', () => {
		expect(decideStart(base).mode).toBe('own');
		expect(decideStart({ ...base, held: 'port', uiStale: true })).toEqual({
			mode: 'refuse',
			loadUrl: 'http://127.0.0.1:4000',
			buildUi: false,
			held: 'port'
		});
		expect(decideStart({ ...base, held: 'services' })).toMatchObject({ mode: 'refuse', held: 'services' });
	});

	it('still attaches to a backend that answers, and adopts its own stack', () => {
		expect(decideStart({ ...base, backendUp: true }).mode).toBe('attach');
		expect(decideStart({ ...base, adoptable: true, held: 'port' }).mode).toBe('adopt');
	});

	it('says what holds it, and how to stop the services', () => {
		const port = refuseMessage('port', 'http://127.0.0.1:4000', 4000, '/home/me/local llm');
		expect(port).toContain('Port 4000 is in use, but nothing answered at http://127.0.0.1:4000/health.');
		expect(port).toContain('does not start a second backend');
		expect(port).toContain('wait for it and retry, or stop it first');
		const services = refuseMessage('services', 'http://127.0.0.1:4000', 4000, '/home/me/local llm');
		expect(services).toContain('are already running');
		expect(services).toContain('`docker compose -f /home/me/local llm/infra/docker-compose.yml down`');
	});

	it('asks compose for the running containers only', () => {
		expect(composeUpCommand('/home/me/local llm')).toBe(
			"docker compose -f '/home/me/local llm/infra/docker-compose.yml' ps -q"
		);
	});

	async function listen(server: Server | ReturnType<typeof createServer>): Promise<number> {
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		return (server.address() as AddressInfo).port;
	}

	/** What startup decides from a real `/health` probe and port check at this port. */
	async function decide(port: number) {
		const origin = `http://127.0.0.1:${port}`;
		const health = await probe(`${origin}/health`, 300);
		const held = health === null && (await portState('127.0.0.1', port, 300)) === 'held' ? 'port' : undefined;
		return decideStart({ ...base, origin, port, backendUp: health !== null, held });
	}

	it('starts its own when the connection is refused', async () => {
		const server = createTcpServer();
		const port = await listen(server);
		await new Promise((resolve) => server.close(resolve));
		expect(await portState('127.0.0.1', port)).toBe('refused');
		expect((await decide(port)).mode).toBe('own');
	});

	it('refuses when the connection is accepted but nothing answers in time', async () => {
		// Accepts and never answers, as a backend reloading or stalled does.
		const sockets: { destroy: () => void }[] = [];
		const server = createTcpServer((socket) => sockets.push(socket));
		const port = await listen(server);
		try {
			expect(await probe(`http://127.0.0.1:${port}/health`, 300)).toBeNull();
			expect(await portState('127.0.0.1', port)).toBe('held');
			expect(await decide(port)).toMatchObject({ mode: 'refuse', held: 'port' });
		} finally {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
		}
	});

	it('attaches when the backend answers', async () => {
		const server = createServer((_request, response) => response.end('ok'));
		const port = await listen(server);
		try {
			expect((await decide(port)).mode).toBe('attach');
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

describe('the UI build', () => {
	it('is stale when missing or older than a source', () => {
		expect(uiBuildIsStale(null, 0)).toBe(true);
		expect(uiBuildIsStale(100, 200)).toBe(true);
		expect(uiBuildIsStale(200, 100)).toBe(false);
	});

	it('sees the newest file under a directory', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lllm-mtime-'));
		writeFileSync(join(dir, 'a.ts'), '');
		writeFileSync(join(dir, 'b.ts'), '');
		utimesSync(join(dir, 'a.ts'), 1000, 1000);
		utimesSync(join(dir, 'b.ts'), 5000, 5000);
		utimesSync(dir, 2000, 2000);
		expect(await newestMtime([dir, join(dir, 'missing')])).toBe(5_000_000);
	});

	it('sees a file deleted or renamed in a subdirectory, by the directory it left (#429)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lllm-mtime-'));
		const pages = join(dir, 'pages');
		mkdirSync(pages);
		writeFileSync(join(pages, 'old.astro'), '');
		writeFileSync(join(pages, 'kept.astro'), '');
		for (const path of [join(pages, 'old.astro'), join(pages, 'kept.astro'), pages, dir]) utimesSync(path, 1000, 1000);
		expect(await newestMtime([dir])).toBe(1_000_000);

		rmSync(join(pages, 'old.astro'));
		utimesSync(pages, 7000, 7000); // what the deletion does to it, at a known time
		expect(await newestMtime([dir])).toBe(7_000_000);
	});

	it('counts the TypeScript config, which holds the path aliases, as a source (#429)', async () => {
		const web = mkdtempSync(join(tmpdir(), 'lllm-web-'));
		mkdirSync(join(web, 'dist'));
		mkdirSync(join(web, 'src'));
		writeFileSync(join(web, 'dist', 'index.html'), '');
		writeFileSync(join(web, 'src', 'main.ts'), '');
		writeFileSync(join(web, 'tsconfig.json'), '{}');
		utimesSync(join(web, 'src', 'main.ts'), 1000, 1000);
		utimesSync(join(web, 'src'), 1000, 1000);
		utimesSync(join(web, 'tsconfig.json'), 1000, 1000);
		utimesSync(join(web, 'dist', 'index.html'), 5000, 5000);
		expect(await isUiStale(web)).toBe(false);

		utimesSync(join(web, 'tsconfig.json'), 9000, 9000);
		expect(await isUiStale(web)).toBe(true);
		expect(UI_SOURCES).toContain('tsconfig.json');
	});
});

describe('crash recovery', () => {
	// Real /proc/<pid>/stat layout; comm can contain spaces and parentheses.
	const stat = (comm: string, start: string) =>
		`4242 (${comm}) S 1 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 ${start} 1 1 18446744073709551615`;

	it('reads comm and the start time', () => {
		expect(parseProcStat(stat('make', '987654'))).toEqual({ comm: 'make', startTicks: '987654' });
		expect(parseProcStat(stat('a (weird) name', '5'))).toEqual({ comm: 'a (weird) name', startTicks: '5' });
		expect(parseProcStat('garbage')).toBeNull();
	});

	it('adopts only the same make, not a reused pid', () => {
		const record = { pgid: 4242, startTicks: '987654' };
		expect(isAdoptable(record, () => ({ comm: 'make', startTicks: '987654' }))).toBe(true);
		expect(isAdoptable(record, () => ({ comm: 'make', startTicks: '1' }))).toBe(false);
		expect(isAdoptable(record, () => ({ comm: 'bash', startTicks: '987654' }))).toBe(false);
		expect(isAdoptable(record, () => null)).toBe(false);
		expect(isAdoptable(null, () => ({ comm: 'make', startTicks: '987654' }))).toBe(false);
	});

	it('parses owned.json defensively', () => {
		expect(parseOwned('{"pgid":4242,"startTicks":"9"}')).toEqual({ pgid: 4242, startTicks: '9' });
		expect(parseOwned('{"pgid":4242,"startTicks":"9","origin":"http://127.0.0.1:4100","repo":"/r"}')).toEqual({
			pgid: 4242,
			startTicks: '9',
			origin: 'http://127.0.0.1:4100',
			repo: '/r'
		});
		expect(parseOwned('{"pgid":4242,"startTicks":"9","origin":5,"repo":null}')).toEqual({
			pgid: 4242,
			startTicks: '9'
		});
		expect(parseOwned('{"pgid":4242,"startTicks":"9","stopping":true}')).toEqual({
			pgid: 4242,
			startTicks: '9',
			stopping: true
		});
		expect(parseOwned('{"pgid":4242,"startTicks":"9","stopping":"yes"}')).toEqual({ pgid: 4242, startTicks: '9' });
		expect(parseOwned('{"pgid":1,"startTicks":"9"}')).toBeNull();
		expect(parseOwned('{"pgid":-5,"startTicks":"9"}')).toBeNull();
		expect(parseOwned('nope')).toBeNull();
		expect(parseOwned(null)).toBeNull();
	});
});

describe('ownedAction (#431)', () => {
	const record = { pgid: 4242, startTicks: '9', origin: 'http://127.0.0.1:4000', repo: '/home/u/local-llm' };
	const here = { origin: 'http://127.0.0.1:4000', repo: '/home/u/local-llm', local: true };
	const act = (r: Parameters<typeof ownedAction>[0], running: boolean, at = here) =>
		ownedAction(r, running, at.origin, at.repo, at.local);

	it('adopts only a stack started for this address and checkout', () => {
		expect(act(record, true)).toBe('adopt');
		expect(act(record, true, { ...here, repo: '/home/u/local-llm/' })).toBe('adopt');
	});

	it('stops a running stack started for another address or checkout, or from a launch for a remote server', () => {
		expect(act(record, true, { ...here, origin: 'http://127.0.0.1:4100' })).toBe('stop');
		expect(act(record, true, { ...here, repo: '/home/u/other' })).toBe('stop');
		expect(act(record, true, { origin: 'https://llm.example.invalid', repo: here.repo, local: false })).toBe('stop');
	});

	it('adopts a stack started for 127.0.0.1 from a launch for localhost, and the other way round (#649)', () => {
		expect(act(record, true, { ...here, origin: 'http://localhost:4000' })).toBe('adopt');
		expect(act({ ...record, origin: 'http://localhost:4000' }, true)).toBe('adopt');
		expect(act(record, true, { ...here, origin: 'http://localhost:4100' })).toBe('stop');
		// make backend listens on 127.0.0.1 by default, so [::1] is another address.
		expect(act(record, true, { ...here, origin: 'http://[::1]:4000' })).toBe('stop');
	});

	it('never adopts a stack an earlier launch was stopping, even for this address and checkout (#649)', () => {
		expect(act({ ...record, stopping: true }, true)).toBe('stop');
		expect(act({ ...record, stopping: true }, false)).toBe('none');
	});

	it('stops a running stack whose record predates the address and checkout', () => {
		expect(act({ pgid: 4242, startTicks: '9' }, true)).toBe('stop');
	});

	it('leaves alone what is not running, or not recorded', () => {
		expect(act(record, false)).toBe('none');
		expect(act(record, false, { ...here, origin: 'http://127.0.0.1:4100' })).toBe('none');
		expect(act(null, true)).toBe('none');
	});
});

describe('commands', () => {
	it('quotes for the shell', () => {
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});

	it('runs make backend without reload and with a bounded shutdown', () => {
		expect(makeBackendCommand('/home/user/local llm', 4000)).toBe(
			"exec make -C '/home/user/local llm' backend 'LLLM_UVICORN_FLAGS=--timeout-graceful-shutdown 10' LLLM_BACKEND_PORT=4000"
		);
	});

	it('keeps Electron’s own variables out of what it starts', () => {
		const env = childEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' }, { LLLM_STOP_JOBS_ON_SHUTDOWN: 'true' });
		expect(env).toEqual({ PATH: '/bin', LLLM_STOP_JOBS_ON_SHUTDOWN: 'true' });
	});
});

/** A process group that exits `exitAfterMs` after its first SIGINT (never, if null). */
function fakeGroup(exitAfterMs: number | null) {
	let clock = 0;
	let interruptedAt: number | null = null;
	let killed = false;
	const signals: string[] = [];
	const calls: string[] = [];
	const alive = () =>
		!killed && (interruptedAt === null || exitAfterMs === null || clock < interruptedAt + exitAfterMs);
	return {
		signals,
		calls,
		deps: {
			kill: (pid: number, signal: NodeJS.Signals | 0) => {
				if (signal !== 0) signals.push(`${signal}:${pid}`);
				if (!alive()) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
				if (signal === 'SIGINT') interruptedAt ??= clock;
				if (signal === 'SIGKILL') killed = true;
			},
			sleep: async (ms: number) => {
				clock += ms;
			},
			now: () => clock,
			composeDown: async () => {
				calls.push('compose down');
			},
			leftoverLlama: async () => [777],
			onTimeout: () => calls.push('timeout')
		}
	};
}

describe('stopGroup', () => {
	it('sends one SIGINT to the group and waits until it is gone', async () => {
		const group = fakeGroup(14_000);
		expect(await stopGroup(4242, group.deps, { budgetMs: 90_000, pollMs: 250 })).toEqual({ forced: false, llama: [] });
		expect(group.signals).toEqual(['SIGINT:-4242']);
		expect(group.calls).toEqual([]);
	});

	it('forces past the budget, without ever sending a second SIGINT', async () => {
		const group = fakeGroup(null);
		expect(await stopGroup(4242, group.deps, { budgetMs: 90_000, pollMs: 250 })).toEqual({
			forced: true,
			llama: [777]
		});
		expect(group.signals).toEqual(['SIGINT:-4242', 'SIGKILL:-4242']);
		expect(group.calls).toEqual(['timeout', 'compose down']);
	});

	it('without interrupting, waits for a group already sent its SIGINT and sends nothing (#649)', async () => {
		const group = fakeGroup(14_000);
		group.deps.kill(4242, 'SIGINT');
		group.signals.length = 0;
		expect(await stopGroup(4242, group.deps, { interrupt: false })).toEqual({ forced: false, llama: [] });
		expect(group.signals).toEqual([]);
		expect(group.calls).toEqual([]);
	});

	it('without interrupting, forces past the budget, never sending a SIGINT (#649)', async () => {
		const group = fakeGroup(null);
		group.deps.kill(4242, 'SIGINT');
		group.signals.length = 0;
		expect(await stopGroup(4242, group.deps, { budgetMs: 90_000, pollMs: 250, interrupt: false })).toEqual({
			forced: true,
			llama: [777]
		});
		expect(group.signals).toEqual(['SIGKILL:-4242']);
		expect(group.calls).toEqual(['timeout', 'compose down']);
	});

	it('returns at once for a group already gone', async () => {
		const group = fakeGroup(0);
		group.deps.kill(4242, 'SIGINT');
		group.signals.length = 0;
		expect(await stopGroup(4242, group.deps)).toEqual({ forced: false, llama: [] });
	});
});

describe('LogTail', () => {
	it('hands over whole lines only, including a character split across reads', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lllm-tail-'));
		const file = join(dir, 'backend.log');
		writeFileSync(file, 'old line\n');
		const lines: string[] = [];
		const tail = new LogTail(file, (line) => lines.push(line));
		tail.start(true);
		const euro = Buffer.from('€');
		appendFileSync(file, Buffer.concat([Buffer.from('==> Starting '), euro.subarray(0, 1)]));
		await new Promise((r) => setTimeout(r, 350));
		appendFileSync(file, Buffer.concat([euro.subarray(1), Buffer.from('\nhalf')]));
		await new Promise((r) => setTimeout(r, 350));
		tail.stop();
		expect(lines).toEqual(['==> Starting €', 'half']);
	});
});

describe('services left after a stop (#435)', () => {
	it('asks compose for the running containers of this checkout', () => {
		expect(composeRunningCommand('/home/me/local llm')).toBe(
			"docker compose -f '/home/me/local llm/infra/docker-compose.yml' ps -a -q"
		);
	});

	it('counts the containers listed, and knows when compose could not be asked', () => {
		expect(countRunning('3f2a9c1d4e5b\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n')).toBe(2);
		expect(countRunning('')).toBe(0);
		expect(countRunning(null)).toBeNull();
		// A login profile's greeting is not a container.
		expect(countRunning('Welcome back\n3f2a9c1d4e5b\n')).toBe(1);
	});
});

describe('the dev server check (#432)', () => {
	// What apps/web/astro.config.mjs's dev server answers at DEV_SERVER_IDENTITY_PATH.
	const devServerIdentity = (webRoot: string) => JSON.stringify({ app: 'local-llm', webRoot });

	function checkout() {
		const repo = mkdtempSync(join(tmpdir(), 'lllm-repo-'));
		const webDir = join(repo, 'apps', 'web');
		mkdirSync(webDir, { recursive: true });
		return { repo, webDir };
	}

	it("takes this checkout's dev server, by its identity answer", () => {
		const { webDir } = checkout();
		expect(isOwnDevServer(devServerIdentity(`${webDir}/`), webDir)).toBe(true);
	});

	it('takes it through a symlinked checkout path too', () => {
		const { repo, webDir } = checkout();
		const link = `${repo}-link`;
		symlinkSync(repo, link);
		expect(isOwnDevServer(devServerIdentity(webDir), join(link, 'apps', 'web'))).toBe(true);
	});

	it("does not take another checkout's dev server", () => {
		const { webDir } = checkout();
		const other = checkout();
		expect(isOwnDevServer(devServerIdentity(other.webDir), webDir)).toBe(false);
	});

	it('does not take another project, which answers that path with its own page', () => {
		const { webDir } = checkout();
		expect(isOwnDevServer(null, webDir)).toBe(false);
		expect(isOwnDevServer('<!doctype html><title>Another app</title>', webDir)).toBe(false);
		expect(isOwnDevServer('{"app":"something-else"}', webDir)).toBe(false);
		expect(isOwnDevServer(JSON.stringify({ app: 'local-llm', webRoot: 7 }), webDir)).toBe(false);
	});

	it("matches what apps/web's dev server answers, path and body", async () => {
		type Use = (path: string, handle: (request: unknown, response: unknown) => void) => void;
		const web = (await import(pathToFileURL(join(__dirname, '..', '..', 'web', 'dev-server-identity.mjs')).href)) as {
			DEV_SERVER_IDENTITY_PATH: string;
			devServerIdentity: (webRoot?: string) => { configureServer: (server: { middlewares: { use: Use } }) => void };
		};
		const { webDir } = checkout();
		let route = '';
		let body: string | null = null;
		web.devServerIdentity(`${webDir}/`).configureServer({
			middlewares: {
				use: (path, handle) => {
					route = path;
					handle({}, { setHeader: () => {}, end: (text: string) => (body = text) });
				}
			}
		});

		expect(web.DEV_SERVER_IDENTITY_PATH).toBe(DEV_SERVER_IDENTITY_PATH);
		expect(route).toBe(DEV_SERVER_IDENTITY_PATH);
		expect(isOwnDevServer(body, webDir)).toBe(true);
	});

	it('does not take a directory that no longer exists', () => {
		const { webDir } = checkout();
		expect(isOwnDevServer(devServerIdentity('/nonexistent/apps/web'), webDir)).toBe(false);
		expect(isOwnDevServer(devServerIdentity(webDir), '/nonexistent/apps/web')).toBe(false);
	});
});

describe('fetchText (#432)', () => {
	async function serve(status: number, body: string) {
		const server = createServer((_request, response) => {
			response.writeHead(status, status === 302 ? { location: '/elsewhere' } : {});
			response.end(body);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
		return { url, close: () => new Promise((resolve) => server.close(resolve)) };
	}

	it('gives the body of a 200, and null for any other status, a redirect included', async () => {
		for (const [status, expected] of [
			[200, 'hello'],
			[404, null],
			[302, null]
		] as const) {
			const { url, close } = await serve(status, 'hello');
			try {
				expect(await fetchText(url)).toBe(expected);
			} finally {
				await close();
			}
		}
	});

	it('gives null when nothing listens', async () => {
		const { url, close } = await serve(200, '');
		await close();
		expect(await fetchText(url)).toBeNull();
	});
});

describe('the served llama-server (#434)', () => {
	const llama = { comm: 'llama-server', startTicks: '9' };

	it('parseOwned keeps a well-formed llama record and drops a malformed one', () => {
		const record = { pgid: 4242, startTicks: '1', llama: { pid: 555, startTicks: '9' } };
		expect(parseOwned(JSON.stringify(record))?.llama).toEqual({ pid: 555, startTicks: '9' });
		expect(parseOwned(JSON.stringify({ ...record, llama: { pid: 'x', startTicks: 9 } }))?.llama).toBeUndefined();
		expect(parseOwned(JSON.stringify({ pgid: 4242, startTicks: '1' }))?.llama).toBeUndefined();
	});

	it('parseListenerPid reads the pid from ss output', () => {
		expect(parseListenerPid('LISTEN 0 1 127.0.0.1:8090 0.0.0.0:* users:(("llama-server",pid=555,fd=3))\n')).toBe(555);
		expect(parseListenerPid('')).toBeNull();
		const two =
			'LISTEN 0 1 127.0.0.1:8090 0.0.0.0:* users:(("llama-server",pid=555,fd=3))\nLISTEN 0 1 [::1]:8090 [::]:* users:(("llama-server",pid=777,fd=4))\n';
		expect(parseListenerPid(two)).toBeNull(); // another listener: record nothing
		expect(parseListenerPid(`${two.split('\n')[0]}\n${two.split('\n')[0]}`)).toBe(555); // one process, two sockets
	});

	it('servedLlama records the process listening on the port /check names, with its start time', async () => {
		const seen: number[] = [];
		const found = await servedLlama({
			check: async () => ({ running: true, port: 8090 }),
			listener: async (port) => {
				seen.push(port);
				return 555;
			},
			stat: () => llama
		});
		expect(seen).toEqual([8090]);
		expect(found).toEqual({ pid: 555, startTicks: '9' });
	});

	it('servedLlama records nothing when none is served, /check cannot be asked, or the listener is not a llama-server', async () => {
		const listener = async () => 555;
		expect(
			await servedLlama({ check: async () => ({ running: false, port: 0 }), listener, stat: () => llama })
		).toBeNull();
		expect(await servedLlama({ check: async () => null, listener, stat: () => llama })).toBeNull();
		expect(
			await servedLlama({
				check: async () => ({ running: true, port: 8090 }),
				listener,
				stat: () => ({ comm: 'nginx', startTicks: '9' })
			})
		).toBeNull();
		expect(
			await servedLlama({
				check: async () => ({ running: true, port: 8090 }),
				listener: async () => null,
				stat: () => llama
			})
		).toBeNull();
	});

	it('recordedLlamaPids names only the recorded process, while it is still the same one', () => {
		const stat = (pid: number) =>
			pid === 555 ? llama : pid === 777 ? { comm: 'llama-server', startTicks: '4' } : null;
		expect(recordedLlamaPids({ pid: 555, startTicks: '9' }, stat)).toEqual([555]); // 777, another, is never listed
		expect(recordedLlamaPids({ pid: 555, startTicks: '8' }, stat)).toEqual([]); // pid reused
		expect(recordedLlamaPids({ pid: 556, startTicks: '9' }, stat)).toEqual([]); // gone
		expect(recordedLlamaPids({ pid: 555, startTicks: '9' }, () => ({ comm: 'bash', startTicks: '9' }))).toEqual([]);
		expect(recordedLlamaPids(undefined, stat)).toEqual([]);
	});
});

describe('waitUntilReady', () => {
	function clock(ready: () => boolean, overrides: Partial<Parameters<typeof waitUntilReady>[0]> = {}) {
		let t = 0;
		return {
			ready: async () => ready(),
			cancelled: () => false,
			stopped: () => null,
			sleep: async (ms: number) => {
				t += ms;
			},
			now: () => t,
			timeoutMs: 2000,
			...overrides
		};
	}

	it('gives true once ready', async () => {
		let polls = 0;
		expect(
			await waitUntilReady(
				clock(() => ++polls === 3),
				'http://127.0.0.1:4000'
			)
		).toBe(true);
	});

	it('throws a clear error when a flat wait passes (attach mode)', async () => {
		await expect(
			waitUntilReady(
				clock(() => false, { timeoutMs: 60_000 }),
				'http://h:1'
			)
		).rejects.toThrow('Nothing was ready at http://h:1 after 1 minutes.');
	});

	it('restarts the deadline on progress, and throws after silence (#797)', async () => {
		let t = 0;
		let size = 0;
		const wait = {
			ready: async () => t >= 5000,
			cancelled: () => false,
			stopped: () => null,
			sleep: async (ms: number) => {
				t += ms;
				if (t < 5000) size += 1;
			},
			now: () => t,
			activity: () => size,
			timeoutMs: 2000
		};
		expect(await waitUntilReady(wait, 'o')).toBe(true);
		t = 0;
		size = 0;
		await expect(
			waitUntilReady(
				{
					...wait,
					ready: async () => false,
					sleep: async (ms) => {
						t += ms;
					}
				},
				'http://h:1'
			)
		).rejects.toThrow('Nothing has happened for 0.03333333333333333 minutes at http://h:1.');
	});

	it('gives the reason a stopped backend gave, and false when cancelled', async () => {
		await expect(
			waitUntilReady(
				clock(() => false, { stopped: () => 'it stopped' }),
				'o'
			)
		).rejects.toThrow('it stopped');
		expect(
			await waitUntilReady(
				clock(() => false, { cancelled: () => true }),
				'o'
			)
		).toBe(false);
	});
});
