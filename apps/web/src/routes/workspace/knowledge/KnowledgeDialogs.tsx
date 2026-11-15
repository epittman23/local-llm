import {
	ArrowUpCircle,
	CircleAlert,
	FolderOpen,
	FolderPlus,
	Globe,
	Plus,
	RefreshCw,
	RotateCcw,
	Type
} from 'lucide-react';
import { useState } from 'react';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export type AddContentKind = 'files' | 'directory' | 'new_directory' | 'web' | 'text';

/** Ports KnowledgeBase/AddContentMenu.svelte: the "+" menu over the file list. */
export function AddContentMenu({
	onUpload,
	onSync,
	onReset
}: {
	onUpload: (kind: AddContentKind) => void;
	onSync: () => void;
	onReset: () => void;
}) {
	// Verbs that name what each item adds; the destructive Reset last, below a separator (ACT-2, ACT-3).
	return (
		<DropdownMenu>
			<Tip content="Add content">
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon-sm" aria-label="Add content">
						<Plus />
					</Button>
				</DropdownMenuTrigger>
			</Tip>
			<DropdownMenuContent align="end" className="min-w-48">
				<DropdownMenuItem onSelect={() => onUpload('files')}>
					<ArrowUpCircle />
					Upload files
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => onUpload('directory')}>
					<FolderOpen />
					Upload a folder
				</DropdownMenuItem>
				<Tip
					side="left"
					content="Mirror a folder on this computer: only new and changed files are uploaded, and files gone from it are removed here."
				>
					<DropdownMenuItem onSelect={onSync}>
						<RefreshCw />
						Sync a folder
					</DropdownMenuItem>
				</Tip>
				<DropdownMenuItem onSelect={() => onUpload('web')}>
					<Globe />
					Add a web page
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => onUpload('text')}>
					<Type />
					Add text
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => onUpload('new_directory')}>
					<FolderPlus />
					New folder
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem variant="destructive" onSelect={onReset}>
					<RotateCcw />
					Reset knowledge base
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The knowledge base's name and description, edited in a dialog with an
 * explicit save (FRM-3; it used to save itself a second after each keystroke).
 * An empty name is refused under the field (FRM-2); the description may be
 * empty. The dialog stays open when the save fails.
 */
export function EditDetailsDialog({
	open,
	onOpenChange,
	name,
	description,
	onSave
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	name: string;
	description: string;
	onSave: (next: { name: string; description: string }) => Promise<boolean>;
}) {
	const [draftName, setDraftName] = useState(name);
	const [draftDescription, setDraftDescription] = useState(description);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const changed = draftName !== name || draftDescription !== description;
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next) {
					setDraftName(name);
					setDraftDescription(description);
					setError(null);
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Edit name and description</DialogTitle>
					<DialogDescription className="sr-only">The knowledge base's name and description.</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={async (e) => {
						e.preventDefault();
						if (!draftName.trim()) {
							setError('Give the knowledge base a name.');
							return;
						}
						setSaving(true);
						const ok = await onSave({ name: draftName.trim(), description: draftDescription.trim() });
						setSaving(false);
						if (ok) onOpenChange(false);
					}}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="kb-name">Name</Label>
						<Input
							id="kb-name"
							value={draftName}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? 'kb-name-error' : undefined}
							onChange={(e) => {
								setDraftName(e.target.value);
								if (e.target.value.trim()) setError(null);
							}}
						/>
						{error && <FieldError id="kb-name-error">{error}</FieldError>}
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="kb-description">Description (optional)</Label>
						<Textarea
							id="kb-description"
							rows={3}
							value={draftDescription}
							onChange={(e) => setDraftDescription(e.target.value)}
						/>
					</div>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={!changed || saving} aria-busy={saving || undefined}>
							{saving ? 'Saving…' : 'Save changes'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** A field's error under it, tied to it by `aria-describedby` (FRM-2). */
function FieldError({ id, children }: { id: string; children: string }) {
	return (
		<p id={id} className="text-danger text-dense flex items-center gap-1.5">
			<CircleAlert aria-hidden className="size-3.5 shrink-0" />
			{children}
		</p>
	);
}

/** Ports KnowledgeBase/NewDirectoryModal.svelte: a 32 rem form titled after its menu item (OVL-1, ACT-2). */
export function NewDirectoryDialog({
	open,
	onOpenChange,
	onSubmit
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (name: string) => void;
}) {
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					setName('');
					setError(null);
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>New folder</DialogTitle>
					<DialogDescription className="sr-only">Create a folder in this knowledge base.</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						if (!name.trim()) {
							setError('Give the folder a name.');
							return;
						}
						onSubmit(name.trim());
						setName('');
						onOpenChange(false);
					}}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="kb-folder-name">Name</Label>
						<Input
							id="kb-folder-name"
							value={name}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? 'kb-folder-name-error' : undefined}
							onChange={(e) => {
								setName(e.target.value);
								if (e.target.value.trim()) setError(null);
							}}
						/>
						{error && <FieldError id="kb-folder-name-error">{error}</FieldError>}
					</div>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit">Create folder</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Ports KnowledgeBase/AddTextContentModal.svelte: a title and a text that become
 * a `.txt` file, in a 48 rem form (OVL-1). (Not ported: the Svelte modal's
 * microphone button, which dictates into the body through the chat input's
 * recorder -- Phase 10.)
 */
export function AddTextDialog({
	open,
	onOpenChange,
	onSubmit
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (name: string, content: string) => void;
}) {
	const [name, setName] = useState('Untitled');
	const [content, setContent] = useState('');
	const [errors, setErrors] = useState<{ name?: string; content?: string }>({});
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Add text</DialogTitle>
					<DialogDescription>Saved as a text file in this knowledge base.</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						const next = {
							name: name.trim() ? undefined : 'Give the text a title.',
							content: content.trim() ? undefined : 'Write or paste the text to add.'
						};
						if (next.name || next.content) {
							setErrors(next);
							return;
						}
						onSubmit(name.trim(), content);
						setName('Untitled');
						setContent('');
						setErrors({});
						onOpenChange(false);
					}}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="kb-text-title">Title</Label>
						<Input
							id="kb-text-title"
							value={name}
							aria-invalid={errors.name ? true : undefined}
							aria-describedby={errors.name ? 'kb-text-title-error' : undefined}
							onChange={(e) => setName(e.target.value)}
						/>
						{errors.name && <FieldError id="kb-text-title-error">{errors.name}</FieldError>}
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="kb-text-content">Text</Label>
						<Textarea
							id="kb-text-content"
							rows={10}
							className="max-h-[50vh] field-sizing-fixed"
							value={content}
							aria-invalid={errors.content ? true : undefined}
							aria-describedby={errors.content ? 'kb-text-content-error' : undefined}
							onChange={(e) => setContent(e.target.value)}
						/>
						{errors.content && <FieldError id="kb-text-content-error">{errors.content}</FieldError>}
					</div>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit">Add text</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
