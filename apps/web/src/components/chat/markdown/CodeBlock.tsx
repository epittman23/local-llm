import saveAs from 'file-saver';
import hljs from 'highlight.js/lib/common';
import latex from 'highlight.js/lib/languages/latex';
import {
	Check,
	ChevronDown,
	ChevronUp,
	Copy,
	Download,
	ExternalLink,
	Eye,
	Loader2,
	Play,
	TextWrap,
	X
} from 'lucide-react';
import 'highlight.js/styles/github-dark.min.css';
import { type ComponentProps, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { SandboxOutputs } from '@/components/chat/SandboxOutputs';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import type { CodeRunResult } from '@/lib/apis/utils';
import { useAuthStore } from '@/lib/stores/authStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { useCopy } from '@/lib/ui/useCopy';
import { cn } from '@/lib/utils';
import { useScrollEdges } from './useScrollEdges';

/** A block longer than this offers Collapse, and a collapsed one shows this many lines (CNT-2). */
export const COLLAPSE_LINES = 25;
/** Below this width a block's header shows its actions as named icons (ACT-4). */
const NARROW_PX = 448;
/** The fixed text the sandbox answers with when it cannot start here (tools/builtin.py's sandbox_error_text). */
export const SANDBOX_UNAVAILABLE = 'The sandbox is not available on this server';
const UNAVAILABLE_STATUS = "The code sandbox isn't set up on this machine";
const SANDBOX_GUIDE = 'https://github.com/epittman23/local-llm/blob/main/docs/guides/sandbox.md';
const WRAP_KEY = 'codeWrap';

const readWrap = () => {
	try {
		return localStorage.getItem(WRAP_KEY) === 'true';
	} catch {
		return false;
	}
};

/**
 * What every code block on the page shares: Wrap lines, remembered across visits (CNT-2), and whether the
 * sandbox has said it cannot start here, after which Run is disabled for the rest of the session (#993).
 */
export const useCodeBlockStore = create<{
	wrap: boolean;
	setWrap: (wrap: boolean) => void;
	sandboxUnavailable: boolean;
	markSandboxUnavailable: () => void;
}>((set) => ({
	wrap: readWrap(),
	setWrap: (wrap) => {
		try {
			localStorage.setItem(WRAP_KEY, String(wrap));
		} catch {
			/* storage blocked: wrap for this page only */
		}
		set({ wrap });
	},
	sandboxUnavailable: false,
	markSandboxUnavailable: () => set({ sandboxUnavailable: true })
}));

// A language's file extension for Download; a short language name is its own extension.
const EXTENSIONS: Record<string, string> = {
	python: 'py',
	javascript: 'js',
	typescript: 'ts',
	bash: 'sh',
	shell: 'sh',
	zsh: 'sh',
	markdown: 'md',
	latex: 'tex',
	rust: 'rs',
	yml: 'yaml',
	'c++': 'cpp',
	plaintext: 'txt',
	text: 'txt'
};
export const extensionOf = (language: string) =>
	EXTENSIONS[language] ?? (/^[a-z0-9]{1,5}$/.test(language) ? language : 'txt');

// The common set has no LaTeX, which `.tex` sandbox outputs (components/chat/SandboxOutputs.tsx) are shown in.
hljs.registerLanguage('latex', latex);

let mermaidLoader: Promise<typeof import('mermaid').default> | null = null;
const loadMermaid = () => {
	mermaidLoader ??= import('mermaid').then((m) => {
		const dark = document.documentElement.classList.contains('dark');
		// look: 'classic' keeps diagrams as they rendered before mermaid 12,
		// which made its new 'neo' look the default for ten diagram types.
		m.default.initialize({
			startOnLoad: false,
			securityLevel: 'strict',
			theme: dark ? 'dark' : 'default',
			look: 'classic'
		});
		return m.default;
	});
	return mermaidLoader;
};

/** A mermaid diagram, rendered once its fence is closed. `securityLevel: strict` keeps the SVG free of script and click handlers. */
function Mermaid({ code, id }: { code: string; id: string }) {
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		loadMermaid()
			.then((m) => m.render(`mermaid-${id.replace(/[^\w-]/g, '')}`, code))
			.then((r) => !cancelled && setSvg(r.svg))
			.catch((e) => !cancelled && setError(`Failed to render diagram: ${e?.message ?? e}`));
		return () => {
			cancelled = true;
		};
	}, [code, id]);
	if (error) return <div className="text-destructive text-xs">{error}</div>;
	if (!svg) return <div className="bg-muted h-24 animate-pulse rounded-xl" />;
	return <div className="flex justify-center overflow-x-auto py-2" dangerouslySetInnerHTML={{ __html: svg }} />;
}

type Run = { state: 'running' } | { state: 'done'; result: CodeRunResult } | { state: 'failed'; error: string };

/** Whether a run's failure is the sandbox saying it cannot start here (the backend may add notes after the text). */
const sandboxUnavailable = (run: Run) =>
	(run.state === 'failed' && run.error.includes(SANDBOX_UNAVAILABLE)) ||
	(run.state === 'done' && (run.result.error ?? '').startsWith(SANDBOX_UNAVAILABLE));

/** One stream of a run's output, in a scrollable block; nothing when it is empty. */
function Stream({ label, text, tone }: { label?: string; text?: string; tone?: 'error' }) {
	if (!text) return null;
	return (
		<div>
			{label && <div className="text-muted-foreground mb-0.5 text-caption">{label}</div>}
			<pre
				className={cn(
					'bg-muted/50 max-h-64 overflow-auto rounded-lg px-3 py-2 text-xs whitespace-pre-wrap',
					tone === 'error' && 'text-destructive'
				)}
			>
				{text}
			</pre>
		</div>
	);
}

/** The one-line status of a run, which is also what a screen reader announces (RunStatus). */
function runStatus(run: Run | null): string {
	if (run === null) return '';
	if (run.state === 'running') return 'Running...';
	if (sandboxUnavailable(run)) return UNAVAILABLE_STATUS;
	if (run.state === 'failed' || run.result.error) return 'Run failed';
	if (run.result.timed_out) return 'Stopped at its time limit';
	const code = run.result.returncode;
	return typeof code === 'number' && code !== 0 ? `Exited with code ${code}` : 'Finished';
}

/** FBK-4: what the unavailable sandbox needs, and where to set it up (the settings only for an admin). */
function SandboxSetup() {
	const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
	const openSettings = useSettingsModalStore((s) => s.openSettings);
	return (
		<>
			<p className="text-muted-foreground text-body">
				Running code needs KVM, the Kata runtime and the sandbox images on the server. Reload the page once they are set
				up.
			</p>
			<div className="flex flex-wrap gap-2">
				<Button asChild variant="outline" size="xs">
					<a href={SANDBOX_GUIDE} target="_blank" rel="noopener noreferrer">
						Read the sandbox guide
						<ExternalLink aria-hidden />
					</a>
				</Button>
				{isAdmin && (
					<Button type="button" variant="outline" size="xs" onClick={() => openSettings('admin:code-execution')}>
						Open Code execution settings
					</Button>
				)}
			</div>
		</>
	);
}

/**
 * What a Run left: its stdout, stderr and result, an error (the endpoint's refusal, or the sandbox's own failure),
 * and the files it put in /workspace/outputs, shown as a reply's sandbox outputs are (SandboxOutputs). The status
 * line names a failure, so its text follows without a second label.
 */
function RunOutput({ run, onClose }: { run: Run; onClose: () => void }) {
	const unavailable = sandboxUnavailable(run);
	return (
		<div
			className="flex flex-col gap-2 border-t px-4 py-3"
			data-testid="code-run-output"
			aria-busy={run.state === 'running'}
		>
			<div className="flex items-center justify-between gap-2">
				<span aria-hidden="true" className={unavailable ? 'text-body font-strong' : 'text-muted-foreground text-xs'}>
					{runStatus(run)}
				</span>
				{run.state !== 'running' && (
					<Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close output">
						<X className="size-3" />
					</Button>
				)}
			</div>
			{run.state === 'running' && <Loader2 className="text-muted-foreground size-4 animate-spin" />}
			{unavailable ? (
				<SandboxSetup />
			) : (
				<>
					{run.state === 'failed' && <Stream text={run.error} tone="error" />}
					{run.state === 'done' && (
						<>
							<Stream text={run.result.error} tone="error" />
							<Stream label="Output" text={run.result.stdout} />
							<Stream label="Errors" text={run.result.stderr} tone="error" />
							<Stream label="Result" text={run.result.result} />
							{run.result.truncated && (
								<div className="text-muted-foreground text-xs">
									The output was cut to its first and last 10,000 characters.
								</div>
							)}
							{!run.result.error &&
								!run.result.stdout &&
								!run.result.stderr &&
								!run.result.result &&
								!run.result.files?.length && <div className="text-muted-foreground text-xs">No output</div>}
							<SandboxOutputs files={run.result.files} />
						</>
					)}
				</>
			)}
		</div>
	);
}

/**
 * One action in a block's header: an icon and its name, or, where the block is narrow, the icon alone, named by
 * `aria-label` and a tooltip (ACT-4). `tip` replaces the tooltip (a disabled Run says why, ACT-5).
 */
function HeaderButton({
	label,
	icon,
	narrow,
	tip,
	'aria-label': name,
	...props
}: Omit<ComponentProps<typeof Button>, 'children'> & {
	label: string;
	icon: ReactNode;
	narrow: boolean;
	tip?: string;
}) {
	return (
		<Tip content={tip ?? (narrow ? label : undefined)}>
			<Button
				type="button"
				variant="ghost"
				size={narrow ? 'icon-xs' : 'xs'}
				aria-label={name ?? (narrow ? label : undefined)}
				{...props}
			>
				{icon}
				{!narrow && label}
			</Button>
		</Tip>
	);
}

/**
 * Ports chat/Messages/CodeBlock.svelte: a fenced block with its language, highlighted by highlight.js (common
 * languages), and a header of actions (CNT-2): Collapse for a block over 25 lines (collapsed by default under the
 * user's "collapse code blocks" setting), Wrap lines (remembered), Run for Python when the caller provides a runner
 * (its output and outputs shown under the block until closed; a second press while it runs does nothing; disabled
 * for the session once the sandbox says it cannot start here), Preview for HTML and SVG when the caller offers one
 * (artifacts), Download (named by the language) and Copy. Long lines scroll inside the block, which is a named tab
 * stop while they do. Mermaid diagrams are drawn once the fence is complete.
 */
export function CodeBlock({
	id,
	lang,
	code,
	complete,
	defaultCollapsed = false,
	onPreview,
	onRun
}: {
	id: string;
	lang: string;
	code: string;
	complete: boolean;
	defaultCollapsed?: boolean;
	onPreview?: (code: string) => void;
	onRun?: (code: string) => Promise<CodeRunResult>;
}) {
	const [collapsedChoice, setCollapsed] = useState(defaultCollapsed);
	const { copied, copy } = useCopy();
	const wrap = useCodeBlockStore((s) => s.wrap);
	const setWrap = useCodeBlockStore((s) => s.setWrap);
	const unavailable = useCodeBlockStore((s) => s.sandboxUnavailable);
	const markUnavailable = useCodeBlockStore((s) => s.markSandboxUnavailable);
	const [run, setRun] = useState<Run | null>(null);
	const runButton = useRef<HTMLButtonElement>(null);
	const root = useRef<HTMLDivElement>(null);
	const [narrow, setNarrow] = useState(false);
	const [preRef, edges] = useScrollEdges<HTMLElement>();
	// Counts runs, so an answer to a run that was closed or replaced is dropped.
	const runs = useRef(0);
	const blocked = !complete || run?.state === 'running' || unavailable;
	const start = async () => {
		if (!onRun || blocked) return;
		const n = ++runs.current;
		setRun({ state: 'running' });
		let next: Run;
		try {
			next = { state: 'done', result: (await onRun(code)) ?? {} };
		} catch (e) {
			next = { state: 'failed', error: `${e}` };
		}
		if (runs.current !== n) return;
		setRun(next);
		if (sandboxUnavailable(next)) markUnavailable();
	};
	useEffect(
		() => () => {
			runs.current += 1;
		},
		[]
	);
	useEffect(() => {
		const el = root.current;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_PX));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const language = (lang || '').trim().split(/\s/)[0].toLowerCase();
	const html = useMemo(() => {
		try {
			return language && hljs.getLanguage(language)
				? hljs.highlight(code, { language, ignoreIllegals: true }).value
				: hljs.highlightAuto(code).value;
		} catch {
			return null;
		}
	}, [code, language]);

	if (language === 'mermaid' && complete) return <Mermaid code={code} id={id} />;

	const lines = code.replace(/\n$/, '').split('\n').length;
	const collapsible = lines > COLLAPSE_LINES;
	const collapsed = collapsible && collapsedChoice;

	return (
		<div ref={root} className="my-2 overflow-hidden rounded-2xl border" data-testid="code-block">
			<div className="bg-muted/50 flex items-center justify-between gap-2 px-3 py-1">
				<span className="text-muted-foreground truncate text-xs">{language || 'text'}</span>
				<div className="flex items-center gap-0.5">
					{collapsible && (
						<HeaderButton
							narrow={narrow}
							label={collapsed ? 'Expand' : 'Collapse'}
							icon={collapsed ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
							aria-expanded={!collapsed}
							onClick={() => setCollapsed((c) => !c)}
						/>
					)}
					<HeaderButton
						narrow={narrow}
						label="Wrap lines"
						icon={<TextWrap aria-hidden />}
						aria-pressed={wrap}
						className="aria-pressed:bg-muted aria-pressed:text-foreground"
						onClick={() => setWrap(!wrap)}
					/>
					{onRun && ['python', 'py'].includes(language) && (
						<HeaderButton
							ref={runButton}
							narrow={narrow}
							label="Run"
							icon={<Play aria-hidden />}
							tip={unavailable ? UNAVAILABLE_STATUS : undefined}
							aria-label={unavailable ? `Run: ${UNAVAILABLE_STATUS.toLowerCase()}` : undefined}
							// aria-disabled, not disabled: a disabled button drops the keyboard focus to the page.
							className={cn(blocked && 'text-foreground-disabled hover:text-foreground-disabled cursor-not-allowed')}
							onClick={() => void start()}
							aria-disabled={blocked}
						/>
					)}
					{onPreview && ['html', 'svg'].includes(language) && (
						<HeaderButton narrow={narrow} label="Preview" icon={<Eye aria-hidden />} onClick={() => onPreview(code)} />
					)}
					<HeaderButton
						narrow={narrow}
						label="Download"
						icon={<Download aria-hidden />}
						onClick={() =>
							saveAs(new Blob([code], { type: 'text/plain;charset=utf-8' }), `code.${extensionOf(language)}`)
						}
					/>
					<HeaderButton
						narrow={narrow}
						label={copied ? 'Copied' : 'Copy'}
						icon={copied ? <Check aria-hidden /> : <Copy aria-hidden />}
						className="copy-code-button"
						onClick={() => void copy(code, 'code')}
					/>
				</div>
			</div>
			<div
				className="scroll-edges"
				data-clipped-start={edges.start || undefined}
				data-clipped-end={edges.end || undefined}
			>
				{/* A figure, the role for a code listing: named, and a tab stop while long lines scroll (A11Y-2). */}
				<figure
					ref={preRef}
					aria-label={`${language || 'text'} code`}
					tabIndex={edges.start || edges.end ? 0 : undefined}
					className={cn(
						'hljs scroll-region overflow-x-auto text-dense leading-relaxed',
						collapsed && 'max-h-[calc(25lh+0.75rem)] overflow-y-hidden'
					)}
				>
					<pre className={cn('px-4 py-3', wrap ? 'break-words whitespace-pre-wrap' : 'w-max min-w-full')}>
						{html !== null ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
					</pre>
				</figure>
			</div>
			{collapsed && (
				<div className="border-t px-2 py-1">
					<Button type="button" variant="ghost" size="xs" onClick={() => setCollapsed(false)}>
						<ChevronDown aria-hidden />
						Show all {lines} lines
					</Button>
				</div>
			)}
			{/* Always mounted, so screen readers announce each status, and only the status, not the whole output. */}
			{onRun && (
				<span className="sr-only" role="status" aria-live="polite">
					{runStatus(run)}
				</span>
			)}
			{run && (
				<RunOutput
					run={run}
					onClose={() => {
						runs.current += 1;
						setRun(null);
						runButton.current?.focus();
					}}
				/>
			)}
		</div>
	);
}
