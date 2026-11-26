import hljs from 'highlight.js/lib/common';
import { type ReactNode, type Ref, useMemo } from 'react';

// CNT-2, CNV-4, CNV-6: one code surface for reading and for editing. Source
// is highlighted by highlight.js, the highlighter the chat's code blocks use,
// with line numbers. The editor is the same surface with a transparent
// <textarea> laid exactly over the highlighted text, so switching between
// reading and editing changes nothing on screen but the caret. Colours come
// from the tokens (the `.hljs-*` rules in styles/standard.css), not from a
// highlight.js theme.

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" };
const decode = (text: string) => text.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity]);

/**
 * highlight.js's output as React nodes. Its HTML is only ever
 * `<span class="hljs-…">`, `</span>` and escaped text, so it is read with a
 * three-way pattern instead of being injected as HTML.
 */
export function highlight(code: string, language: string): ReactNode[] {
	const html = hljs.getLanguage(language)
		? hljs.highlight(code, { language, ignoreIllegals: true }).value
		: hljs.highlight(code, { language: 'plaintext' }).value;
	const root: ReactNode[] = [];
	const stack: Array<{ className: string; children: ReactNode[] }> = [];
	let key = 0;
	for (const match of html.matchAll(/<span class="([^"]*)">|<\/span>|([^<]+)/g)) {
		const target = stack.length ? stack[stack.length - 1].children : root;
		if (match[1] !== undefined) stack.push({ className: match[1], children: [] });
		else if (match[2] !== undefined) target.push(decode(match[2]));
		else {
			const done = stack.pop();
			if (!done) continue;
			const parent = stack.length ? stack[stack.length - 1].children : root;
			parent.push(
				<span key={key++} className={done.className}>
					{done.children}
				</span>
			);
		}
	}
	return root;
}

export function CodeSurface({
	code,
	language,
	edit
}: {
	code: string;
	language: string;
	/** Present while editing: the surface shows `code` highlighted under a textarea that edits it. */
	edit?: { label: string; onChange: (value: string) => void; inputRef?: Ref<HTMLTextAreaElement> };
}) {
	const nodes = useMemo(() => highlight(code, language), [code, language]);
	const lines = useMemo(() => code.split('\n').map((_, i) => i + 1), [code]);
	// The line numbers stay put while long lines scroll; scroll-padding keeps the caret clear of them.
	return (
		<div className="code-surface bg-surface-1 h-full scroll-pl-16 overflow-auto" data-editing={edit ? '' : undefined}>
			<div className="text-dense grid min-h-full min-w-max grid-cols-[auto_1fr] py-3 font-mono leading-relaxed">
				<div
					aria-hidden
					className="bg-surface-1 text-foreground-muted sticky left-0 z-10 pr-4 pl-3 text-right select-none"
				>
					{lines.map((number) => (
						<div key={number}>{number}</div>
					))}
				</div>
				<div className="relative pr-3">
					<pre aria-hidden={edit ? true : undefined} className="whitespace-pre">
						<code>
							{nodes}
							{/* A trailing newline has no height of its own; this keeps the last line the textarea shows. */}
							{code.endsWith('\n') ? ' ' : null}
						</code>
					</pre>
					{edit && (
						<textarea
							ref={edit.inputRef}
							data-code-editor
							aria-label={edit.label}
							value={code}
							onChange={(event) => edit.onChange(event.target.value)}
							wrap="off"
							spellCheck={false}
							autoCapitalize="off"
							autoComplete="off"
							className="absolute inset-0 size-full resize-none overflow-hidden whitespace-pre"
						/>
					)}
				</div>
			</div>
		</div>
	);
}
