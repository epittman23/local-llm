import {
	ChevronDownIcon,
	CodeIcon,
	CopyIcon,
	DownloadIcon,
	EllipsisIcon,
	EyeIcon,
	FileCodeIcon,
	FilesIcon,
	FileTextIcon,
	GlobeIcon,
	Maximize2Icon,
	Minimize2Icon,
	PencilIcon,
	RotateCwIcon,
	TableIcon,
	XIcon
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Example, Section } from './parts';

// /ui, "Canvas": the design of the document panel beside a chat (CNV rules;
// docs/plans/canvas.md is the plan to build it). This is a self-contained
// mock: the documents are invented constants and nothing is fetched or
// saved. The real canvas will reuse SandboxedHtmlFrame and the sandbox
// routes; the frame here has the same `allow-scripts`-only sandbox.

type Kind = 'HTML' | 'Markdown' | 'Python' | 'CSV';

interface DemoDocument {
	id: string;
	name: string;
	kind: Kind;
	size: string;
	icon: typeof GlobeIcon;
	text: string;
}

const PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Standard error explorer</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; background: #f7f6f1; color: #17221e; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { margin: 0 0 16px; color: #4d5c56; }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  input { width: 100%; }
  output { display: block; font-size: 32px; font-weight: 650; margin-top: 16px; font-variant-numeric: tabular-nums; }
</style>
<h1>Standard error explorer</h1>
<p>With s = 1.5, how the standard error falls as the sample grows.</p>
<label for="n">Sample size: <span id="shown">25</span></label>
<input id="n" type="range" min="2" max="400" value="25">
<output id="se"></output>
<script>
  const n = document.getElementById('n');
  const update = () => {
    document.getElementById('shown').textContent = n.value;
    document.getElementById('se').textContent = 'SE = ' + (1.5 / Math.sqrt(n.value)).toFixed(3);
  };
  n.addEventListener('input', update);
  update();
</script>
</html>`;

const NOTES = `## Method notes

The standard error of the mean is the sample standard deviation divided by
the square root of the sample size.

- Quadrupling the sample halves the standard error.
- The estimate assumes independent observations.

Use \`fit.py\` to reproduce the table in \`summary.csv\`.`;

const SCRIPT = `import numpy as np


def standard_error(x: np.ndarray) -> float:
    """Standard error of the mean of x."""
    return x.std(ddof=1) / np.sqrt(len(x))


rng = np.random.default_rng(7)
for n in (25, 100, 400):
    print(n, round(standard_error(rng.normal(0, 1.5, n)), 3))`;

const CSV = `n,standard_error
25,0.300
100,0.150
400,0.075`;

const DOCUMENTS: DemoDocument[] = [
	{ id: 'explorer', name: 'Standard error explorer', kind: 'HTML', size: '1 kB', icon: GlobeIcon, text: PAGE },
	{ id: 'notes', name: 'method-notes.md', kind: 'Markdown', size: '300 B', icon: FileTextIcon, text: NOTES },
	{ id: 'fit', name: 'fit.py', kind: 'Python', size: '320 B', icon: FileCodeIcon, text: SCRIPT },
	{ id: 'summary', name: 'summary.csv', kind: 'CSV', size: '50 B', icon: TableIcon, text: CSV }
];

/** CNV-4: which kinds have a Preview as well as a Source, and which can be edited. */
const HAS_PREVIEW: Record<Kind, boolean> = { HTML: true, Markdown: true, Python: false, CSV: true };
const EDITABLE: Record<Kind, boolean> = { HTML: false, Markdown: true, Python: true, CSV: false };

/** CNV-1: a document in a reply is a card that opens the canvas. */
function DocumentCard({
	document: doc,
	open,
	onOpen,
	buttonRef
}: {
	document: DemoDocument;
	open: boolean;
	onOpen: () => void;
	buttonRef: (el: HTMLButtonElement | null) => void;
}) {
	const Icon = doc.icon;
	return (
		<button
			ref={buttonRef}
			type="button"
			aria-current={open ? 'true' : undefined}
			onClick={onOpen}
			className={`bg-surface-1 hover:bg-surface-3 flex w-full max-w-sm items-center gap-3 rounded-panel border p-3 text-left ${open ? 'border-brand' : 'border-border'}`}
		>
			<span className="bg-surface-3 flex size-9 shrink-0 items-center justify-center rounded-lg">
				<Icon aria-hidden className={`size-4 ${open ? 'text-brand' : 'text-foreground-muted'}`} />
			</span>
			<span className="min-w-0">
				<span className="font-strong block truncate" title={doc.name}>
					{doc.name}
				</span>
				<span className="text-dense text-foreground-muted block">
					{doc.kind}, {doc.size}
				</span>
			</span>
		</button>
	);
}

/** CNV-4, CNT-2: source with line numbers, on a panel, scrolling inside its own box. */
function SourceView({ text }: { text: string }) {
	const lines = text.split('\n').map((line, i) => ({ number: i + 1, line }));
	return (
		<pre className="text-dense h-full overflow-auto py-3 leading-relaxed">
			<code className="grid grid-cols-[auto_1fr] gap-x-4 bg-transparent p-0">
				{lines.map(({ number, line }) => (
					<span key={number} className="contents">
						<span aria-hidden className="text-foreground-muted pl-3 text-right select-none">
							{number}
						</span>
						<span className="pr-3 whitespace-pre">{line || ' '}</span>
					</span>
				))}
			</code>
		</pre>
	);
}

function CsvView({ text }: { text: string }) {
	const [header, ...rows] = text.split('\n').map((row) => row.split(','));
	return (
		<div className="h-full overflow-auto p-3">
			<Table className="text-dense">
				<TableHeader>
					<TableRow>
						{header.map((cell, i) => (
							<TableHead key={cell} scope="col" className={i > 0 ? 'text-right' : undefined}>
								{cell === 'n' ? 'Sample size' : 'Standard error'}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row[0]}>
							<TableCell>{row[0]}</TableCell>
							<TableCell className="text-right">{row[1]}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

export function CanvasSection() {
	const [texts, setTexts] = useState(() => Object.fromEntries(DOCUMENTS.map((d) => [d.id, d.text])));
	const [openId, setOpenId] = useState<string | null>('explorer');
	const [mode, setMode] = useState<'preview' | 'source'>('preview');
	const [draft, setDraft] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(false);
	const [reloads, setReloads] = useState(0);
	const cards = useRef<Record<string, HTMLButtonElement | null>>({});
	const heading = useRef<HTMLHeadingElement>(null);
	const panel = useRef<HTMLElement>(null);

	const doc = DOCUMENTS.find((d) => d.id === openId) ?? null;
	const text = doc ? texts[doc.id] : '';
	const editing = draft !== null;
	const dirty = editing && draft !== text;
	const showPreview = doc !== null && HAS_PREVIEW[doc.kind] && mode === 'preview' && !editing;

	// CNV-6: with unsaved changes, opening another document or closing asks first.
	// `pending` is what was asked for: a document id, or null for Close.
	const [pending, setPending] = useState<{ id: string | null } | null>(null);
	const editor = useRef<HTMLTextAreaElement>(null);

	const show = (id: string | null) => {
		const from = openId;
		const next = DOCUMENTS.find((d) => d.id === id);
		setOpenId(id);
		setDraft(null);
		if (next) setMode(HAS_PREVIEW[next.kind] ? 'preview' : 'source');
		else setExpanded(false);
		// CNV-8: opening moves focus to the canvas's heading; closing returns it to the card.
		requestAnimationFrame(() => (next ? heading.current?.focus() : from && cards.current[from]?.focus()));
	};
	const open = (id: string) => (dirty ? setPending({ id }) : show(id));
	const close = () => (dirty ? setPending({ id: null }) : show(null));
	/** CNV-6: leaving the editor, by saving or discarding, puts focus back on the heading. */
	const leaveEditor = () => {
		setDraft(null);
		requestAnimationFrame(() => heading.current?.focus());
	};
	// CNV-6: entering the editor moves focus into it.
	useEffect(() => {
		if (editing) editor.current?.focus();
	}, [editing]);

	// CNV-8: Escape closes the canvas when nothing inside it (a menu) is open.
	// Listened for on the frame around both columns, which outlives the canvas.
	const closeRef = useRef(close);
	closeRef.current = close;
	const frame = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = frame.current;
		if (!el) return;
		const onKey = (event: KeyboardEvent) => {
			const inCanvas = event.target instanceof Node && panel.current?.contains(event.target);
			if (event.key === 'Escape' && !event.defaultPrevented && inCanvas) closeRef.current();
		};
		el.addEventListener('keydown', onKey);
		return () => el.removeEventListener('keydown', onKey);
	}, []);

	return (
		<Section
			id="canvas"
			title="Canvas"
			lead="A document the model provides, whether a file or a page of HTML, is a card in the reply and opens beside the chat, where it can be read, inspected as source and, for text, edited. This is a design that is planned and not yet built; the documents below are invented."
			rules={['CNV-1', 'CNV-2', 'CNV-3', 'CNV-4', 'CNV-5', 'CNV-6', 'CNV-8', 'CNT-4']}
		>
			<Example
				title="A reply with four documents"
				note="Choose a card. The page is live inside a sandboxed frame and sits on a themed surround; Source shows it with line numbers. The Markdown and Python documents can be edited, and saving is on request. On a narrow screen the canvas covers the chat instead of squeezing it. Not shown in this box: the resize handle and remembered width of CNV-2, and the real breakpoints, which are wider than a demo inside a page can use."
			>
				<div
					ref={frame}
					className="border-border bg-background grid h-[40rem] overflow-hidden rounded-panel border lg:grid-cols-2"
				>
					<div
						className={`flex min-h-0 min-w-0 flex-col ${doc ? 'max-lg:hidden' : ''} ${doc && expanded ? 'lg:hidden' : ''}`}
					>
						<div className="border-border border-b px-4 py-2.5">
							<p className="font-strong">Standard error by sample size</p>
						</div>
						<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
							<p className="text-reading max-w-[60ch]">
								I wrote a small page to explore it, the script that produced the figures, the table they came from and
								notes on the method.
							</p>
							{DOCUMENTS.map((d) => (
								<DocumentCard
									key={d.id}
									document={d}
									open={d.id === openId}
									onOpen={() => open(d.id)}
									buttonRef={(el) => {
										cards.current[d.id] = el;
									}}
								/>
							))}
						</div>
					</div>

					{doc ? (
						<aside
							ref={panel}
							aria-label="Canvas"
							className={`border-border bg-surface-1 flex min-h-0 min-w-0 flex-col lg:border-l ${expanded ? 'lg:col-span-2 lg:border-l-0' : ''}`}
						>
							<div className="border-border flex items-center gap-1 border-b px-2 py-1.5">
								{HAS_PREVIEW[doc.kind] && (
									<fieldset className="flex" disabled={editing}>
										<legend className="sr-only">View</legend>
										<Button
											variant={showPreview ? 'secondary' : 'ghost'}
											size="icon-sm"
											aria-label="Preview"
											aria-pressed={showPreview}
											onClick={() => setMode('preview')}
										>
											<EyeIcon aria-hidden />
										</Button>
										<Button
											variant={showPreview ? 'ghost' : 'secondary'}
											size="icon-sm"
											aria-label="Source"
											aria-pressed={!showPreview}
											onClick={() => setMode('source')}
										>
											<CodeIcon aria-hidden />
										</Button>
									</fieldset>
								)}
								<h4 ref={heading} tabIndex={-1} className="min-w-0 flex-1 truncate px-2" title={doc.name}>
									<span className="font-strong">{doc.name}</span>{' '}
									<span className="text-foreground-muted text-dense">{doc.kind}</span>
								</h4>
								{/* CNV-3: from `sm` up each action has its own control; below it they fold into one menu. */}
								<span className="flex items-center gap-1 max-sm:hidden">
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button variant="ghost" size="sm" aria-label={`${DOCUMENTS.length} documents in this chat`}>
												<FilesIcon aria-hidden />
												{DOCUMENTS.length}
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											{DOCUMENTS.map((d) => (
												<DropdownMenuItem key={d.id} onSelect={() => open(d.id)}>
													<d.icon aria-hidden />
													{d.name}
												</DropdownMenuItem>
											))}
										</DropdownMenuContent>
									</DropdownMenu>
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button variant="outline" size="sm">
												Copy
												<ChevronDownIcon aria-hidden />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem onSelect={() => toast.success('Copied')}>
												<CopyIcon aria-hidden />
												Copy
											</DropdownMenuItem>
											<DropdownMenuItem onSelect={() => toast.success('Downloaded')}>
												<DownloadIcon aria-hidden />
												Download
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
									{doc.kind === 'HTML' && (
										<IconAction label="Reload the page" onClick={() => setReloads((n) => n + 1)}>
											<RotateCwIcon aria-hidden />
										</IconAction>
									)}
								</span>
								<span className="sm:hidden">
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button variant="ghost" size="icon-sm" aria-label="More actions for this document">
												<EllipsisIcon aria-hidden />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem onSelect={() => toast.success('Copied')}>
												<CopyIcon aria-hidden />
												Copy
											</DropdownMenuItem>
											<DropdownMenuItem onSelect={() => toast.success('Downloaded')}>
												<DownloadIcon aria-hidden />
												Download
											</DropdownMenuItem>
											{doc.kind === 'HTML' && (
												<DropdownMenuItem onSelect={() => setReloads((n) => n + 1)}>
													<RotateCwIcon aria-hidden />
													Reload the page
												</DropdownMenuItem>
											)}
											<DropdownMenuSeparator />
											{DOCUMENTS.map((d) => (
												<DropdownMenuItem key={d.id} onSelect={() => open(d.id)}>
													<d.icon aria-hidden />
													{d.name}
												</DropdownMenuItem>
											))}
										</DropdownMenuContent>
									</DropdownMenu>
								</span>
								<span className="max-lg:hidden">
									<IconAction
										label={expanded ? 'Show the chat beside it' : 'Expand to the full width'}
										onClick={() => setExpanded(!expanded)}
									>
										{expanded ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
									</IconAction>
								</span>
								<IconAction label="Close the canvas" onClick={close}>
									<XIcon aria-hidden />
								</IconAction>
							</div>

							<div className="bg-background min-h-0 flex-1">
								{editing ? (
									<Textarea
										ref={editor}
										aria-label={`Edit ${doc.name}`}
										value={draft}
										onChange={(e) => setDraft(e.target.value)}
										className="text-dense h-full resize-none rounded-none border-0 font-mono leading-relaxed"
									/>
								) : showPreview && doc.kind === 'HTML' ? (
									// CNV-5: scripts only, an opaque origin, filled through srcdoc; the surround is themed.
									<div className="bg-surface-1 h-full p-3">
										<iframe
											key={reloads}
											title={doc.name}
											sandbox="allow-scripts"
											srcDoc={text}
											className="border-border bg-surface-1 size-full rounded-lg border"
										/>
									</div>
								) : showPreview && doc.kind === 'Markdown' ? (
									<div className="h-full overflow-auto p-4">
										<SafeMarkdown text={text} className="rich-text text-reading max-w-[72ch]" />
									</div>
								) : showPreview && doc.kind === 'CSV' ? (
									<CsvView text={text} />
								) : (
									<SourceView text={text} />
								)}
							</div>

							{EDITABLE[doc.kind] && (
								<div className="border-border flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
									<p className="text-dense text-foreground-muted" role="status">
										{!editing ? 'All changes saved' : dirty ? 'Unsaved changes' : 'Editing. No changes yet'}
									</p>
									{editing ? (
										<div className="flex gap-2">
											<Button variant="ghost" size="sm" onClick={leaveEditor}>
												Discard changes
											</Button>
											<Button
												size="sm"
												disabled={!dirty}
												onClick={() => {
													setTexts({ ...texts, [doc.id]: draft });
													leaveEditor();
													toast.success('Document saved');
												}}
											>
												Save document
											</Button>
										</div>
									) : (
										<Button variant="outline" size="sm" onClick={() => setDraft(text)}>
											<PencilIcon aria-hidden />
											Edit document
										</Button>
									)}
								</div>
							)}
						</aside>
					) : (
						<div className="text-foreground-muted flex items-center justify-center p-6 text-center max-lg:hidden">
							<p className="max-w-xs">
								The canvas is closed. In a chat, the conversation would now have this space. Choose a document on the
								left to open it here.
							</p>
						</div>
					)}
				</div>
				<AlertDialog open={pending !== null} onOpenChange={(isOpen) => !isOpen && setPending(null)}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Discard changes to {doc?.name}?</AlertDialogTitle>
							<AlertDialogDescription>
								The document has edits that are not saved. Keep editing to save them first.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel autoFocus>Keep editing</AlertDialogCancel>
							<AlertDialogAction
								variant="destructive"
								onClick={() => {
									if (pending) show(pending.id);
									setPending(null);
								}}
							>
								Discard changes
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</Example>
		</Section>
	);
}
