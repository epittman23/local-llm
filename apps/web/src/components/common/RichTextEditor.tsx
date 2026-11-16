import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { ListItem, TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Typography from '@tiptap/extension-typography';
import { CharacterCount, Placeholder } from '@tiptap/extensions';
import type { EditorState } from '@tiptap/pm/state';
import { type Editor, EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
	Bold,
	Code,
	Heading1,
	Heading2,
	Heading3,
	Highlighter,
	Italic,
	Link2,
	List,
	ListChecks,
	ListOrdered,
	Quote,
	Redo2,
	Sigma,
	SquareCode,
	Strikethrough,
	Table,
	Undo2
} from 'lucide-react';
import { type ComponentProps, type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { htmlToMarkdown } from '@/lib/editor/markdown';
import { MathPreview } from '@/lib/editor/mathPreview';
import { formatChord } from '@/lib/shortcuts';
import { useToolbarKeys } from '@/lib/ui/useToolbarKeys';
import { cn } from '@/lib/utils';
import { RichTextCodeBlock } from './RichTextCodeBlock';

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
			// The code block is RichTextCodeBlock: highlighted, with its language and Copy (CNT-2).
			StarterKit.configure({ codeBlock: false, listItem: false, link: { openOnClick: false, autolink: true } }),
			NestedOnlyListItem,
			RichTextCodeBlock,
			MathPreview,
			TaskList,
			NestedOnlyTaskItem.configure({ nested: true }),
			TableKit.configure({ table: { resizable: true } }),
			Image.configure({ allowBase64: true }),
			Highlight,
			Typography,
			Placeholder.configure({ placeholder, showOnlyWhenEditable: false }),
			CharacterCount
		],
		content: (content as string | object | null) ?? '',
		editorProps: {
			attributes: {
				class: cn('rich-text', className),
				'aria-label': ariaLabel,
				role: 'textbox',
				'aria-multiline': 'true'
			}
		},
		onUpdate: ({ editor: e, transaction }) => {
			// Only edits: the first click into a note ending in a list or a table also changes the
			// document (TrailingNode appends a paragraph to the selection's transaction), and that
			// alone saved the note (#1132).
			if (!transaction.docChanged) return;
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
		// Not an edit: by default TipTap reports one here, which saved every note on open (#1132).
		editor?.setEditable(editable, false);
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
			<EditorContent
				editor={editor}
				className="flex min-h-0 flex-1 flex-col [&_.ProseMirror]:min-h-[12rem] [&_.ProseMirror]:flex-1"
			/>
		</div>
	);
}

const LIST_ITEMS = ['listItem', 'taskItem'];

/** Whether the caret's nearest `name` item sits inside another list item: a level Shift+Tab can lift it out of. */
function inNestedItem(state: EditorState, name: string): boolean {
	const { $from } = state.selection;
	for (let d = $from.depth; d > 0; d--) {
		if ($from.node(d).type.name !== name) continue;
		return d >= 3 && LIST_ITEMS.includes($from.node(d - 2).type.name);
	}
	return false;
}

/**
 * Shift+Tab lifts a nested item up a level, and leaves a top-level one where
 * it is (#1138): there, lifting took the item out of its list (a task lost
 * its tick) and saved the note, from a key people press to move focus back.
 * Unhandled, the key does that instead: focus goes back to the toolbar.
 */
const liftNestedOnly = <T extends typeof ListItem | typeof TaskItem>(item: T) =>
	item.extend({
		addKeyboardShortcuts() {
			return {
				...this.parent?.(),
				'Shift-Tab': () => inNestedItem(this.editor.state, this.name) && this.editor.commands.liftListItem(this.name)
			};
		}
	}) as T;
const NestedOnlyListItem = liftNestedOnly(ListItem);
const NestedOnlyTaskItem = liftNestedOnly(TaskItem);

/** A tool's hint: its name, and its shortcut when it has one ("Bold, Ctrl+B"). */
export const toolHint = (label: string, chord?: string) => (chord ? `${label}, ${formatChord(chord)}` : label);

/**
 * One tool: an icon button named for what it does, with its name and shortcut
 * in a Tip (ACT-4). `active` marks a format that is on at the caret. `blocked`
 * keeps a tool that cannot act now (Undo with nothing to undo) focusable and
 * says so, rather than dropping it from the arrow-key order (ACT-5).
 */
function ToolButton({
	label,
	chord,
	active,
	blocked = false,
	onClick,
	children,
	...props
}: {
	label: string;
	chord?: string;
	active?: boolean;
	blocked?: boolean;
	onClick?: () => void;
	children: ReactNode;
} & Omit<ComponentProps<typeof Button>, 'onClick' | 'children'>) {
	return (
		<Tip content={toolHint(label, chord)}>
			<Button
				variant={active ? 'secondary' : 'ghost'}
				size="icon-sm"
				type="button"
				data-tool=""
				aria-label={label}
				aria-pressed={active}
				aria-disabled={blocked || undefined}
				className={cn(blocked && 'text-foreground-disabled hover:text-foreground-disabled cursor-not-allowed')}
				// The editor keeps its selection while a tool is pressed.
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => !blocked && onClick?.()}
				{...props}
			>
				{children}
			</Button>
		</Tip>
	);
}

const Divider = () => <div aria-hidden className="bg-border-divider mx-1 h-4 w-px shrink-0" />;

/** Link: the address for the selection or the link at the caret; an empty address removes the link. */
function LinkTool({ editor, active }: { editor: Editor; active: boolean }) {
	const [open, setOpen] = useState(false);
	const [href, setHref] = useState('');
	const apply = (e: FormEvent) => {
		e.preventDefault();
		const url = href.trim();
		const chain = editor.chain().focus().extendMarkRange('link');
		if (!url) chain.unsetLink().run();
		else if (editor.state.selection.empty && !active)
			chain.insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
		else chain.setLink({ href: url }).run();
		setOpen(false);
	};
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (next) setHref((editor.getAttributes('link').href as string | undefined) ?? '');
				setOpen(next);
			}}
		>
			<PopoverTrigger asChild>
				<ToolButton label="Link" active={active}>
					<Link2 />
				</ToolButton>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
				<form onSubmit={apply} className="flex flex-col gap-2">
					<Input
						aria-label="Link address"
						placeholder="https://"
						value={href}
						onChange={(e) => setHref(e.target.value)}
						autoFocus
					/>
					<div className="flex justify-end gap-2">
						{active && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => {
									editor.chain().focus().extendMarkRange('link').unsetLink().run();
									setOpen(false);
								}}
							>
								Remove link
							</Button>
						)}
						<Button type="submit" size="sm">
							{active ? 'Update link' : 'Add link'}
						</Button>
					</div>
				</form>
			</PopoverContent>
		</Popover>
	);
}

/** Table: inserts a 3 by 3 table, or, with the caret in one, the row, column and table actions. */
function TableTool({ editor, inTable }: { editor: Editor; inTable: boolean }) {
	const c = () => editor.chain().focus();
	if (!inTable)
		return (
			<ToolButton label="Table" onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
				<Table />
			</ToolButton>
		);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<ToolButton label="Table" active>
					<Table />
				</ToolButton>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-44">
				<DropdownMenuItem onSelect={() => c().addRowAfter().run()}>Add row below</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => c().addColumnAfter().run()}>Add column right</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => c().deleteRow().run()}>Delete row</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => c().deleteColumn().run()}>Delete column</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem variant="destructive" onSelect={() => c().deleteTable().run()}>
					Delete table
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Formula: the selection, or a placeholder `x`, written as inline math with the formula selected (CNT-3). */
export function insertFormula(editor: Editor) {
	const { from, to } = editor.state.selection;
	const latex = editor.state.doc.textBetween(from, to) || 'x';
	editor
		.chain()
		.focus()
		// A text node, not a string: TipTap reads a string as HTML, and `a<b` would open a tag.
		.insertContentAt({ from, to }, { type: 'text', text: `$${latex}$` })
		.setTextSelection({ from: from + 1, to: from + 1 + latex.length })
		.run();
}

/**
 * The formatting bar (#1038): history, headings, inline formats, lists and
 * blocks, each a Tip-named icon button with its shortcut. It is one tab stop:
 * the arrow keys, Home and End move between tools, and Escape returns to the
 * text (NAV-5). On a narrow screen it scrolls in its own row instead of
 * wrapping (LAY-7).
 */
function Toolbar({ editor }: { editor: Editor }) {
	const s = useEditorState({
		editor,
		selector: ({ editor: e }) => ({
			undo: e.can().undo(),
			redo: e.can().redo(),
			bold: e.isActive('bold'),
			italic: e.isActive('italic'),
			strike: e.isActive('strike'),
			code: e.isActive('code'),
			highlight: e.isActive('highlight'),
			link: e.isActive('link'),
			h1: e.isActive('heading', { level: 1 }),
			h2: e.isActive('heading', { level: 2 }),
			h3: e.isActive('heading', { level: 3 }),
			bullet: e.isActive('bulletList'),
			ordered: e.isActive('orderedList'),
			task: e.isActive('taskList'),
			codeBlock: e.isActive('codeBlock'),
			quote: e.isActive('blockquote'),
			table: e.isActive('table')
		})
	});
	// One tab stop: Escape returns to the text the tools act on. The bar scrolls in its own frame,
	// padded by the focus ring's 4 px (and pulled back by as much) so the frame never clips it.
	const toolbar = useToolbarKeys(() => editor.commands.focus());
	const c = () => editor.chain().focus();
	return (
		<div
			{...toolbar}
			role="toolbar"
			aria-label="Formatting"
			className="scroll-region -mx-1 -mt-1 mb-0.5 flex shrink-0 items-center gap-0.5 overflow-x-auto p-1 [&_svg]:size-4"
		>
			<ToolButton label="Undo" chord="Cmd+Z" blocked={!s.undo} onClick={() => c().undo().run()}>
				<Undo2 />
			</ToolButton>
			<ToolButton label="Redo" chord="Cmd+Shift+Z" blocked={!s.redo} onClick={() => c().redo().run()}>
				<Redo2 />
			</ToolButton>
			<Divider />
			<ToolButton
				label="Heading 1"
				chord="Cmd+Alt+1"
				active={s.h1}
				onClick={() => c().toggleHeading({ level: 1 }).run()}
			>
				<Heading1 />
			</ToolButton>
			<ToolButton
				label="Heading 2"
				chord="Cmd+Alt+2"
				active={s.h2}
				onClick={() => c().toggleHeading({ level: 2 }).run()}
			>
				<Heading2 />
			</ToolButton>
			<ToolButton
				label="Heading 3"
				chord="Cmd+Alt+3"
				active={s.h3}
				onClick={() => c().toggleHeading({ level: 3 }).run()}
			>
				<Heading3 />
			</ToolButton>
			<Divider />
			<ToolButton label="Bold" chord="Cmd+B" active={s.bold} onClick={() => c().toggleBold().run()}>
				<Bold />
			</ToolButton>
			<ToolButton label="Italic" chord="Cmd+I" active={s.italic} onClick={() => c().toggleItalic().run()}>
				<Italic />
			</ToolButton>
			<ToolButton label="Strikethrough" chord="Cmd+Shift+S" active={s.strike} onClick={() => c().toggleStrike().run()}>
				<Strikethrough />
			</ToolButton>
			<ToolButton
				label="Highlight"
				chord="Cmd+Shift+H"
				active={s.highlight}
				onClick={() => c().toggleHighlight().run()}
			>
				<Highlighter />
			</ToolButton>
			<ToolButton label="Inline code" chord="Cmd+E" active={s.code} onClick={() => c().toggleCode().run()}>
				<Code />
			</ToolButton>
			<ToolButton label="Formula" onClick={() => insertFormula(editor)}>
				<Sigma />
			</ToolButton>
			<LinkTool editor={editor} active={s.link} />
			<Divider />
			<ToolButton
				label="Bullet list"
				chord="Cmd+Shift+8"
				active={s.bullet}
				onClick={() => c().toggleBulletList().run()}
			>
				<List />
			</ToolButton>
			<ToolButton
				label="Numbered list"
				chord="Cmd+Shift+7"
				active={s.ordered}
				onClick={() => c().toggleOrderedList().run()}
			>
				<ListOrdered />
			</ToolButton>
			<ToolButton label="Task list" chord="Cmd+Shift+9" active={s.task} onClick={() => c().toggleTaskList().run()}>
				<ListChecks />
			</ToolButton>
			<Divider />
			<ToolButton label="Quote" chord="Cmd+Shift+B" active={s.quote} onClick={() => c().toggleBlockquote().run()}>
				<Quote />
			</ToolButton>
			<ToolButton label="Code block" chord="Cmd+Alt+C" active={s.codeBlock} onClick={() => c().toggleCodeBlock().run()}>
				<SquareCode />
			</ToolButton>
			<TableTool editor={editor} inTable={s.table} />
		</div>
	);
}

// Default export for React.lazy (the editor and TipTap load only where one is shown).
export default RichTextEditor;
