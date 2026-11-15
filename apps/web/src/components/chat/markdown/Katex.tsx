import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useMemo } from 'react';
import { useScrollEdges } from './useScrollEdges';

/**
 * CNT-3: mathematics inherits the text colour. Black and white written by the
 * model (`\color{black}`) are left to the theme: KaTeX's inline `color:black;`
 * becomes `color:var(--math-black,black);`, which standard.css points at the
 * text colour in dark (and white likewise in light), where they would vanish.
 * Only `color` in a style attribute, never `background-color` or the text.
 */
const themedColours = (html: string) =>
	html.replace(/style="[^"]*"/g, (style) =>
		style.replace(
			/(?<![-\w])color:(black|#000|#000000|white|#fff|#ffffff);/gi,
			(_, colour: string) => `color:var(--math-${/^(black|#0+)$/i.test(colour) ? 'black' : 'white'},${colour});`
		)
	);

/**
 * Ports KatexRenderer.svelte: KaTeX's own HTML (it escapes its input), with errors shown in place rather than thrown.
 * A display equation wider than the column scrolls inside its own box, whose frame shades the edge hiding the rest
 * (`scroll-edges` in standard.css); while it overflows it is a named tab stop the arrow keys scroll (CNT-3, A11Y-2).
 */
export function Katex({ content, displayMode }: { content: string; displayMode: boolean }) {
	const [ref, edges] = useScrollEdges<HTMLSpanElement>();
	const html = useMemo(() => {
		try {
			return themedColours(
				katex.renderToString(content, { displayMode, throwOnError: false, output: 'htmlAndMathml', trust: false })
			);
		} catch {
			return null;
		}
	}, [content, displayMode]);
	if (html === null) return <code>{content}</code>;
	// A display equation is a figure, named, and a tab stop while it scrolls (A11Y-2); inline math is a span.
	const Tag = displayMode ? 'figure' : 'span';
	const math = (
		<Tag
			ref={displayMode ? ref : undefined}
			aria-label={displayMode ? 'Equation' : undefined}
			tabIndex={edges.start || edges.end ? 0 : undefined}
			data-testid={displayMode ? 'display-equation' : undefined}
			className={displayMode ? 'scroll-region overflow-x-auto py-1' : undefined}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
	if (!displayMode) return math;
	return (
		<span
			className="scroll-edges block"
			data-clipped-start={edges.start || undefined}
			data-clipped-end={edges.end || undefined}
		>
			{math}
		</span>
	);
}
