import { toast } from 'sonner';

/** The server's own words for whatever a request rejected with, or null when there are none. */
export function errorText(error: unknown): string | null {
	if (error === null || error === undefined) return null;
	if (typeof error === 'string') return error.trim() || null;
	const e = error as { detail?: unknown; message?: unknown };
	const text = e.detail ?? e.message;
	if (text !== undefined && text !== null) return String(text).trim() || null;
	return String(error).trim() || null;
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
 * A failure toast for the knowledge base page: a sentence saying what failed
 * and what to do (FBK-4), with the server's own words behind "Details" rather
 * than as the message.
 */
export function failed(message: string, error?: unknown) {
	const detail = errorText(error);
	toast.error(message, detail ? { description: <ErrorDetails detail={detail} /> } : undefined);
}
