import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Message } from '@/lib/chat/history';
import { cn } from '@/lib/utils';
import { statusText } from './statusText';

/**
 * A reply's latest status, as a button that expands to every status so far.
 * A status with nothing to say is left out, so a retrieval step without
 * wording never shows as an empty button (#529).
 */
export function StatusLine({ message }: { message: Message }) {
	const [open, setOpen] = useState(false);
	// Keyed by its text and how often that text came before.
	const seen = new Map<string, number>();
	const shown = (message.statusHistory ?? [])
		.filter((s) => !s.hidden)
		.map((s) => ({ text: statusText(s), done: s.done }))
		.filter((s) => s.text)
		.map((s) => {
			const n = (seen.get(s.text) ?? 0) + 1;
			seen.set(s.text, n);
			return { ...s, key: `${s.text}#${n}` };
		});
	const last = shown.at(-1);
	if (!last) return null;
	// Done once the reply's latest status is, shown or not: a search that ends
	// with a hidden status must not pulse on.
	const working = message.statusHistory?.at(-1)?.done === false;
	return (
		<div className="mb-1 text-sm">
			<Button
				type="button"
				variant="ghost"
				className={cn('line-clamp-1 h-auto justify-start text-left', working && 'animate-pulse')}
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
			>
				{last.text}
			</Button>
			{open && shown.length > 1 && (
				<ul className="text-muted-foreground mt-1 border-l-2 pl-3 text-xs">
					{shown.map((s) => (
						<li key={s.key} className="line-clamp-1">
							{s.text}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
