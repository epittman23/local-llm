import hljs from 'highlight.js/lib/common';
import latex from 'highlight.js/lib/languages/latex';
import { Check, ChevronDown, ChevronUp, Copy, Eye, Loader2, Play, X } from 'lucide-react';
import 'highlight.js/styles/github-dark.min.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SandboxOutputs } from '@/components/chat/SandboxOutputs';
import type { CodeRunResult } from '@/lib/apis/utils';
import { cn, copyToClipboard } from '@/lib/utils';

const COLLAPSED_LINES = 5;

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

/** One stream of a run's output, in a scrollable block; nothing when it is empty. */
function Stream({ label, text, tone }: { label: string; text?: string; tone?: 'error' }) {
	if (!text) return null;
	return (
		<div>
			<div className="text-muted-foreground mb-0.5 text-[0.6875rem] uppercase">{label}</div>
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

/**
 * What a Run left: its stdout, stderr and result, an error (the endpoint's refusal, or the sandbox's own failure),
 * and the files it put in /workspace/outputs, shown as a reply's sandbox outputs are (SandboxOutputs).
 */
function RunOutput({ run, onClose }: { run: Run; onClose: () => void }) {
	return (
		<div className="flex flex-col gap-2 border-t px-4 py-3" data-testid="code-run-output" aria-live="polite">
			<div className="text-muted-foreground flex items-center justify-between text-xs">
				<span>
					{run.state === 'running'
						? 'Running...'
						: run.state === 'failed' || run.result.error
							? 'Run failed'
							: run.result.timed_out
								? 'Stopped at its time limit'
								: 'Output'}
				</span>
				{run.state !== 'running' && (
					<button type="button" className="hover:bg-muted rounded-md p-0.5" onClick={onClose} aria-label="Close output">
						<X className="size-3" />
					</button>
				)}
			</div>
			{run.state === 'running' && <Loader2 className="text-muted-foreground size-4 animate-spin" />}
			{run.state === 'failed' && <Stream label="Error" text={run.error} tone="error" />}
			{run.state === 'done' && (
				<>
					<Stream label="Error" text={run.result.error} tone="error" />
					<Stream label="Output" text={run.result.stdout} />
					<Stream label="Errors" text={run.result.stderr} tone="error" />
					<Stream label="Result" text={run.result.result} />
					{!run.result.error &&
						!run.result.stdout &&
						!run.result.stderr &&
						!run.result.result &&
						!run.result.files?.length && <div className="text-muted-foreground text-xs">No output</div>}
					<SandboxOutputs files={run.result.files} />
				</>
			)}
		</div>
	);
}

/**
 * Ports chat/Messages/CodeBlock.svelte: a fenced block with its language,
 * highlighted by highlight.js (common languages), Copy, Collapse (defaults to
 * the user's "collapse code blocks" setting), Preview for HTML and SVG when
 * the caller offers one (artifacts), Run for Python when the caller provides
 * a runner (its output and outputs shown under the block until closed; a
 * second press while it runs does nothing), and mermaid diagrams drawn once
 * the fence is complete.
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
	const [collapsed, setCollapsed] = useState(defaultCollapsed);
	const [copied, setCopied] = useState(false);
	const [run, setRun] = useState<Run | null>(null);
	// Counts runs, so an answer to a run that was closed or replaced is dropped.
	const runs = useRef(0);
	const start = async () => {
		if (!onRun || run?.state === 'running') return;
		const n = ++runs.current;
		setRun({ state: 'running' });
		try {
			const result = (await onRun(code)) ?? {};
			if (runs.current === n) setRun({ state: 'done', result });
		} catch (e) {
			if (runs.current === n) setRun({ state: 'failed', error: `${e}` });
		}
	};
	useEffect(
		() => () => {
			runs.current += 1;
		},
		[]
	);
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

	const lines = code.split('\n');
	const hidden = collapsed ? Math.max(0, lines.length - COLLAPSED_LINES) : 0;
	const bar =
		'text-muted-foreground hover:bg-muted flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs transition';

	return (
		<div className="my-2 overflow-hidden rounded-2xl border" data-testid="code-block">
			<div className="bg-muted/50 flex items-center justify-between px-3 py-1">
				<span className="text-muted-foreground text-xs">{language || 'text'}</span>
				<div className="flex items-center gap-0.5">
					<button
						type="button"
						className={bar}
						onClick={() => setCollapsed((c) => !c)}
						aria-label={collapsed ? 'Expand' : 'Collapse'}
					>
						{collapsed ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
						{collapsed ? 'Expand' : 'Collapse'}
					</button>
					{onRun && ['python', 'py'].includes(language) && (
						<button
							type="button"
							className={bar}
							onClick={() => void start()}
							disabled={!complete || run?.state === 'running'}
						>
							<Play className="size-3" /> Run
						</button>
					)}
					{onPreview && ['html', 'svg'].includes(language) && (
						<button type="button" className={bar} onClick={() => onPreview(code)}>
							<Eye className="size-3" /> Preview
						</button>
					)}
					<button
						type="button"
						className={cn(bar, 'copy-code-button')}
						onClick={async () => {
							if (await copyToClipboard(code)) {
								setCopied(true);
								setTimeout(() => setCopied(false), 1500);
							}
						}}
					>
						{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
						{copied ? 'Copied' : 'Copy'}
					</button>
				</div>
			</div>
			<pre
				className={cn(
					'hljs overflow-x-auto px-4 py-3 text-[0.8125rem] leading-relaxed',
					collapsed && 'max-h-40 overflow-hidden'
				)}
			>
				{html !== null ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
			</pre>
			{hidden > 0 && <div className="text-muted-foreground border-t px-4 py-1 text-xs">{hidden} hidden lines</div>}
			{run && (
				<RunOutput
					run={run}
					onClose={() => {
						runs.current += 1;
						setRun(null);
					}}
				/>
			)}
		</div>
	);
}
