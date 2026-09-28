import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

/**
 * What DOMPurify must also remove from text other users write. Its defaults
 * strip script but keep `<style>` (which restyles the whole page), forms and
 * inputs (a fake sign-in that posts elsewhere), and `style`/`class`
 * attributes (a full-screen overlay, written inline or with the app's own
 * utility classes). docs/code-review.md H1.
 */
export const SAFE_MARKDOWN_PURIFY = {
	FORBID_TAGS: ['style', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'frameset', 'object', 'embed', 'dialog'],
	FORBID_ATTR: ['style', 'class', 'id']
};

/** Markdown from another user, as HTML that can only format text: no styles, forms, embeds or layout. */
export const safeMarkdownHtml = (text: string) => DOMPurify.sanitize(marked.parse(text ?? '', { async: false }) as string, SAFE_MARKDOWN_PURIFY);

/**
 * Renders markdown from a source the app doesn't control (a plugin's valve
 * descriptions, a model's or tool's description) through `marked` then
 * DOMPurify with SAFE_MARKDOWN_PURIFY. Messages go through the chat renderer
 * instead (components/chat/markdown), which shows raw HTML as text.
 */
export function SafeMarkdown({ text, className }: { text: string; className?: string }) {
	const html = useMemo(() => safeMarkdownHtml(text), [text]);
	return <div className={cn('max-w-full text-xs [&_a]:underline [&_code]:font-mono', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
