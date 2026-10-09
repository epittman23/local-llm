import { Minus, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DEFAULT_FLOATING_ACTIONS, type FloatingAction, newFloatingAction } from './interfaceSettingDefs';

const bare = 'w-full bg-transparent text-xs outline-hidden placeholder:text-muted-foreground/50';

/**
 * Ports chat/Settings/Interface/ManageFloatingActionButtonsModal.svelte: the
 * quick actions offered when text is selected in a chat. `null` means "use the
 * built-in ones"; Custom starts from those two. Edits stay in the dialog until
 * Save (the Svelte modal edited the caller's array in place, so a closed,
 * unsaved dialog still changed it). A row is removed by position, not by id,
 * so two rows sharing an id no longer vanish together.
 */
export function FloatingActionsDialog({
	open,
	onOpenChange,
	value,
	onSave
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	value: FloatingAction[] | null;
	onSave: (actions: FloatingAction[] | null) => void;
}) {
	const [actions, setActions] = useState<FloatingAction[] | null>(null);
	useEffect(() => {
		if (open) setActions(value ? value.map((a) => ({ ...a })) : null);
		// Seeded when the dialog opens.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);
	const edit = (idx: number, patch: Partial<FloatingAction>) =>
		setActions((list) => list && list.map((a, i) => (i === idx ? { ...a, ...patch } : a)));

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="text-sm font-medium">Quick Actions</DialogTitle>
					<DialogDescription className="sr-only">The actions offered when you select text in a chat.</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						onSave(actions);
						onOpenChange(false);
					}}
				>
					<div className="flex items-center justify-between text-xs">
						<div>Actions</div>
						<div className="text-muted-foreground flex items-center gap-2">
							<button
								type="button"
								className="hover:text-foreground"
								onClick={() => setActions(actions === null ? DEFAULT_FLOATING_ACTIONS.map((a) => ({ ...a })) : null)}
							>
								{actions === null ? 'Default' : 'Custom'}
							</button>
							{actions !== null && (
								<button
									type="button"
									aria-label="Add action"
									className="hover:text-foreground"
									onClick={() => setActions([...actions, newFloatingAction(actions)])}
								>
									<Plus className="size-4" />
								</button>
							)}
						</div>
					</div>
					{!actions?.length ? (
						<div className="text-muted-foreground text-xs">Default action buttons will be used.</div>
					) : (
						<ul className="flex flex-col gap-2">
							{actions.map((a, idx) => (
								// Rows have no stable identity (ids are editable), and are only appended or removed.
								<li key={idx} className="flex items-start gap-2 rounded-lg border p-2">
									<div className="flex min-w-0 flex-1 flex-col gap-1">
										<div className="flex gap-2">
											<input
												className={bare}
												aria-label="Button Label"
												placeholder="Button Label"
												value={a.label}
												onChange={(e) => edit(idx, { label: e.target.value })}
											/>
											<input
												className={`${bare} font-mono`}
												aria-label="Button ID"
												placeholder="Button ID"
												value={a.id}
												onChange={(e) => edit(idx, { id: e.target.value })}
											/>
										</div>
										<textarea
											className={`${bare} min-h-8 resize-y`}
											aria-label="Button Prompt"
											placeholder="Button Prompt"
											value={a.prompt}
											onChange={(e) => edit(idx, { prompt: e.target.value })}
										/>
									</div>
									<button
										type="button"
										aria-label="Remove action"
										className="text-muted-foreground hover:text-foreground"
										onClick={() => setActions(actions.filter((_, i) => i !== idx))}
									>
										<Minus className="size-4" />
									</button>
								</li>
							))}
						</ul>
					)}
					<div className="flex justify-end pt-1">
						<Button type="submit" size="sm">
							Save
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export type CompressionSize = { width: number | ''; height: number | '' };

/** Ports ManageImageCompressionModal.svelte: the largest width and height an uploaded image is scaled down to. */
export function ImageCompressionDialog({
	open,
	onOpenChange,
	value,
	onSave
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	value: CompressionSize;
	onSave: (size: CompressionSize) => void;
}) {
	const [size, setSize] = useState<CompressionSize>({ width: '', height: '' });
	useEffect(() => {
		if (open) setSize({ width: value?.width ?? '', height: value?.height ?? '' });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);
	const num = (v: string): number | '' => (v === '' ? '' : Number(v));

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle className="text-sm font-medium">Manage</DialogTitle>
					<DialogDescription className="sr-only">Image compression size.</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						onSave(size);
						onOpenChange(false);
					}}
				>
					<div className="text-muted-foreground text-xs">Image Max Compression Size</div>
					<div className="flex items-center gap-2">
						<input
							className={`${bare} rounded-lg border px-2 py-1`}
							type="number"
							min={0}
							aria-label="Image Max Compression Size width"
							placeholder="Width"
							value={size.width}
							onChange={(e) => setSize({ ...size, width: num(e.target.value) })}
						/>
						<X className="text-muted-foreground size-4 shrink-0" />
						<input
							className={`${bare} rounded-lg border px-2 py-1`}
							type="number"
							min={0}
							aria-label="Image Max Compression Size height"
							placeholder="Height"
							value={size.height}
							onChange={(e) => setSize({ ...size, height: num(e.target.value) })}
						/>
					</div>
					<div className="flex justify-end pt-1">
						<Button type="submit" size="sm">
							Save
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
