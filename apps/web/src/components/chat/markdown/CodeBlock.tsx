import hljs from 'highlight.js/lib/common';
import { Check, ChevronDown, ChevronUp, Copy, Eye, Play } from 'lucide-react';
import 'highlight.js/styles/github-dark.min.css';
import { useEffect, useMemo, useState } from 'react';
import { cn, copyToClipboard } from '@/lib/utils';

const COLLAPSED_LINES = 5;

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

/**
 * Ports chat/Messages/CodeBlock.svelte: a fenced block with its language,
 * highlighted by highlight.js (common languages), Copy, Collapse (defaults to
 * the user's "collapse code blocks" setting), Preview for HTML and SVG when
 * the caller offers one (artifacts), Run when the caller provides a runner,
 * and mermaid diagrams drawn once the fence is complete.
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
	onRun?: (code: string) => void;
}) {
	const [collapsed, setCollapsed] = useState(defaultCollapsed);
	const [copied, setCopied] = useState(false);
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
						<button type="button" className={bar} onClick={() => onRun(code)}>
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
		</div>
	);
}
