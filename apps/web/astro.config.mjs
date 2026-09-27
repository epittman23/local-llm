// @ts-check
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { readFileSync } from 'node:fs';

// Mirrors d863707:apps/openwebui/vite.config.ts's dev-server proxy: the backend
// isn't containerized, so both frontends point at the same host process,
// started by `make backend` (see docs/migration-plan.md's Phase 3).
const backendTarget = process.env.WEBUI_BACKEND_URL || 'http://localhost:4000';

// Read, not process.env.npm_package_version: that is set only when Astro runs
// through a package script, and without it APP_VERSION is left undefined and
// the app fails to hydrate (ReferenceError). Kept equal to the backend's
// version, which the About tab and plugin version checks compare against.
const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

// https://astro.build/config
export default defineConfig({
	output: 'static',
	integrations: [react()],
	vite: {
		// Mirrors d863707:apps/openwebui/vite.config.ts's own define block: constants.ts
		// (ported verbatim from the SvelteKit app) reads these as globals rather
		// than import.meta.env, so the port didn't have to touch that file.
		define: {
			APP_VERSION: JSON.stringify(appVersion),
			APP_BUILD_HASH: JSON.stringify(process.env.APP_BUILD_HASH || 'dev-build')
		},
		plugins: [tailwindcss()],
		server: {
			proxy: {
				'/api': { target: backendTarget, changeOrigin: true, ws: true },
				'/ollama': { target: backendTarget, changeOrigin: true },
				'/openai': { target: backendTarget, changeOrigin: true },
				'/oauth': { target: backendTarget, changeOrigin: true },
				// The backend serves /static itself (the fallback model logo, uploaded
				// images, ...). It seeds that directory at boot from this app's
				// dist/static, or public/static when there is no build yet, so
				// public/static is the source of those files either way.
				'/static': { target: backendTarget, changeOrigin: true },
				'/ws': { target: backendTarget, changeOrigin: true, ws: true }
			}
		}
	},
	server: {
		port: 5174
	}
});
