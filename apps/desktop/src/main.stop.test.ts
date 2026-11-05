// How main.ts stops (#421, #423), run against a fake Electron. main.ts runs at
// import, so each test imports it afresh with a new fake. Nothing here spawns
// or signals a real process: spawnInGroup, probe, stopGroup and the llama-server
// lookup are fakes driven by the test, and process.kill is spied on.
//
// The fake is built inside vi.hoisted because vi.mock factories may only use
// hoisted values; it follows docs/audit/2026-10-28-desktop/repro/P1/main-harness.ts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;
	class Emitter {
		private listeners = new Map<string, Listener[]>();
		on(name: string, f: Listener) {
			this.listeners.set(name, [...(this.listeners.get(name) ?? []), f]);
			return this;
		}
		once(name: string, f: Listener) {
			const wrapped: Listener = (...args) => {
				this.off(name, wrapped);
				f(...args);
			};
			return this.on(name, wrapped);
		}
		off(name: string, f: Listener) {
			this.listeners.set(
				name,
				(this.listeners.get(name) ?? []).filter((g) => g !== f)
			);
			return this;
		}
		emit(name: string, ...args: unknown[]) {
			for (const f of [...(this.listeners.get(name) ?? [])]) f(...args);
		}
	}

	const state = {
		userData: '',
		statusHtml: '',
		windows: [] as FakeWindow[],
		exits: [] as number[],
		handlers: new Map<string, (...args: unknown[]) => unknown>(),
		appEvents: new Emitter(),
		stops: [] as number[],
		spawned: 0,
		/** What the next /ready probe answers; a promise holds it in flight. */
		ready: (): Promise<number | null> => Promise.resolve(200),
		stopResult: { forced: false, llama: [] as number[] },
		/** Holds every stop in flight until it resolves. */
		stopHold: Promise.resolve() as Promise<void>,
		llama: [] as number[],
		/** Containers compose still lists as running after a clean stop; null when it can't be asked. */
		servicesLeft: 0 as number | null,
		/** What answers on the dev server's :5174, by URL; nothing by default (#432). */
		devServer: null as ((url: string) => string | null) | null
	};
	let nextId = 1;

	class FakeWindow extends Emitter {
		webContents = { id: nextId++, send: () => {} };
		destroyed = false;
		loaded = '';
		constructor(public opts: unknown) {
			super();
			state.windows.push(this);
		}
		setMenu() {}
		show() {}
		focus() {}
		restore() {}
		isMinimized() {
			return false;
		}
		getNormalBounds() {
			return { x: 0, y: 0, width: 100, height: 100 };
		}
		destroy() {
			if (this.destroyed) return;
			this.destroyed = true;
			this.emit('closed');
			// A destroyed BrowserWindow fires no more events.
			this.off = () => this;
			this.emit = () => {};
		}
		isDestroyed() {
			return this.destroyed;
		}
		loadFile(f: string) {
			this.loaded = f;
			return Promise.resolve();
		}
		loadURL(u: string) {
			this.loaded = u;
			return Promise.resolve();
		}
		/** A user's close: 'close' listeners may preventDefault; true when the window closed. */
		userClose(): boolean {
			let prevented = false;
			this.emit('close', { preventDefault: () => (prevented = true) });
			if (!prevented) this.destroy();
			return !prevented;
		}
		static getAllWindows() {
			return state.windows.filter((w) => !w.destroyed);
		}
	}

	let markReady: () => void = () => {};
	const electron = () => ({
		app: {
			isPackaged: false,
			getPath: () => state.userData,
			getVersion: () => '0.0.0',
			requestSingleInstanceLock: () => true,
			on: (name: string, f: Listener) => state.appEvents.on(name, f),
			whenReady: () => new Promise<void>((resolve) => (markReady = resolve)),
			exit: (code: number) => state.exits.push(code),
			relaunch: () => {}
		},
		BrowserWindow: FakeWindow,
		dialog: {},
		ipcMain: { handle: (name: string, f: (...args: unknown[]) => unknown) => state.handlers.set(name, f) },
		Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
		screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 1000 } }) },
		session: { defaultSession: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} } },
		shell: { openExternal: () => {}, openPath: () => {} }
	});

	function reset() {
		state.windows = [];
		state.exits = [];
		state.handlers = new Map();
		state.appEvents = new Emitter();
		state.stops = [];
		state.spawned = 0;
		state.ready = () => Promise.resolve(200);
		state.stopResult = { forced: false, llama: [] };
		state.stopHold = Promise.resolve();
		state.llama = [];
		state.servicesLeft = 0;
		state.devServer = null;
	}

	return { state, FakeWindow, Emitter, electron, reset, start: () => markReady() };
});

vi.mock('../node_modules/electron/index.js', () => {
	const electron = h.electron();
	return { ...electron, default: electron };
});
vi.mock('./config', async (original) => ({ ...(await original<typeof import('./config')>()), isRepoRoot: () => true }));
vi.mock('./stack', async (original) => ({
	...(await original<typeof import('./stack')>()),
	isUiStale: async () => false,
	readProcStat: () => ({ comm: 'make', startTicks: '1' }),
	// Nothing answers before the stack starts, so the app starts its own.
	probe: async (url: string) =>
		url.endsWith('/ready')
			? h.state.ready()
			: url.startsWith('http://localhost:5174') && h.state.devServer
				? 200
				: null,
	fetchText: async (url: string) => h.state.devServer?.(url) ?? null,
	spawnInGroup: () => {
		h.state.spawned++;
		return Object.assign(new h.Emitter(), { pid: 990201 });
	},
	stopGroup: async (pgid: number) => {
		h.state.stops.push(pgid);
		await h.state.stopHold;
		return h.state.stopResult;
	},
	llamaServerPids: async () => h.state.llama,
	runningServices: async () => h.state.servicesLeft
}));

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** The bundled status page calling one of its IPC handlers. */
function statusCall(name: string, ...args: unknown[]) {
	const status = h.state.windows.filter((w) => !w.destroyed && w.loaded === h.state.statusHtml).at(-1);
	if (!status) throw new Error('no status window');
	const event = { sender: { id: status.webContents.id }, senderFrame: { url: pathToFileURL(h.state.statusHtml).href } };
	return h.state.handlers.get(name)?.(event, ...args);
}

const appWindows = () => h.FakeWindow.getAllWindows().filter((w) => w.loaded.startsWith('http'));
const statusWindows = () => h.FakeWindow.getAllWindows().filter((w) => w.loaded === h.state.statusHtml);

async function launch() {
	await import('./main.js');
	h.start();
	await tick(50);
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
let listenersBefore: Map<string, Set<(...args: unknown[]) => void>>;

beforeEach(() => {
	vi.resetModules();
	h.reset();
	// A server URL exported for the real app would send startup down the remote path.
	vi.stubEnv('LLLM_SERVER_URL', '');
	h.state.userData = mkdtempSync(join(tmpdir(), 'lllm-desktop-'));
	h.state.statusHtml = join(__dirname, '..', 'static', 'status.html');
	vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
	listenersBefore = new Map(SIGNALS.map((s) => [s, new Set(process.listeners(s) as never)]));
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(h.state.userData, { recursive: true, force: true });
	// main.ts adds signal handlers each time it is imported.
	for (const signal of SIGNALS) {
		for (const f of process.listeners(signal)) {
			if (!listenersBefore.get(signal)?.has(f as never)) process.off(signal, f);
		}
	}
});

/** The SIGINT handler the freshly imported main.ts added. */
const sigint = () => (process.listeners('SIGINT').at(-1) as (() => void) | undefined)?.();

test('a Cancel while the last readiness probe is in flight opens no app window and stops once (#423)', async () => {
	let answer: (status: number) => void = () => {};
	h.state.ready = () => new Promise<number>((resolve) => (answer = resolve));
	await launch();

	void statusCall('status:action', 'cancel');
	await tick(20);
	answer(200);
	await tick(50);

	// No app window opened during the stop, and the stop dialog is still up.
	expect(appWindows()).toHaveLength(0);
	expect(statusWindows()).toHaveLength(1);
	// Closing the dialog or quitting during the stop does not start a second one.
	statusWindows()[0]?.userClose();
	h.state.appEvents.emit('before-quit', { preventDefault: () => {} });
	await tick(800);
	expect(h.state.stops).toEqual([990201]);
});

test('a quit while the app window loads keeps the stop dialog and stops once (#423)', async () => {
	await launch();
	const win = appWindows()[0];
	expect(win).toBeDefined();

	// The window is still loading when the user quits; the stop destroys it,
	// so it never paints, and the dialog stays.
	h.state.appEvents.emit('before-quit', { preventDefault: () => {} });
	await tick(20);
	win?.emit('ready-to-show');
	await tick(20);

	expect(appWindows()).toHaveLength(0);
	expect(statusWindows()).toHaveLength(1);
	h.state.appEvents.emit('window-all-closed');
	await tick(800);
	expect(h.state.stops).toEqual([990201]);
});

test('Retry during a stop does not start the stack again', async () => {
	let answer: (status: number) => void = () => {};
	h.state.ready = () => new Promise<number>((resolve) => (answer = resolve));
	await launch();
	expect(h.state.spawned).toBe(1);

	void statusCall('status:action', 'cancel');
	await tick(20);
	await statusCall('status:action', 'retry');
	answer(200);
	await tick(50);

	expect(h.state.spawned).toBe(1);
	expect(appWindows()).toHaveLength(0);
	await tick(800); // let the stop finish, so its exit does not land in the next test
});

test('after a forced stop that left a llama-server, "Leave it" quits and leaves it running (#421)', async () => {
	h.state.stopResult = { forced: true, llama: [777] };
	h.state.llama = [777];
	await launch();
	const win = appWindows()[0];
	win?.emit('ready-to-show');
	await tick(10);

	expect(win?.userClose()).toBe(false); // owned and running: the close becomes a stop
	await tick(50);
	expect(h.state.exits).toEqual([]); // the offer is shown, waiting for the user

	await statusCall('status:action', 'quit'); // "Leave it"
	expect(h.state.exits).toEqual([0]);
	expect(vi.mocked(process.kill).mock.calls.filter(([pid]) => pid === 777)).toEqual([]);
});

test('after a forced stop that left a llama-server, closing the dialog quits too (#421)', async () => {
	h.state.stopResult = { forced: true, llama: [777] };
	h.state.llama = [777];
	await launch();
	appWindows()[0]?.emit('ready-to-show');
	await tick(10);
	appWindows()[0]?.userClose();
	await tick(50);

	expect(statusWindows()[0]?.userClose()).toBe(true);
	h.state.appEvents.emit('window-all-closed');
	await tick(10);
	expect(h.state.exits).toEqual([0]);
	expect(h.state.stops).toEqual([990201]);
});

test('after a forced stop that left a llama-server, a signal quits too (#421)', async () => {
	h.state.stopResult = { forced: true, llama: [777] };
	h.state.llama = [777];
	await launch();
	appWindows()[0]?.emit('ready-to-show');
	await tick(10);
	appWindows()[0]?.userClose();
	await tick(50);
	expect(h.state.exits).toEqual([]);

	sigint(); // Ctrl-C on `make desktop`, or the session ending
	await tick(10);
	expect(h.state.exits).toEqual([0]);
	expect(h.state.stops).toEqual([990201]);
});

async function cleanStop() {
	await launch();
	appWindows()[0]?.emit('ready-to-show');
	await tick(10);
	appWindows()[0]?.userClose();
	await tick(50);
}

type Shown = { progress: { error?: string; steps: { id: string; state: string }[] } };

test('a clean stop that left the services running says so and waits (#435)', async () => {
	h.state.servicesLeft = 2;
	await cleanStop();
	await tick(700);

	expect(h.state.exits).toEqual([]);
	const shown = (await statusCall('status:ready')) as Shown;
	expect(shown.progress.steps.find((s) => s.id === 'services')?.state).toBe('failed');
	expect(shown.progress.error).toContain('2 containers are still there');

	await statusCall('status:action', 'quit');
	expect(h.state.exits).toEqual([0]);
});

test('a clean stop quits once the services are down (#435)', async () => {
	await cleanStop();
	await tick(700);
	expect(h.state.exits).toEqual([0]);
});

test('a stop it cannot check says so and waits, rather than calling it clean (#435)', async () => {
	h.state.servicesLeft = null;
	await cleanStop();
	await tick(700);

	expect(h.state.exits).toEqual([]);
	const shown = (await statusCall('status:ready')) as Shown;
	expect(shown.progress.error).toContain('Could not check');
	await statusCall('status:action', 'quit');
	expect(h.state.exits).toEqual([0]);
});

test('a forced stop that left the services fails the force step, and mentions a llama-server left (#435)', async () => {
	h.state.stopResult = { forced: true, llama: [777] };
	h.state.llama = [777];
	h.state.servicesLeft = 1;
	await cleanStop();

	const shown = (await statusCall('status:ready')) as Shown;
	expect(shown.progress.steps.find((s) => s.id === 'force')?.state).toBe('failed');
	expect(shown.progress.error).toContain('1 container is still there');
	expect(shown.progress.error).toContain('llama-server');
	expect(h.state.exits).toEqual([]);
});

// --- A stack an earlier launch started, found in owned.json (#431) -------------

function recordEarlierStack(record: Record<string, unknown>, config?: Record<string, unknown>) {
	writeFileSync(join(h.state.userData, 'owned.json'), JSON.stringify({ pgid: 4242, startTicks: '1', ...record }));
	if (config) writeFileSync(join(h.state.userData, 'config.json'), JSON.stringify(config));
}

const HERE = { serverUrl: 'http://127.0.0.1:4000', repoPath: '/home/u/local-llm' };
const ownedFile = () => JSON.parse(readFileSync(join(h.state.userData, 'owned.json'), 'utf8'));

test('a launch records the address and checkout it started the stack for (#431)', async () => {
	writeFileSync(join(h.state.userData, 'config.json'), JSON.stringify(HERE));
	await launch();

	expect(h.state.spawned).toBe(1);
	expect(ownedFile()).toMatchObject({ pgid: 990201, origin: HERE.serverUrl, repo: HERE.repoPath });
});

test('a stack started for this address and checkout is adopted, not stopped (#431)', async () => {
	recordEarlierStack({ origin: HERE.serverUrl, repo: HERE.repoPath }, HERE);
	await launch();

	expect(h.state.spawned).toBe(0);
	expect(h.state.stops).toEqual([]);
	expect(appWindows()).toHaveLength(1);
});

test('a stack started for another address is stopped, and a new one started (#431)', async () => {
	recordEarlierStack({ origin: 'http://127.0.0.1:4100', repo: HERE.repoPath }, HERE);
	await launch();

	expect(h.state.stops).toEqual([4242]);
	expect(h.state.spawned).toBe(1);
	expect(ownedFile()).toMatchObject({ pgid: 990201, origin: HERE.serverUrl });
});

test('a launch for a remote server stops the stack an earlier launch left running (#431)', async () => {
	recordEarlierStack({ origin: HERE.serverUrl, repo: HERE.repoPath }, HERE);
	vi.stubEnv('LLLM_SERVER_URL', 'https://llm.example.invalid');
	await launch();

	expect(h.state.stops).toEqual([4242]);
	expect(h.state.spawned).toBe(0);
	expect(existsSync(join(h.state.userData, 'owned.json'))).toBe(false);
});

test('a cancel while the earlier stack stops waits for that stop, and never signals it again (#431)', async () => {
	let release: () => void = () => {};
	h.state.stopHold = new Promise<void>((resolve) => (release = resolve));
	recordEarlierStack({ origin: 'http://127.0.0.1:4100', repo: HERE.repoPath }, HERE);
	await launch();
	expect(h.state.stops).toEqual([4242]);

	void statusCall('status:action', 'cancel');
	await tick(20);
	expect(statusWindows()[0]?.userClose()).toBe(false); // the dialog stays while it stops
	expect(h.state.exits).toEqual([]);

	release();
	await tick(20);
	expect(h.state.exits).toEqual([0]);
	expect(h.state.stops).toEqual([4242]);
	expect(h.state.spawned).toBe(0);
});

test('an earlier stack that had to be forced and left a llama-server stops the launch, saying so (#431)', async () => {
	h.state.stopResult = { forced: true, llama: [777] };
	recordEarlierStack({ origin: 'http://127.0.0.1:4100', repo: HERE.repoPath }, HERE);
	await launch();

	const shown = (await statusCall('status:ready')) as Shown;
	expect(shown.progress.error).toContain('a llama-server is still running (pid 777)');
	expect(h.state.spawned).toBe(0);
});

test('an earlier stack forced to stop cleanly lets the launch go on (#431)', async () => {
	h.state.stopResult = { forced: true, llama: [] };
	recordEarlierStack({ origin: 'http://127.0.0.1:4100', repo: HERE.repoPath }, HERE);
	await launch();

	expect(h.state.spawned).toBe(1);
});

// --- What answers on the dev server's port (#432) ------------------------------

test("another project's server on :5174 is not loaded in place of the built UI (#432)", async () => {
	writeFileSync(join(h.state.userData, 'config.json'), JSON.stringify(HERE));
	// Any page at any path, as a Vite server for some other project gives.
	h.state.devServer = () => '<!doctype html><title>Another app</title>';
	await launch();

	expect(h.state.spawned).toBe(1);
	expect(appWindows().map((w) => w.loaded)).toEqual([HERE.serverUrl]);
});

test("this checkout's dev server is loaded in place of the built UI (#432)", async () => {
	const repo = mkdtempSync(join(tmpdir(), 'lllm-repo-'));
	const webDir = join(repo, 'apps', 'web');
	mkdirSync(webDir, { recursive: true });
	writeFileSync(join(h.state.userData, 'config.json'), JSON.stringify({ ...HERE, repoPath: repo }));
	const asked: string[] = [];
	h.state.devServer = (url) => {
		asked.push(url);
		return JSON.stringify({ app: 'local-llm', webRoot: `${webDir}/` });
	};
	try {
		await launch();
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}

	expect(asked).toEqual(['http://localhost:5174/__lllm/dev-server']);
	expect(appWindows().map((w) => w.loaded)).toEqual(['http://localhost:5174']);
});
