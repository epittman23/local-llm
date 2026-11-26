import saveAs from 'file-saver';
import {
	ChevronDownIcon,
	CodeIcon,
	CopyIcon,
	DiffIcon,
	DownloadIcon,
	EllipsisIcon,
	EyeIcon,
	FilesIcon,
	HardDriveUploadIcon,
	HistoryIcon,
	Maximize2Icon,
	Minimize2Icon,
	PaperclipIcon,
	PencilIcon,
	RotateCwIcon,
	TextIcon
} from 'lucide-react';
import { type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Gone } from '@/components/common/Gone';
import { Tip } from '@/components/common/Tip';
import { SidePanel, useMdUp, useSmUp } from '@/components/layout/SidePanel';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { SaveBar } from '@/components/ui/save-bar';
import { errorMessage } from '@/lib/apis/errors';
import { getFileById } from '@/lib/apis/files';
import type { FileVersion, SavedVersion } from '@/lib/apis/files/versions';
import { getSandboxOutputText } from '@/lib/apis/sandbox';
import type { CanvasDocument } from '@/lib/chat/documents';
import { useAuthStore } from '@/lib/stores/authStore';
import { canonicalCsvText, parseCsvTable } from '@/lib/utils/csvTable';
import { cn, copyToClipboard } from '@/lib/utils';
import { useUnsavedChanges } from '@/lib/ui/useUnsavedChanges';
import { Canvas, type Mode, viewsOf } from './Canvas';
import { CanvasContext } from './CanvasContext';
import { CSV_MAX_BYTES, HTML_MAX_BYTES, TEXT_MAX_BYTES } from './limits';
import {
	canEditDocument,
	contentUrl,
	editabilityOf,
	fileIdOf,
	hasChanges,
	kindIcon,
	kindLabel,
	tableNote,
	uneditableText,
	versionLabel,
	withVersion
} from './present';
import type { CanvasState } from './useCanvas';
import { useDocumentEdit } from './useDocumentEdit';
import { useDocumentVersions } from './useDocumentVersions';
import { useWriteBack } from './useWriteBack';
import { Loading, Note } from './views/parts';
import { useDocumentText } from './views/useDocumentText';

/** The text a Copy puts on the clipboard has these kinds; an image, a PDF or any other file has none. */
const COPYABLE = new Set(['html', 'markdown', 'csv', 'code']);

/** What a fenced block downloads as: its own text, named for the document. */
function saveBlock(doc: CanvasDocument, draft?: string) {
	if (doc.source.type !== 'block') return;
	const { language } = doc.source;
	const text = draft ?? doc.source.text;
	const extension = language === 'svg' ? 'svg' : language === 'html' ? 'html' : 'txt';
	const type = language === 'svg' ? 'image/svg+xml' : language === 'html' ? 'text/html' : 'text/plain';
	const base = doc.name.replace(/[^\w. -]+/g, '').trim() || 'document';
	saveAs(new Blob([text], { type }), `${base}.${extension}`);
}

/** A menu entry that downloads the document: a block is saved from its text (the draft, while one is tried), a file asks the server for an attachment. */
function DownloadItem({ doc, draft }: { doc: CanvasDocument; draft?: string }) {
	const id = fileIdOf(doc);
	if (id === null)
		return (
			<DropdownMenuItem onSelect={() => saveBlock(doc, draft)}>
				<DownloadIcon aria-hidden />
				Download
			</DropdownMenuItem>
		);
	return (
		<DropdownMenuItem asChild>
			<a href={contentUrl(id, true)} download={doc.name}>
				<DownloadIcon aria-hidden />
				Download
			</a>
		</DropdownMenuItem>
	);
}

function FileItems({ canvas }: { canvas: CanvasState }) {
	return canvas.documents.map((d) => {
		const Icon = kindIcon(d);
		return (
			<DropdownMenuItem
				key={d.id}
				aria-current={d.id === canvas.openId ? 'true' : undefined}
				onSelect={() => canvas.open(d.id)}
			>
				<Icon aria-hidden />
				{d.name}
			</DropdownMenuItem>
		);
	});
}

/** The choice among a document's versions, as a radio group (CNV-6). */
function VersionItems({
	versions,
	shownId,
	label,
	onChoose
}: {
	versions: FileVersion[];
	shownId: string | undefined;
	label: string;
	onChoose: (id: string) => void;
}) {
	return (
		<>
			<DropdownMenuLabel>{label}</DropdownMenuLabel>
			<DropdownMenuRadioGroup value={shownId} onValueChange={onChoose}>
				{versions.map((v, i) => (
					<DropdownMenuRadioItem key={v.id} value={v.id}>
						{versionLabel(v, i)}
					</DropdownMenuRadioItem>
				))}
			</DropdownMenuRadioGroup>
		</>
	);
}

function FilesMenu({ canvas, trigger }: { canvas: CanvasState; trigger?: ReactNode }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				{trigger ?? (
					<Button variant="ghost" size="sm" aria-label={`${canvas.documents.length} documents in this chat`}>
						<FilesIcon aria-hidden />
						{canvas.documents.length}
					</Button>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<FileItems canvas={canvas} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The canvas: the chat's side panel holding one document (CNV-1 to CNV-8). The
 * header is the same for every kind (CNV-3): the Preview / Source switch where
 * the kind has both, the name and kind, then the file list (more than one
 * document), Edit document, Copy with its menu, the Versions menu, Reload for
 * a live page, Expand and Close; below `sm` all but the switch and Close fold
 * into one menu. A document that is no longer in the chat says so in place
 * (NAV-3).
 *
 * A fenced block still being written shows its Source filling in, with Preview
 * unavailable; it switches to Preview once when the block closes, unless the
 * person chose a view. `focusOnOpen` is false for an auto-open
 * (`useCanvasAutoOpen`).
 *
 * CNV-6, docs/plans/canvas.md C13 to C16: a Markdown, text or code file can be
 * edited in its Source (`editable` is false in a temporary chat, which has no
 * server files). Save document stores the text as a new version of the file;
 * the document stays the original, whose versions the heading counts ("Version
 * 2 of 2") and the Versions menu lists. An older version is read-only, with
 * the way back to the latest. A version reaches the model only when it is
 * attached to the next message. The state lives here because it has to guard
 * the header's own actions: one `useUnsavedChanges` asks before anything
 * leaves a draft behind (Close, Escape, another document, Back, leaving the
 * chat, a reload, Preview, another version).
 *
 * A knowledge file a reply cites (`file:<uuid>`, CNV-1) is shown read-only, with its heading saying where it
 * is from: no Edit, no versions, no Reload. Its cited passages and the Note for a file the server refuses
 * are part of its view (`KnowledgeFrame`).
 */
export function CanvasPanel({
	canvas,
	focusOnOpen = true,
	editable = true
}: {
	canvas: CanvasState;
	focusOnOpen?: boolean;
	editable?: boolean;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const attach = useContext(CanvasContext)?.attach;
	const generating = useContext(CanvasContext)?.generating ?? false;
	const writeBack = useWriteBack();
	const smUp = useSmUp();
	const mdUp = useMdUp();
	const open = canvas.openId !== null;
	// A document removed from the chat while it holds unsaved edits stays on screen, so they are not lost unseen.
	const held = useRef<CanvasDocument | null>(null);
	const hadDraft = useRef(false);
	if (canvas.doc) held.current = canvas.doc;
	const removed = canvas.doc === null && hadDraft.current && held.current !== null;
	const doc = canvas.doc ?? (removed ? held.current : null);
	const [choice, setChoice] = useState<{ id: string; mode: Mode } | null>(null);
	const [reload, setReload] = useState<{ id: string; n: number } | null>(null);
	const [expanded, setExpanded] = useState(false);
	const [viewing, setViewing] = useState<{ docId: string; versionId: string } | null>(null);
	const headingRef = useRef<{ focus: () => void }>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	// The first cell of a table being edited: where focus goes, as the textarea is for the source editor.
	const cellRef = useRef<HTMLElement>(null);
	// A CSV the person chose to edit as text although it could be a table.
	const [asText, setAsText] = useState<string | null>(null);
	useEffect(() => {
		if (!open) setExpanded(false);
	}, [open]);

	// Which saved version is shown: the one picked, else the latest. The document keeps its id, so the address does not change.
	const { versions, latest, loading: versionsLoading } = useDocumentVersions(doc, editable);
	const picked = doc && viewing?.docId === doc.id ? versions.find((v) => v.id === viewing.versionId) : undefined;
	const shownVersion = picked ?? latest;
	const shown = doc && withVersion(doc, shownVersion);
	const shownIndex = shownVersion ? versions.findIndex((v) => v.id === shownVersion.id) : -1;
	const isLatest = !shownVersion || shownVersion.id === latest?.id;
	const editableDoc = editable && shown && canEditDocument(shown) ? shown : null;
	// A fenced block of a page can be tried but not saved: its draft is keyed by the document's id, with no file behind it.
	const tryingDoc = shown && editabilityOf(shown).draftOnly ? shown : null;
	const text = useDocumentText(editableDoc, TEXT_MAX_BYTES);
	const reason = text.data ? uneditableText(text.data) : null;
	// A CSV is edited as a table when it is faithful, and as text otherwise (CNV-6).
	const csvParse = useMemo(
		() => (shown?.kind === 'csv' && text.data ? parseCsvTable(text.data.text) : null),
		[shown?.kind, text.data]
	);
	const tableMode = csvParse !== null && 'table' in csvParse && asText !== doc?.id;
	let editFileId: string | null = null;
	if (tryingDoc) editFileId = tryingDoc.id;
	else if (editableDoc && isLatest && reason === null) editFileId = fileIdOf(editableDoc);
	const rootId = doc && doc.source.type !== 'block' ? doc.source.fileId : null;

	const attachVersion = async (version: Pick<FileVersion, 'id' | 'size'>, number: number, status?: string) => {
		if (!attach || !doc) return;
		let state = status;
		if (state === undefined) {
			try {
				state = ((await getFileById(token, version.id)) as { data?: { status?: string } | null } | null)?.data?.status;
			} catch {
				// Unknown: the model reading it is the server's to refuse.
			}
		}
		if (state === 'failed') {
			toast.error('This version could not be prepared for the model');
			return;
		}
		const attached = attach({
			type: 'file',
			id: version.id,
			name: doc.name,
			url: version.id,
			size: version.size ?? undefined,
			content_type: doc.kind === 'markdown' ? 'text/markdown' : 'text/plain',
			collection_name: '',
			context: 'full'
		});
		if (!attached) return;
		toast.success(`Attached version ${number}`);
		// A sheet covers the composer: close it so the attached file shows, unless a draft is still open in it.
		if (!mdUp && !hadDraft.current) canvas.close();
	};
	// Only a saved version of a file the model wrote to its workspace goes back there: an upload is read-only
	// in the sandbox, a block and a knowledge file have no workspace file, and a running reply holds the workspace.
	const offerWriteBack = editable && !generating && doc?.source.type === 'output' && editableDoc !== null;
	const edit = useDocumentEdit({
		fileId: editFileId,
		rootId,
		text: tryingDoc?.source.type === 'block' ? tryingDoc.source.text : text.data?.text,
		draftOnly: tryingDoc !== null,
		canonical: tableMode ? canonicalCsvText : undefined,
		onSaved: (saved: SavedVersion) => {
			setViewing(null);
			setAsText(null);
			// A saved page is shown as the page, through the server's policy route, not as the source just typed.
			if (doc && doc.kind === 'html' && viewsOf(doc).preview) setChoice({ id: doc.id, mode: 'preview' });
			headingRef.current?.focus();
			const number = saved.meta?.version ?? versions.length + 1;
			toast.success(`Saved as version ${number}`, {
				// Two buttons do not fit beside the text in a toast's one row: let the second wrap under it.
				className: offerWriteBack ? 'flex-wrap' : undefined,
				action: attach
					? {
							label: 'Attach to next message',
							onClick: () =>
								void attachVersion({ id: saved.id, size: saved.meta?.size ?? null }, number, saved.data?.status)
						}
					: undefined,
				// The second button of a toast is its `cancel`: it is the action beside the first, not a dismissal.
				cancel: offerWriteBack ? { label: 'Save to workspace', onClick: () => void writeBack.run(saved.id) } : undefined
			});
		}
	});
	hadDraft.current = edit.dirty;
	const guard = useUnsavedChanges(edit.dirty, {
		message: 'Your edits to this document are not saved. They are lost if you leave.',
		// Keep editing goes back to the editor (NAV-4), not to the Close button that raised the question.
		keepFocus: () => inputRef.current ?? cellRef.current
	});
	const canStartEdit =
		editFileId !== null &&
		(tryingDoc !== null || text.data !== undefined) &&
		!versionsLoading &&
		!removed &&
		!edit.editing;
	useEffect(() => {
		if (edit.editing) (inputRef.current ?? cellRef.current)?.focus();
	}, [edit.editing]);

	const views = doc ? viewsOf(doc) : { preview: false, source: false };
	const writing = doc?.source.type === 'block' && !doc.source.closed;
	const changesShown = editable && shown !== null && hasChanges(shown, versions);
	const switchShown = Number(views.preview) + Number(views.source) + Number(changesShown) > 1;
	const previewEnabled = !writing;
	const chosen = choice && choice.id === doc?.id ? choice.mode : null;
	// A page being edited keeps Preview: its draft is shown beside the source, or in place of it below 44 rem.
	const splitEdit = edit.editing && views.preview && shown?.kind === 'html';
	// A CSV being edited as a table is the Preview slot's table; the Source switch turns it into the text.
	const tableEdit = edit.editing && tableMode;
	let mode: Mode = 'preview';
	if (!views.preview) mode = 'source';
	else if (views.source) {
		if (tableEdit) mode = 'preview';
		else if (writing || (edit.editing && !splitEdit)) mode = 'source';
		else if (chosen === 'source' || chosen === 'preview') mode = chosen;
		else mode = edit.editing ? 'source' : 'preview';
	}
	if (changesShown && chosen === 'changes' && !writing && !edit.editing) mode = 'changes';
	const reloads = doc && reload?.id === doc.id ? reload.n : 0;
	const choose = (next: Mode) => {
		if (doc && previewEnabled) setChoice({ id: doc.id, mode: next });
	};
	const startEdit = () => {
		if (doc && views.preview && !tableMode) setChoice({ id: doc.id, mode: 'source' });
		edit.start();
	};
	const editAsText = () => {
		if (!doc) return;
		setAsText(doc.id);
		setChoice({ id: doc.id, mode: 'source' });
		if (!edit.editing) edit.start();
	};
	const discard = () => {
		setAsText(null);
		edit.discard();
		headingRef.current?.focus();
	};
	const showVersion = (versionId: string) =>
		guard.confirmLeave(() => {
			if (doc) setViewing({ docId: doc.id, versionId });
		});

	const canEdit = canStartEdit && isLatest && mode !== 'changes';
	const canReload =
		doc !== null && doc.kind === 'html' && doc.source.type !== 'upload' && mode === 'preview' && !edit.editing;
	const doReload = () => doc && setReload({ id: doc.id, n: reloads + 1 });
	const canCopy = doc !== null && COPYABLE.has(doc.kind);
	const doCopy = async () => {
		if (!shown) return;
		try {
			let text: string;
			if (shown.source.type === 'block') text = tryingDoc && edit.editing ? edit.draft : shown.source.text;
			else {
				const cap = shown.kind === 'csv' ? CSV_MAX_BYTES : shown.kind === 'html' ? HTML_MAX_BYTES : TEXT_MAX_BYTES;
				text = (await getSandboxOutputText(token, shown.source.fileId, cap)).text;
			}
			if (await copyToClipboard(text)) toast.success('Copied');
			else toast.error('Could not copy');
		} catch (error) {
			toast.error(`Could not copy: ${errorMessage(error)}`);
		}
	};

	const copyItem = (
		<DropdownMenuItem onSelect={doCopy}>
			<CopyIcon aria-hidden />
			Copy
		</DropdownMenuItem>
	);
	const editAsTextItem = tableMode && (canEdit || tableEdit) && (
		<DropdownMenuItem onSelect={editAsText}>
			<TextIcon aria-hidden />
			Edit as text
		</DropdownMenuItem>
	);
	const writeBackId = offerWriteBack && !edit.editing && !removed && shown ? fileIdOf(shown) : null;
	const writeBackItem = writeBackId !== null && (
		<DropdownMenuItem disabled={writeBack.pending} onSelect={() => void writeBack.run(writeBackId)}>
			<HardDriveUploadIcon aria-hidden />
			Save to workspace
		</DropdownMenuItem>
	);
	const canAttach = attach !== undefined && shownVersion !== undefined && shownVersion !== null && versions.length > 1;
	const attachItem = canAttach && (
		<DropdownMenuItem onSelect={() => void attachVersion(shownVersion, shownIndex + 1)}>
			<PaperclipIcon aria-hidden />
			Attach to next message
		</DropdownMenuItem>
	);
	// The count shows once, as the Versions menu's own label; the heading stays the name and the kind.
	const versionCount = shownIndex >= 0 ? `Version ${shownIndex + 1} of ${versions.length}` : 'Versions';
	const reloadLabel = 'Reload the page';
	const editLabel = tryingDoc ? 'Try changes' : 'Edit document';
	const draftText = tryingDoc && edit.editing ? edit.draft : undefined;
	let actions: ReactNode = null;
	if (shown) {
		const downloadFile = fileIdOf(shown);
		actions = smUp ? (
			<>
				{canvas.documents.length > 1 && <FilesMenu canvas={canvas} />}
				{canEdit && (
					<Button
						variant="outline"
						size="sm"
						aria-label={editLabel}
						className="px-1.5 @min-[30rem]:px-2.5"
						onClick={startEdit}
					>
						<PencilIcon aria-hidden />
						{/* Only with room: at the panel's narrowest the header keeps its heading whole. */}
						<span className="hidden @min-[30rem]:inline">{editLabel}</span>
					</Button>
				)}
				{versions.length > 1 && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="sm" aria-label={versionCount} className="px-1.5 @min-[30rem]:px-2.5">
								<HistoryIcon aria-hidden />
								<span className="hidden @min-[30rem]:inline">{versionCount}</span>
								<ChevronDownIcon aria-hidden className="hidden @min-[30rem]:block" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<VersionItems versions={versions} shownId={shownVersion?.id} label="Versions" onChoose={showVersion} />
						</DropdownMenuContent>
					</DropdownMenu>
				)}
				{canCopy ? (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="outline" size="sm" aria-label="Copy" className="px-1.5 @min-[30rem]:px-2.5">
								{/* At the panel's narrowest the menu is its icon, so the heading stays whole beside the view switch. */}
								<CopyIcon aria-hidden className="@min-[30rem]:hidden" />
								<span className="hidden @min-[30rem]:inline">Copy</span>
								<ChevronDownIcon aria-hidden className="hidden @min-[30rem]:block" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{copyItem}
							{attachItem}
							{writeBackItem}
							{editAsTextItem}
							<DownloadItem doc={shown} draft={draftText} />
						</DropdownMenuContent>
					</DropdownMenu>
				) : (
					downloadFile !== null && (
						<Button asChild variant="outline" size="sm">
							<a href={contentUrl(downloadFile, true)} download={shown.name}>
								Download
							</a>
						</Button>
					)
				)}
				{canReload && (
					<Tip content={reloadLabel}>
						<Button variant="ghost" size="icon-sm" aria-label={reloadLabel} onClick={doReload}>
							<RotateCwIcon aria-hidden />
						</Button>
					</Tip>
				)}
				{mdUp && (
					<Tip content={expanded ? 'Show the chat beside it' : 'Expand to the full width'}>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={expanded ? 'Show the chat beside it' : 'Expand to the full width'}
							onClick={() => setExpanded(!expanded)}
						>
							{expanded ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
						</Button>
					</Tip>
				)}
			</>
		) : (
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon-sm" aria-label="More actions for this document">
						<EllipsisIcon aria-hidden />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{canEdit && (
						<DropdownMenuItem onSelect={startEdit}>
							<PencilIcon aria-hidden />
							{editLabel}
						</DropdownMenuItem>
					)}
					{canCopy && copyItem}
					{attachItem}
					{writeBackItem}
					{editAsTextItem}
					<DownloadItem doc={shown} draft={draftText} />
					{canReload && (
						<DropdownMenuItem onSelect={doReload}>
							<RotateCwIcon aria-hidden />
							{reloadLabel}
						</DropdownMenuItem>
					)}
					{versions.length > 1 && (
						<>
							<DropdownMenuSeparator />
							<VersionItems
								versions={versions}
								shownId={shownVersion?.id}
								label={versionCount}
								onChoose={showVersion}
							/>
						</>
					)}
					{canvas.documents.length > 1 && (
						<>
							<DropdownMenuSeparator />
							<FileItems canvas={canvas} />
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		);
	}

	// With a Changes segment the switch is a little smaller at the panel's narrowest, so the heading keeps its room.
	const segment = changesShown ? 'size-6 @min-[30rem]:size-7' : undefined;
	const leading = switchShown ? (
		<fieldset className={cn('flex', splitEdit && mdUp && '@min-[44rem]:hidden')}>
			<legend className="sr-only">View</legend>
			{views.preview && (
				<Button
					variant={mode === 'preview' ? 'secondary' : 'ghost'}
					size="icon-sm"
					aria-label="Preview"
					className={segment}
					aria-pressed={mode === 'preview'}
					disabled={!previewEnabled}
					onClick={() =>
						splitEdit || tableEdit
							? choose('preview')
							: guard.confirmLeave(() => {
									edit.discard();
									choose('preview');
								})
					}
				>
					<EyeIcon aria-hidden />
				</Button>
			)}
			{views.source && (
				<Button
					variant={mode === 'source' ? 'secondary' : 'ghost'}
					size="icon-sm"
					aria-label="Source"
					className={segment}
					aria-pressed={mode === 'source'}
					onClick={() => (tableEdit ? editAsText() : choose('source'))}
				>
					<CodeIcon aria-hidden />
				</Button>
			)}
			{changesShown && (
				<Button
					variant={mode === 'changes' ? 'secondary' : 'ghost'}
					size="icon-sm"
					aria-label="Changes"
					className={segment}
					aria-pressed={mode === 'changes'}
					onClick={() =>
						guard.confirmLeave(() => {
							edit.discard();
							choose('changes');
						})
					}
				>
					<DiffIcon aria-hidden />
				</Button>
			)}
		</fieldset>
	) : undefined;

	const heading = doc ? (
		<span title={doc.name}>
			<span className="font-strong">{doc.name}</span>{' '}
			<span className="text-foreground-muted text-dense">
				{kindLabel(doc)}
				{doc.source.type === 'knowledge' ? ', from a knowledge source' : ''}
			</span>
		</span>
	) : undefined;

	// A page between the edit cap and the HTML route's limit is shown, and only downloaded to change it.
	const tooLargeToEdit =
		editable &&
		shown !== null &&
		(shown.kind === 'html' || shown.kind === 'csv') &&
		shown.source.type !== 'block' &&
		typeof shown.bytes === 'number' &&
		shown.bytes > TEXT_MAX_BYTES;
	let body: ReactNode = <Loading />;
	if (shown) {
		const editProps = edit.editing
			? { draft: edit.draft, setDraft: edit.setDraft, inputRef, onSave: edit.save }
			: undefined;
		body = (
			<>
				{!isLatest && (
					<div
						className="bg-surface-2 text-dense flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5"
						role="status"
					>
						<span>
							You are viewing version {shownIndex + 1} of {versions.length}.
						</span>
						<Button variant="link" size="xs" onClick={() => setViewing(null)}>
							Back to version {versions.length}
						</Button>
					</div>
				)}
				{removed && <Note>This document was removed from the chat. Your edits can still be copied.</Note>}
				{!edit.editing && tooLargeToEdit && <Note>Too large to edit; download it to change it.</Note>}
				{edit.editing && shown.kind === 'csv' && csvParse && 'notFaithful' in csvParse && (
					<Note>{tableNote(csvParse.notFaithful)}</Note>
				)}
				<Canvas
					doc={shown}
					mode={mode}
					reloads={reloads}
					edit={editProps}
					csvTable={
						tableEdit && text.data
							? { cellRef, dirty: edit.dirty, rewrites: canonicalCsvText(text.data.text) !== text.data.text }
							: undefined
					}
					changes={{ versions, shownIndex }}
				/>
				{edit.editing && tryingDoc && (
					<div className="px-3 pb-3">
						<div data-keep-clear className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
							<p role="status" className="text-foreground-muted text-dense me-auto max-sm:w-full">
								Changes to a code block are not saved. Copy or download them.
							</p>
							<Button type="button" variant="ghost" onClick={discard}>
								Discard changes
							</Button>
						</div>
					</div>
				)}
				{edit.editing && !tryingDoc && (
					<div className="px-3 pb-3">
						<SaveBar
							dirty={edit.dirty}
							saving={edit.saving}
							disabled={edit.blocked !== null || removed}
							note={edit.blocked ?? undefined}
							saveLabel="Save document"
							onDiscard={discard}
							onSave={edit.save}
						/>
					</div>
				)}
			</>
		);
	} else if (canvas.gone)
		body = (
			<Gone
				level={3}
				title="This document is no longer in the chat"
				description="It may have been removed when the reply was edited or regenerated."
				actions={
					<>
						<Button variant="outline" onClick={canvas.close}>
							Close the canvas
						</Button>
						{canvas.documents.length > 0 && (
							<FilesMenu
								canvas={canvas}
								trigger={
									<Button variant="ghost">
										<FilesIcon aria-hidden />
										Documents in this chat
									</Button>
								}
							/>
						)}
					</>
				}
			/>
		);

	return (
		<>
			<SidePanel
				open={open}
				onClose={canvas.close}
				title="Canvas"
				storageKey="sidePanel.canvas"
				defaultWidth={(space) => space / 2}
				minWidth={320}
				leading={leading}
				heading={heading}
				actions={actions}
				expanded={expanded}
				focusOnOpen={focusOnOpen}
				headingRef={headingRef}
			>
				{body}
			</SidePanel>
			{guard.dialog}
			{writeBack.dialog}
		</>
	);
}
