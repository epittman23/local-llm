import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { useConfigStore, useWebUIName } from '@/lib/stores/configStore';
import { routePaths } from '@/routes/routePaths';

/**
 * Ports apps/openwebui/src/routes/error/+page.svelte. `config` being null
 * here specifically means the backend was unreachable when
 * lib/auth/session.ts's initAuth() tried getBackendConfig() -- if it's
 * present, whatever originally sent someone here has resolved, so this
 * redirects home instead of showing a stale warning.
 */
export function ErrorPage() {
	const config = useConfigStore((state) => state.config);
	const WEBUI_NAME = useWebUIName();
	const navigate = useNavigate();

	useEffect(() => {
		if (config) {
			navigate(routePaths.home, { replace: true });
		}
	}, [config, navigate]);

	if (config) return null;

	return (
		<div className="flex h-screen w-full items-center justify-center px-10 text-center">
			<div className="max-w-md">
				<h1 className="text-2xl font-normal">{WEBUI_NAME} Backend Required</h1>
				<p className="mt-4 text-sm">
					Oops! You're using an unsupported method (frontend only). Please serve the WebUI from the
					backend.
				</p>
				<Button className="mt-6" variant="secondary" onClick={() => (window.location.href = '/')}>
					Check Again
				</Button>
			</div>
		</div>
	);
}
