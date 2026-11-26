import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Excerpt } from '../../Excerpt';

/** The passages shown before "Show N more": the file keeps its room however many were cited. */
const SHOWN = 2;

/**
 * The passages the retrieval gave a reply from a knowledge file (CNV-4), above the file's own view. Text
 * only, as in the citation dialog; each is cut at 1,500 characters and a repeated passage is shown once.
 * Where in the file a passage sits is not shown: a chunk is not guaranteed to match the file's lines.
 */
export function PassagesNote({ passages }: { passages: string[] }) {
	const headingId = useId();
	const [all, setAll] = useState(false);
	const unique = [...new Set(passages)];
	if (!unique.length) return null;
	const shown = all ? unique : unique.slice(0, SHOWN);
	return (
		<section aria-labelledby={headingId} className="bg-surface-2 text-dense shrink-0 border-b px-3 py-2">
			<h3 id={headingId} className="font-strong text-foreground-muted mb-1">
				Cited in this reply
			</h3>
			<ul className="flex flex-col gap-2">
				{shown.map((text) => (
					<li key={text} className="border-s ps-2">
						<Excerpt text={text} />
					</li>
				))}
			</ul>
			{unique.length > shown.length && (
				<Button type="button" variant="link" size="xs" onClick={() => setAll(true)}>
					Show {unique.length - shown.length} more
				</Button>
			)}
		</section>
	);
}
