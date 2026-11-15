import { toast } from 'sonner';
import { errorMessage } from '@/lib/apis/errors';

/** The server's own words for whatever a request rejected with, or null when there are none. */
export function errorText(error: unknown): string | null {
	if (error === null || error === undefined) return null;
	if (typeof error !== 'object') return String(error).trim() || null;
	// errorMessage reads every shape a failure comes in (a validation list, `{ error: { message } }`),
	// where String() would print "[object Object]".
	return errorMessage(error, '').trim() || null;
}

/** The raw text behind a "Details" disclosure, as LoadFailed shows it (FBK-4). */
export function ErrorDetails({ detail }: { detail: string }) {
	return (
		<details className="text-dense mt-1 max-w-full">
			<summary className="cursor-pointer">Details</summary>
			<p className="mt-1 break-words">{detail}</p>
		</details>
	);
}

/**
 * A failure toast: a sentence saying what failed and what to do (FBK-4), with
 * the server's own words behind "Details" rather than as the message.
 */
export function toastFailure(message: string, error?: unknown) {
	const detail = errorText(error);
	toast.error(message, detail ? { description: <ErrorDetails detail={detail} /> } : undefined);
}
