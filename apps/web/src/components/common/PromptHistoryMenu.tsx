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
 * selected history version. Delete is disabled (with a reason) for the live
 * production version, and asks first otherwise.
 */
export function PromptHistoryMenu({
	isProduction,
	onDelete
}: {
	isProduction: boolean;
	onDelete: () => void;
}) {
	const [confirming, setConfirming] = useState(false);

	return (
		<>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="Delete Version"
				confirmLabel="Delete"
				onConfirm={onDelete}
			>
				Are you sure you want to delete this version? Child versions will be relinked to this
				version's parent.
			</ConfirmDialog>
			<DropdownMenu>
				<Tip content="More">
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon-sm" aria-label="More Options">
							<MoreHorizontal />
						</Button>
					</DropdownMenuTrigger>
				</Tip>
				<DropdownMenuContent align="end" className="min-w-40">
					{isProduction ? (
						<Tip content="Cannot delete the production version" side="top">
							<div className="flex cursor-not-allowed items-center gap-2 px-1.5 py-1 text-sm opacity-40">
								<Trash2 className="size-3.5" />
								Delete
							</div>
						</Tip>
					) : (
						<DropdownMenuItem onSelect={() => setConfirming(true)}>
							<Trash2 />
							Delete
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}
