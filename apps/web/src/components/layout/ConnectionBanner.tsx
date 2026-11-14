import { WifiOffIcon } from 'lucide-react';
import { useConnectionStore } from '@/lib/socket/connectionStore';

/**
 * The live connection is down (FBK-1): a condition that lasts gets a message
 * that lasts, not a toast that expires while it is still true. It shows for
 * as long as SocketProvider reports the connection lost and leaves when it
 * is back. Fixed at the top of the viewport over the page, so the app's own
 * full-height layout is not pushed down; the polite live region is always in the
 * document so a screen reader announces the message when it appears.
 */
export function ConnectionBanner() {
	const lost = useConnectionStore((state) => state.lost);
	const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
	return (
		<div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-2 z-40 flex justify-center px-4">
			{lost && (
				<p className="border-border-divider bg-surface-2 text-dense text-foreground flex max-w-full items-center gap-2 rounded-full border px-3 py-1 shadow-lg">
					<WifiOffIcon aria-hidden className="text-warning size-4 shrink-0" />
					<span className="min-w-0">
						{offline ? 'This computer is offline.' : "Can't reach the server."} Reconnecting…
					</span>
				</p>
			)}
		</div>
	);
}
