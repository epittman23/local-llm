// How main.ts stops (#421, #423), run against a fake Electron. main.ts runs at
// import, so each test imports it afresh with a new fake. Nothing here spawns
// or signals a real process: spawnInGroup, probe, stopGroup and the llama-server
// lookup are fakes driven by the test, and process.kill is spied on.
//
// The fake is built inside vi.hoisted because vi.mock factories may only use
// hoisted values; it follows docs/audit/2026-10-28-desktop/repro/P1/main-harness.ts.
import { mkdtempSync } from 'node:fs';
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
		/** What the next /ready probe answers; a promise holds it in flight. */
		ready: (): Promise<number | null> => Promise.resolve(200),
		stopResult: { forced: false, llama: [] as number[] },
		llama: [] as number[]
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
		state.ready = () => Promise.resolve(200);
		state.stopResult = { forced: false, llama: [] };
		state.llama = [];
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
	probe: async (url: string) => (url.endsWith('/ready') ? h.state.ready() : null),
	spawnInGroup: () => Object.assign(new h.Emitter(), { pid: 990201 }),
	stopGroup: async (pgid: number) => {
		h.state.stops.push(pgid);
		return h.state.stopResult;
	},
	llamaServerPids: async () => h.state.llama
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

beforeEach(() => {
	vi.resetModules();
	h.reset();
	h.state.userData = mkdtempSync(join(tmpdir(), 'lllm-desktop-'));
	h.state.statusHtml = join(__dirname, '..', 'static', 'status.html');
	vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
});

afterEach(() => vi.restoreAllMocks());

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

test('an app window that paints after a stop began does not end the stopping phase (#423)', async () => {
	await launch();
	const win = appWindows()[0];
	expect(win).toBeDefined();

	// The window is still loading when the user quits.
	h.state.appEvents.emit('before-quit', { preventDefault: () => {} });
	await tick(20);
	win?.emit('ready-to-show');
	await tick(20);

	expect(statusWindows()).toHaveLength(1);
	win?.userClose();
	await tick(800);
	expect(h.state.stops).toEqual([990201]);
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

test('after a forced stop that left a llama-server, closing the dialog or a signal quits too (#421)', async () => {
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
