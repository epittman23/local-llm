import { CircleAlertIcon, RotateCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isServerUnreachable } from '@/lib/apis/errors';

/** Why a load failed, in words for the person using the app (FBK-4). */
export function failureCause(error: unknown): { cause: string; detail: string | null } {
	if (isServerUnreachable(error) || error instanceof TypeError) {
		// Requests are made while the browser reports offline (#1123), so being offline only explains one
		// that got no answer; a server that answered with an error says so whatever the browser reports.
		if (typeof navigator !== 'undefined' && navigator.onLine === false) {
			return { cause: 'This computer is offline. It loads again when the connection is back.', detail: null };
		}
		return { cause: 'The server did not answer. It may be restarting or stopped.', detail: null };
	}
	const detail = error === null || error === undefined ? '' : String(error).trim();
	return { cause: 'The server answered with an error.', detail: detail || null };
}

/**
 * A section that could not load its data (STA-4, FBK-1, FBK-4): shown in
 * place of the list, never as an empty list, a 0 or a spinner that does not
 * end. Says what could not be loaded and why in plain words, keeps the
 * server's own message behind "Details", and offers to try again.
 */
export function LoadFailed({
	what,
	error,
	onRetry,
	retrying = false
}: {
	/** What could not be loaded, as the page names it: "prompts", "models". */
	what: string;
	error: unknown;
	onRetry: () => void;
	retrying?: boolean;
}) {
	const { cause, detail } = failureCause(error);
	return (
		<div role="alert" className="mx-auto flex max-w-sm flex-col items-center py-16 text-center">
			<CircleAlertIcon aria-hidden className="text-danger size-5" />
			<p className="text-title font-title mt-2">Couldn't load {what}</p>
			<p className="text-foreground-muted mt-1">{cause}</p>
			{detail && (
				<details className="text-dense text-foreground-muted mt-2 max-w-full">
					<summary className="cursor-pointer">Details</summary>
					<p className="mt-1 break-words">{detail}</p>
				</details>
			)}
			<Button variant="outline" className="mt-4" onClick={onRetry} disabled={retrying}>
				<RotateCwIcon aria-hidden />
				{retrying ? 'Trying again…' : 'Try again'}
			</Button>
		</div>
	);
}
