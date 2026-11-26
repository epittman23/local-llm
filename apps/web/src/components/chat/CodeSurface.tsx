import {
	type KeyboardEvent,
	type ReactNode,
	type Ref,
	useCallback,
	useDeferredValue,
	useEffect,
	useId,
	useMemo,
	useRef
} from 'react';
import { hljs } from '@/lib/markdown/highlight';

// CNT-2, CNV-4, CNV-6: one code surface for reading and for editing. Source
// is highlighted by highlight.js, the highlighter the chat's code blocks use,
// with line numbers. The editor is the same surface with a transparent
// <textarea> laid exactly over the highlighted text, so switching between
// reading and editing changes nothing on screen but the caret. Colours come
// from the tokens (the `.hljs-*` rules in styles/standard.css); no
// highlight.js stylesheet is imported anywhere, the chat's code blocks
// included, so all three are one theme.

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

export const TAB_HELP = 'Tab indents. Press Esc, then Tab, to leave the editor.';

/** One level of indentation: a tab for the languages that require one, two spaces otherwise. */
const indentOf = (language: string) => (language === 'go' || language === 'makefile' ? '\t' : '  ');

/**
 * Replaces a range of the textarea through the browser's own insert command, so native undo and redo keep
 * working; where there is none (jsdom), it sets the range and tells React with an input event.
 */
function replaceRange(el: HTMLTextAreaElement, start: number, end: number, text: string) {
	el.setSelectionRange(start, end);
	if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) return;
	el.setRangeText(text, start, end, 'end');
	el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Tab and Shift+Tab inside the editor: indent or outdent the caret's line, or every line the selection touches. */
function indentSelection(el: HTMLTextAreaElement, indent: string, outdent: boolean) {
	const { value, selectionStart: a, selectionEnd: b } = el;
	if (!outdent && !value.slice(a, b).includes('\n')) return replaceRange(el, a, b, indent);
	const lineStart = a === 0 ? 0 : value.lastIndexOf('\n', a - 1) + 1;
	// A selection that ends at the start of a line does not include that line.
	const endAt = b > a && value[b - 1] === '\n' ? b - 1 : b;
	const found = value.indexOf('\n', endAt);
	const lineEnd = found < 0 ? value.length : found;
	const block = value.slice(lineStart, lineEnd);
	const removed: number[] = [];
	const next = block
		.split('\n')
		.map((line) => {
			if (!outdent) return indent + line;
			const drop = line.startsWith('\t') ? 1 : (/^ */.exec(line)?.[0].length ?? 0);
			removed.push(Math.min(drop, indent.length));
			return line.slice(Math.min(drop, indent.length));
		})
		.join('\n');
	if (next === block) return;
	replaceRange(el, lineStart, lineEnd, next);
	const start = outdent ? Math.max(lineStart, a - removed[0]) : a + indent.length;
	el.setSelectionRange(start, a === b ? start : b + next.length - block.length);
}

export function CodeSurface({
	code,
	language,
	edit
}: {
	code: string;
	language: string;
	/** Present while editing: the surface shows `code` highlighted under a textarea that edits it. */
	edit?: {
		label: string;
		onChange: (value: string) => void;
		inputRef?: Ref<HTMLTextAreaElement>;
		/** Ctrl or Cmd+S in the editor; the browser's own save dialog is suppressed. */
		onSave?: () => void;
		/** The id of a visible element that says how Tab and Esc work (TAB_HELP); without it a screen-reader-only line does. */
		describedBy?: string;
	};
}) {
	// The textarea shows the live value (its text is transparent); only the colour may lag a frame behind typing.
	const shown = useDeferredValue(code);
	const nodes = useMemo(() => highlight(shown, language), [shown, language]);
	const lines = useMemo(() => shown.split('\n').map((_, i) => i + 1), [shown]);
	// False until something is typed (an input event) and again after Escape, so Tab still leaves the editor
	// for a keyboard user who has not typed, and Escape then Tab always leaves it. The `data-escape-kept`
	// attribute says so to the panel around it (SidePanel), whose sheet reads it before the editor can.
	const typed = useRef(false);
	const area = useRef<HTMLTextAreaElement | null>(null);
	const setTyped = useCallback((value: boolean) => {
		typed.current = value;
		area.current?.toggleAttribute('data-escape-kept', value);
	}, []);
	const helpId = useId();
	const editing = edit !== undefined;
	const inputRef = edit?.inputRef;
	const setArea = useCallback(
		(el: HTMLTextAreaElement | null) => {
			area.current = el;
			if (typeof inputRef === 'function') inputRef(el);
			else if (inputRef) inputRef.current = el;
		},
		[inputRef]
	);
	// Escape is handled on the textarea itself, natively: the panel's own listener is on an ancestor and runs
	// before React's, which sits at the root, so a React handler could not stop the canvas closing.
	useEffect(() => {
		const el = area.current;
		if (!editing || !el) return;
		const onEscape = (event: globalThis.KeyboardEvent) => {
			if (event.key !== 'Escape' || event.isComposing || !typed.current) return;
			event.preventDefault();
			setTyped(false);
		};
		el.addEventListener('keydown', onEscape);
		return () => el.removeEventListener('keydown', onEscape);
	}, [editing, setTyped]);
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (!edit || event.nativeEvent.isComposing) return;
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && edit.onSave) {
			event.preventDefault();
			edit.onSave();
		} else if (event.key === 'Tab' && typed.current && !event.ctrlKey && !event.altKey && !event.metaKey) {
			event.preventDefault();
			indentSelection(event.currentTarget, indentOf(language), event.shiftKey);
		}
	};
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
							{shown.endsWith('\n') ? ' ' : null}
						</code>
					</pre>
					{edit && !edit.describedBy && (
						<span id={helpId} className="sr-only">
							{TAB_HELP}
						</span>
					)}
					{edit && (
						<textarea
							ref={setArea}
							data-code-editor
							aria-label={edit.label}
							value={code}
							onChange={(event) => {
								setTyped(true);
								edit.onChange(event.target.value);
							}}
							onKeyDown={onKeyDown}
							aria-describedby={edit.describedBy ?? helpId}
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
