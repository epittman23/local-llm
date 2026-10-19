import { expect, it } from 'vitest';
import { createBrowserRouter } from '../../../../../apps/web/node_modules/react-router/dist/development/index.js';
import { safeRedirect } from '@/lib/auth/redirect';

it('safeRedirect lets a tab-prefixed protocol-relative target through; the router then refuses it', async () => {
	const evil = '/\t/evil.example/x';
	console.log('safeRedirect ->', JSON.stringify(safeRedirect(evil)));
	console.log('WHATWG URL ->', new URL(evil, 'http://127.0.0.1:4000/auth').href);
	const router = createBrowserRouter([{ path: '*', element: null }]);
	let err: unknown = null;
	try {
		await router.navigate(safeRedirect(evil)!, { replace: true });
	} catch (e) {
		err = e;
	}
	console.log('router.navigate ->', String(err), '| location now:', window.location.href);
	expect(safeRedirect(evil)).toBe(evil);
	expect(String(err)).toContain('External navigation is not allowed');
});
