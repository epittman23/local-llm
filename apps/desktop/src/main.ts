// Local LLM's desktop app: opens the server's own pages in a window of their
// own, so the desktop and the browser run the same app from the same origin.
// When the server is this machine, it also starts the local stack (through
// the root Makefile's `make backend`) if nothing is running, and stops what
// it started when it closes. A stack started elsewhere, from a terminal, is
// connected to as it is and left running. docs/guides/desktop.md has the
// whole picture.

import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	app,
	BrowserWindow,
	dialog,
	type IpcMainInvokeEvent,
	ipcMain,
	Menu,
	type Rectangle,
	screen,
	session,
	shell,
	type WebPreferences
} from 'electron';
import {
	type Bounds,
	DEFAULT_SERVER_URL,
	type DesktopConfig,
	isLocalOrigin,
	isRepoRoot,
	localPort,
	normalizeServerUrl,
	readConfig,
	resolveServerUrl,
	writeConfig
} from './config';
import { classifyOpen, isAllowedPermission } from './policy';
import {
	createProgress,
	type Progress,
	type ProgressEvent,
	reduce,
	SHUTDOWN,
	STARTUP_ATTACH,
	STARTUP_OWN,
	startupRemote
} from './progress';
import {
	buildUiCommand,
	childEnv,
	composeDownCommand,
	DEV_SERVER_URL,
	decideStart,
	groupAlive,
	isAdoptable,
	isUiStale,
	LogTail,
	llamaServerPids,
	makeBackendCommand,
	type OwnedRecord,
	parseOwned,
	probe,
	readProcStat,
	runInShell,
	spawnInGroup,
	stopGroup
} from './stack';

const STATUS_HTML = join(__dirname, '..', 'static', 'status.html');
const ICON = app.isPackaged
	? join(process.resourcesPath, 'icon.png')
	: join(__dirname, '..', '..', 'web', 'public', 'favicon.png');

// userData is ~/.config/Local LLM: package.json's productName, the same in
// development (`electron .`) and packaged, so both share one session.
const USER_DATA = app.getPath('userData');
const CONFIG_FILE = join(USER_DATA, 'config.json');
const OWNED_FILE = join(USER_DATA, 'owned.json');
const LOG_FILE = join(USER_DATA, 'logs', 'backend.log');

type Phase = 'idle' | 'starting' | 'running' | 'failed' | 'stopping';

let phase: Phase = 'idle';
let config: DesktopConfig;
/** The origin the app window shows; '' until it opens, which denies everything. */
let appOrigin = '';
let mainWindow: BrowserWindow | null = null;
let statusWindow: BrowserWindow | null = null;
let statusView: 'progress' | 'settings' = 'progress';
let progress: Progress = createProgress('startup', 'Starting Local LLM', [], Date.now());
/** The stack this app started (or adopted) and so must stop. */
let owned: { pgid: number; child?: ChildProcess; exitCode?: number | null } | null = null;
let buildChild: ChildProcess | null = null;
let tail: LogTail | null = null;
let startAbort: AbortController | null = null;

class Cancelled extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function buildInfoRepo(): string {
	try {
		return JSON.parse(readFileSync(join(__dirname, 'build-info.json'), 'utf8')).repoRoot;
	} catch {
		return join(app.getPath('home'), 'local-llm');
	}
}

function storedConfig(): DesktopConfig {
	return readConfig(CONFIG_FILE, { serverUrl: DEFAULT_SERVER_URL, repoPath: buildInfoRepo() });
}

/** The stored settings, with `--server-url` / LLLM_SERVER_URL applied on top (never saved). */
function loadConfig(): DesktopConfig {
	const stored = storedConfig();
	return { ...stored, serverUrl: resolveServerUrl(process.argv, process.env, stored.serverUrl) };
}

// --- The progress window -------------------------------------------------------

let sendTimer: NodeJS.Timeout | undefined;

function dispatch(event: ProgressEvent): void {
	setProgress(reduce(progress, event));
}

/** Snapshots go to the window at most ten times a second; a build prints thousands of lines. */
function setProgress(next: Progress): void {
	progress = next;
	if (sendTimer) return;
	sendTimer = setTimeout(() => {
		sendTimer = undefined;
		statusWindow?.webContents.send('status:update', progress);
	}, 100);
}

function openStatus(view: 'progress' | 'settings'): void {
	statusView = view;
	if (!statusWindow) {
		statusWindow = new BrowserWindow({
			// A fixed size (minimum = maximum) is what tiling compositors such
			// as Hyprland and sway take as "float this", so the dialog opens
			// floating and centred instead of being tiled like the app window.
			width: 560,
			height: 480,
			resizable: false,
			maximizable: false,
			fullscreenable: false,
			center: true,
			title: 'Local LLM',
			icon: ICON,
			autoHideMenuBar: true,
			show: false,
			webPreferences: {
				preload: join(__dirname, 'status-preload.js'),
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false
			}
		});
		statusWindow.setMenu(null);
		statusWindow.once('ready-to-show', () => statusWindow?.show());
		statusWindow.on('close', (event) => {
			// Closing the dialog mid-startup cancels it; mid-shutdown it can't
			// be closed; a failed start just quits.
			if (phase === 'starting') {
				event.preventDefault();
				void shutdown();
			} else if (phase === 'stopping') {
				event.preventDefault();
			}
		});
		statusWindow.on('closed', () => {
			statusWindow = null;
		});
		void statusWindow.loadFile(STATUS_HTML);
	} else {
		statusWindow.webContents.send('status:view', view);
		statusWindow.show();
		statusWindow.focus();
	}
}

// --- The app window --------------------------------------------------------------

function appWebPreferences(): WebPreferences {
	return {
		preload: join(__dirname, 'preload.js'),
		sandbox: true,
		contextIsolation: true,
		nodeIntegration: false,
		webviewTag: false,
		additionalArguments: [`--lllm-desktop-version=${app.getVersion()}`]
	};
}

/** Saved bounds, if they still overlap a connected display. */
function savedBounds(): Partial<Rectangle> {
	const b = config.bounds;
	if (!b) return { width: 1280, height: 860 };
	const area = screen.getDisplayMatching(b).workArea;
	const overlaps =
		b.x < area.x + area.width && b.x + b.width > area.x && b.y < area.y + area.height && b.y + b.height > area.y;
	return overlaps ? b : { width: b.width, height: b.height };
}

function saveBounds(bounds: Bounds): void {
	try {
		writeConfig(CONFIG_FILE, { ...storedConfig(), bounds });
	} catch {
		// Not worth interrupting a close for.
	}
}

function openApp(url: string): Promise<void> {
	appOrigin = new URL(url).origin;
	dispatch({ type: 'begin', step: 'open', at: Date.now() });
	const win = new BrowserWindow({
		...savedBounds(),
		minWidth: 480,
		minHeight: 400,
		title: 'Local LLM',
		icon: ICON,
		autoHideMenuBar: true,
		show: false,
		webPreferences: appWebPreferences()
	});
	mainWindow = win;
	win.on('close', (event) => {
		saveBounds(win.getNormalBounds());
		if (owned && phase === 'running') {
			event.preventDefault();
			void shutdown();
		}
	});
	win.on('closed', () => {
		mainWindow = null;
	});
	return new Promise((resolve) => {
		win.once('ready-to-show', () => {
			// Shown before the dialog closes, or no window would be left
			// open for a moment and the app would quit.
			win.show();
			dispatch({ type: 'complete', at: Date.now() });
			phase = 'running';
			if (statusView === 'progress') statusWindow?.destroy();
			resolve();
		});
		void win.loadURL(url);
	});
}

// --- Starting ------------------------------------------------------------------

function fail(message: string): void {
	phase = 'failed';
	dispatch({ type: 'fail', message, at: Date.now() });
}

async function waitReady(origin: string, signal: AbortSignal, stopped: () => string | null): Promise<void> {
	for (;;) {
		if (signal.aborted) throw new Cancelled();
		const reason = stopped();
		if (reason) throw new Error(reason);
		if ((await probe(`${origin}/ready`)) === 200) return;
		await sleep(500);
	}
}

function writeOwned(record: OwnedRecord): void {
	mkdirSync(USER_DATA, { recursive: true });
	writeFileSync(OWNED_FILE, `${JSON.stringify(record)}\n`);
}

function readOwned(): OwnedRecord | null {
	try {
		return parseOwned(readFileSync(OWNED_FILE, 'utf8'));
	} catch {
		return null;
	}
}

/** A fresh log per started stack; the previous one is kept beside it as backend.log.1. */
function rotateLog(): void {
	mkdirSync(join(USER_DATA, 'logs'), { recursive: true });
	if (existsSync(LOG_FILE)) renameSync(LOG_FILE, `${LOG_FILE}.1`);
	writeFileSync(LOG_FILE, '');
}

function followLog(fromEnd: boolean): void {
	tail?.stop();
	tail = new LogTail(LOG_FILE, (line) => dispatch({ type: 'line', text: line, at: Date.now() }));
	tail.start(fromEnd);
}

function runBuild(repo: string, signal: AbortSignal): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const child = spawnInGroup(buildUiCommand(repo), LOG_FILE, childEnv(process.env));
		buildChild = child;
		child.once('error', reject);
		child.once('exit', (code) => {
			buildChild = null;
			if (signal.aborted) reject(new Cancelled());
			else resolve(code);
		});
	});
}

async function startup(): Promise<void> {
	phase = 'starting';
	config = loadConfig();
	const origin = config.serverUrl;
	const abort = new AbortController();
	startAbort = abort;
	const now = Date.now;

	try {
		if (!isLocalOrigin(origin)) {
			setProgress(createProgress('startup', 'Connecting to Local LLM', startupRemote(origin), now()));
			openStatus('progress');
			dispatch({ type: 'begin', step: 'check', at: now() });
			if ((await probe(`${origin}/health`, 5000)) === null) {
				return fail(`Nothing answered at ${origin}. Check the address in Settings, or retry.`);
			}
			dispatch({ type: 'finish', step: 'check', at: now() });
			return await openApp(origin);
		}

		const port = localPort(origin);
		const record = readOwned();
		const adoptable = isAdoptable(record, readProcStat);
		const [health, dev] = await Promise.all([probe(`${origin}/health`), probe(DEV_SERVER_URL)]);
		const repo = config.repoPath;
		const webDir = join(repo, 'apps', 'web');
		const plan = decideStart({
			origin,
			local: true,
			backendUp: health !== null,
			devServerUp: dev !== null,
			adoptable,
			// Only worth walking apps/web for when the stack is about to be started.
			uiStale: health === null && !adoptable && existsSync(webDir) ? await isUiStale(webDir) : false,
			port
		});

		if (plan.mode === 'attach' || plan.mode === 'adopt') {
			setProgress(createProgress('startup', 'Starting Local LLM', STARTUP_ATTACH, now()));
			openStatus('progress');
			const found =
				plan.mode === 'adopt' ? 'found the backend this app started earlier' : `found a running backend at ${origin}`;
			dispatch({ type: 'begin', step: 'check', at: now(), detail: found });
			dispatch({ type: 'begin', step: 'ready', at: now() });
			const adopted = plan.mode === 'adopt' && record ? record.pgid : null;
			if (adopted) {
				owned = { pgid: adopted };
				followLog(true);
			}
			// A terminal's backend may take its time; the adopted one must still be there.
			await waitReady(origin, abort.signal, () =>
				adopted && !groupAlive(adopted)
					? 'The backend this app started earlier has stopped. Retry to start it again.'
					: null
			);
			dispatch({ type: 'finish', step: 'ready', at: now() });
			return await openApp(plan.loadUrl);
		}

		setProgress(createProgress('startup', 'Starting Local LLM', STARTUP_OWN, now()));
		openStatus('progress');
		dispatch({ type: 'begin', step: 'check', at: now() });
		if (!isRepoRoot(repo)) {
			return fail(`No local-llm checkout at ${repo}. Set the repository folder in Settings.`);
		}
		dispatch({ type: 'finish', step: 'check', at: now() });
		rotateLog();
		followLog(false);

		if (plan.buildUi) {
			dispatch({ type: 'begin', step: 'build', at: now() });
			const code = await runBuild(repo, abort.signal);
			if (code !== 0) return fail(`The UI build stopped (exit code ${code}). The log shows why.`);
			dispatch({ type: 'finish', step: 'build', at: now() });
		} else {
			dispatch({
				type: 'skip',
				step: 'build',
				reason: plan.loadUrl === DEV_SERVER_URL ? 'the dev server is running' : 'up to date',
				at: now()
			});
		}

		const env = childEnv(process.env, { LLLM_STOP_JOBS_ON_SHUTDOWN: 'true' });
		const child = spawnInGroup(makeBackendCommand(repo, port), LOG_FILE, env);
		if (!child.pid) return fail('Could not start make backend.');
		const started = { pgid: child.pid, child, exitCode: undefined as number | null | undefined };
		owned = started;
		writeOwned({ pgid: child.pid, startTicks: readProcStat(child.pid)?.startTicks ?? '' });
		child.once('exit', (code) => {
			started.exitCode = code;
		});

		await waitReady(origin, abort.signal, () =>
			started.exitCode === undefined
				? null
				: `make backend stopped (exit code ${started.exitCode}) before the backend was ready. The log shows why.`
		);
		dispatch({ type: 'finish', step: 'backend', at: now() });
		await openApp(plan.loadUrl);
	} catch (error) {
		if (error instanceof Cancelled) return;
		fail(error instanceof Error ? error.message : String(error));
		if (owned && !groupAlive(owned.pgid)) forgetOwned();
	}
}

function forgetOwned(): void {
	owned = null;
	rmSync(OWNED_FILE, { force: true });
}

// --- Stopping ------------------------------------------------------------------

/**
 * Stops what this app started, showing each step, then quits. With nothing
 * owned (attached, remote, or a failed start) it just quits.
 */
async function shutdown(): Promise<void> {
	if (phase === 'stopping') return;
	phase = 'stopping';
	startAbort?.abort();
	if (buildChild?.pid) {
		try {
			process.kill(-buildChild.pid, 'SIGTERM');
		} catch {
			// Finished meanwhile.
		}
	}
	if (!owned) {
		tail?.stop();
		app.exit(0);
		return;
	}

	setProgress(createProgress('shutdown', 'Stopping Local LLM', SHUTDOWN, Date.now()));
	openStatus('progress');
	dispatch({ type: 'begin', step: 'window', at: Date.now() });
	// Destroyed, not hidden: a hidden window keeps its streams (the Serve
	// log, Tests and Tune progress) open, which holds uvicorn's shutdown up.
	for (const win of BrowserWindow.getAllWindows()) {
		if (win !== statusWindow) win.destroy();
	}
	dispatch({ type: 'begin', step: 'requests', at: Date.now() });
	if (!tail) followLog(true);

	const repo = config.repoPath;
	const env = childEnv(process.env);
	const result = await stopGroup(owned.pgid, {
		kill: process.kill,
		sleep,
		now: Date.now,
		composeDown: () => runInShell(composeDownCommand(repo), env, 60_000),
		leftoverLlama: llamaServerPids,
		onTimeout: () => {
			const running = progress.steps.find((s) => s.state === 'running');
			if (running) dispatch({ type: 'timeout', step: running.id, at: Date.now() });
			dispatch({ type: 'begin', step: 'force', at: Date.now(), detail: 'killing the process group' });
		}
	});
	tail?.stop();
	forgetOwned();
	if (result.forced && result.llama.length > 0) {
		// Its own session keeps it out of the group; offer, don't kill unasked.
		dispatch({ type: 'offer-stop-llama' });
		dispatch({ type: 'complete', at: Date.now() });
		return;
	}
	dispatch({ type: 'complete', at: Date.now() });
	await sleep(600);
	app.exit(0);
}

async function stopLlama(): Promise<void> {
	for (const pid of await llamaServerPids()) {
		try {
			process.kill(pid, 'SIGTERM');
		} catch {
			// Gone already.
		}
	}
}

// --- Settings and the dialog's actions -------------------------------------------

/** Only the bundled status page may call these; the app window has no access. */
/** Compared as paths, so a space in the install directory (/opt/Local LLM) can't be encoded two ways. */
function isStatusPage(url: string | undefined): boolean {
	try {
		return url !== undefined && fileURLToPath(url) === STATUS_HTML;
	} catch {
		return false;
	}
}

function fromStatus<A extends unknown[], R>(handler: (...args: A) => R) {
	return (event: IpcMainInvokeEvent, ...args: A): R => {
		if (event.sender.id !== statusWindow?.webContents.id || !isStatusPage(event.senderFrame?.url)) {
			throw new Error('refused');
		}
		return handler(...args);
	};
}

interface SettingsInput {
	serverUrl: string;
	repoPath: string;
}

function saveSettings(input: SettingsInput): { error?: string; restart?: boolean } {
	const serverUrl = normalizeServerUrl(String(input.serverUrl ?? ''));
	if (!serverUrl) return { error: 'The server URL must be an http:// or https:// address.' };
	const repoPath = String(input.repoPath ?? '').trim();
	if (isLocalOrigin(serverUrl) && !isRepoRoot(repoPath)) {
		return { error: `${repoPath || 'That folder'} is not a local-llm checkout (no Makefile and apps/server).` };
	}
	writeConfig(CONFIG_FILE, { ...storedConfig(), serverUrl, repoPath });
	return { restart: phase === 'running' };
}

function registerIpc(): void {
	ipcMain.handle(
		'status:ready',
		fromStatus(() => ({ progress, view: statusView }))
	);
	ipcMain.handle(
		'status:get-settings',
		fromStatus(() => {
			const stored = storedConfig();
			return { serverUrl: stored.serverUrl, repoPath: stored.repoPath, running: phase === 'running' };
		})
	);
	ipcMain.handle(
		'status:save-settings',
		fromStatus((input: SettingsInput) => saveSettings(input))
	);
	ipcMain.handle(
		'status:browse-repo',
		fromStatus(async () => {
			if (!statusWindow) return null;
			const result = await dialog.showOpenDialog(statusWindow, {
				title: 'The local-llm checkout',
				defaultPath: storedConfig().repoPath,
				properties: ['openDirectory']
			});
			return result.canceled ? null : (result.filePaths[0] ?? null);
		})
	);
	ipcMain.handle(
		'status:action',
		fromStatus(async (name: string) => {
			switch (name) {
				case 'cancel':
				case 'quit':
					return shutdown();
				case 'retry':
					statusView = 'progress';
					return startup();
				case 'open-log':
					return shell.openPath(LOG_FILE);
				case 'stop-llama':
					await stopLlama();
					return app.exit(0);
				case 'restart':
					app.relaunch();
					return owned ? shutdown() : app.exit(0);
				case 'close-settings':
					if (phase === 'running') statusWindow?.destroy();
					else statusView = 'progress';
					return;
			}
		})
	);
}

// --- What the windows may do -----------------------------------------------------

function applyPolicy(): void {
	app.on('web-contents-created', (_event, contents) => {
		const isStatus = () => statusWindow?.webContents.id === contents.id;
		contents.on('will-navigate', (event, url) => {
			if (isStatus()) {
				if (!isStatusPage(url)) event.preventDefault();
				return;
			}
			const decision = classifyOpen(url, appOrigin);
			if (decision === 'in-app') return;
			event.preventDefault();
			if (decision === 'external') void shell.openExternal(url);
		});
		contents.setWindowOpenHandler(({ url }) => {
			const decision = isStatus() ? 'deny' : classifyOpen(url, appOrigin);
			if (decision === 'in-app') {
				return {
					action: 'allow',
					overrideBrowserWindowOptions: { icon: ICON, autoHideMenuBar: true, webPreferences: appWebPreferences() }
				};
			}
			if (decision === 'external') void shell.openExternal(url);
			return { action: 'deny' };
		});
		contents.on('will-attach-webview', (event) => event.preventDefault());
	});

	session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
		callback(isAllowedPermission(permission, details.requestingUrl, appOrigin))
	);
	session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
		isAllowedPermission(permission, requestingOrigin, appOrigin)
	);
}

function buildMenu(): void {
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: 'File',
				submenu: [
					{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openStatus('settings') },
					{ type: 'separator' },
					{ role: 'quit' }
				]
			},
			{ role: 'editMenu' },
			{ role: 'viewMenu' },
			{ role: 'windowMenu' }
		])
	);
}

// --- Lifecycle -------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
	app.exit(0);
} else {
	app.on('second-instance', () => {
		const win = mainWindow ?? statusWindow;
		if (!win) return;
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
	});

	// Every way of quitting (the menu, Ctrl+Q, the session ending, Ctrl-C on
	// `make desktop`) goes through shutdown(), so an owned stack is stopped.
	app.on('before-quit', (event) => {
		if (owned && phase !== 'stopping') {
			event.preventDefault();
			void shutdown();
		}
	});
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
		process.on(signal, () => void shutdown());
	}
	app.on('window-all-closed', () => {
		if (phase !== 'stopping') void shutdown();
	});

	void app.whenReady().then(() => {
		registerIpc();
		applyPolicy();
		buildMenu();
		void startup();
	});
}
