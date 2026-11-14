import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Spinner } from '@/components/common/Spinner';
import { APP_NAME } from '@/lib/constants';
import { routePaths } from '@/routes/routePaths';

/** The spinner waits this long, so a quick start shows only the name. */
export const SPINNER_AFTER_MS = 400;
/** After this long the splash says it is still waiting, and offers a way on. */
export const WAITING_AFTER_MS = 8000;

/** The id of the static splash in layouts/Base.astro, which paints before any script runs. */
export const BOOT_SPLASH_ID = 'boot-splash';

/** Removes Base.astro's static splash once React has drawn something in its place (RootLayout). */
export function removeStaticBootSplash() {
	document.getElementById(BOOT_SPLASH_ID)?.remove();
}

/** Milliseconds since the page started loading, so the delays count from the first paint, not this mount. */
const sinceNavigation = () => (typeof performance === 'undefined' ? 0 : performance.now());

/**
 * What the app shows while it waits for the server to say who is signed in
 * (STA-2, WRD-3): the product's name on the page colour, a spinner after
 * 400 ms, and after 8 s a sentence saying it is still waiting with a link to
 * the page that retries the server. It continues Base.astro's static splash,
 * which looks the same.
 */
export function BootSplash() {
	const location = useLocation();
	const [showSpinner, setShowSpinner] = useState(false);
	const [waiting, setWaiting] = useState(false);

	useEffect(() => {
		const elapsed = sinceNavigation();
		const spinner = setTimeout(() => setShowSpinner(true), Math.max(0, SPINNER_AFTER_MS - elapsed));
		const wait = setTimeout(() => setWaiting(true), Math.max(0, WAITING_AFTER_MS - elapsed));
		return () => {
			clearTimeout(spinner);
			clearTimeout(wait);
		};
	}, []);

	const here = `${location.pathname}${location.search}`;
	return (
		<div className="bg-page text-foreground flex h-svh w-full flex-col items-center justify-center gap-4 p-4 text-center">
			<p className="text-title font-title">{APP_NAME}</p>
			<div className="flex size-5 items-center justify-center">{showSpinner && <Spinner />}</div>
			<p role="status" className="text-foreground-muted min-h-5">
				{waiting && (
					<>
						Still waiting for the server…{' '}
						<Link
							className="text-foreground underline underline-offset-2"
							to={`${routePaths.error}?redirect=${encodeURIComponent(here)}`}
						>
							Retry
						</Link>
					</>
				)}
			</p>
		</div>
	);
}
