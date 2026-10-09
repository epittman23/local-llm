import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useMemo } from 'react';

/** Ports KatexRenderer.svelte: KaTeX's own HTML (it escapes its input), with errors shown in place rather than thrown. */
export function Katex({ content, displayMode }: { content: string; displayMode: boolean }) {
	const html = useMemo(() => {
		try {
			return katex.renderToString(content, { displayMode, throwOnError: false, output: 'htmlAndMathml', trust: false });
		} catch {
			return null;
		}
	}, [content, displayMode]);
	if (html === null) return <code>{content}</code>;
	return (
		<span
			className={displayMode ? 'block overflow-x-auto py-1' : undefined}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
