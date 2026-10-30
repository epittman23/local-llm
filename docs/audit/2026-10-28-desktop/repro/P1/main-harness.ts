// Shared fake Electron for loading src/main.ts under Vitest. Nothing here
// spawns or signals a real process: spawnInGroup, probe and process.kill are
// all fakes driven by the test.
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCRATCH = tmpdir();
export const STATUS_HTML = fileURLToPath(new URL('../../../../../apps/desktop/static/status.html', import.meta.url));

export function makeElectron() {
	const userData = mkdtempSync(`${SCRATCH}/userdata-`);
	const appEvents = new EventEmitter();
	const handlers = new Map<string, (...a: unknown[]) => unknown>();
	const windows: FakeWindow[] = [];
	const exits: number[] = [];
	let nextId = 1;

	class FakeWindow extends EventEmitter {
		webContents = { id: nextId++, send: () => {} };
		destroyed = false;
		loaded = '';
		constructor(public opts: unknown) {
			super();
			windows.push(this);
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
		/** What a user's close (or the compositor's) does: 'close' listeners may preventDefault. */
		userClose(): boolean {
			let prevented = false;
			this.emit('close', { preventDefault: () => (prevented = true) });
			if (!prevented) this.destroy();
			return !prevented;
		}
		static getAllWindows() {
			return windows.filter((w) => !w.destroyed);
		}
	}

	let readyResolve!: () => void;
	const ready = new Promise<void>((r) => (readyResolve = r));
	const electron = {
		app: {
			isPackaged: false,
			getPath: () => userData,
			getVersion: () => '0.0.0',
			requestSingleInstanceLock: () => true,
			on: (e: string, f: (...a: unknown[]) => void) => appEvents.on(e, f),
			whenReady: () => ready,
			exit: (code: number) => exits.push(code),
			relaunch: () => {}
		},
		BrowserWindow: FakeWindow,
		dialog: {},
		ipcMain: { handle: (name: string, f: (...a: unknown[]) => unknown) => handlers.set(name, f) },
		Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
		screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 1000 } }) },
		session: { defaultSession: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} } },
		shell: { openExternal: () => {}, openPath: () => {} }
	};

	/** The bundled status page calling one of its IPC handlers. */
	function statusCall(name: string, ...args: unknown[]) {
		const status = windows.filter((w) => !w.destroyed && w.loaded === STATUS_HTML).at(-1);
		if (!status) throw new Error('no status window');
		const event = { sender: { id: status.webContents.id }, senderFrame: { url: pathToFileURL(STATUS_HTML).href } };
		return handlers.get(name)?.(event, ...args);
	}

	return { electron, appEvents, handlers, windows, exits, userData, start: () => readyResolve(), statusCall, FakeWindow };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
