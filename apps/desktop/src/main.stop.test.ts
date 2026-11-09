// How main.ts stops (#421, #423), run against a fake Electron. main.ts runs at
// import, so each test imports it afresh with a new fake. Nothing here spawns
// or signals a real process: spawnInGroup, probe, stopGroup and the llama-server
// lookup are fakes driven by the test, and process.kill is spied on.
//
// The fake is built inside vi.hoisted because vi.mock factories may only use
// hoisted values; it follows docs/audit/2026-10-28-desktop/repro/P1/main-harness.ts.
import { EventEmitter } from 'node:events';
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
		/** Each stop's interrupt option, and owned.json as it was when the stop began (#649). */
		stopCalls: [] as { pgid: number; interrupt: boolean; owned: unknown }[],
		spawned: 0,
		/** What the next /ready probe answers; a promise holds it in flight. */
		ready: (): Promise<number | null> => Promise.resolve(200),
		stopResult: { forced: false, llama: [] as number[] },
		/** Holds every stop in flight until it resolves. */
		stopHold: Promise.resolve() as Promise<void>,
		/** What /check and the port's listener give for the served llama-server (#434). */
		served: null as { pid: number; startTicks: string } | null,
		/** Processes as /proc shows them, by pid; any other is a `make`. */
		procs: new Map<number, { comm: string; startTicks: string }>(),
		/** Containers compose still lists as running after a clean stop; null when it can't be asked. */
		servicesLeft: 0 as number | null,
		/** Whether the backend's port refuses a connection or something holds it, before a start (#422). */
		port: 'refused' as 'refused' | 'held',
		/** Containers compose lists as running before a start; null when it can't be asked (#422). */
		servicesUp: 0 as number | null,
		/** The args of each app.relaunch (#424). */
		relaunches: [] as unknown[],
		/** The application menu's template, so a test can click an item. */
		menu: [] as unknown[],
		/** What answers on the dev server's :5174, by URL; nothing by default (#432). */
		devServer: null as ((url: string) => string | null) | null,
		/** Builds the next spawned child; the default is one that started (#433). */
		spawnChild: null as (() => unknown) | null,
		/** owned.json operations that fail, as a full disk or a read-only directory would (#649). */
		ownedFails: { rename: false, rm: false },
		/** How the app page's own load settles; it loads at once by default (#803). */
		pageLoad: null as (() => Promise<void>) | null
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
		bounds = { x: 0, y: 0, width: 100, height: 100 };
		getNormalBounds() {
			return this.bounds;
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
			return (u.startsWith('http') && state.pageLoad?.()) || Promise.resolve();
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
			relaunch: (options?: { args?: string[] }) => state.relaunches.push(options?.args)
		},
		BrowserWindow: FakeWindow,
		dialog: {},
		ipcMain: { handle: (name: string, f: (...args: unknown[]) => unknown) => state.handlers.set(name, f) },
		Menu: {
			setApplicationMenu: () => {},
			buildFromTemplate: (template: unknown[]) => {
				state.menu = template;
				return {};
			}
		},
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
		state.stopCalls = [];
		state.spawned = 0;
		state.ready = () => Promise.resolve(200);
		state.stopResult = { forced: false, llama: [] };
		state.stopHold = Promise.resolve();
		state.served = null;
		state.procs = new Map();
		state.servicesLeft = 0;
		state.port = 'refused';
		state.servicesUp = 0;
		state.relaunches = [];
		state.menu = [];
		state.devServer = null;
		state.spawnChild = null;
		state.ownedFails = { rename: false, rm: false };
		state.pageLoad = null;
	}

	return { state, FakeWindow, Emitter, electron, reset, start: () => markReady() };
});

vi.mock('../node_modules/electron/index.js', () => {
	const electron = h.electron();
	return { ...electron, default: electron };
});
vi.mock('node:fs', async (original) => {
	const fs = await original<typeof import('node:fs')>();
	const failing = (op: 'rename' | 'rm', path: unknown) => {
		if (h.state.ownedFails[op] && String(path).endsWith('owned.json')) {
			throw Object.assign(new Error(`EACCES: ${op} ${String(path)}`), { code: 'EACCES' });
		}
	};
	const renameSync: typeof fs.renameSync = (from, to) => {
		failing('rename', to);
		fs.renameSync(from, to);
	};
	const rmSync: typeof fs.rmSync = (path, options) => {
		failing('rm', path);
		fs.rmSync(path, options);
	};
	return { ...fs, default: { ...fs, renameSync, rmSync }, renameSync, rmSync };
});
vi.mock('./config', async (original) => ({ ...(await original<typeof import('./config')>()), isRepoRoot: () => true }));
vi.mock('./stack', async (original) => ({
	...(await original<typeof import('./stack')>()),
	isUiStale: async () => false,
	readProcStat: (pid: number) => h.state.procs.get(pid) ?? { comm: 'make', startTicks: '1' },
	servedLlama: async () => h.state.served,
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
		return h.state.spawnChild?.() ?? Object.assign(new h.Emitter(), { pid: 990201 });
	},
	stopGroup: async (pgid: number, _deps: unknown, options?: { interrupt?: boolean }) => {
		h.state.stops.push(pgid);
		let owned: unknown = null;
		try {
			owned = JSON.parse(readFileSync(join(h.state.userData, 'owned.json'), 'utf8'));
		} catch {
			// None recorded.
		}
		h.state.stopCalls.push({ pgid, interrupt: options?.interrupt ?? true, owned });
		await h.state.stopHold;
		return h.state.stopResult;
	},
	runningServices: async () => h.state.servicesLeft,
	portState: async () => h.state.port,
	servicesUp: async () => h.state.servicesUp
}));

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** The bundled status page calling one of its IPC handlers. */
function statusCall(name: string, ...args: unknown[]) {
	const status = h.state.windows.filter((w) => !w.destroyed && w.loaded === h.state.statusHtml).at(-1);
	if (!status) throw new Error('no status window');
	const event = { sender: { id: status.webContents.id }, senderFrame: { url: pathToFileURL(h.state.statusHtml).href } };
	return h.state.handlers.get(name)?.(event, ...args);
}

/** Clicks a menu item by its label, searching every submenu. */
function clickMenu(label: string) {
	type Item = { label?: string; click?: () => void; submenu?: Item[] };
	const find = (items: Item[]): Item | undefined =>
		items.reduce<Item | undefined>(
			(found, item) => found ?? (item.label === label ? item : find(item.submenu ?? [])),
			undefined
		);
	const item = find(h.state.menu as Item[]);
	if (!item?.click) throw new Error(`no menu item ${label}`);
	item.click();
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

/** A launch that runs, then a forced stop that leaves what /proc lists, offering what `stopResult` says. */
async function forcedStopOffering(llama: number[]) {
	h.state.stopResult = { forced: true, llama };
	await launch();
	const win = appWindows()[0];
	win?.emit('ready-to-show');
	await tick(10);
	win?.userClose();
	await tick(50);
}

const llamaKills = () =>
	vi
		.mocked(process.kill)
		.mock.calls.filter(([, signal]) => signal === 'SIGTERM')
		.map(([pid]) => pid);

test('"Stop llama-server" stops the llama-server this stack served and no other (#434)', async () => {
	h.state.served = { pid: 555, startTicks: '9' };
	h.state.procs.set(555, { comm: 'llama-server', startTicks: '9' });
	h.state.procs.set(777, { comm: 'llama-server', startTicks: '4' }); // the user's own
	await forcedStopOffering([555]);

	await statusCall('status:action', 'stop-llama');
	expect(llamaKills()).toEqual([555]);
	expect(h.state.exits).toEqual([0]);
});

test('the recorded llama-server is written into owned.json while the stack runs (#434)', async () => {
	h.state.served = { pid: 555, startTicks: '9' };
	await launch();
	appWindows()[0]?.emit('ready-to-show');
	await tick(20);
	expect(JSON.parse(readFileSync(join(h.state.userData, 'owned.json'), 'utf8')).llama).toEqual({
		pid: 555,
		startTicks: '9'
	});
});

test('with nothing recorded, "Stop llama-server" signals no llama-server (#434)', async () => {
	h.state.procs.set(777, { comm: 'llama-server', startTicks: '4' }); // the user's own
	await forcedStopOffering([777]);

	await statusCall('status:action', 'stop-llama');
	expect(llamaKills()).toEqual([]);
});

test('a recorded llama-server whose pid was reused is not signalled (#434)', async () => {
	h.state.served = { pid: 555, startTicks: '9' };
	h.state.procs.set(555, { comm: 'llama-server', startTicks: '10' }); // same pid, started later
	await forcedStopOffering([555]);

	await statusCall('status:action', 'stop-llama');
	expect(llamaKills()).toEqual([]);
});

test('after a forced stop that left a llama-server, closing the dialog quits too (#421)', async () => {
	h.state.stopResult = { forced: true, llama: [777] };
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

type Shown = { progress: { error?: string; steps: { id: string; state: string; detail?: string }[] } };

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
	h.state.servicesLeft = 1;
	await cleanStop();

	const shown = (await statusCall('status:ready')) as Shown;
	expect(shown.progress.steps.find((s) => s.id === 'force')?.state).toBe('failed');
	expect(shown.progress.error).toContain('1 container is still there');
	expect(shown.progress.error).toContain('llama-server');
	expect(h.state.exits).toEqual([]);
});

// --- The page's pending saves, before the window goes (#803) --------------------

/** A running app window whose blank-page load the test holds. */
async function heldUnload(unload: () => Promise<void>) {
	await launch();
	const win = appWindows()[0];
	if (!win) throw new Error('no app window');
	win.emit('ready-to-show');
	await tick(10);
	const loads: string[] = [];
	win.loadURL = (url: string) => {
		loads.push(url);
		return url === 'about:blank' ? unload() : Promise.resolve();
	};
	return { win, loads };
}

test('closing the app unloads the page, so its pagehide sends pending saves, before destroying it and stopping (#803)', async () => {
	let unloaded: () => void = () => {};
	const { win, loads } = await heldUnload(() => new Promise<void>((resolve) => (unloaded = resolve)));

	expect(win.userClose()).toBe(false);
	await tick(50);
	expect(loads).toEqual(['about:blank']);
	// Still unloading: not destroyed, and the stack not signalled yet.
	expect(win.isDestroyed()).toBe(false);
	expect(h.state.stops).toEqual([]);

	unloaded();
	await tick(20);
	expect(win.isDestroyed()).toBe(true);
	expect(h.state.stops).toEqual([990201]);
	await tick(700);
	expect(h.state.exits).toEqual([0]);
});

test('a page that never finishes unloading is destroyed after 2 s, and the stop goes on (#803)', async () => {
	const { win } = await heldUnload(() => new Promise<void>(() => {}));

	expect(win.userClose()).toBe(false);
	await tick(1000);
	expect(win.isDestroyed()).toBe(false);
	expect(h.state.stops).toEqual([]);

	await tick(1200);
	expect(win.isDestroyed()).toBe(true);
	expect(h.state.stops).toEqual([990201]);
	await tick(700);
	expect(h.state.exits).toEqual([0]);
});

test('the app page load the blank page aborts raises no unhandled rejection (#803)', async () => {
	let abort: () => void = () => {};
	h.state.pageLoad = () =>
		new Promise<void>((_resolve, reject) => {
			abort = () =>
				reject(Object.assign(new Error('ERR_ABORTED (-3) loading http://127.0.0.1:4000'), { code: 'ERR_ABORTED' }));
		});
	const unhandled: unknown[] = [];
	const record = (reason: unknown) => unhandled.push(reason);
	process.on('unhandledRejection', record);
	try {
		await launch();
		const win = appWindows()[0];
		win?.emit('ready-to-show');
		await tick(10);
		win?.userClose();
		abort(); // what loading about:blank does to a load still in flight
		await tick(50);
	} finally {
		process.off('unhandledRejection', record);
	}

	expect(unhandled).toEqual([]);
	expect(h.state.stops).toEqual([990201]);
	await tick(700);
});

test('a blank-page load that fails still destroys the window and stops (#803)', async () => {
	const { win } = await heldUnload(() => Promise.reject(new Error('ERR_ABORTED')));

	win.userClose();
	await tick(50);
	expect(win.isDestroyed()).toBe(true);
	expect(h.state.stops).toEqual([990201]);
	await tick(700);
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

// --- A crash during a stop leaves owned.json marked stopping (#649) -----------

test('closing the app marks owned.json stopping before its one SIGINT, and removes it after (#649)', async () => {
	writeFileSync(join(h.state.userData, 'config.json'), JSON.stringify(HERE));
	await cleanStop();

	expect(h.state.stopCalls).toEqual([
		{ pgid: 990201, interrupt: true, owned: expect.objectContaining({ pgid: 990201, stopping: true }) }
	]);
	await tick(700);
	expect(existsSync(join(h.state.userData, 'owned.json'))).toBe(false);
});

test('a stack an earlier launch was stopping is waited for, never signalled again, and not adopted (#649)', async () => {
	recordEarlierStack({ origin: HERE.serverUrl, repo: HERE.repoPath, stopping: true }, HERE);
	await launch();

	expect(h.state.stopCalls.map(({ pgid, interrupt }) => ({ pgid, interrupt }))).toEqual([
		{ pgid: 4242, interrupt: false }
	]);
	expect(h.state.spawned).toBe(1);
	expect(ownedFile()).toEqual({ pgid: 990201, startTicks: '1', origin: HERE.serverUrl, repo: HERE.repoPath });
});

test('a launch for a remote server waits for a stack an earlier launch was stopping, never signalling it (#649)', async () => {
	recordEarlierStack({ origin: HERE.serverUrl, repo: HERE.repoPath, stopping: true }, HERE);
	vi.stubEnv('LLLM_SERVER_URL', 'https://llm.example.invalid');
	await launch();

	expect(h.state.stopCalls.map(({ pgid, interrupt }) => ({ pgid, interrupt }))).toEqual([
		{ pgid: 4242, interrupt: false }
	]);
	expect(existsSync(join(h.state.userData, 'owned.json'))).toBe(false);
});

test('while an earlier stack stops, owned.json names it as stopping, so a crash then cannot signal it twice (#649)', async () => {
	let release: () => void = () => {};
	h.state.stopHold = new Promise<void>((resolve) => (release = resolve));
	recordEarlierStack({ origin: 'http://127.0.0.1:4100', repo: HERE.repoPath }, HERE);
	await launch();

	expect(h.state.stopCalls).toEqual([
		{ pgid: 4242, interrupt: true, owned: expect.objectContaining({ pgid: 4242, stopping: true }) }
	]);
	expect(ownedFile()).toMatchObject({ pgid: 4242, stopping: true });

	release();
	await tick(50);
	expect(ownedFile()).toEqual({ pgid: 990201, startTicks: '1', origin: HERE.serverUrl, repo: HERE.repoPath });
});

test('owned.json is written whole, through a temporary file renamed into place (#649)', async () => {
	writeFileSync(join(h.state.userData, 'config.json'), JSON.stringify(HERE));
	await cleanStop();

	expect(h.state.stopCalls[0]?.owned).toMatchObject({ stopping: true });
	expect(existsSync(join(h.state.userData, 'owned.json.tmp'))).toBe(false);
	await tick(700); // let the stop finish, so its exit does not land in the next test
});

test('a stopping mark that cannot be written removes the record before the SIGINT, and the stop goes on (#649)', async () => {
	writeFileSync(join(h.state.userData, 'config.json'), JSON.stringify(HERE));
	await launch();
	expect(ownedFile()).toMatchObject({ pgid: 990201 });
	mkdirSync(join(h.state.userData, 'owned.json.tmp')); // the temporary file the write goes through
	appWindows()[0]?.emit('ready-to-show');
	await tick(10);
	appWindows()[0]?.userClose();
	await tick(700);

	expect(h.state.stopCalls).toEqual([{ pgid: 990201, interrupt: true, owned: null }]);
	expect(h.state.exits).toEqual([0]);
});

test('a stopping mark that cannot be renamed into place removes the record before the SIGINT (#649)', async () => {
	writeFileSync(join(h.state.userData, 'config.json'), JSON.stringify(HERE));
	await launch();
	h.state.ownedFails.rename = true;
	appWindows()[0]?.emit('ready-to-show');
	await tick(10);
	appWindows()[0]?.userClose();
	await tick(700);

	expect(h.state.stopCalls).toEqual([{ pgid: 990201, interrupt: true, owned: null }]);
	expect(h.state.exits).toEqual([0]);
});

test('a record that can be neither marked nor removed still lets the stop and the quit go on (#649)', async () => {
	writeFileSync(join(h.state.userData, 'config.json'), JSON.stringify(HERE));
	await launch();
	h.state.ownedFails = { rename: true, rm: true };
	appWindows()[0]?.emit('ready-to-show');
	await tick(10);
	appWindows()[0]?.userClose();
	await tick(700);

	expect(h.state.stops).toEqual([990201]);
	expect(h.state.exits).toEqual([0]);
});

test('an earlier stack whose record cannot be removed after its stop still lets the launch go on (#649)', async () => {
	recordEarlierStack({ origin: 'http://127.0.0.1:4100', repo: HERE.repoPath }, HERE);
	h.state.ownedFails.rm = true;
	await launch();

	expect(h.state.stops).toEqual([4242]);
	expect(h.state.spawned).toBe(1);
});

// --- Settings and config.json (#424, #425, #426, #437) --------------------------

const configFile = () => join(h.state.userData, 'config.json');
const storedFile = () => JSON.parse(readFileSync(configFile(), 'utf8'));
type Settings = { serverUrl: string; override: { url: string; from: string } | null; problem: string | null };
type Saved = { error?: string; restart?: boolean; replaced?: { url: string; from: string } };

test('Settings names an active LLLM_SERVER_URL, and a save replaces it for Retry (#424)', async () => {
	writeFileSync(configFile(), JSON.stringify(HERE));
	vi.stubEnv('LLLM_SERVER_URL', 'https://nothing.invalid');
	await launch();
	expect(((await statusCall('status:ready')) as Shown).progress.error).toContain('https://nothing.invalid');

	const settings = (await statusCall('status:get-settings')) as Settings;
	expect(settings.serverUrl).toBe(HERE.serverUrl);
	expect(settings.override).toEqual({ url: 'https://nothing.invalid', from: 'LLLM_SERVER_URL' });

	const saved = (await statusCall('status:save-settings', HERE)) as Saved;
	expect(saved.error).toBeUndefined();
	expect(saved.replaced).toEqual({ url: 'https://nothing.invalid', from: 'LLLM_SERVER_URL' });
	expect(((await statusCall('status:get-settings')) as Settings).override).toBeNull();

	void statusCall('status:action', 'retry'); // settles once the window shows
	await tick(50);
	expect(h.state.spawned).toBe(1);
	expect(appWindows().map((w) => w.loaded)).toEqual([HERE.serverUrl]);
});

test('Restart now relaunches without --server-url or LLLM_SERVER_URL (#424)', async () => {
	const argv = process.argv;
	process.argv = [...argv, '--server-url=https://nothing.invalid'];
	vi.stubEnv('LLLM_SERVER_URL', 'https://nothing.invalid');
	try {
		await launch();
		await statusCall('status:action', 'restart');
	} finally {
		process.argv = argv;
	}

	expect(h.state.relaunches).toHaveLength(1);
	expect(h.state.relaunches[0]).not.toContain('--server-url=https://nothing.invalid');
	expect(process.env.LLLM_SERVER_URL).toBeUndefined();
	expect(h.state.exits).toEqual([0]);
});

test('a save that cannot be written says so in the dialog (#426)', async () => {
	writeFileSync(configFile(), JSON.stringify(HERE));
	h.state.ready = () => new Promise<number>(() => {}); // held in its start, so Settings is all that runs
	await launch();
	mkdirSync(`${configFile()}.tmp`); // the temporary file a save writes first

	const saved = (await statusCall('status:save-settings', HERE)) as Saved;
	expect(saved.error).toContain('Could not save the settings');
	expect(saved.restart).toBeUndefined();
});

test('a mistyped server URL in config.json is reported at startup, and a bounds save keeps it (#437)', async () => {
	writeFileSync(
		configFile(),
		JSON.stringify({ serverUrl: 'llm.example.ts.net', repoPath: HERE.repoPath, theme: 'dark' })
	);
	await launch();

	const shown = (await statusCall('status:ready')) as Shown;
	expect(shown.progress.steps.find((s) => s.id === 'check')?.detail).toContain('"llm.example.ts.net"');

	const win = appWindows()[0];
	expect(win).toBeDefined();
	if (win) win.bounds = { x: 10, y: 20, width: 900, height: 700 };
	win?.emit('ready-to-show');
	await tick(10);
	win?.userClose();
	await tick(800);

	expect(storedFile()).toEqual({
		serverUrl: 'llm.example.ts.net',
		repoPath: HERE.repoPath,
		theme: 'dark',
		bounds: { x: 10, y: 20, width: 900, height: 700 }
	});
});

test('quitting from the menu or Ctrl+Q saves the window size, though no close event comes (#425)', async () => {
	writeFileSync(configFile(), JSON.stringify(HERE));
	await launch();
	const win = appWindows()[0];
	if (win) win.bounds = { x: 10, y: 20, width: 900, height: 700 };
	win?.emit('ready-to-show');
	await tick(10);

	h.state.appEvents.emit('before-quit', { preventDefault: () => {} });
	await tick(800);

	expect(h.state.stops).toEqual([990201]);
	expect(storedFile().bounds).toEqual({ x: 10, y: 20, width: 900, height: 700 });
});

test('a signal saves the window size too (#425)', async () => {
	writeFileSync(configFile(), JSON.stringify(HERE));
	await launch();
	const win = appWindows()[0];
	if (win) win.bounds = { x: 1, y: 2, width: 800, height: 600 };
	win?.emit('ready-to-show');
	await tick(10);

	sigint();
	await tick(800);
	expect(storedFile().bounds).toEqual({ x: 1, y: 2, width: 800, height: 600 });
});

test('a mistyped stored URL is not reported while an override is what this launch uses, and Settings still names it (#437)', async () => {
	writeFileSync(configFile(), JSON.stringify({ serverUrl: 'llm.example.ts.net', repoPath: HERE.repoPath }));
	vi.stubEnv('LLLM_SERVER_URL', 'https://nothing.invalid');
	await launch();

	const shown = (await statusCall('status:ready')) as Shown;
	expect(shown.progress.steps.find((s) => s.id === 'check')?.detail).toBeUndefined();
	const settings = (await statusCall('status:get-settings')) as Settings;
	expect(settings.problem).toContain('"llm.example.ts.net"');
});

test('Settings has no problem to name for a valid file (#437)', async () => {
	writeFileSync(configFile(), JSON.stringify(HERE));
	await launch();
	expect(((await statusCall('status:get-settings')) as Settings).problem).toBeNull();
});

test('Restart now while the app runs its own stack saves the window size and stops the stack once (#424, #425)', async () => {
	writeFileSync(configFile(), JSON.stringify(HERE));
	await launch();
	const win = appWindows()[0];
	if (win) win.bounds = { x: 3, y: 4, width: 1000, height: 750 };
	win?.emit('ready-to-show');
	await tick(10);
	clickMenu('Settings…');
	await tick(10);

	await statusCall('status:action', 'restart');
	await tick(50);

	expect(h.state.relaunches).toHaveLength(1);
	expect(h.state.stops).toEqual([990201]);
	expect(storedFile().bounds).toEqual({ x: 3, y: 4, width: 1000, height: 750 });
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

// --- A login shell that cannot be spawned (#433) --------------------------------

test('a login shell that cannot be spawned fails the start, saying why, with no uncaught error (#433)', async () => {
	// Node's own: an 'error' with no listener throws. spawn gives no pid, then emits it.
	h.state.spawnChild = () => {
		const child = Object.assign(new EventEmitter(), { pid: undefined });
		setImmediate(() => child.emit('error', new Error('spawn /nonexistent/shell ENOENT')));
		return child;
	};
	const uncaught: unknown[] = [];
	const record = (error: unknown) => uncaught.push(error);
	process.on('uncaughtException', record);
	try {
		await launch();
		await tick(50);
	} finally {
		process.off('uncaughtException', record);
	}

	expect(uncaught).toEqual([]);
	const shown = (await statusCall('status:ready')) as Shown;
	expect(shown.progress.error).toContain('Could not start make backend');
	expect(shown.progress.error).toContain('spawn /nonexistent/shell ENOENT');
	expect(existsSync(join(h.state.userData, 'owned.json'))).toBe(false);
});

// --- A port held, or the services up, with no answer on /health (#422) ----------

test('a port that accepts connections but does not answer starts no second backend, and says why (#422)', async () => {
	h.state.port = 'held';
	await launch();

	expect(h.state.spawned).toBe(0);
	expect(appWindows()).toHaveLength(0);
	const shown = (await statusCall('status:ready')) as Shown;
	expect(shown.progress.steps.find((s) => s.id === 'check')?.state).toBe('failed');
	expect(shown.progress.error).toContain('Port 4000 is in use');
	expect(shown.progress.error).toContain('does not start a second backend');
	expect(existsSync(join(h.state.userData, 'owned.json'))).toBe(false);
});

test('services already running with nothing on the port start no second backend, and name the stop command (#422)', async () => {
	writeFileSync(join(h.state.userData, 'config.json'), JSON.stringify(HERE));
	h.state.servicesUp = 4;
	await launch();

	expect(h.state.spawned).toBe(0);
	const shown = (await statusCall('status:ready')) as Shown;
	expect(shown.progress.error).toContain('are already running');
	expect(shown.progress.error).toContain(`docker compose -f ${HERE.repoPath}/infra/docker-compose.yml down`);
});

test('a refused connection with the services down starts the stack as before (#422)', async () => {
	await launch();
	expect(h.state.spawned).toBe(1);
});

test('compose that cannot be asked does not stop a start; make backend then says why (#422)', async () => {
	h.state.servicesUp = null;
	await launch();
	expect(h.state.spawned).toBe(1);
});

test('the stack this app started before a crash is adopted even while it holds the port without answering (#422)', async () => {
	recordEarlierStack({ origin: HERE.serverUrl, repo: HERE.repoPath }, HERE);
	h.state.port = 'held';
	h.state.servicesUp = 4;
	await launch();

	expect(h.state.spawned).toBe(0);
	expect(h.state.stops).toEqual([]);
	expect(appWindows()).toHaveLength(1);
});
