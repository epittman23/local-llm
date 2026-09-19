import { acceptCompletion } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { keymap, placeholder } from '@codemirror/view';
import { EditorView, basicSetup } from 'codemirror';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { toast } from 'sonner';
import { formatPythonCode } from '@/lib/apis/utils';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';

export type CodeEditorHandle = {
	/** Formats the buffer with the backend's Black. Resolves false if it could not. */
	formatPython: () => Promise<boolean>;
	focus: () => void;
};

/**
 * Ports common/CodeEditor.svelte: a CodeMirror 6 editor with basicSetup, the
 * language picked from `lang`, One Dark when the page is dark, Tab to accept a
 * completion, Ctrl/Cmd+S to `onSave`, and Ctrl/Cmd+Shift+F to format.
 *
 * Uncontrolled after mount, on purpose: CodeMirror owns the document, `value`
 * seeds it (falling back to `boilerplate` when empty) and later changes to
 * `value` are applied as a minimal diff so the cursor and undo history survive.
 * `onChange` reports every edit.
 *
 * Formatting: admins format through the backend (`/utils/code/format`). The
 * Svelte version formats for everyone else with `black` in a Pyodide worker;
 * that needs the Pyodide machinery Phase 10 builds, so here a non-admin's
 * format request returns false and callers save the code unformatted -- what
 * the original does whenever formatting fails.
 *
 * This module pulls in CodeMirror (~hundreds of KB): import it with
 * `React.lazy`, so the pages that never edit code don't pay for it.
 */
export default function CodeEditor({
	value = '',
	boilerplate = '',
	lang = '',
	className = 'text-sm',
	onChange,
	onSave,
	ref
}: {
	value?: string;
	boilerplate?: string;
	lang?: string;
	className?: string;
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
					indentUnit.of('    '),
					placeholder('Enter your code here...'),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) cb.current.onChange?.(update.state.doc.toString());
					}),
					theme.current.of(dark() ? oneDark : []),
					language.current.of([])
				]
			}),
			parent: container.current
		});
		view.current = editor;
		// Seeding from the boilerplate is a change the parent should hear about.
		if (value === '' && boilerplate !== '') cb.current.onChange?.(boilerplate);

		const observer = new MutationObserver(() =>
			editor.dispatch({ effects: theme.current.reconfigure(dark() ? oneDark : []) })
		);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

		const onKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 's') {
				e.preventDefault();
				cb.current.onSave?.();
			}
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
				e.preventDefault();
				formatRef.current();
			}
		};
		document.addEventListener('keydown', onKeyDown);

		return () => {
			observer.disconnect();
			document.removeEventListener('keydown', onKeyDown);
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
