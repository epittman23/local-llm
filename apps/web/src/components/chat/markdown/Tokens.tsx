import saveAs from 'file-saver';
import { ArrowRightCircle, ChevronDown, ChevronUp, Copy, Download, Info, Lightbulb, Star, Zap } from 'lucide-react';
import { Fragment, type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Tip } from '@/components/common/Tip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { resolveChatMessageToolCall } from '@/lib/apis/chats';
import { WEBUI_BASE_URL } from '@/lib/constants';
import { unescapeHtml } from '@/lib/markdown/content';
import { type MdToken, lexChat } from '@/lib/markdown/lexer';
import { type AlertType, type DetailGroup, alertOf, detailText, detailTitle, groupDetails, htmlKind, inAppPath, sourceLabel, tableToCsv } from '@/lib/markdown/markdownModel';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn, copyToClipboard } from '@/lib/utils';
import { CodeBlock } from './CodeBlock';
import { Katex } from './Katex';
import { useMarkdownEnv } from './MarkdownContext';
import { ToolCallDisplay } from './ToolCallDisplay';

// Ports chat/Messages/Markdown/MarkdownTokens.svelte and
// MarkdownInlineTokens.svelte: every token type the chat lexer produces,
// rendered as React elements. No token is turned into HTML by string: raw
// HTML in a response is either one of the recognised embeds (htmlKind) or
// shown as text, and the only innerHTML is KaTeX's, highlight.js's and
// mermaid's own output.

const ALERTS: Record<AlertType, { border: string; text: string; icon: typeof Info }> = {
	NOTE: { border: 'border-sky-500', text: 'text-sky-500', icon: Info },
	TIP: { border: 'border-emerald-500', text: 'text-emerald-500', icon: Lightbulb },
	IMPORTANT: { border: 'border-purple-500', text: 'text-purple-500', icon: Star },
	WARNING: { border: 'border-yellow-500', text: 'text-yellow-500', icon: ArrowRightCircle },
	CAUTION: { border: 'border-rose-500', text: 'text-rose-500', icon: Zap }
};

const iframeHeight = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
	try {
		const doc = e.currentTarget.contentWindow?.document;
		if (doc) e.currentTarget.style.height = `${doc.body.scrollHeight + 20}px`;
	} catch {
		/* cross-origin: keep the default height */
	}
};

function HtmlToken({ text }: { text: string }) {
	const k = htmlKind(text);
	switch (k.kind) {
		case 'video':
			return <video src={k.src} controls className="my-2 max-w-full rounded-lg" />;
		case 'audio':
			return <audio src={k.src} controls className="my-2" />;
		case 'youtube':
			return (
				<iframe
					src={`https://www.youtube.com/embed/${k.id}`}
					title="YouTube video player"
					className="my-2 aspect-video w-full rounded-lg"
					allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
					referrerPolicy="strict-origin-when-cross-origin"
					allowFullScreen
				/>
			);
		case 'iframe':
			return <iframe src={k.src} title="Embedded content" sandbox="" className="my-2 w-full rounded-lg" onLoad={iframeHeight} />;
		case 'status':
			return <div className={cn('text-muted-foreground my-1 line-clamp-1 text-sm', !k.done && 'animate-pulse')}>{k.title}</div>;
		case 'htmlFile':
			return <iframe src={`${WEBUI_BASE_URL}/api/v1/files/${k.fileId}/content/html`} title="Content" sandbox="allow-scripts allow-downloads allow-forms" className="my-2 w-full rounded-lg" onLoad={iframeHeight} />;
		case 'br':
			return <br />;
		default:
			return <>{k.text}</>;
	}
}

function SourceChip({ identifier, title }: { identifier: string | number; title: string | undefined }) {
	const env = useMarkdownEnv();
	if (!title) return null;
	return (
		<button
			type="button"
			aria-label={`View source: ${sourceLabel(title)}`}
			className="bg-muted text-foreground/80 hover:text-foreground mx-0.5 inline-flex translate-y-[2px] rounded-xl px-2 py-0.5 text-[0.625rem] transition"
			onClick={() => env.onSourceClick?.(identifier)}
		>
			<span className="line-clamp-1">{sourceLabel(title)}</span>
		</button>
	);
}

function Citation({ token }: { token: MdToken }) {
	const env = useMarkdownEnv();
	const ids: number[] = token.ids ?? [];
	const identifiers: (string | number)[] = token.citationIdentifiers ?? ids;
	if (!env.sourceIds.length) return <>{token.raw}</>;
	if (ids.length === 1) return <SourceChip identifier={identifiers[0]} title={env.sourceIds[ids[0] - 1]} />;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button type="button" className="bg-muted mx-0.5 inline-flex translate-y-[2px] rounded-xl px-2 py-0.5 text-[0.625rem]">
					{sourceLabel(env.sourceIds[ids[0] - 1])} +{ids.length - 1}
				</button>
			</PopoverTrigger>
			<PopoverContent className="flex w-auto max-w-sm flex-wrap gap-1 p-2">
				{identifiers.map((ident, i) => (
					<SourceChip key={i} identifier={ident} title={env.sourceIds[(typeof ident === 'string' ? parseInt(ident.split('#')[0]) : ident) - 1]} />
				))}
			</PopoverContent>
		</Popover>
	);
}

function Link({ token, children }: { token: MdToken; children: ReactNode }) {
	const navigate = useNavigate();
	return (
		<a
			href={token.href}
			target="_blank"
			rel="nofollow noopener noreferrer"
			title={token.title ?? undefined}
			className="underline"
			onClick={(e) => {
				const path = inAppPath(token.href);
				if (path) {
					e.preventDefault();
					navigate(path);
				}
			}}
		>
			{children}
		</a>
	);
}

function Text({ token }: { token: MdToken }) {
	const env = useMarkdownEnv();
	const raw = unescapeHtml(token.raw ?? token.text ?? '');
	if (env.done || !env.fadeStreamingText) return <>{raw}</>;
	return <span className="animate-in fade-in duration-300">{raw}</span>;
}

export function Inline({ tokens }: { tokens: MdToken[] }) {
	return (
		<>
			{tokens.map((t, i) => {
				switch (t.type) {
					case 'escape':
						return <Fragment key={i}>{unescapeHtml(t.text)}</Fragment>;
					case 'html':
						return <HtmlToken key={i} text={t.text ?? t.raw} />;
					case 'link':
						return (
							<Link key={i} token={t}>
								{t.tokens ? <Inline tokens={t.tokens} /> : t.text}
							</Link>
						);
					case 'image':
						return <img key={i} src={t.href} alt={t.text} className="my-1 max-h-96 rounded-lg" loading="lazy" />;
					case 'strong':
						return (
							<strong key={i}>
								<Inline tokens={t.tokens ?? []} />
							</strong>
						);
					case 'em':
						return (
							<em key={i}>
								<Inline tokens={t.tokens ?? []} />
							</em>
						);
					case 'del':
						return (
							<del key={i}>
								<Inline tokens={t.tokens ?? []} />
							</del>
						);
					case 'underline':
						return (
							<u key={i}>
								<Inline tokens={t.tokens ?? []} />
							</u>
						);
					case 'codespan':
						return (
							<code key={i} className="bg-muted mx-0.5 rounded-md px-1 py-0.5 font-mono text-[0.85em]">
								{unescapeHtml(t.text)}
							</code>
						);
					case 'br':
						return <br key={i} />;
					case 'inlineKatex':
						return t.text ? <Katex key={i} content={t.text} displayMode={t.displayMode ?? false} /> : null;
					case 'mention':
						return (
							<span key={i} className="rounded bg-blue-500/10 px-0.5 text-blue-600 dark:text-blue-400" data-type="mention">
								{t.triggerChar}
								{t.label}
							</span>
						);
					case 'footnote':
						return (
							<sup key={i} className="text-muted-foreground">
								[{t.text}]
							</sup>
						);
					case 'citation':
						return <Citation key={i} token={t} />;
					case 'text':
						return t.tokens ? <Inline key={i} tokens={t.tokens} /> : <Text key={i} token={t} />;
					default:
						return <Fragment key={i}>{t.raw}</Fragment>;
				}
			})}
		</>
	);
}

function Collapsible({ title, attributes, defaultOpen, disabled, children }: { title: string; attributes?: Record<string, string>; defaultOpen: boolean; disabled?: boolean; children?: ReactNode }) {
	const env = useMarkdownEnv();
	const [open, setOpen] = useState(defaultOpen);
	const pending = !(attributes?.done === 'true' || env.done) && ['reasoning', 'code_interpreter'].includes(attributes?.type ?? '');
	return (
		<div className="my-1 w-full" data-testid="details">
			<button type="button" disabled={disabled} className={cn('text-muted-foreground hover:text-foreground flex items-center gap-1 py-0.5 text-[0.9375rem]', pending && 'animate-pulse')} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
				{detailTitle(attributes, title, env.done)}
				{!disabled && (open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />)}
			</button>
			{open && !disabled && <div className="border-muted text-muted-foreground mt-1 border-l-2 pl-3">{children}</div>}
		</div>
	);
}

function Details({ token }: { token: MdToken }) {
	const env = useMarkdownEnv();
	const token_ = useAuthStore((s) => s.token) ?? '';
	const [resolving, setResolving] = useState(false);
	const attributes: Record<string, string> = token.attributes ?? {};
	const text = detailText(token);
	if (attributes.type === 'tool_calls') {
		const resolve = async (approved: boolean) => {
			if (!env.chatId || !env.messageId || !attributes.id || resolving) return;
			setResolving(true);
			try {
				env.onToolCallResolved?.(await resolveChatMessageToolCall(token_, env.chatId, env.messageId, attributes.id, approved ? 'approve' : 'reject'));
			} catch (e) {
				toast.error(String(e));
			}
			setResolving(false);
		};
		return <ToolCallDisplay attributes={attributes} resultContent={text} messageDone={env.done} resolvable={env.resolvable} resolving={resolving} onResolve={resolve} defaultOpen={env.expandDetails} />;
	}
	if (!text) return <Collapsible title={token.summary} attributes={attributes} defaultOpen={false} disabled />;
	return (
		<Collapsible title={token.summary} attributes={attributes} defaultOpen={env.expandDetails}>
			<Blocks tokens={lexChat(unescapeHtml(token.text))} />
		</Collapsible>
	);
}

function DetailGroupView({ group }: { group: DetailGroup }) {
	const env = useMarkdownEnv();
	const [open, setOpen] = useState(env.expandDetails);
	const running = !env.done;
	return (
		<div className="my-1" data-testid="details-group">
			<button type="button" className={cn('text-muted-foreground hover:text-foreground flex items-center gap-1 py-0.5 text-[0.9375rem]', running && 'animate-pulse')} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
				{running ? 'Working...' : `${group.items.length} steps`}
				{open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
			</button>
			{open && (
				<div className="border-muted mt-1 border-l-2 pl-3">
					{group.items.map((t, i) => (
						<Details key={i} token={t} />
					))}
				</div>
			)}
		</div>
	);
}

function Table({ token, index }: { token: MdToken; index: number }) {
	const env = useMarkdownEnv();
	return (
		<div className="group relative my-2 w-full">
			<div className="max-w-full overflow-x-auto rounded-lg border">
				<table className="w-full text-left text-sm">
					<thead className="bg-muted/50 text-xs">
						<tr>
							{token.header.map((h: MdToken, i: number) => (
								<th key={i} className="px-3 py-1.5 font-medium" style={token.align[i] ? { textAlign: token.align[i] } : undefined}>
									<Inline tokens={h.tokens} />
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{token.rows.map((row: MdToken[], r: number) => (
							<tr key={r} className="border-t">
								{row.map((cell, c) => (
									<td key={c} className="px-3 py-1.5" style={token.align[c] ? { textAlign: token.align[c] } : undefined}>
										<Inline tokens={cell.tokens} />
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<div className="absolute top-1 right-1 hidden gap-0.5 group-hover:flex">
				<Tip content="Copy">
					<button type="button" aria-label="Copy table" className="bg-background hover:bg-muted rounded p-1" onClick={() => void copyToClipboard(token.raw.trim())}>
						<Copy className="size-3.5" />
					</button>
				</Tip>
				<Tip content="Export to CSV">
					<button
						type="button"
						aria-label="Export to CSV"
						className="bg-background hover:bg-muted rounded p-1"
						onClick={() => saveAs(new Blob([`﻿${tableToCsv(token)}`], { type: 'text/csv;charset=UTF-8' }), `table-${env.id}-${index}.csv`)}
					>
						<Download className="size-3.5" />
					</button>
				</Tip>
			</div>
		</div>
	);
}

function ListItems({ token }: { token: MdToken }) {
	return (
		<>
			{token.items.map((item: MdToken, i: number) => (
				<li key={i} className={item.task ? 'flex list-none gap-2' : undefined}>
					{item.task && <input type="checkbox" checked={item.checked} readOnly className="mt-1" aria-label={item.checked ? 'Done' : 'Not done'} />}
					<div className="min-w-0">
						<Blocks tokens={item.tokens} top={token.loose} />
					</div>
				</li>
			))}
		</>
	);
}

export function Blocks({ tokens, top = true, paragraphSpan = false }: { tokens: MdToken[]; top?: boolean; paragraphSpan?: boolean }) {
	const env = useMarkdownEnv();
	return (
		<>
			{groupDetails(tokens).map((t, i) => {
				if (t.type === 'detail_group') return <DetailGroupView key={i} group={t as DetailGroup} />;
				const token = t as MdToken;
				switch (token.type) {
					case 'hr':
						return <hr key={i} className="my-4" />;
					case 'heading': {
						const H = `h${token.depth}` as 'h1';
						return (
							<H key={i} dir="auto" className={cn('mt-4 mb-2 font-semibold', ['text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm', 'text-sm'][token.depth - 1])}>
								<Inline tokens={token.tokens} />
							</H>
						);
					}
					case 'code':
						return token.raw.includes('```') || token.raw.includes('~~~') ? (
							<CodeBlock
								key={i}
								id={`${env.id}-${i}`}
								lang={token.lang ?? ''}
								code={token.text ?? ''}
								complete={/(```|~~~)\s*$/.test(token.raw)}
								defaultCollapsed={env.collapseCodeBlocks}
								onPreview={env.onPreview}
								onRun={env.onRun}
							/>
						) : (
							<pre key={i} className="bg-muted overflow-x-auto rounded-lg p-3 text-sm">
								{token.text}
							</pre>
						);
					case 'table':
						return <Table key={i} token={token} index={i} />;
					case 'blockquote': {
						const alert = alertOf(token);
						if (alert) {
							const { border, text, icon: Icon } = ALERTS[alert.type];
							return (
								<div key={i} className={cn('my-2 border-l-4 pl-3', border)}>
									<div className={cn('flex items-center gap-1 text-sm font-medium', text)}>
										<Icon className="size-4" />
										{alert.type[0] + alert.type.slice(1).toLowerCase()}
									</div>
									<Blocks tokens={alert.tokens} />
								</div>
							);
						}
						return (
							<blockquote key={i} dir="auto" className="text-muted-foreground my-2 border-l-4 pl-3">
								<Blocks tokens={token.tokens} />
							</blockquote>
						);
					}
					case 'list':
						return token.ordered ? (
							<ol key={i} start={token.start || 1} dir="auto" className="my-2 list-decimal pl-6">
								<ListItems token={token} />
							</ol>
						) : (
							<ul key={i} dir="auto" className="my-2 list-disc pl-6">
								<ListItems token={token} />
							</ul>
						);
					case 'details':
						return <Details key={i} token={token} />;
					case 'html':
						return <HtmlToken key={i} text={token.text ?? token.raw} />;
					case 'paragraph':
						return paragraphSpan ? (
							<span key={i} dir="auto">
								<Inline tokens={token.tokens ?? []} />
							</span>
						) : (
							<p key={i} dir="auto" className="my-2 leading-relaxed">
								<Inline tokens={token.tokens ?? []} />
							</p>
						);
					case 'text':
						return top ? (
							<p key={i} dir="auto" className="my-1">
								{token.tokens ? <Inline tokens={token.tokens} /> : unescapeHtml(token.text)}
							</p>
						) : token.tokens ? (
							<Inline key={i} tokens={token.tokens} />
						) : (
							<Fragment key={i}>{unescapeHtml(token.text)}</Fragment>
						);
					case 'blockKatex':
					case 'inlineKatex':
						return token.text ? <Katex key={i} content={token.text} displayMode={token.displayMode ?? false} /> : null;
					case 'colonFence':
						return (
							<div key={i} className="bg-muted/30 my-2 rounded-xl border p-3" data-fence={token.fenceType}>
								<Blocks tokens={token.tokens ?? []} />
							</div>
						);
					case 'space':
						return null;
					default:
						return <Fragment key={i}>{token.raw}</Fragment>;
				}
			})}
		</>
	);
}
