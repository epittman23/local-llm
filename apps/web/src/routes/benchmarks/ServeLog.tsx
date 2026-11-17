import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCopy } from '@/lib/ui/useCopy';
import { cn } from '@/lib/utils';

/** llama.cpp's level markers (` W `, ` E `) and the words its errors start with. */
const DANGER = /\sE\s|^error\b|\berror:|CUDA error|failed to/i;
const WARNING = /\sW\s|^warning\b|\bwarning:/i;

/** A log line's status colour (COL-3): errors in danger, warnings in warning, the rest plain. */
export function lineTone(line: string): 'danger' | 'warning' | null {
	if (DANGER.test(line)) return 'danger';
	if (WARNING.test(line)) return 'warning';
	return null;
}

/** How close to the bottom still counts as "at the end" when the person scrolls. */
const AT_END_PX = 8;

/**
 * The served model's log (#972): a bordered panel with a header (its state,
 * Follow and Copy) over a named scroll region the keyboard can scroll
 * (DAT-6). Lines wrap at word boundaries, and warnings and errors are tinted.
 * Follow keeps the newest line in view; scrolling up turns it off, and
 * pressing Follow (or scrolling back to the end) turns it on again.
 */
export type LogLine = { n: number; text: string };

export function ServeLog({ lines, streaming }: { lines: LogLine[]; streaming: boolean }) {
	const scroller = useRef<HTMLElement>(null);
	const [follow, setFollow] = useState(true);
	const { copied, copy } = useCopy();

	useEffect(() => {
		const el = scroller.current;
		if (follow && el && lines.length) el.scrollTop = el.scrollHeight;
	}, [lines.length, follow]);

	return (
		<div className="bg-surface-1 flex flex-col rounded-panel border">
			<div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
				<h3 id="serve-log-title" className="font-strong">
					Log
				</h3>
				<span className="text-foreground-muted text-dense">
					{streaming ? 'Streaming' : lines.length ? `${lines.length.toLocaleString()} lines` : 'Nothing yet'}
				</span>
				<div className="ms-auto flex gap-2">
					<Button
						size="sm"
						variant="ghost"
						aria-pressed={follow}
						onClick={() => setFollow(!follow)}
						disabled={lines.length === 0}
					>
						{follow ? 'Following' : 'Follow'}
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => copy(lines.map((l) => l.text).join('\n'), 'log')}
						disabled={lines.length === 0}
					>
						{copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
						{copied ? 'Copied' : 'Copy log'}
					</Button>
				</div>
			</div>
			<section
				ref={scroller}
				aria-labelledby="serve-log-title"
				// A tab stop once there is something to scroll (DAT-6, A11Y-2).
				tabIndex={lines.length ? 0 : undefined}
				onScroll={(e) => {
					const el = e.currentTarget;
					const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - AT_END_PX;
					if (atEnd !== follow) setFollow(atEnd);
				}}
				className="scroll-region max-h-96 overflow-y-auto px-3 py-2 font-mono text-dense break-words whitespace-pre-wrap"
			>
				{lines.length === 0 && (
					<p className="text-foreground-muted">No log output yet. Start a server and its output appears here.</p>
				)}
				{lines.map((line) => {
					const tone = lineTone(line.text);
					return (
						<div key={line.n} className={cn(tone === 'danger' && 'text-danger', tone === 'warning' && 'text-warning')}>
							{line.text}
						</div>
					);
				})}
			</section>
		</div>
	);
}
