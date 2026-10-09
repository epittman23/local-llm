import { replaceOutsideCode } from '@/lib/markdown/content';
import type { Source } from './history';

// How a reply's retrieved documents become its numbered sources
// (Citations.svelte and ContentRenderer.svelte). A `[n]` in the text is the
// n-th citation below; the inline chip is labelled from `sourceIds`.

export type Citation = {
	id: string;
	source: Record<string, any>;
	document: string[];
	metadata: Record<string, any>[];
	distances: number[];
};

/** Documents grouped by where they came from (a URL, a file, a tool), in first-seen order. */
export function citationsOf(sources: Source[] | undefined): Citation[] {
	const acc: Citation[] = [];
	for (const source of sources ?? []) {
		if (!source || Object.keys(source).length === 0) continue;
		(source.document ?? []).forEach((document, i) => {
			const metadata = (source.metadata?.[i] ?? undefined) as Record<string, any> | undefined;
			const distance = (source.distances as number[] | undefined)?.[i];
			const id = String(metadata?.source ?? source.source?.id ?? 'N/A');
			let s: Record<string, any> = { ...(source.source ?? {}) };
			if (metadata?.name) s = { ...s, name: metadata.name };
			if (id.startsWith('http://') || id.startsWith('https://')) s = { ...s, name: id, url: id };
			const existing = acc.find((c) => c.id === id);
			if (existing) {
				existing.document.push(document);
				if (metadata) existing.metadata.push(metadata);
				if (distance !== undefined) existing.distances.push(distance);
			} else
				acc.push({
					id,
					source: s,
					document: [document],
					metadata: metadata ? [metadata] : [],
					distances: distance !== undefined ? [distance] : []
				});
		});
	}
	return acc;
}

/** The labels inline citation chips show, deduplicated; "N/A" for a model without citations. */
export function sourceIdsOf(sources: Source[] | undefined, citationsEnabled = true): string[] {
	const out: string[] = [];
	for (const source of sources ?? []) {
		(source.document ?? []).forEach((_, i) => {
			if (!citationsEnabled) {
				out.push('N/A');
				return;
			}
			const metadata = source.metadata?.[i] as Record<string, any> | undefined;
			const id = String(metadata?.source ?? 'N/A');
			if (metadata?.name) out.push(String(metadata.name));
			else if (id.startsWith('http://') || id.startsWith('https://')) out.push(id);
			else out.push(String(source.source?.name ?? id));
		});
	}
	return [...new Set(out)];
}

/** A model with citations turned off: `[1]` markers removed from its text. */
export const stripCitations = (content: string) =>
	replaceOutsideCode(content, (s) => s.replace(/\s*(\[(?:\d+(?:#[^,\]\s]+)?(?:,\s*\d+(?:#[^,\]\s]+)?)*)\])+/g, ''));

/** "3" or "3#chunk" (or a number) as a 0-based citation index. */
export const citationIndex = (id: string | number) =>
	(typeof id === 'number' ? id : parseInt(String(id).split('#')[0], 10)) - 1;
