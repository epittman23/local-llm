import { MoreHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

/**
 * Ports workspace/Prompts/PromptHistoryMenu.svelte: the "..." menu on the
 * selected history version. Delete version is disabled (with a reason) for
 * the live version, and otherwise asks first, naming the version by its date,
 * with the danger-coloured button (ACT-3, #1012).
 */
export function PromptHistoryMenu({
	isProduction,
	date,
	onDelete
}: {
	isProduction: boolean;
	/** When the version was saved, as the history shows it. */
	date: string;
	onDelete: () => void;
}) {
	const [confirming, setConfirming] = useState(false);

	return (
		<>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={`Delete version from ${date}?`}
				confirmLabel="Delete version"
				destructive
				onConfirm={onDelete}
			>
				The versions saved after it are kept, linked to the version before it.
			</ConfirmDialog>
			<DropdownMenu>
				<Tip content="Version options">
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon-sm" aria-label="Version options">
							<MoreHorizontal />
						</Button>
					</DropdownMenuTrigger>
				</Tip>
				<DropdownMenuContent align="end" className="min-w-40">
					{isProduction ? (
						<Tip content="The live version can't be deleted. Make another version live first." side="top">
							<div className="flex cursor-not-allowed items-center gap-2 px-1.5 py-1 text-sm opacity-40">
								<Trash2 className="size-3.5" />
								Delete version
							</div>
						</Tip>
					) : (
						<DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
							<Trash2 />
							Delete version
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}
