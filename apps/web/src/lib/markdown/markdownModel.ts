import { csvCell } from '@/lib/utils/csv';
import { unescapeHtml } from './content';
import { type MdToken, lexChat } from './lexer';

// The rendering rules behind components/chat/markdown (ported from
// chat/Messages/Markdown/*.svelte), kept apart from React so they can be
// unit-tested.

const GROUPABLE = new Set(['tool_calls', 'reasoning', 'code_interpreter']);
export type DetailGroup = { type: 'detail_group'; items: MdToken[] };

/** Consecutive reasoning / tool-call / code-interpreter blocks are shown as one group. */
export function groupDetails(tokens: MdToken[]): (MdToken | DetailGroup)[] {
	const out: (MdToken | DetailGroup)[] = [];
	let group: MdToken[] = [];
	const flush = () => {
		if (group.length > 1) out.push({ type: 'detail_group', items: group });
		else if (group.length === 1) out.push(group[0]);
		group = [];
	};
	for (const t of tokens) {
		if (t.type === 'details' && GROUPABLE.has(t.attributes?.type ?? '')) group.push(t);
		else {
			flush();
			out.push(t);
		}
	}
	flush();
	return out;
}

/** A details block's body without its <summary>, entities decoded. */
export const detailText = (t: MdToken) =>
	unescapeHtml(t.text ?? '')
		.replace(/<summary>.*?<\/summary>/gi, '')
		.trim();

/** The label on a details block (Collapsible.svelte's title rules). */
export function detailTitle(
	attributes: Record<string, string> | undefined,
	summary: string,
	messageDone: boolean
): string {
	const done = attributes?.done === 'true' || messageDone;
	if (attributes?.type === 'reasoning') {
		const d = Number(attributes.duration);
		if (done && attributes.duration && !Number.isNaN(d)) {
			if (d < 1) return 'Thought for less than a second';
			if (d < 60) return `Thought for ${d} seconds`;
			const m = Math.round(d / 60);
			return `Thought for ${m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : `${Math.round(m / 60)} hours`}`;
		}
		return done ? 'Thought' : 'Thinking...';
	}
	if (attributes?.type === 'code_interpreter') return done ? 'Analyzed' : 'Analyzing...';
	return summary;
}

export type AlertType = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION';

/** A GitHub-style `> [!NOTE]` blockquote, re-tokenized without its marker; or null. */
export function alertOf(token: MdToken): { type: AlertType; tokens: MdToken[] } | null {
	const re = /^(?:\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\])\s*?\n*/;
	const m = (token.text ?? '').match(re);
	return m ? { type: m[1] as AlertType, tokens: lexChat(token.text.replace(re, '')) } : null;
}

/** A Markdown table as CSV (formula cells neutralised, see lib/utils/csv). */
export function tableToCsv(token: MdToken): string {
	const header = token.header.map((h: MdToken) => csvCell(unescapeHtml(h.text)));
	const rows = token.rows.map((row: MdToken[]) =>
		row.map((cell) => csvCell(unescapeHtml((cell.tokens ?? []).map((t: MdToken) => t.text).join(''))))
	);
	return [header, ...rows].map((r) => r.join(',')).join('\n');
}

export type HtmlKind =
	| { kind: 'video' | 'audio'; src: string }
	| { kind: 'youtube'; id: string }
	| { kind: 'iframe'; src: string }
	| { kind: 'status'; title: string; done: boolean }
	| { kind: 'htmlFile'; fileId: string }
	| { kind: 'br' }
	| { kind: 'text'; text: string };

/**
 * What an HTML token in a response becomes (HTMLToken.svelte). Only these
 * shapes are rendered as elements; anything else is shown as its text, never
 * injected.
 */
export function htmlKind(text: string): HtmlKind {
	const media = text.match(/<(video|audio)[^>]*>([\s\S]*?)<\/\1>/);
	if (media)
		return media[2].trim()
			? { kind: media[1] as 'video' | 'audio', src: media[2].trim().replaceAll('&amp;', '&') }
			: { kind: 'text', text };
	const yt = text.match(
		/<iframe\s+[^>]*src="https:\/\/www\.youtube\.com\/embed\/([a-zA-Z0-9_-]{11})(?:\?[^"]*)?"[^>]*><\/iframe>/
	);
	if (yt) return { kind: 'youtube', id: yt[1] };
	if (text.includes('<iframe')) {
		const m = text.match(/<iframe\s+[^>]*src="([^"]+)"[^>]*><\/iframe>/);
		return m ? { kind: 'iframe', src: m[1] } : { kind: 'text', text };
	}
	if (text.includes('<status')) {
		const m = text.match(/<status title="([^"]+)" done="(true|false)" ?\/?>/);
		return m ? { kind: 'status', title: m[1], done: m[2] === 'true' } : { kind: 'text', text };
	}
	const file = text.match(/<file type="html" id="([^"]+)"/);
	if (file) return { kind: 'htmlFile', fileId: file[1] };
	if (/^<br\s*\/?>$/i.test(text.trim())) return { kind: 'br' };
	return { kind: 'text', text };
}

/** A source's label: a URL shows its domain; long labels are shortened in the middle. */
export function sourceLabel(title: string | undefined): string {
	if (!title) return 'N/A';
	let t = unescapeHtml(title);
	if (t.startsWith('http')) {
		t = t.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
		if (t.startsWith('www.')) t = t.slice(4);
	}
	return t.length > 30 ? `${t.slice(0, 15)}...${t.slice(-10)}` : t;
}

/** Same-origin links into the app that should navigate in place. */
export function inAppPath(href: string, origin = window.location.origin): string | null {
	try {
		const url = new URL(href, origin);
		if (url.origin === origin && /^\/(notes|c|channels)\//.test(url.pathname))
			return url.pathname + url.search + url.hash;
	} catch {
		/* not a URL */
	}
	return null;
}
