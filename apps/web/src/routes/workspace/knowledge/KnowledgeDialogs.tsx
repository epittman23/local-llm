import { ArrowUpCircle, FolderOpen, FolderPlus, Globe, Plus, RefreshCw, RotateCcw, Type } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

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
	return (
		<DropdownMenu>
			<Tip content="Add Content">
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon-sm" aria-label="Add Content">
						<Plus />
					</Button>
				</DropdownMenuTrigger>
			</Tip>
			<DropdownMenuContent align="end" className="min-w-44">
				<DropdownMenuItem onSelect={() => onUpload('new_directory')}>
					<FolderPlus />
					New directory
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={() => onUpload('files')}>
					<ArrowUpCircle />
					Upload files
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => onUpload('directory')}>
					<FolderOpen />
					Upload directory
				</DropdownMenuItem>
				<Tip
					side="left"
					content="Sync a local directory with this knowledge base. Only new and modified files will be uploaded. The directory structure will be mirrored."
				>
					<DropdownMenuItem onSelect={onSync}>
						<RefreshCw />
						Sync directory
					</DropdownMenuItem>
				</Tip>
				<DropdownMenuItem onSelect={() => onUpload('web')}>
					<Globe />
					Add webpage
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => onUpload('text')}>
					<Type />
					Add text content
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={onReset}>
					<RotateCcw />
					Reset
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Ports KnowledgeBase/NewDirectoryModal.svelte. */
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
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) setName('');
				onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle className="text-base font-normal">New Directory</DialogTitle>
					<DialogDescription className="sr-only">Create a folder in this knowledge base.</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (!name.trim()) {
							toast.error('Name is required');
							return;
						}
						onSubmit(name.trim());
						setName('');
						onOpenChange(false);
					}}
				>
					<div className="text-muted-foreground mb-1 text-xs">Name</div>
					<input
						className="placeholder:text-muted-foreground/60 w-full bg-transparent text-sm outline-hidden"
						aria-label="Name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Directory name"
					/>
					<div className="flex justify-end gap-2 pt-3">
						<Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" size="sm">
							Create
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Ports KnowledgeBase/AddTextContentModal.svelte: a title and a body that become
 * a `.txt` file. (Not ported: the Svelte modal's microphone button, which
 * dictates into the body through the chat input's recorder -- Phase 10.)
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
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="text-sm">Add text content</DialogTitle>
					<DialogDescription className="sr-only">Saved as a text file in this knowledge base.</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (name.trim() === '' || content.trim() === '') {
							toast.error('Please fill in all fields.');
							setName(name.trim());
							setContent(content.trim());
							return;
						}
						onSubmit(name, content);
						setName('Untitled');
						setContent('');
						onOpenChange(false);
					}}
				>
					<input
						className="w-full bg-transparent text-sm outline-hidden"
						aria-label="Title"
						placeholder="Title"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
					<textarea
						className="placeholder:text-muted-foreground/60 mt-2 h-64 w-full resize-none bg-transparent text-sm outline-hidden"
						aria-label="Content"
						placeholder="Write something..."
						value={content}
						onChange={(e) => setContent(e.target.value)}
					/>
					<div className="flex justify-end pt-2">
						<Button type="submit" size="sm">
							Save
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
