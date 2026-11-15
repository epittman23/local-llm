import { SearchXIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The server's detail for something that does not exist, or that this user
 * may not read (`ERROR_MESSAGES.NOT_FOUND`, local_llm/constants.py). The API
 * helpers throw the detail itself, and some routes answer it with 401, so
 * the words are the only thing that tells "gone" from "failed".
 */
export const NOT_FOUND_DETAIL = "We could not find what you're looking for :/";

/** Whether a failed load means the thing is not there (NAV-3), as opposed to a failure to load it (STA-4). */
export const isNotFound = (error: unknown) => error === NOT_FOUND_DETAIL;

/**
 * A link to something that no longer exists, said in place (NAV-3): what is
 * gone as the heading, one sentence on why it might be, and ways onward. A
 * failure to load (offline, a server error) is `LoadFailed` instead, which
 * offers to try again; this panel is for a definite answer that nothing is
 * there. `level` is 2 where the page already has its h1 (A11Y-3).
 */
export function Gone({
	title,
	description,
	actions,
	level = 1
}: {
	/** What is gone, as a sentence: "This chat no longer exists." */
	title: string;
	description?: ReactNode;
	/** Ways onward: `Button`s, the most likely first. */
	actions?: ReactNode;
	level?: 1 | 2;
}) {
	const Heading = level === 1 ? 'h1' : 'h2';
	return (
		<section
			data-slot="gone"
			aria-label={title}
			className="mx-auto flex max-w-md flex-col items-center px-4 py-12 text-center"
		>
			<SearchXIcon aria-hidden className="size-6 text-foreground-muted" />
			<Heading className="text-heading font-title mt-3 tracking-tight">{title}</Heading>
			{description && <p className="text-foreground-muted mt-2">{description}</p>}
			{actions && <div className="mt-6 flex flex-wrap justify-center gap-2">{actions}</div>}
		</section>
	);
}
