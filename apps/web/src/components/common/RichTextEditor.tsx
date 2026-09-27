import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Typography from '@tiptap/extension-typography';
import { CharacterCount, Placeholder } from '@tiptap/extensions';
import { type Editor, EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Code2, Heading1, Heading2, Italic, List, ListChecks, ListOrdered, Quote, Strikethrough } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { htmlToMarkdown } from '@/lib/editor/markdown';
import { cn } from '@/lib/utils';

export type EditorContentValue = { html: string; json: unknown; md: string };

/**
 * A TipTap editor for React: the parts of common/RichTextInput.svelte that
 * Notes uses -- headings, lists and task lists, tables, images, links,
 * highlight, typography, a placeholder, word and character counts -- with
 * every change reported as `{ html, json, md }` (the Markdown through
 * lib/editor/markdown.ts). Phase 10's chat composer builds on it.
 *
 * `content` seeds the editor (TipTap JSON, or HTML); later changes to the prop
 * are applied only when `contentKey` changes, so typing is never fought by a
 * parent re-render. Not here yet: real-time collaboration (Yjs over the
 * socket), mentions, AI autocompletion and the drag handle.
 */
export function RichTextEditor({
	content,
	contentKey,
	onChange,
	editable = true,
	placeholder = 'Write something...',
	className,
	toolbar = true,
	onReady,
	ariaLabel = 'Editor'
}: {
	content: unknown;
	contentKey?: string | number;
	onChange?: (value: EditorContentValue) => void;
	editable?: boolean;
	placeholder?: string;
	className?: string;
	toolbar?: boolean;
	onReady?: (editor: Editor) => void;
	ariaLabel?: string;
}) {
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	const editor = useEditor({
		immediatelyRender: false,
		editable,
		extensions: [
			StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
			TaskList,
			TaskItem.configure({ nested: true }),
			TableKit.configure({ table: { resizable: true } }),
			Image.configure({ allowBase64: true }),
			Highlight,
			Typography,
			Placeholder.configure({ placeholder, showOnlyWhenEditable: false }),
			CharacterCount
		],
		content: (content as string | object | null) ?? '',
		editorProps: { attributes: { class: cn('rich-text outline-hidden', className), 'aria-label': ariaLabel, role: 'textbox', 'aria-multiline': 'true' } },
		onUpdate: ({ editor: e }) => {
			const html = e.getHTML();
			onChangeRef.current?.({ html, json: e.getJSON(), md: htmlToMarkdown(html) });
		}
	});

	useEffect(() => {
		if (editor) onReady?.(editor);
		// Once, when the editor exists.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor]);
	useEffect(() => {
		editor?.setEditable(editable);
	}, [editor, editable]);
	// A new document (another note, a restored version): replace the content without reporting it as an edit.
	const firstKey = useRef(contentKey);
	useEffect(() => {
		if (!editor || contentKey === firstKey.current) return;
		firstKey.current = contentKey;
		editor.commands.setContent((content as string | object | null) ?? '', { emitUpdate: false });
		// Only when the key changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor, contentKey]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{toolbar && editor && editable && <Toolbar editor={editor} />}
			<EditorContent editor={editor} className="flex min-h-0 flex-1 flex-col [&_.ProseMirror]:min-h-[12rem] [&_.ProseMirror]:flex-1" />
		</div>
	);
}

function ToolButton({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={active}
			title={label}
			className={cn('rounded-md p-1 transition', active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
			onMouseDown={(e) => e.preventDefault()}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

/** A compact formatting bar (the Svelte editor's FormattingButtons, as a row rather than a bubble menu). */
function Toolbar({ editor }: { editor: Editor }) {
	const s = useEditorState({
		editor,
		selector: ({ editor: e }) => ({
			bold: e.isActive('bold'),
			italic: e.isActive('italic'),
			strike: e.isActive('strike'),
			h1: e.isActive('heading', { level: 1 }),
			h2: e.isActive('heading', { level: 2 }),
			bullet: e.isActive('bulletList'),
			ordered: e.isActive('orderedList'),
			task: e.isActive('taskList'),
			code: e.isActive('codeBlock'),
			quote: e.isActive('blockquote')
		})
	});
	const c = () => editor.chain().focus();
	const icon = 'size-3.5';
	return (
		<div role="toolbar" aria-label="Formatting" className="mb-1 flex flex-wrap items-center gap-0.5">
			<ToolButton label="Bold" active={s.bold} onClick={() => c().toggleBold().run()}>
				<Bold className={icon} />
			</ToolButton>
			<ToolButton label="Italic" active={s.italic} onClick={() => c().toggleItalic().run()}>
				<Italic className={icon} />
			</ToolButton>
			<ToolButton label="Strikethrough" active={s.strike} onClick={() => c().toggleStrike().run()}>
				<Strikethrough className={icon} />
			</ToolButton>
			<ToolButton label="Heading 1" active={s.h1} onClick={() => c().toggleHeading({ level: 1 }).run()}>
				<Heading1 className={icon} />
			</ToolButton>
			<ToolButton label="Heading 2" active={s.h2} onClick={() => c().toggleHeading({ level: 2 }).run()}>
				<Heading2 className={icon} />
			</ToolButton>
			<ToolButton label="Bullet list" active={s.bullet} onClick={() => c().toggleBulletList().run()}>
				<List className={icon} />
			</ToolButton>
			<ToolButton label="Numbered list" active={s.ordered} onClick={() => c().toggleOrderedList().run()}>
				<ListOrdered className={icon} />
			</ToolButton>
			<ToolButton label="Task list" active={s.task} onClick={() => c().toggleTaskList().run()}>
				<ListChecks className={icon} />
			</ToolButton>
			<ToolButton label="Code block" active={s.code} onClick={() => c().toggleCodeBlock().run()}>
				<Code2 className={icon} />
			</ToolButton>
			<ToolButton label="Quote" active={s.quote} onClick={() => c().toggleBlockquote().run()}>
				<Quote className={icon} />
			</ToolButton>
		</div>
	);
}

// Default export for React.lazy (the editor and TipTap load only where one is shown).
export default RichTextEditor;
