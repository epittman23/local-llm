// @ts-check
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// Mirrors apps/openwebui/vite.config.ts's dev-server proxy: the backend
// isn't containerized, so both frontends point at the same host process,
// started by `make backend` (see docs/migration-plan.md's Phase 3).
const backendTarget = process.env.WEBUI_BACKEND_URL || 'http://localhost:4000';

// process.argv, not defineConfig's own (command) => (...) function form:
// that form reaches @tailwindcss/vite's postcss-import resolution through a
// different internal Vite code path in this astro/vite combination and
// breaks `@import 'tailwindcss'` outright (`ENOENT ... open '.../tailwindcss'`)
// -- reproduced in isolation, config content otherwise identical. A plain
// object literal does not hit that path.
const isBuild = process.argv.includes('build');

// https://astro.build/config
export default defineConfig({
	output: 'static',
	// Built assets are mounted under /next in main.py (a preview alongside
	// the SvelteKit app, not a replacement yet -- see docs/migration-plan.md's
	// Phase 3), so a production build needs its own asset paths prefixed to
	// match. The standalone dev server (`make astro`, :5174) stays unprefixed
	// since nothing mounts it under a path there.
	base: isBuild ? '/next' : '/',
	integrations: [react()],
	vite: {
		// Mirrors apps/openwebui/vite.config.ts's own define block: constants.ts
		// (ported verbatim from the SvelteKit app) reads these as globals rather
		// than import.meta.env, so the port didn't have to touch that file.
		define: {
			APP_VERSION: JSON.stringify(process.env.npm_package_version),
			APP_BUILD_HASH: JSON.stringify(process.env.APP_BUILD_HASH || 'dev-build')
		},
		plugins: [tailwindcss()],
		server: {
			proxy: {
				'/api': { target: backendTarget, changeOrigin: true, ws: true },
				'/ollama': { target: backendTarget, changeOrigin: true },
				'/openai': { target: backendTarget, changeOrigin: true },
				'/oauth': { target: backendTarget, changeOrigin: true },
				'/ws': { target: backendTarget, changeOrigin: true, ws: true }
			}
		}
	},
	server: {
		port: 5174
	}
});
