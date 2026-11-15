/**
 * Where a tool's or function's code came from when it was not written in the
 * editor (S4-D4): a clone of another one, a link, or a file. The list pages put
 * it in the stash they leave for the create page (`sessionStorage.tool` /
 * `.function`) as `source`.
 */
export type CodeSource = { kind: 'clone' | 'link' | 'file'; from: string };

const KINDS = new Set(['clone', 'link', 'file']);

/** The stash's `source`, or null when it has none (an older stash, or a list page that does not say). */
export function readCodeSource(stash: unknown): CodeSource | null {
	const source = (stash as { source?: unknown } | null)?.source as Partial<CodeSource> | undefined;
	if (!source || typeof source !== 'object' || !KINDS.has(String(source.kind))) return null;
	const from = typeof source.from === 'string' ? source.from.trim().slice(0, 300) : '';
	return from ? { kind: source.kind as CodeSource['kind'], from } : null;
}

/**
 * The one sentence asked before code from elsewhere is created or imported
 * (S4-D4, WRD-1): where it came from, and why that matters. Code written in
 * the editor is not asked about.
 */
export function acknowledgement(
	what: 'tool' | 'function',
	source: CodeSource | null,
	verb: 'create' | 'import' = 'create'
): string {
	const why = `${what}s run their code on this server: ${verb} it only if you trust`;
	if (!source) return `The code was not written here, and ${why} its source.`;
	if (source.kind === 'clone') return `The code is copied from "${source.from}", and ${why} that code.`;
	if (source.kind === 'file') return `The code comes from the file ${source.from}, and ${why} that source.`;
	return `The code comes from ${source.from}, and ${why} that source.`;
}
