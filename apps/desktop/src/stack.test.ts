import { appendFileSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	childEnv,
	DEV_SERVER_URL,
	decideStart,
	isAdoptable,
	LogTail,
	makeBackendCommand,
	newestMtime,
	parseOwned,
	parseProcStat,
	type StartInput,
	shellQuote,
	stopGroup,
	uiBuildIsStale
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
		expect(parseOwned('{"pgid":1,"startTicks":"9"}')).toBeNull();
		expect(parseOwned('{"pgid":-5,"startTicks":"9"}')).toBeNull();
		expect(parseOwned('nope')).toBeNull();
		expect(parseOwned(null)).toBeNull();
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
