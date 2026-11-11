import { useQuery } from '@tanstack/react-query';
import { ChevronsDown, ChevronsUp, Download, FileText, Maximize2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { CodeBlock } from '@/components/chat/markdown/CodeBlock';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { errorMessage } from '@/lib/apis/errors';
import { getSandboxOutputHtml, getSandboxOutputText } from '@/lib/apis/sandbox';
import type { ChatFile } from '@/lib/chat/history';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { parseCsvRows } from '@/lib/utils/csv';

/**
 * The files a sandbox `bash` call left in /workspace/outputs, shown on the
 * reply (docs/guides/sandbox.md, "Outputs"). Whatever the model wrote is
 * untrusted: images and SVG only ever as `<img>`, HTML only inside
 * SandboxedHtmlFrame, text through the code-block renderer (escaped), and
 * anything else as a download, which the server always sends as an
 * attachment.
 */

/** The most of a text output fetched and shown; past it, the start is shown and the rest is a download. */
export const TEXT_MAX_BYTES = 256 * 1024;
export const CSV_MAX_BYTES = 1024 * 1024;
export const CSV_MAX_ROWS = 200;
/** A hostile CSV (a megabyte of commas) must stay a small table. */
export const CSV_MAX_COLS = 50;
export const CSV_MAX_CELL = 1000;
/** The HTML route's own limit (routers/sandbox.py, 413 over it); a larger file is not asked for. */
export const HTML_MAX_BYTES = 5 * 1024 * 1024;
/** The frame's starting height in pixels; the user drags it, or steps it with Taller and Shorter. */
const FRAME_HEIGHT = 360;
const FRAME_STEP = 120;
const FRAME_MIN = 120;
const FRAME_MAX = 2400;

type OutputMeta = {
	source?: string;
	sandbox_path?: string;
	content_type?: string;
	preview_of?: string;
	preview_page?: number;
};

// `message.files` can hold anything a plugin's event or an imported chat put there: read it defensively.
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const metaOf = (f: unknown): OutputMeta => {
	const meta = f && typeof f === 'object' ? (f as ChatFile).meta : undefined;
	if (!meta || typeof meta !== 'object') return {};
	const m = meta as Record<string, unknown>;
	return {
		source: str(m.source),
		sandbox_path: str(m.sandbox_path),
		content_type: str(m.content_type),
		preview_of: str(m.preview_of),
		preview_page: typeof m.preview_page === 'number' ? m.preview_page : undefined
	};
};

/** A sandbox output: the server stores each as a file, so each has a UUID, the only id put into a URL. */
type OutputFile = ChatFile & { id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isSandboxOutput = (f: unknown): f is OutputFile =>
	Boolean(f) &&
	typeof f === 'object' &&
	metaOf(f).source === 'sandbox_output' &&
	UUID.test(str((f as ChatFile).id) ?? '');

export type OutputKind = 'image' | 'html' | 'pdf' | 'code' | 'csv' | 'download';
type Renderer = { kind: OutputKind; language?: string };

const BY_EXTENSION: Record<string, Renderer> = {
	png: { kind: 'image' },
	jpg: { kind: 'image' },
	jpeg: { kind: 'image' },
	svg: { kind: 'image' },
	html: { kind: 'html' },
	htm: { kind: 'html' },
	xhtml: { kind: 'html' },
	pdf: { kind: 'pdf' },
	csv: { kind: 'csv' },
	tex: { kind: 'code', language: 'latex' },
	py: { kind: 'code', language: 'python' },
	r: { kind: 'code', language: 'r' },
	json: { kind: 'code', language: 'json' },
	md: { kind: 'code', language: 'markdown' },
	txt: { kind: 'code', language: 'plaintext' },
	log: { kind: 'code', language: 'plaintext' }
};

const BY_TYPE: Record<string, Renderer> = {
	'image/png': { kind: 'image' },
	'image/jpeg': { kind: 'image' },
	'image/svg+xml': { kind: 'image' },
	'text/html': { kind: 'html' },
	'application/xhtml+xml': { kind: 'html' },
	'application/pdf': { kind: 'pdf' },
	'text/csv': { kind: 'csv' },
	'application/json': { kind: 'code', language: 'json' },
	'text/x-python': { kind: 'code', language: 'python' },
	'text/x-tex': { kind: 'code', language: 'latex' },
	'text/plain': { kind: 'code', language: 'plaintext' }
};

/** How an output is shown: by its name's extension, else by its stored media type, else as a download. */
export function outputRenderer(f: ChatFile): Renderer {
	const name = str(f.name) ?? metaOf(f).sandbox_path ?? '';
	const dot = name.lastIndexOf('.');
	const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
	const type = (metaOf(f).content_type ?? '').split(';')[0].trim().toLowerCase();
	return BY_EXTENSION[extension] ?? BY_TYPE[type] ?? { kind: 'download' };
}

const contentUrl = (id: string, attachment = false) =>
	`${WEBUI_API_BASE_URL}/files/${encodeURIComponent(id)}/content${attachment ? '?attachment=true' : ''}`;

/**
 * The name shown: the file's `name`, which the server cleaned of control and
 * format characters (sandbox/outputs.py `display_name`), never the raw
 * `sandbox_path`, where a right-to-left override could make `x.exe` read as
 * `x.pdf`.
 */
const displayName = (f: ChatFile) => str(f.name) || 'output';

/**
 * Model-written HTML in an iframe sandboxed to `allow-scripts` and nothing
 * else: an opaque origin, so its script reaches neither the app's cookies,
 * storage nor DOM, and it cannot open windows, submit forms or navigate the
 * page. The document comes from the server with its content-security policy
 * already in front, which blocks fetches, images, fonts and form posts, but
 * not WebRTC: CSP has no directive for it, so a script here can still reach
 * the network through a STUN or TURN host it names, and leak what the model
 * wrote, what the user types into the frame, and the user's IP. The owner
 * accepted that (Q23 in docs/plans/sandbox-implementation.md), so scripts
 * run as soon as the reply shows. Nor does the policy stop the frame
 * navigating itself, which only the desktop app denies (docs/guides/sandbox.md,
 * "Outputs"). Never a `blob:` URL or a new window, which would give it an
 * origin of its own to run in.
 */
export function SandboxedHtmlFrame({ html, title }: { html: string; title: string }) {
	return (
		<iframe
			srcDoc={html}
			sandbox="allow-scripts"
			title={title}
			referrerPolicy="no-referrer"
			className="size-full border-0 bg-white"
		/>
	);
}

function DownloadLink({ file }: { file: OutputFile }) {
	return (
		<a
			href={contentUrl(file.id, true)}
			download={str(file.name) ?? ''}
			aria-label={`Download ${displayName(file)}`}
			className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
		>
			<Download className="size-3" />
			Download
		</a>
	);
}

function Note({ children }: { children: React.ReactNode }) {
	return <div className="text-muted-foreground px-3 py-2 text-xs">{children}</div>;
}

function HtmlOutput({ file }: { file: OutputFile }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [enlarged, setEnlarged] = useState(false);
	const [height, setHeight] = useState(FRAME_HEIGHT);
	const box = useRef<HTMLDivElement>(null);
	const tooLarge = typeof file.size === 'number' && file.size > HTML_MAX_BYTES;
	const doc = useQuery({
		queryKey: ['sandbox-output-html', file.id],
		queryFn: ({ signal }) => getSandboxOutputHtml(token, file.id, signal),
		enabled: !tooLarge,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false
	});
	const title = `Output ${displayName(file)}`;
	// From the box's height now, which a drag of its corner may have changed, and written to the box as well as the
	// state: after a drag the new height can equal the state's, which alone would leave the dragged size in place.
	const step = (by: number) => {
		const next = Math.min(FRAME_MAX, Math.max(FRAME_MIN, (box.current?.offsetHeight || height) + by));
		if (box.current) box.current.style.height = `${next}px`;
		setHeight(next);
	};
	if (tooLarge) return <Note>Too large to show here; download it instead.</Note>;
	if (doc.isError) return <Note>Could not show this page: {errorMessage(doc.error)}</Note>;
	if (doc.data === undefined) return <div className="bg-muted h-24 animate-pulse" role="status" aria-label="Loading" />;
	return (
		<>
			<div className="flex justify-end gap-3 px-2 pt-1">
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs disabled:opacity-50"
					onClick={() => step(-FRAME_STEP)}
					aria-label={`Shorter: ${displayName(file)}`}
					disabled={height <= FRAME_MIN}
				>
					<ChevronsUp className="size-3" />
					Shorter
				</button>
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs disabled:opacity-50"
					onClick={() => step(FRAME_STEP)}
					aria-label={`Taller: ${displayName(file)}`}
					disabled={height >= FRAME_MAX}
				>
					<ChevronsDown className="size-3" />
					Taller
				</button>
				<span className="sr-only" aria-live="polite">
					{`Frame height ${height} pixels`}
				</span>
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
					onClick={() => setEnlarged(true)}
					aria-label={`Enlarge: ${displayName(file)}`}
				>
					<Maximize2 className="size-3" />
					Enlarge
				</button>
			</div>
			{/* A height the user sets (drag the corner, or Taller/Shorter): the frame's own cannot be read across its opaque origin. */}
			<div
				ref={box}
				className="min-h-[120px] resize-y overflow-hidden"
				style={{ height, maxHeight: FRAME_MAX }}
				data-testid="sandbox-frame-box"
			>
				<SandboxedHtmlFrame html={doc.data} title={title} />
			</div>
			<Dialog open={enlarged} onOpenChange={setEnlarged}>
				<DialogContent className="flex h-[90vh] flex-col sm:max-w-[90vw]" aria-describedby={undefined}>
					<DialogTitle className="truncate pr-8">{displayName(file)}</DialogTitle>
					<div className="min-h-0 flex-1">
						<SandboxedHtmlFrame html={doc.data} title={`${title}, enlarged`} />
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

function TextOutput({ file, language, csv }: { file: OutputFile; language?: string; csv?: boolean }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const cap = csv ? CSV_MAX_BYTES : TEXT_MAX_BYTES;
	const text = useQuery({
		queryKey: ['sandbox-output-text', file.id, cap],
		queryFn: ({ signal }) => getSandboxOutputText(token, file.id, cap, signal),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false
	});
	if (text.isError) return <Note>Could not show this file: {errorMessage(text.error)}</Note>;
	if (!text.data) return <div className="bg-muted h-16 animate-pulse" role="status" aria-label="Loading" />;
	const cut = text.data.truncated ? <Note>Showing the first {cap / 1024} KiB; download it for the rest.</Note> : null;
	if (!csv) {
		return (
			<div className="px-2">
				<CodeBlock
					id={`sandbox-${file.id}`}
					lang={language ?? 'plaintext'}
					code={text.data.text}
					complete
					defaultCollapsed={text.data.text.split('\n').length > 30}
				/>
				{cut}
			</div>
		);
	}
	const parsed = parseCsvRows(text.data.text, CSV_MAX_ROWS, { maxCols: CSV_MAX_COLS, maxCell: CSV_MAX_CELL });
	// When the fetch stopped at the cap inside the rows shown, the last one is cut short: leave it out.
	const rows = text.data.truncated && !parsed.more ? parsed.rows.slice(0, -1) : parsed.rows;
	// A row's or cell's place is its identity: the table is drawn once per file and never reordered.
	const [head, ...body] = rows.map((cells, at) => ({ at, cells: cells.map((cell, col) => ({ col, cell })) }));
	return (
		<div>
			<div className="max-h-96 overflow-auto">
				<table className="w-full border-collapse text-xs" data-testid="sandbox-csv">
					{head ? (
						<thead>
							<tr className="bg-muted/50">
								{head.cells.map(({ col, cell }) => (
									<th key={col} scope="col" className="px-2 py-1 text-left font-medium whitespace-pre-wrap">
										{cell}
									</th>
								))}
							</tr>
						</thead>
					) : null}
					<tbody>
						{body.map((row) => (
							<tr key={row.at} className="border-t">
								{row.cells.map(({ col, cell }) => (
									<td key={col} className="px-2 py-1 whitespace-pre-wrap">
										{cell}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{parsed.more || text.data.truncated ? <Note>Showing the first {rows.length} rows.</Note> : null}
			{parsed.clipped ? (
				<Note>
					Wide rows and long cells are cut (at most {CSV_MAX_COLS} columns of {CSV_MAX_CELL} characters).
				</Note>
			) : null}
		</div>
	);
}

function Output({ file, previews }: { file: OutputFile; previews: OutputFile[] }) {
	const { kind, language } = outputRenderer(file);
	const name = displayName(file);
	let body: React.ReactNode = null;
	if (kind === 'image') {
		body = <img src={contentUrl(file.id)} alt={name} loading="lazy" className="max-h-[32rem] max-w-full" />;
	} else if (kind === 'html') {
		body = <HtmlOutput file={file} />;
	} else if (kind === 'pdf' && previews.length) {
		body = (
			<div className="flex flex-col items-start gap-2 p-2">
				{previews.map((p, i) => (
					<img
						key={p.id}
						src={contentUrl(p.id)}
						alt={`${name}, page ${metaOf(p).preview_page ?? i + 1}`}
						loading="lazy"
						className="max-w-full border"
					/>
				))}
			</div>
		);
	} else if (kind === 'code' || kind === 'csv') {
		body = <TextOutput file={file} language={language} csv={kind === 'csv'} />;
	}
	return (
		<figure className="overflow-hidden rounded-xl border" data-testid="sandbox-output" data-kind={kind}>
			<figcaption className="bg-muted/50 flex items-center gap-2 px-3 py-1.5 text-xs">
				<FileText className="text-muted-foreground size-3.5 shrink-0" />
				<span className="min-w-0 flex-1 truncate" title={name}>
					{name}
				</span>
				<DownloadLink file={file} />
			</figcaption>
			{body}
		</figure>
	);
}

/** A reply's sandbox outputs, each PDF with its page previews (`meta.preview_of`); nothing when it has none. */
export function SandboxOutputs({ files }: { files?: unknown }) {
	const outputs = (Array.isArray(files) ? (files as unknown[]) : []).filter(isSandboxOutput);
	if (!outputs.length) return null;
	const ids = new Set(outputs.filter((f) => !metaOf(f).preview_of).map((f) => f.id));
	const previews = new Map<string, OutputFile[]>();
	const attached = new Set<OutputFile>();
	for (const f of outputs) {
		const of = metaOf(f).preview_of;
		if (of && ids.has(of)) {
			previews.set(of, [...(previews.get(of) ?? []), f]);
			attached.add(f);
		}
	}
	for (const pages of previews.values())
		pages.sort((a, b) => (metaOf(a).preview_page ?? 0) - (metaOf(b).preview_page ?? 0));
	// A preview whose PDF is not on the list is shown as the image it is.
	const shown = outputs.filter((f) => !attached.has(f));
	return (
		<section className="my-2 flex flex-col gap-2" aria-label="Sandbox outputs">
			{shown.map((f) => (
				<Output key={f.id} file={f} previews={previews.get(f.id) ?? []} />
			))}
		</section>
	);
}
