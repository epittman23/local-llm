import { ArrowLeftRightIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorMessage } from '@/lib/apis/errors';
import type { FileVersion } from '@/lib/apis/files/versions';
import type { CanvasDocument } from '@/lib/chat/documents';
import { cn } from '@/lib/utils';
import { DIFF_MAX_LINES, type DiffLine, lineDiff } from '@/lib/utils/lineDiff';
import { TEXT_MAX_BYTES } from '../limits';
import { versionLabel, withVersion } from '../present';
import { Loading, Note } from './parts';
import { useDocumentText } from './useDocumentText';

/** An unchanged run longer than this many lines is folded into one button. */
const FOLD_OVER = 6;

type Segment = { key: number; lines: DiffLine[]; fold: boolean };

/** The diff's lines as rows, with each long unchanged run set apart as a fold. */
function segments(lines: DiffLine[]): Segment[] {
	const out: Segment[] = [];
	let i = 0;
	while (i < lines.length) {
		let j = i;
		while (j < lines.length && (lines[j].kind === 'same') === (lines[i].kind === 'same')) j++;
		const run = lines.slice(i, j);
		out.push({ key: i, lines: run, fold: lines[i].kind === 'same' && run.length > FOLD_OVER });
		i = j;
	}
	return out;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const GLYPH = { add: '+', del: '-', same: '' } as const;
const SPOKEN = { add: 'Added: ', del: 'Removed: ', same: '' } as const;

function Row({ line }: { line: DiffLine }) {
	return (
		<div
			className={cn(
				'grid grid-cols-[3rem_3rem_1.5rem_1fr]',
				line.kind === 'add' && 'bg-success/10',
				line.kind === 'del' && 'bg-danger/10'
			)}
		>
			<span aria-hidden className="text-foreground-muted pr-2 text-right select-none">
				{line.oldNo}
			</span>
			<span aria-hidden className="text-foreground-muted pr-2 text-right select-none">
				{line.newNo}
			</span>
			<span
				aria-hidden
				className={cn(
					'text-center select-none',
					line.kind === 'add' && 'text-success',
					line.kind === 'del' && 'text-danger'
				)}
			>
				{GLYPH[line.kind]}
			</span>
			<span className="pr-3 whitespace-pre">
				<span className="sr-only">{SPOKEN[line.kind]}</span>
				{line.text || ' '}
			</span>
		</div>
	);
}

/**
 * CNV-9: the line diff of two texts, unified: a summary, then rows with the
 * old and new line numbers, a `+` or `-` glyph and a tint (never the tint
 * alone, COL-3), long unchanged runs folded. Every line is a text node, so a
 * diff of HTML is of its source and never renders it. Remount it (a `key`)
 * for a new pair, which folds the runs again.
 */
export function DiffView({ from, to, label }: { from: string; to: string; label: string }) {
	const diff = useMemo(() => lineDiff(from, to), [from, to]);
	const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
	if (diff.status === 'tooLarge')
		return (
			<Note>
				These versions are too long to compare here (more than {DIFF_MAX_LINES.toLocaleString('en')} lines). Open each
				in Source.
			</Note>
		);
	if (diff.status === 'tooDifferent')
		return <Note>These versions differ too much to compare line by line. Open each in Source.</Note>;
	if (diff.added === 0 && diff.removed === 0) {
		let note = 'No differences';
		if (diff.lineEndingsDiffer) note = 'No differences in the lines. Only the line endings differ.';
		else if (diff.finalNewlineDiffers) note = 'No differences in the lines. Only the final newline differs.';
		return <Note>{note}</Note>;
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<p className="text-dense border-b px-3 py-1.5" role="status">
				{plural(diff.added, 'line')} added, {diff.removed} removed
			</p>
			<div
				// A named region and a tab stop: the keyboard scrolls it (A11Y-2, NAV-5).
				{...{ role: 'region', 'aria-label': label, tabIndex: 0 }}
				className="scroll-region text-dense min-h-0 flex-1 overflow-auto py-2 font-mono leading-relaxed"
			>
				<div className="min-w-max">
					{segments(diff.lines).map((segment) =>
						segment.fold && !open.has(segment.key) ? (
							<div key={segment.key} className="bg-surface-2 px-3 py-0.5">
								<Button
									variant="ghost"
									size="xs"
									aria-label={`Show ${plural(segment.lines.length, 'unchanged line')}`}
									onClick={() => setOpen(new Set(open).add(segment.key))}
								>
									{plural(segment.lines.length, 'unchanged line')}
								</Button>
							</div>
						) : (
							segment.lines.map((line) => <Row key={`${line.oldNo}-${line.newNo}`} line={line} />)
						)
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * The Changes view (CNV-3, CNV-9): two versions of a text document compared,
 * read-only. From and To are this view's own state, starting at the version
 * shown against the one before it (version 1 against 2 when that is the one
 * shown); the same version cannot be both, and a button swaps them (with two versions, the only way to read the change backwards). Each side is read through the
 * canvas's own text query, so the editor's cache is shared. A version cut at
 * the cap is not compared: a partial diff would mislead.
 */
export function ChangesView({
	doc,
	versions,
	shownIndex
}: {
	doc: CanvasDocument;
	versions: FileVersion[];
	shownIndex: number;
}) {
	const [pair, setPair] = useState(() => {
		const to = shownIndex > 0 ? shownIndex : 1;
		return { from: to - 1, to };
	});
	const from = useDocumentText(withVersion(doc, versions[pair.from]), TEXT_MAX_BYTES);
	const to = useDocumentText(withVersion(doc, versions[pair.to]), TEXT_MAX_BYTES);

	const choose = (side: 'from' | 'to', value: string) => setPair({ ...pair, [side]: Number(value) });
	const selector = (side: 'from' | 'to', title: string, other: number) => (
		<div className="flex items-center gap-1.5">
			<span className="text-foreground-muted">{title}</span>
			<Select value={String(pair[side])} onValueChange={(value) => choose(side, value)}>
				<SelectTrigger size="sm" aria-label={`${title} version`}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent position="popper">
					{versions.map((v, i) => (
						<SelectItem key={v.id} value={String(i)} disabled={i === other}>
							{versionLabel(v, i)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);

	let result: React.ReactNode;
	if (from.isError || to.isError)
		result = <Note>Could not compare these versions: {errorMessage(from.error ?? to.error)}</Note>;
	else if (!from.data || !to.data) result = <Loading />;
	else if (from.data.truncated || to.data.truncated)
		result = <Note>A version is too large to compare here. Open each in Source.</Note>;
	else
		result = (
			<DiffView
				key={`${versions[pair.from].id}:${versions[pair.to].id}`}
				from={from.data.text}
				to={to.data.text}
				label={`Changes from version ${pair.from + 1} to version ${pair.to + 1}`}
			/>
		);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="text-dense flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-3 py-2">
				{selector('from', 'From', pair.to)}
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Swap From and To"
					onClick={() => setPair({ from: pair.to, to: pair.from })}
				>
					<ArrowLeftRightIcon aria-hidden />
				</Button>
				{selector('to', 'To', pair.from)}
			</div>
			{result}
		</div>
	);
}
