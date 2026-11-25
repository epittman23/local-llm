import saveAs from 'file-saver';
import {
	ChevronDownIcon,
	CodeIcon,
	CopyIcon,
	DownloadIcon,
	EllipsisIcon,
	EyeIcon,
	FilesIcon,
	Maximize2Icon,
	Minimize2Icon,
	RotateCwIcon
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Gone } from '@/components/common/Gone';
import { Tip } from '@/components/common/Tip';
import { SidePanel, useMdUp, useSmUp } from '@/components/layout/SidePanel';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { errorMessage } from '@/lib/apis/errors';
import { getSandboxOutputText } from '@/lib/apis/sandbox';
import type { CanvasDocument } from '@/lib/chat/documents';
import { useAuthStore } from '@/lib/stores/authStore';
import { copyToClipboard } from '@/lib/utils';
import { Canvas, type Mode, viewsOf } from './Canvas';
import { CSV_MAX_BYTES, HTML_MAX_BYTES, TEXT_MAX_BYTES } from './limits';
import { contentUrl, fileIdOf, kindIcon, kindLabel } from './present';
import type { CanvasState } from './useCanvas';
import { Loading } from './views/parts';

/** The text a Copy puts on the clipboard has these kinds; an image, a PDF or any other file has none. */
const COPYABLE = new Set(['html', 'markdown', 'csv', 'code']);

/** What a fenced block downloads as: its own text, named for the document. */
function saveBlock(doc: CanvasDocument) {
	if (doc.source.type !== 'block') return;
	const { text, language } = doc.source;
	const extension = language === 'svg' ? 'svg' : language === 'html' ? 'html' : 'txt';
	const type = language === 'svg' ? 'image/svg+xml' : language === 'html' ? 'text/html' : 'text/plain';
	const base = doc.name.replace(/[^\w. -]+/g, '').trim() || 'document';
	saveAs(new Blob([text], { type }), `${base}.${extension}`);
}

/** A menu entry that downloads the document: a block is saved from its text, a file asks the server for an attachment. */
function DownloadItem({ doc }: { doc: CanvasDocument }) {
	const id = fileIdOf(doc);
	if (id === null)
		return (
			<DropdownMenuItem onSelect={() => saveBlock(doc)}>
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
 * document), Copy with its menu, Reload for a live page, Expand and Close;
 * below `sm` all but the switch and Close fold into one menu. A document that
 * is no longer in the chat says so in place (NAV-3).
 *
 * A fenced block still being written shows its Source filling in, with Preview
 * unavailable; it switches to Preview once when the block closes, unless the
 * person chose a view. `focusOnOpen` is false for an auto-open
 * (`useCanvasAutoOpen`).
 */
export function CanvasPanel({ canvas, focusOnOpen = true }: { canvas: CanvasState; focusOnOpen?: boolean }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const smUp = useSmUp();
	const mdUp = useMdUp();
	const open = canvas.openId !== null;
	const { doc } = canvas;
	const [choice, setChoice] = useState<{ id: string; mode: Mode } | null>(null);
	const [reload, setReload] = useState<{ id: string; n: number } | null>(null);
	const [expanded, setExpanded] = useState(false);
	useEffect(() => {
		if (!open) setExpanded(false);
	}, [open]);

	const views = doc ? viewsOf(doc) : { preview: false, source: false };
	const writing = doc?.source.type === 'block' && !doc.source.closed;
	const switchShown = views.preview && views.source;
	const previewEnabled = !writing;
	let mode: Mode = 'preview';
	if (!views.preview) mode = 'source';
	else if (views.source) mode = writing ? 'source' : choice && choice.id === doc?.id ? choice.mode : 'preview';
	const reloads = doc && reload?.id === doc.id ? reload.n : 0;
	const choose = (next: Mode) => {
		if (doc && previewEnabled) setChoice({ id: doc.id, mode: next });
	};

	const canReload = doc !== null && doc.kind === 'html' && doc.source.type !== 'upload' && mode === 'preview';
	const doReload = () => doc && setReload({ id: doc.id, n: reloads + 1 });
	const canCopy = doc !== null && COPYABLE.has(doc.kind);
	const doCopy = async () => {
		if (!doc) return;
		try {
			let text: string;
			if (doc.source.type === 'block') text = doc.source.text;
			else {
				const cap = doc.kind === 'csv' ? CSV_MAX_BYTES : doc.kind === 'html' ? HTML_MAX_BYTES : TEXT_MAX_BYTES;
				text = (await getSandboxOutputText(token, doc.source.fileId, cap)).text;
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
	const reloadLabel = 'Reload the page';
	let actions: ReactNode = null;
	if (doc) {
		const downloadFile = fileIdOf(doc);
		actions = smUp ? (
			<>
				{canvas.documents.length > 1 && <FilesMenu canvas={canvas} />}
				{canCopy ? (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="outline" size="sm">
								Copy
								<ChevronDownIcon aria-hidden />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{copyItem}
							<DownloadItem doc={doc} />
						</DropdownMenuContent>
					</DropdownMenu>
				) : (
					downloadFile !== null && (
						<Button asChild variant="outline" size="sm">
							<a href={contentUrl(downloadFile, true)} download={doc.name}>
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
					{canCopy && copyItem}
					<DownloadItem doc={doc} />
					{canReload && (
						<DropdownMenuItem onSelect={doReload}>
							<RotateCwIcon aria-hidden />
							{reloadLabel}
						</DropdownMenuItem>
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

	const leading = switchShown ? (
		<fieldset className="flex">
			<legend className="sr-only">View</legend>
			<Button
				variant={mode === 'preview' ? 'secondary' : 'ghost'}
				size="icon-sm"
				aria-label="Preview"
				aria-pressed={mode === 'preview'}
				disabled={!previewEnabled}
				onClick={() => choose('preview')}
			>
				<EyeIcon aria-hidden />
			</Button>
			<Button
				variant={mode === 'source' ? 'secondary' : 'ghost'}
				size="icon-sm"
				aria-label="Source"
				aria-pressed={mode === 'source'}
				onClick={() => choose('source')}
			>
				<CodeIcon aria-hidden />
			</Button>
		</fieldset>
	) : undefined;

	const heading = doc ? (
		<span title={doc.name}>
			<span className="font-strong">{doc.name}</span>{' '}
			<span className="text-foreground-muted text-dense">{kindLabel(doc)}</span>
		</span>
	) : undefined;

	let body: ReactNode = <Loading />;
	if (doc) body = <Canvas doc={doc} mode={mode} reloads={reloads} />;
	else if (canvas.gone)
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
		>
			{body}
		</SidePanel>
	);
}
