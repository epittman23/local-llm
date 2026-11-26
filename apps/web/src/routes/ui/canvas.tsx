import {
	ChevronDownIcon,
	CodeIcon,
	CopyIcon,
	DiffIcon,
	DownloadIcon,
	EllipsisIcon,
	EyeIcon,
	FileCodeIcon,
	FilesIcon,
	FileTextIcon,
	GlobeIcon,
	HardDriveUploadIcon,
	Maximize2Icon,
	Minimize2Icon,
	PencilIcon,
	RotateCwIcon,
	TableIcon,
	TextIcon,
	XIcon
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CodeSurface } from '@/components/chat/CodeSurface';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import { panelMode, SidePanel } from '@/components/layout/SidePanel';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { RowButton } from '@/components/ui/row-button';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CanvasDocument } from '@/lib/chat/documents';
import { withHtmlPolicy } from '@/lib/chat/htmlPolicy';
import { tableNote } from '@/routes/chat/canvas/present';
import { SAVED_TO_WORKSPACE, workspaceDialog } from '@/routes/chat/canvas/useWriteBack';
import { DiffView } from '@/routes/chat/canvas/views/ChangesView';
import { CsvEditView } from '@/routes/chat/canvas/views/CsvEditView';
import { Note } from '@/routes/chat/canvas/views/parts';
import { PassagesNote } from '@/routes/chat/canvas/views/PassagesNote';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Example, Section } from './parts';

// /ui, "Canvas": the design of the document panel beside a chat (CNV rules;
// docs/plans/canvas.md is the plan). The viewer, the editor and the page
// editor are built (routes/chat/canvas/); the editor's keyboard behaviour is the
// real CodeSurface's. This is a self-contained mock of them: the
// documents are invented constants and nothing is fetched or saved. The real
// canvas reuses SandboxedHtmlFrame and the sandbox routes; the frame here has
// the same `allow-scripts`-only sandbox.

type Kind = 'HTML' | 'Markdown' | 'Python' | 'CSV';

interface DemoDocument {
	id: string;
	name: string;
	kind: Kind;
	size: string;
	icon: typeof GlobeIcon;
	text: string;
	/** A fenced block of a reply: it can be tried but has no file, so its changes are never saved. */
	block?: boolean;
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

const SNIPPET = `<!doctype html>
<h1 id="hello"></h1>
<script>document.getElementById('hello').textContent = 'Hello from a block';</script>`;

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
	{ id: 'summary', name: 'summary.csv', kind: 'CSV', size: '50 B', icon: TableIcon, text: CSV },
	{ id: 'snippet', name: 'Greeting page', kind: 'HTML', size: '110 B', icon: GlobeIcon, text: SNIPPET, block: true }
];

/** highlight.js's name for each kind's source. */
const LANGUAGE: Record<Kind, string> = { HTML: 'xml', Markdown: 'markdown', Python: 'python', CSV: 'plaintext' };

/** CNV-4: which kinds have a Preview as well as a Source, and which can be edited. */
const HAS_PREVIEW: Record<Kind, boolean> = { HTML: true, Markdown: true, Python: false, CSV: true };
/** CNV-9: an earlier version of each editable document, for the Changes view. */
const PREVIOUS: Record<string, string> = {
	notes: NOTES.replace('Quadrupling the sample halves', 'Doubling the sample shrinks').replace(
		'\n- The estimate assumes independent observations.',
		''
	),
	fit: SCRIPT.replace('rng = np.random.default_rng(7)', 'rng = np.random.default_rng(1)').replace(
		'\n\n\nrng',
		'\n\nrng'
	)
};
const EDITABLE: Record<Kind, boolean> = { HTML: true, Markdown: true, Python: true, CSV: true };

/** What the real `CsvEditView` is given for the invented table: it needs only the document's name. */
const CSV_DOCUMENT: CanvasDocument = {
	id: 'summary',
	name: 'summary.csv',
	kind: 'csv',
	bytes: null,
	messageId: 'm1',
	source: { type: 'upload', fileId: '00000000-0000-4000-8000-000000000001' }
};

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
		<RowButton
			ref={buttonRef}
			aria-current={open ? 'true' : undefined}
			onClick={onOpen}
			className={`flex max-w-sm items-center justify-start gap-3 rounded-panel border p-3 ${open ? 'border-brand' : ''}`}
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
		</RowButton>
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
	const [mode, setMode] = useState<'preview' | 'source' | 'changes'>('preview');
	const [draft, setDraft] = useState<string | null>(null);
	// CNV-6: a CSV is edited as a table; Edit as text turns it into its source.
	const [asText, setAsText] = useState(false);
	const firstCell = useRef<HTMLElement>(null);
	// CNV-5, CNV-6: what the preview beside an HTML draft shows: the draft as of the last Update preview.
	const [applied, setApplied] = useState('');
	const [live, setLive] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [reloads, setReloads] = useState(0);
	const cards = useRef<Record<string, HTMLButtonElement | null>>({});
	const heading = useRef<HTMLHeadingElement>(null);
	const panel = useRef<HTMLElement>(null);

	const doc = DOCUMENTS.find((d) => d.id === openId) ?? null;
	const text = doc ? texts[doc.id] : '';
	const editing = draft !== null;
	const dirty = editing && draft !== text;
	const splitEdit = editing && doc?.kind === 'HTML';
	const isBlock = doc?.block === true;
	const showPreview = doc !== null && HAS_PREVIEW[doc.kind] && mode === 'preview' && !editing;
	const previous = doc ? PREVIOUS[doc.id] : undefined;
	const showChanges = previous !== undefined && mode === 'changes' && !editing;

	// CNV-6: with unsaved changes, opening another document or closing asks first.
	// `pending` is what was asked for: a document id, or null for Close.
	const [pending, setPending] = useState<{ id: string | null } | null>(null);
	const editor = useRef<HTMLTextAreaElement>(null);
	// CNV-6: Save to workspace. The demo alternates the two answers the server's `changed` 409 gives, so both show.
	const [workspaceAsk, setWorkspaceAsk] = useState<{ missing: boolean } | null>(null);
	const workspacePresses = useRef(0);
	const saveToWorkspace = () => setWorkspaceAsk({ missing: workspacePresses.current++ % 2 === 1 });
	const workspaceWords = workspaceDialog(workspaceAsk?.missing === true);

	const show = (id: string | null) => {
		const from = openId;
		const next = DOCUMENTS.find((d) => d.id === id);
		setOpenId(id);
		setDraft(null);
		setAsText(false);
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
		setAsText(false);
		requestAnimationFrame(() => heading.current?.focus());
	};
	const save = () => {
		if (!doc || draft === null || !dirty) return;
		setTexts({ ...texts, [doc.id]: draft });
		leaveEditor();
		toast.success('Document saved');
	};
	const startEdit = () => {
		if (!doc) return;
		setDraft(text);
		setApplied(text);
		if (doc.kind === 'HTML') setMode('source');
	};
	const csvTable = doc?.kind === 'CSV' && !asText;
	const editAsText = () => {
		setAsText(true);
		setMode('source');
		if (draft === null) setDraft(text);
	};
	// "Update as I type": the preview follows the draft 800 ms after typing stops.
	useEffect(() => {
		if (!live || draft === null || applied === draft) return;
		const timer = setTimeout(() => setApplied(draft), 800);
		return () => clearTimeout(timer);
	}, [live, draft, applied]);
	// CNV-6: entering the editor moves focus into it.
	useEffect(() => {
		if (editing) (editor.current ?? firstCell.current)?.focus();
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
			lead="A document the model provides, whether a file or a page of HTML, is a card in the reply and opens beside the chat, where it can be read, inspected as source and, for text and pages, edited. The viewer, the editor and the page editor with its preview beside the source are built, and the side panel they open in is shared with the chat's Controls; the documents below are invented and nothing is saved."
			rules={[
				'CNV-1',
				'CNV-2',
				'CNV-3',
				'CNV-4',
				'CNV-5',
				'CNV-6',
				'CNV-8',
				'CNV-9',
				'DAT-1',
				'CNT-4',
				'LAY-4',
				'NAV-4'
			]}
		>
			<Example
				title="A reply with five documents"
				note="Choose a card. The page is live inside a sandboxed frame and sits on a themed surround; Source shows it with line numbers. The page, the Markdown, the Python and the CSV documents can be edited (the table is edited as a table, with Edit as text in the Copy menu), and Changes compares the last two with their earlier version: the editor is the Source view with a caret, highlighted as you type, and saving is on request. A page has its preview beside the source (one pane at a time, by the View switch, when the canvas is narrower than 44 rem); it updates on Update preview or Ctrl or Cmd+Enter, says Out of date until it does, and updates as you type only when that is switched on. The greeting page stands for a fenced block: Try changes edits a draft that is never saved. On a narrow screen the canvas covers the chat instead of squeezing it. The real breakpoints are wider than a demo inside a page can use; the side panel below shows CNV-2's resize handle and remembered width."
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
							className={`@container border-border bg-surface-1 flex min-h-0 min-w-0 flex-col lg:border-l ${expanded ? 'lg:col-span-2 lg:border-l-0' : ''}`}
						>
							<div className="border-border flex items-center gap-1 border-b px-2 py-1.5">
								{(HAS_PREVIEW[doc.kind] || previous !== undefined) && (
									<fieldset
										className={`flex ${splitEdit ? '@min-[44rem]:hidden' : ''}`}
										disabled={editing && !splitEdit}
									>
										<legend className="sr-only">View</legend>
										{HAS_PREVIEW[doc.kind] && (
											<Button
												variant={showPreview ? 'secondary' : 'ghost'}
												size="icon-sm"
												aria-label="Preview"
												aria-pressed={showPreview}
												onClick={() => setMode('preview')}
											>
												<EyeIcon aria-hidden />
											</Button>
										)}
										<Button
											variant={!showPreview && !showChanges ? 'secondary' : 'ghost'}
											size="icon-sm"
											aria-label="Source"
											aria-pressed={!showPreview && !showChanges}
											onClick={() => setMode('source')}
										>
											<CodeIcon aria-hidden />
										</Button>
										{previous !== undefined && (
											<Button
												variant={showChanges ? 'secondary' : 'ghost'}
												size="icon-sm"
												aria-label="Changes"
												aria-pressed={showChanges}
												onClick={() => setMode('changes')}
											>
												<DiffIcon aria-hidden />
											</Button>
										)}
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
											{!isBlock && doc.kind !== 'CSV' && (
												<DropdownMenuItem onSelect={saveToWorkspace}>
													<HardDriveUploadIcon aria-hidden />
													Save to workspace
												</DropdownMenuItem>
											)}
											{csvTable && (
												<DropdownMenuItem onSelect={editAsText}>
													<TextIcon aria-hidden />
													Edit as text
												</DropdownMenuItem>
											)}
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
											{!isBlock && doc.kind !== 'CSV' && (
												<DropdownMenuItem onSelect={saveToWorkspace}>
													<HardDriveUploadIcon aria-hidden />
													Save to workspace
												</DropdownMenuItem>
											)}
											{csvTable && (
												<DropdownMenuItem onSelect={editAsText}>
													<TextIcon aria-hidden />
													Edit as text
												</DropdownMenuItem>
											)}
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
								{splitEdit ? (
									// CNV-5, CNV-6: the draft's source and its preview, side by side from 44 rem.
									<div className="flex h-full min-h-0 flex-col">
										<div className="bg-surface-2 text-dense flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5">
											<Button variant="outline" size="xs" onClick={() => setApplied(draft)}>
												Update preview
											</Button>
											{applied !== draft && <Badge variant="warning">Out of date</Badge>}
											<Label htmlFor="demo-live-preview" className="text-dense ms-auto font-normal">
												<Switch id="demo-live-preview" size="sm" checked={live} onCheckedChange={setLive} />
												Update as I type
											</Label>
										</div>
										<div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-1 @min-[44rem]:grid-cols-2">
											<div
												className={`min-h-0 min-w-0 @min-[44rem]:block @min-[44rem]:border-e ${mode === 'preview' ? 'hidden' : 'block'}`}
											>
												<CodeSurface
													code={draft}
													language={LANGUAGE[doc.kind]}
													edit={{
														label: `Edit ${doc.name}`,
														onChange: setDraft,
														inputRef: editor,
														onSave: save,
														onRun: () => setApplied(draft)
													}}
												/>
											</div>
											<div
												className={`bg-surface-1 min-h-0 min-w-0 p-3 @min-[44rem]:block ${mode === 'preview' ? 'block' : 'hidden'}`}
											>
												<iframe
													title={`Preview of ${doc.name}`}
													sandbox="allow-scripts"
													srcDoc={withHtmlPolicy(applied)}
													className="border-border bg-surface-1 size-full rounded-lg border"
												/>
											</div>
										</div>
									</div>
								) : editing && csvTable ? (
									// CNV-6, DAT-1: a CSV is a table with a field in every cell, written back as text.
									<CsvEditView
										doc={CSV_DOCUMENT}
										edit={{ draft, setDraft, inputRef: editor, onSave: save }}
										extras={{ cellRef: firstCell, dirty, rewrites: false }}
									/>
								) : editing ? (
									// CNV-6: the same surface as Source, with a caret.
									<CodeSurface
										code={draft}
										language={LANGUAGE[doc.kind]}
										edit={{ label: `Edit ${doc.name}`, onChange: setDraft, inputRef: editor, onSave: save }}
									/>
								) : showChanges && previous !== undefined ? (
									// CNV-9: a unified line diff of two versions, read-only.
									<div className="flex h-full min-h-0 flex-col">
										<p className="text-foreground-muted text-dense border-b px-3 py-2">From version 1 to version 2</p>
										<DiffView from={previous} to={text} label={`Changes from version 1 to version 2 of ${doc.name}`} />
									</div>
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
									<CodeSurface code={text} language={LANGUAGE[doc.kind]} />
								)}
							</div>

							{EDITABLE[doc.kind] && !showChanges && (
								<div className="border-border flex flex-wrap items-center justify-end gap-2 border-t px-3 py-2">
									{(isBlock ? editing : true) && (
										<p className="text-dense text-foreground-muted me-auto" role="status">
											{isBlock
												? 'Changes to a code block are not saved. Copy or download them.'
												: !editing
													? 'All changes saved'
													: dirty
														? 'Unsaved changes'
														: 'Editing. No changes yet'}
										</p>
									)}
									{editing ? (
										<div className="flex gap-2">
											<Button variant="ghost" size="sm" onClick={leaveEditor}>
												Discard changes
											</Button>
											{!isBlock && (
												<Button size="sm" disabled={!dirty} onClick={save}>
													Save document
												</Button>
											)}
										</div>
									) : (
										<Button variant="outline" size="sm" onClick={startEdit}>
											<PencilIcon aria-hidden />
											{isBlock ? 'Try changes' : 'Edit document'}
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
				<AlertDialog open={workspaceAsk !== null} onOpenChange={(isOpen) => !isOpen && setWorkspaceAsk(null)}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>{workspaceWords.title}</AlertDialogTitle>
							<AlertDialogDescription>{workspaceWords.body}</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={() => toast.success(SAVED_TO_WORKSPACE)}>
								{workspaceWords.confirm}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
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
			<Example
				title="A CSV that is edited as text"
				note="A file the table cannot hold faithfully (past 500 rows or 50 columns, a cell over 1,000 characters, not comma-separated, or mixed line endings) is edited in Source with one of these Notes above it. Editing a table never clips: what is not faithful is not offered as a table."
			>
				<div className="border-border bg-background flex max-w-xl flex-col overflow-hidden rounded-panel border">
					<Note>{tableNote('size')}</Note>
					<Note>{tableNote('delimiter')}</Note>
				</div>
			</Example>
			<Example
				title="A knowledge file a reply cites"
				note="Read-only, opened from Open in canvas in a citation (the address is ?canvas=file:<id>) and not part of the file list. The passages the reply drew from it are text above its own view; a file the server refuses is the one Note."
			>
				<div className="border-border bg-background flex h-[16rem] max-w-xl flex-col overflow-hidden rounded-panel border">
					<PassagesNote
						passages={['The standard error of the mean is the standard deviation divided by the square root of n.']}
					/>
					<Note>You can’t open this file. It may have been removed, or you may no longer have access.</Note>
				</div>
			</Example>
			<Example
				title="The side panel"
				note="The real component that holds Controls and the code preview beside a chat. Drag the separator, or focus it and use the arrow keys (Shift for bigger steps), Home and End; the width is remembered. Escape from inside closes it and focus returns to the button that opened it. Where this box cannot hold the panel and 24 rem beside it, the panel is a full-screen sheet instead."
			>
				<SidePanelDemo />
			</Example>
		</Section>
	);
}

/**
 * CNV-2, LAY-4, NAV-4: the shared `SidePanel` in a box of its own. It starts
 * open only where it would be a column, so a phone's /ui does not open on a
 * full-screen sheet.
 */
function SidePanelDemo() {
	const row = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		const space = row.current?.clientWidth || Number.POSITIVE_INFINITY;
		const wide = window.matchMedia?.('(min-width: 768px)').matches ?? true;
		if (panelMode(space, 240, wide) === 'column') setOpen(true);
	}, []);
	return (
		<div ref={row} className="border-border bg-background flex h-[24rem] overflow-hidden rounded-panel border">
			<div className="flex min-w-0 flex-1 flex-col items-start gap-3 overflow-y-auto p-4">
				<p className="text-reading max-w-[60ch]">
					The chat stays at least 24 rem wide beside the panel, and the panel never goes under its minimum.
				</p>
				<Button variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
					{open ? 'Close the side panel' : 'Open the side panel'}
				</Button>
			</div>
			<SidePanel
				open={open}
				onClose={() => setOpen(false)}
				title="Side panel"
				storageKey="ui.sidePanel"
				defaultWidth={288}
				minWidth={240}
			>
				<div className="text-foreground-muted flex flex-col gap-2 overflow-y-auto p-4">
					<p>An occupant's own content: Controls, or the preview of a code block.</p>
					<p>Each occupant keeps its own width.</p>
				</div>
			</SidePanel>
		</div>
	);
}
