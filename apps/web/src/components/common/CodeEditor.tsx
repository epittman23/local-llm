import { acceptCompletion } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { keymap, placeholder } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { basicSetup, EditorView } from 'codemirror';
import { type Ref, useEffect, useImperativeHandle, useRef } from 'react';
import { toast } from 'sonner';
import { formatPythonCode } from '@/lib/apis/utils';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';

// CNT-2: the editor's colours are the standard's tokens, the same ones the
// .hljs-* rules in standard.css give a code block, so one piece of code looks
// the same in an answer and in the editor, in every app theme. The values are
// CSS variables, so a theme change needs no reconfiguring; only CodeMirror's
// own light/dark base styles are switched (EditorView.darkTheme below).
const selection = 'color-mix(in oklch, var(--brand), transparent 65%)';
const tokenTheme = EditorView.theme({
	// The editor fills its host and scrolls inside it. Without a height CodeMirror
	// grows to its content, and a host that clips (every caller's panel does) then
	// hides the lines past its bottom from the wheel and from Ctrl+End.
	'&': { height: '100%', color: 'var(--foreground-strong)', backgroundColor: 'var(--surface-1)' },
	'.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-code)' },
	'.cm-content': { caretColor: 'var(--foreground-strong)' },
	'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground-strong)' },
	'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
		{ backgroundColor: selection },
	'.cm-gutters': {
		backgroundColor: 'var(--surface-1)',
		color: 'var(--foreground-muted)',
		borderRight: '1px solid var(--border-divider)'
	},
	'.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--surface-3), transparent 50%)' },
	'.cm-activeLineGutter': { backgroundColor: 'var(--surface-3)', color: 'var(--foreground-strong)' },
	'.cm-placeholder': { color: 'var(--foreground-muted)' },
	'&.cm-focused .cm-matchingBracket': {
		backgroundColor: 'var(--surface-3)',
		outline: '1px solid var(--border-control)'
	},
	'.cm-searchMatch': { backgroundColor: 'color-mix(in oklch, var(--series-2), transparent 70%)' },
	'.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: selection },
	'.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--foreground-strong)' },
	'.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border-divider)' },
	'.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border-divider)' },
	'.cm-tooltip': {
		backgroundColor: 'var(--surface-2)',
		color: 'var(--foreground-strong)',
		border: '1px solid var(--border-divider)'
	},
	'.cm-tooltip-autocomplete > ul > li[aria-selected]': {
		backgroundColor: 'var(--surface-3)',
		color: 'var(--foreground-strong)'
	},
	'.cm-foldPlaceholder': { backgroundColor: 'var(--surface-3)', color: 'var(--foreground-muted)', border: 'none' }
});
// The groups match standard.css's .hljs-* rules: keywords and literals, strings,
// numbers, names being defined, attributes and types, meta, comments.
const tokenHighlight = HighlightStyle.define([
	{
		tag: [t.keyword, t.operatorKeyword, t.modifier, t.bool, t.null, t.atom, t.self, t.special(t.variableName)],
		color: 'var(--series-3)'
	},
	{ tag: [t.string, t.special(t.string), t.regexp, t.inserted, t.character], color: 'var(--series-4)' },
	{ tag: [t.number, t.deleted, t.escape], color: 'var(--series-5)' },
	{
		tag: [
			t.function(t.variableName),
			t.function(t.definition(t.variableName)),
			t.definition(t.className),
			t.className,
			t.heading,
			t.tagName
		],
		color: 'var(--series-1)'
	},
	{ tag: [t.attributeName, t.propertyName, t.typeName, t.labelName, t.namespace], color: 'var(--series-2)' },
	{ tag: [t.meta, t.annotation, t.processingInstruction, t.link, t.url], color: 'var(--series-6)' },
	{ tag: t.comment, color: 'var(--foreground-muted)' },
	{ tag: t.invalid, color: 'var(--danger)' },
	{ tag: t.strong, fontWeight: '650' },
	{ tag: t.emphasis, fontStyle: 'italic' },
	{ tag: t.link, textDecoration: 'underline' }
]);

export type CodeEditorHandle = {
	/** Formats the buffer with the backend's Black. Resolves false if it could not. */
	formatPython: () => Promise<boolean>;
	focus: () => void;
};

/**
 * Ports common/CodeEditor.svelte: a CodeMirror 6 editor with basicSetup, the
 * language picked from `lang`, the standard's code colours (CNT-2), Tab to accept a
 * completion, Ctrl/Cmd+S to `onSave`, and Ctrl/Cmd+Shift+F to format. The keys
 * act only while the editor has focus, so a page holding two editors, or other
 * fields, keeps its own Ctrl+S.
 *
 * A field (CNT-2, A11Y-2): `ariaLabel` names the editable content and
 * `describedBy` points at the caller's help line, which sits outside the
 * caller's clipped panel. Tab indents here, so the help line says how to leave:
 * Esc, then Tab (CodeMirror's tab-focus mode).
 *
 * Uncontrolled after mount, on purpose: CodeMirror owns the document, `value`
 * seeds it (falling back to `boilerplate` when empty) and later changes to
 * `value` are applied as a minimal diff so the cursor and undo history survive.
 * `onChange` reports every edit.
 *
 * Formatting: admins format through the backend (`/utils/code/format`). The
 * Svelte version formats for everyone else with `black` in a browser worker;
 * this app has no such worker, so here a non-admin's format request returns
 * false and callers save the code unformatted -- what the original does
 * whenever formatting fails.
 *
 * This module pulls in CodeMirror (~hundreds of KB): import it with
 * `React.lazy`, so the pages that never edit code don't pay for it.
 */
export default function CodeEditor({
	value = '',
	boilerplate = '',
	lang = '',
	className = 'text-sm',
	placeholder: placeholderText = 'Enter your code here...',
	ariaLabel,
	describedBy,
	onChange,
	onSave,
	ref
}: {
	value?: string;
	boilerplate?: string;
	lang?: string;
	className?: string;
	/** Shown while the document is empty; '' shows none. */
	placeholder?: string;
	/** The field's name, on the editable content: "Tool code". */
	ariaLabel?: string;
	/** The id of the help line under the editor. */
	describedBy?: string;
	onChange?: (value: string) => void;
	onSave?: () => void;
	ref?: Ref<CodeEditorHandle>;
}) {
	const container = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const language = useRef(new Compartment());
	const theme = useRef(new Compartment());
	// Latest callbacks, read from inside listeners created once at mount.
	const cb = useRef({ onChange, onSave });
	cb.current = { onChange, onSave };
	// Read once at mount, like `value`: the field's name, help and placeholder.
	const field = useRef({ placeholderText, ariaLabel, describedBy });
	const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
	const token = useAuthStore((s) => s.token) ?? '';

	const formatPython = async () => {
		const v = view.current;
		if (!v) return false;
		if (!isAdmin) return false;
		const res = await formatPythonCode(token, v.state.doc.toString()).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (!res?.code) return false;
		v.dispatch({ changes: [{ from: 0, to: v.state.doc.length, insert: res.code }] });
		toast.success('Code formatted successfully');
		return true;
	};
	const formatRef = useRef(formatPython);
	formatRef.current = formatPython;

	useImperativeHandle(ref, () => ({ formatPython: () => formatRef.current(), focus: () => view.current?.focus() }), []);

	useEffect(() => {
		if (!container.current) return;
		const dark = () => document.documentElement.classList.contains('dark');
		const editor = new EditorView({
			state: EditorState.create({
				doc: value === '' ? boilerplate : value,
				extensions: [
					basicSetup,
					keymap.of([{ key: 'Tab', run: acceptCompletion }, indentWithTab]),
					// Scoped to the editor: these run only while it has focus.
					Prec.high(
						keymap.of([
							{
								key: 'Mod-s',
								preventDefault: true,
								run: () => {
									cb.current.onSave?.();
									return true;
								}
							},
							{
								key: 'Mod-Shift-f',
								preventDefault: true,
								run: () => {
									formatRef.current();
									return true;
								}
							}
						])
					),
					indentUnit.of('    '),
					field.current.placeholderText ? placeholder(field.current.placeholderText) : [],
					// tabindex on the content (already the one Tab stop) tells checkers the
					// scroller holds something focusable (axe scrollable-region-focusable).
					EditorView.contentAttributes.of({
						tabindex: '0',
						...(field.current.ariaLabel ? { 'aria-label': field.current.ariaLabel } : {}),
						...(field.current.describedBy ? { 'aria-describedby': field.current.describedBy } : {})
					}),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) cb.current.onChange?.(update.state.doc.toString());
					}),
					tokenTheme,
					syntaxHighlighting(tokenHighlight),
					theme.current.of(EditorView.darkTheme.of(dark())),
					language.current.of([])
				]
			}),
			parent: container.current
		});
		view.current = editor;
		// Seeding from the boilerplate is a change the parent should hear about.
		if (value === '' && boilerplate !== '') cb.current.onChange?.(boilerplate);

		const observer = new MutationObserver(() =>
			editor.dispatch({ effects: theme.current.reconfigure(EditorView.darkTheme.of(dark())) })
		);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

		return () => {
			observer.disconnect();
			// CodeMirror keeps a DOM observer and references until destroyed.
			editor.destroy();
			view.current = null;
		};
		// Mount once: `value`/`boilerplate` are seeds; later `value` changes are handled below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Apply an externally-changed `value` as the smallest edit that gets there.
	useEffect(() => {
		const v = view.current;
		if (!v || value === '') return;
		const current = v.state.doc.toString();
		if (current === value) return;
		let start = 0;
		while (start < current.length && start < value.length && current[start] === value[start]) start++;
		let endOld = current.length;
		let endNew = value.length;
		while (endOld > start && endNew > start && current[endOld - 1] === value[endNew - 1]) {
			endOld--;
			endNew--;
		}
		v.dispatch({ changes: [{ from: start, to: endOld, insert: value.slice(start, endNew) }] });
	}, [value]);

	useEffect(() => {
		let cancelled = false;
		const match = languages.find((l) => l.alias.includes(lang));
		match?.load().then((support) => {
			if (!cancelled && view.current) view.current.dispatch({ effects: language.current.reconfigure(support) });
		});
		return () => {
			cancelled = true;
		};
	}, [lang]);

	return <div ref={container} className={cn('h-full w-full min-w-0 overflow-hidden', className)} />;
}
