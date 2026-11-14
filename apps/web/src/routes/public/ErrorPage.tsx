import { RotateCwIcon, ServerOffIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { safeRedirect } from '@/lib/auth/redirect';
import { WEBUI_BASE_URL } from '@/lib/constants';
import { useWebUIName } from '@/lib/stores/configStore';
import { routePaths } from '@/routes/routePaths';

/** How often the page asks the server again on its own. */
export const RETRY_INTERVAL_MS = 3000;
/** A press of "Try now" shows that it is trying for at least this long, even when the answer is instant (FBK-3). */
const PRESSED_MIN_MS = 400;

/** A full page load, so the session is restored from the saved token on the way back. */
export const navigation = { leaveFor: (url: string) => window.location.assign(url) };

/**
 * Where the app lands when it cannot reach its server: on load, the sign-in
 * page sends anyone whose config fetch failed here, with where they were going
 * as `?redirect=` (AuthPage). It says so in words (FBK-4), asks the server
 * again every few seconds and on "Try now", and goes back to that page once
 * the server answers (STA-4). Going back is a full page load, so the session
 * kept in the saved token is restored on the way.
 *
 * Starting the server again from here needs a capability the desktop bridge
 * does not have yet; the page says how to start it instead.
 */
export function ErrorPage() {
	const name = useWebUIName();
	const [searchParams] = useSearchParams();
	const target = safeRedirect(searchParams.get('redirect')) ?? routePaths.home;
	// Only a press of "Try now" changes the page while it checks: the automatic
	// checks leave it still, so a focused button is never disabled under the
	// person and a screen reader is not told the same thing every 3 seconds.
	const [pressed, setPressed] = useState(false);
	const [lastFailure, setLastFailure] = useState<string | null>(null);
	const inFlight = useRef(false);

	const check = useCallback(
		async (byPress = false) => {
			if (inFlight.current) return;
			inFlight.current = true;
			if (byPress) setPressed(true);
			try {
				const [res] = await Promise.all([
					fetch(`${WEBUI_BASE_URL}/api/config`, { credentials: 'include' }),
					byPress ? new Promise((resolve) => setTimeout(resolve, PRESSED_MIN_MS)) : null
				]);
				if (res.ok) {
					navigation.leaveFor(target);
					return;
				}
				setLastFailure(`the server answered with an error (${res.status}).`);
			} catch {
				setLastFailure('no answer.');
			} finally {
				inFlight.current = false;
				setPressed(false);
			}
		},
		[target]
	);

	useEffect(() => {
		void check();
		const timer = setInterval(() => void check(), RETRY_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [check]);

	return (
		<main className="flex h-screen w-full items-center justify-center px-6">
			<div className="flex max-w-md flex-col items-center text-center">
				<ServerOffIcon aria-hidden className="text-danger size-6" />
				<h1 className="text-heading font-title mt-3 tracking-tight">Can't reach the server</h1>
				<p className="text-foreground-muted mt-2">
					{name} at {window.location.origin} is not answering. It may be starting or stopped.
				</p>
				<p className="text-foreground-muted mt-2">
					Start it with <code>make backend</code>, or open the desktop app.
				</p>
				<p role="status" className="text-dense text-foreground-muted mt-4">
					{lastFailure ? `Last try: ${lastFailure} Retrying every ${RETRY_INTERVAL_MS / 1000} seconds…` : 'Checking…'}
				</p>
				<Button className="mt-4" variant="outline" onClick={() => void check(true)} aria-busy={pressed}>
					<RotateCwIcon aria-hidden />
					{pressed ? 'Retrying…' : 'Try now'}
				</Button>
			</div>
		</main>
	);
}
