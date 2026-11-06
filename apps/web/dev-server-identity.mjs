// @ts-check
// The dev server's answer to "which checkout are you?", for the desktop app.
// It loads `make frontend`'s dev server in place of the build only when this
// names the checkout it is set to, so another project's server that took
// :5174 is never loaded as the app (#432). apps/desktop/src/stack.ts reads it
// (DEV_SERVER_IDENTITY_PATH, isOwnDevServer), and its test calls this plugin.
import { fileURLToPath } from 'node:url';

export const DEV_SERVER_IDENTITY_PATH = '/__lllm/dev-server';

/**
 * A Vite plugin answering DEV_SERVER_IDENTITY_PATH with the apps/web it serves.
 * Its middleware is added directly, so it runs before Astro's pages.
 * @param {string} [webRoot] apps/web; this file's own folder unless given
 * @returns {{ name: string, configureServer: (server: { middlewares: { use: (path: string, handle: (request: unknown, response: { setHeader: (name: string, value: string) => void, end: (body: string) => void }) => void) => void } }) => void }}
 */
export function devServerIdentity(webRoot = fileURLToPath(new URL('.', import.meta.url))) {
	return {
		name: 'lllm-dev-server-identity',
		configureServer(server) {
			server.middlewares.use(DEV_SERVER_IDENTITY_PATH, (_request, response) => {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify({ app: 'local-llm', webRoot }));
			});
		}
	};
}
