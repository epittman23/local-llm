// The desktop app's settings: which server to open, and where the checkout
// that runs it locally lives. Stored as JSON in Electron's userData directory
// (~/.config/Local LLM/config.json); everything here but the file access is
// pure, so it is unit-tested directly.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:4000';

export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface DesktopConfig {
	serverUrl: string;
	repoPath: string;
	bounds?: Bounds;
}

/** The origin of an http(s) URL, or null for anything else (including garbage). */
export function normalizeServerUrl(input: string): string | null {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	return url.origin;
}

/**
 * Whether the server is on this machine, which is what makes the app start
 * and stop it. Anything else (the future remote server) is only connected to.
 */
export function isLocalOrigin(origin: string): boolean {
	const { hostname } = new URL(origin);
	return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

/** The port `make backend` should listen on for a local origin. */
export function localPort(origin: string): number {
	const url = new URL(origin);
	return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}

const SERVER_URL_FLAG = '--server-url=';

export interface ServerOverride {
	url: string;
	from: '--server-url' | 'LLLM_SERVER_URL';
}

/** The `--server-url` or LLLM_SERVER_URL that this launch uses in place of the stored setting, if any. */
export function serverOverride(argv: readonly string[], env: NodeJS.ProcessEnv): ServerOverride | null {
	const flag = argv.find((arg) => arg.startsWith(SERVER_URL_FLAG))?.slice(SERVER_URL_FLAG.length);
	const candidates = [
		[flag, '--server-url'],
		[env.LLLM_SERVER_URL, 'LLLM_SERVER_URL']
	] as const;
	for (const [candidate, from] of candidates) {
		const url = candidate ? normalizeServerUrl(candidate) : null;
		if (url) return { url, from };
	}
	return null;
}

/** `--server-url`, then LLLM_SERVER_URL, then the stored setting, then the default. */
export function resolveServerUrl(argv: readonly string[], env: NodeJS.ProcessEnv, stored: string | undefined): string {
	return serverOverride(argv, env)?.url ?? (stored ? normalizeServerUrl(stored) : null) ?? DEFAULT_SERVER_URL;
}

/**
 * The arguments for Restart now's new launch: this one's, without
 * `--server-url`, which overrides the setting for one launch only (#424).
 */
export function relaunchArgs(argv: readonly string[]): string[] {
	return argv.slice(1).filter((arg) => !arg.startsWith(SERVER_URL_FLAG));
}

/** A local-llm checkout: the Makefile that runs it and the backend it runs. */
export function isRepoRoot(dir: string, exists: (path: string) => boolean = existsSync): boolean {
	return exists(join(dir, 'Makefile')) && exists(join(dir, 'apps', 'server', 'pyproject.toml'));
}

/** The stored file as written: an object ({} for none), or null when it is not one. */
function storedObject(text: string | null): Record<string, unknown> | null {
	if (!text) return {};
	try {
		const raw: unknown = JSON.parse(text);
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Why the stored file's server URL is not the one used, for the startup
 * dialog, or null when nothing in it is set aside (#437). The app still
 * starts: a broken file must not keep it from opening Settings.
 */
export function configProblem(text: string | null): string | null {
	const stored = storedObject(text);
	if (stored === null) return 'config.json is not a JSON object, so the default settings are used.';
	const url = stored.serverUrl;
	if (url === undefined || (typeof url === 'string' && normalizeServerUrl(url))) return null;
	return (
		`The server URL in config.json, ${JSON.stringify(url)}, is not an http:// or https:// address, ` +
		`so ${DEFAULT_SERVER_URL} is used. Set it in Settings.`
	);
}

/** Parses the stored file, keeping only well-formed fields; never throws. */
export function parseConfig(text: string | null, defaults: DesktopConfig): DesktopConfig {
	let raw: unknown;
	try {
		raw = text ? JSON.parse(text) : {};
	} catch {
		raw = {};
	}
	const stored = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const config: DesktopConfig = { ...defaults };
	if (typeof stored.serverUrl === 'string') {
		config.serverUrl = normalizeServerUrl(stored.serverUrl) ?? defaults.serverUrl;
	}
	if (typeof stored.repoPath === 'string' && stored.repoPath) config.repoPath = stored.repoPath;
	const b = stored.bounds as Partial<Bounds> | undefined;
	if (b && [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))) {
		config.bounds = { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number };
	}
	return config;
}

export function readConfig(file: string, defaults: DesktopConfig): DesktopConfig {
	let text: string | null = null;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		// First run, or unreadable: the defaults stand.
	}
	return parseConfig(text, defaults);
}

/**
 * Writes `changes` over the stored file as it is written, so a value this
 * version could not parse (a mistyped server URL) or does not know is kept
 * (#437). A file that is there but cannot be read, or is not a JSON object,
 * is left alone and false returned, unless `replaceUnreadable` (an explicit
 * save from Settings). Throws when the write fails.
 */
export function updateConfig(file: string, changes: Partial<DesktopConfig>, replaceUnreadable = false): boolean {
	let stored: Record<string, unknown> | null;
	try {
		stored = storedObject(readFileSync(file, 'utf8'));
	} catch (error) {
		stored = (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null;
	}
	if (stored === null && !replaceUnreadable) return false;
	writeConfig(file, { ...stored, ...changes });
	return true;
}

/** Written to a temporary file and renamed, so a crash never leaves half a file. */
export function writeConfig(file: string, config: Record<string, unknown>): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
	renameSync(tmp, file);
}
