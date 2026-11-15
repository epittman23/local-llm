import { acceptCompletion } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, Prec, RangeSet, StateEffect, StateField } from '@codemirror/state';
import { Decoration, GutterMarker, gutterLineClass, keymap, placeholder } from '@codemirror/view';
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
	// A line Black could not parse (#1015): tinted, with its number in the danger colour.
	'.cm-parse-error': { backgroundColor: 'color-mix(in oklch, var(--danger), transparent 82%)' },
	'.cm-gutterElement.cm-parse-error-gutter': {
		backgroundColor: 'color-mix(in oklch, var(--danger), transparent 70%)',
		color: 'var(--danger)',
		fontWeight: '650'
	},
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

/** Where Black stopped parsing, and its own words. */
export type CodeParseError = { line: number; column: number; detail: string };

/** Black's "cannot parse: 30:12: ..." (or "Cannot parse for target version ...: 30:12"), else null. */
export function parseBlackError(error: unknown): CodeParseError | null {
	const detail = typeof error === 'string' ? error : '';
	const at = /cannot parse[^:]*: (\d+):(\d+)/i.exec(detail);
	return at ? { line: Number(at[1]), column: Number(at[2]), detail } : null;
}

/**
 * What formatting did: `invalid` means the code is not valid Python (the
 * caller does not save it, and hears where through `onParseError`);
 * `unformatted` means it could not be formatted for another reason (not an
 * admin, the server did not answer), so the caller saves it as it is.
 */
export type FormatOutcome = 'formatted' | 'unformatted' | 'invalid';

export type CodeEditorHandle = {
	/** Formats the buffer with the backend's Black. */
	formatPython: () => Promise<FormatOutcome>;
	focus: () => void;
};

// The line Black could not parse, marked until the next edit or format.
const setParseErrorLine = StateEffect.define<number | null>();
const parseErrorLine = StateField.define<number | null>({
	create: () => null,
	update(line, tr) {
		for (const effect of tr.effects) if (effect.is(setParseErrorLine)) return effect.value;
		return tr.docChanged ? null : line;
	}
});
class ParseErrorGutter extends GutterMarker {
	elementClass = 'cm-parse-error-gutter';
}
const parseErrorGutter = new ParseErrorGutter();
const lineStart = (state: EditorState) => {
	const line = state.field(parseErrorLine);
	return line !== null && line >= 1 && line <= state.doc.lines ? state.doc.line(line).from : null;
};
const parseErrorMarks = [
	parseErrorLine,
	EditorView.decorations.compute([parseErrorLine], (state) => {
		const from = lineStart(state);
		return from === null ? Decoration.none : Decoration.set([Decoration.line({ class: 'cm-parse-error' }).range(from)]);
	}),
	gutterLineClass.compute([parseErrorLine], (state) => {
		const from = lineStart(state);
		return from === null ? RangeSet.empty : RangeSet.of([parseErrorGutter.range(from)]);
	}),
	EditorView.contentAttributes.compute(
		[parseErrorLine],
		(state): Record<string, string> => (state.field(parseErrorLine) === null ? {} : { 'aria-invalid': 'true' })
	)
];

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
 * Formatting: admins format through the backend (`/utils/code/format`). Code
 * Black cannot parse is reported to `onParseError` (where, and Black's words)
 * and its line is marked in the gutter until the next edit, never toasted:
 * the caller shows it in place (FRM-2, FBK-1). The
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
	onParseError,
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
	/** Where the code stopped parsing on the last format, or null once it parses or is edited. */
	onParseError?: (error: CodeParseError | null) => void;
	ref?: Ref<CodeEditorHandle>;
}) {
	const container = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const language = useRef(new Compartment());
	const theme = useRef(new Compartment());
	// Latest callbacks, read from inside listeners created once at mount.
	const cb = useRef({ onChange, onSave, onParseError });
	cb.current = { onChange, onSave, onParseError };
	// Read once at mount, like `value`: the field's name, help and placeholder.
	const field = useRef({ placeholderText, ariaLabel, describedBy });
	const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
	const token = useAuthStore((s) => s.token) ?? '';

	const formatPython = async (): Promise<FormatOutcome> => {
		const v = view.current;
		if (!v || !isAdmin) return 'unformatted';
		const code = v.state.doc.toString();
		let parseError: CodeParseError | null = null;
		const res = await formatPythonCode(token, code).catch((error) => {
			parseError = parseBlackError(error);
			return null;
		});
		if (view.current !== v) return 'unformatted';
		const line = parseError ? (parseError as CodeParseError).line : null;
		const at = line !== null && line >= 1 && line <= v.state.doc.lines ? v.state.doc.line(line).from : null;
		// The marked line is brought into view, so the error and its line are on screen together.
		v.dispatch({
			effects: [setParseErrorLine.of(line), ...(at === null ? [] : [EditorView.scrollIntoView(at, { y: 'center' })])]
		});
		cb.current.onParseError?.(parseError);
		if (parseError) return 'invalid';
		if (!res?.code) return 'unformatted';
		if (res.code !== code) v.dispatch({ changes: [{ from: 0, to: v.state.doc.length, insert: res.code }] });
		return 'formatted';
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
									formatRef.current().then((outcome) => {
										if (outcome === 'formatted') toast.success('Code formatted');
									});
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
					parseErrorMarks,
					EditorView.updateListener.of((update) => {
						if (update.docChanged) cb.current.onChange?.(update.state.doc.toString());
						// An edit clears the mark; the caller's message goes with it.
						if (update.startState.field(parseErrorLine) !== null && update.state.field(parseErrorLine) === null)
							cb.current.onParseError?.(null);
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
