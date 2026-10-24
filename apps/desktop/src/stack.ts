// Starting, finding and stopping the local stack. The app runs the root
// Makefile's own `make backend`, which already brings the Compose services up
// and back down around uvicorn; this module decides whether to run it at
// all, runs it in its own process group, and stops that group the way Ctrl-C
// would. The decisions and the stop sequence are pure or take their effects
// as arguments, so they are unit-tested without spawning anything.

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const DEV_SERVER_URL = 'http://localhost:5174';

/** The `make frontend` dev server proxies to this port and no other. */
export const DEV_SERVER_BACKEND_PORT = 4000;

// The graceful-shutdown timeout bounds how long uvicorn waits on open
// requests (a page streaming a log never finishes one); without it the
// lifespan teardown that stops the served model would never run.
export const GRACEFUL_SHUTDOWN_SECONDS = 10;

// 10 s of graceful timeout, up to 15 s for ServeProcess.stop() (three 5 s
// graces), 20 s each for a tune sweep and a Tests job, compose down, margin.
export const STOP_BUDGET_MS = 90_000;

export type Mode = 'remote' | 'attach' | 'adopt' | 'own';

export interface StartPlan {
	mode: Mode;
	/** What the main window loads. */
	loadUrl: string;
	/** Build apps/web before starting the backend. */
	buildUi: boolean;
}

export interface StartInput {
	origin: string;
	local: boolean;
	backendUp: boolean;
	devServerUp: boolean;
	/** owned.json names a `make backend` this app started and is still running. */
	adoptable: boolean;
	uiStale: boolean;
	port: number;
}

/**
 * - **remote**: connect only, start nothing.
 * - **adopt**: a stack this app started before it crashed; stop it on close.
 * - **attach**: started elsewhere (a terminal); never restarted, rebuilt or stopped.
 * - **own**: nothing running; start it, and stop it on close.
 *
 * A running dev server is used in place of the built UI, and makes a build pointless.
 */
export function decideStart(input: StartInput): StartPlan {
	if (!input.local) return { mode: 'remote', loadUrl: input.origin, buildUi: false };
	const useDevServer = input.devServerUp && input.port === DEV_SERVER_BACKEND_PORT;
	const loadUrl = useDevServer ? DEV_SERVER_URL : input.origin;
	if (input.adoptable) return { mode: 'adopt', loadUrl, buildUi: false };
	if (input.backendUp) return { mode: 'attach', loadUrl, buildUi: false };
	return { mode: 'own', loadUrl, buildUi: input.uiStale && !useDevServer };
}

/** apps/web inputs whose change means `dist/` is out of date. */
export const UI_SOURCES = ['src', 'public', 'package.json', 'bun.lock', 'astro.config.mjs'];

export function uiBuildIsStale(builtAt: number | null, newestSource: number): boolean {
	return builtAt === null || newestSource > builtAt;
}

/** The newest modification time among these files and everything under these directories. */
export async function newestMtime(paths: string[]): Promise<number> {
	let newest = 0;
	for (const path of paths) {
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(path);
		} catch {
			continue;
		}
		newest = Math.max(newest, info.mtimeMs);
		if (!info.isDirectory()) continue;
		for (const entry of await readdir(path, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile()) continue;
			try {
				newest = Math.max(newest, (await stat(join(entry.parentPath, entry.name))).mtimeMs);
			} catch {
				// Deleted while walking.
			}
		}
	}
	return newest;
}

export async function isUiStale(webDir: string): Promise<boolean> {
	let builtAt: number | null = null;
	try {
		builtAt = statSync(join(webDir, 'dist', 'index.html')).mtimeMs;
	} catch {
		// Never built.
	}
	return uiBuildIsStale(builtAt, await newestMtime(UI_SOURCES.map((p) => join(webDir, p))));
}

// --- Crash recovery: owned.json and /proc ---------------------------------

export interface OwnedRecord {
	pgid: number;
	startTicks: string;
}

export interface ProcStat {
	comm: string;
	startTicks: string;
}

/** `comm` and `starttime` (field 22) from /proc/<pid>/stat; comm may hold spaces and parentheses. */
export function parseProcStat(text: string): ProcStat | null {
	const open = text.indexOf('(');
	const close = text.lastIndexOf(')');
	if (open < 0 || close < open) return null;
	const rest = text
		.slice(close + 2)
		.trim()
		.split(/\s+/);
	// rest[0] is field 3 (state), so field 22 is rest[19].
	const startTicks = rest[19];
	return startTicks ? { comm: text.slice(open + 1, close), startTicks } : null;
}

export function readProcStat(pid: number): ProcStat | null {
	try {
		return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
	} catch {
		return null;
	}
}

/**
 * The recorded group leader is still the same `make` (same start time, so a
 * reused pid doesn't count): this app started that stack before it crashed.
 */
export function isAdoptable(record: OwnedRecord | null, stat_: (pid: number) => ProcStat | null): boolean {
	if (!record) return false;
	const now = stat_(record.pgid);
	return now?.comm === 'make' && now.startTicks === record.startTicks;
}

export function parseOwned(text: string | null): OwnedRecord | null {
	try {
		const raw = JSON.parse(text ?? '');
		return Number.isInteger(raw?.pgid) && raw.pgid > 1 && typeof raw.startTicks === 'string'
			? { pgid: raw.pgid, startTicks: raw.startTicks }
			: null;
	} catch {
		return null;
	}
}

// --- Commands ----------------------------------------------------------------

/** POSIX single quoting (also valid in fish). */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run through the user's login shell, so PATH (uv, bun, node, docker) is what
 * a terminal has: an app started from the launcher gets a minimal one.
 */
export function loginShell(env: NodeJS.ProcessEnv): string {
	return env.SHELL || '/bin/bash';
}

export function makeBackendCommand(repo: string, port: number): string {
	// exec: make becomes the group leader, which owned.json records.
	return [
		'exec make -C',
		shellQuote(repo),
		'backend',
		shellQuote(`LLLM_UVICORN_FLAGS=--timeout-graceful-shutdown ${GRACEFUL_SHUTDOWN_SECONDS}`),
		`LLLM_BACKEND_PORT=${port}`
	].join(' ');
}

export function buildUiCommand(repo: string): string {
	return `cd ${shellQuote(join(repo, 'apps', 'web'))} && bun install --frozen-lockfile && bun run build`;
}

export function composeDownCommand(repo: string): string {
	return `docker compose -f ${shellQuote(join(repo, 'infra', 'docker-compose.yml'))} down`;
}

/** The environment for everything the app starts: its own, minus what Electron put there for itself. */
export function childEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const { ELECTRON_RUN_AS_NODE: _, ...rest } = env;
	return { ...rest, ...extra };
}

/**
 * Starts `command` in a login shell as the leader of a new process group,
 * writing straight to the log file rather than through a pipe: if the app
 * dies, the stack keeps running (and can be adopted) instead of dying of
 * SIGPIPE on its next log line.
 */
export function spawnInGroup(command: string, logFile: string, env: NodeJS.ProcessEnv): ChildProcess {
	const fd = openSync(logFile, 'a');
	try {
		return spawn(loginShell(env), ['-lc', command], { detached: true, stdio: ['ignore', fd, fd], env });
	} finally {
		closeSync(fd);
	}
}

export function runInShell(command: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		execFile(loginShell(env), ['-lc', command], { env, timeout: timeoutMs }, () => resolve());
	});
}

/** pids of running llama-server processes (none when pgrep finds nothing). */
export function llamaServerPids(): Promise<number[]> {
	return new Promise((resolve) => {
		execFile('pgrep', ['-x', 'llama-server'], (_error, stdout) => {
			resolve(
				String(stdout ?? '')
					.split(/\s+/)
					.filter(Boolean)
					.map(Number)
			);
		});
	});
}

// --- Stopping ----------------------------------------------------------------

export type Kill = (pid: number, signal: NodeJS.Signals | 0) => void;

/** Whether any process in the group is left. EPERM still means it exists. */
export function groupAlive(pgid: number, kill: Kill = process.kill): boolean {
	try {
		kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

export interface StopDeps {
	kill: Kill;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	composeDown: () => Promise<void>;
	leftoverLlama: () => Promise<number[]>;
	/** Called once the budget has run out, before anything is forced. */
	onTimeout: () => void;
}

export interface StopResult {
	forced: boolean;
	/** llama-server processes still running after a forced stop. */
	llama: number[];
}

/**
 * Ctrl-C for a process group: one SIGINT, then wait until the whole group is
 * gone (make's EXIT trap runs compose down after uvicorn exits).
 *
 * **Never a second SIGINT**: uvicorn takes it as "force exit" and skips its
 * lifespan teardown, which is what stops the served model. Past the budget,
 * the group is killed outright, compose is brought down directly, and any
 * llama-server left (it runs in its own session, outside the group) is
 * reported rather than killed unasked.
 */
export async function stopGroup(
	pgid: number,
	deps: StopDeps,
	{ budgetMs = STOP_BUDGET_MS, pollMs = 250 } = {}
): Promise<StopResult> {
	try {
		deps.kill(-pgid, 'SIGINT');
	} catch {
		// Already gone.
	}
	const started = deps.now();
	while (groupAlive(pgid, deps.kill)) {
		if (deps.now() - started >= budgetMs) {
			deps.onTimeout();
			try {
				deps.kill(-pgid, 'SIGKILL');
			} catch {
				// Gone in the meantime.
			}
			await deps.composeDown();
			return { forced: true, llama: await deps.leftoverLlama() };
		}
		await deps.sleep(pollMs);
	}
	return { forced: false, llama: [] };
}

// --- Probing and reading the log -----------------------------------------------

/** The HTTP status of a GET, or null when nothing answered in time. */
export async function probe(url: string, timeoutMs = 1500): Promise<number | null> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
		await response.body?.cancel();
		return response.status;
	} catch {
		return null;
	}
}

/** Follows a file as it grows and hands over complete lines, like `tail -f`. */
export class LogTail {
	private offset = 0;
	private partial = '';
	// Keeps a multi-byte character split across two reads whole.
	private readonly decoder = new StringDecoder('utf8');
	private timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly file: string,
		private readonly onLine: (line: string) => void
	) {}

	start(fromEnd: boolean): void {
		if (fromEnd) {
			try {
				this.offset = statSync(this.file).size;
			} catch {
				this.offset = 0;
			}
		}
		this.timer = setInterval(() => this.poll(), 200);
	}

	/** Reads what is left, then stops. */
	stop(): void {
		clearInterval(this.timer);
		this.poll();
		if (this.partial) this.onLine(this.partial);
		this.partial = '';
	}

	private poll(): void {
		let fd: number;
		try {
			fd = openSync(this.file, 'r');
		} catch {
			return;
		}
		try {
			const buffer = Buffer.alloc(64 * 1024);
			for (;;) {
				const read = readSync(fd, buffer, 0, buffer.length, this.offset);
				if (read <= 0) break;
				this.offset += read;
				const lines = (this.partial + this.decoder.write(buffer.subarray(0, read))).split('\n');
				this.partial = lines.pop() ?? '';
				for (const line of lines) this.onLine(line);
			}
		} finally {
			closeSync(fd);
		}
	}
}
