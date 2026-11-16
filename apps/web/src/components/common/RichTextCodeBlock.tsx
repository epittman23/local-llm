import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { NodeViewContent, type NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { common, createLowlight } from 'lowlight';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCopy } from '@/lib/ui/useCopy';

const lowlight = createLowlight(common);

/** The name a fence gave its language, as the header shows it; "text" when it gave none. */
export const codeLanguageLabel = (language: unknown) =>
	(typeof language === 'string' && language.trim().split(/\s/)[0]) || 'text';

/**
 * CNT-2 in the note editor (#935): a code block reads as the chat's do, with
 * its language over it, a Copy button, and the same syntax colours (lowlight
 * gives highlight.js's token classes, which standard.css colours from the
 * tokens). The header is the view's own; the stored HTML and Markdown stay
 * `<pre><code class="language-…">` and a fenced block.
 */
export function CodeBlockView({ node }: NodeViewProps) {
	const { copied, copy } = useCopy();
	const label = codeLanguageLabel(node.attrs.language);
	return (
		<NodeViewWrapper data-slot="note-code-block" className="my-2 overflow-hidden rounded-lg border">
			<div contentEditable={false} className="bg-surface-2 flex items-center justify-between gap-2 py-0.5 ps-3 pe-1">
				<span className="text-foreground-muted truncate text-caption">{label}</span>
				<Button
					type="button"
					variant="ghost"
					size="xs"
					onMouseDown={(e) => e.preventDefault()}
					// The block's text ends in the newline before its closing fence; the code does not.
					onClick={() => void copy(node.textContent.replace(/\n$/, ''), 'code')}
				>
					{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
					{copied ? 'Copied' : 'Copy'}
				</Button>
			</div>
			<pre className="hljs">
				<NodeViewContent<'code'> as="code" className={`language-${label}`} />
			</pre>
		</NodeViewWrapper>
	);
}

export const RichTextCodeBlock = CodeBlockLowlight.extend({
	addNodeView() {
		return ReactNodeViewRenderer(CodeBlockView);
	}
}).configure({ lowlight });
