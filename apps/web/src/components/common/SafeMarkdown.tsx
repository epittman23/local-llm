import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

/**
 * Renders markdown from a source the app doesn't control (a plugin's valve
 * descriptions, a login footer) through `marked` then DOMPurify, the same
 * pipeline the Benchmarks Report page uses. Sanitizing is not optional here:
 * the text is written by whoever wrote the plugin.
 */
export function SafeMarkdown({ text, className }: { text: string; className?: string }) {
	const html = useMemo(() => DOMPurify.sanitize(marked.parse(text ?? '', { async: false }) as string), [text]);
	return <div className={cn('max-w-full text-xs [&_a]:underline [&_code]:font-mono', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
