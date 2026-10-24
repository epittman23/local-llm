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

/** `--server-url`, then LLLM_SERVER_URL, then the stored setting, then the default. */
export function resolveServerUrl(argv: readonly string[], env: NodeJS.ProcessEnv, stored: string | undefined): string {
	const flag = argv.find((arg) => arg.startsWith('--server-url='))?.slice('--server-url='.length);
	for (const candidate of [flag, env.LLLM_SERVER_URL, stored]) {
		const origin = candidate ? normalizeServerUrl(candidate) : null;
		if (origin) return origin;
	}
	return DEFAULT_SERVER_URL;
}

/** A local-llm checkout: the Makefile that runs it and the backend it runs. */
export function isRepoRoot(dir: string, exists: (path: string) => boolean = existsSync): boolean {
	return exists(join(dir, 'Makefile')) && exists(join(dir, 'apps', 'server', 'pyproject.toml'));
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

/** Written to a temporary file and renamed, so a crash never leaves half a file. */
export function writeConfig(file: string, config: DesktopConfig): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
	renameSync(tmp, file);
}
