import { useState } from 'react';
import { MemberSelector } from '@/components/common/MemberSelector';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';

/** Ports workspace/common/AddAccessModal.svelte. */
export function AddAccessModal({
	open,
	onOpenChange,
	shareUsers = true,
	allowGroups = true,
	accessGrants,
	onAdd
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	shareUsers?: boolean;
	allowGroups?: boolean;
	accessGrants: { principal_type: string; principal_id: string }[];
	onAdd: (payload: { userIds: string[]; groupIds: string[] }) => void;
}) {
	const [userIds, setUserIds] = useState<string[]>([]);
	const [groupIds, setGroupIds] = useState<string[]>([]);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// Picks are per-open, as in the Svelte modal (it resets on submit;
				// a cancelled pick should not resurface next time either).
				if (!next) {
					setUserIds([]);
					setGroupIds([]);
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Add Access</DialogTitle>
					<DialogDescription className="sr-only">
						Choose users and groups to give access to.
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col"
					onSubmit={(e) => {
						e.preventDefault();
						onAdd({ userIds, groupIds });
						setUserIds([]);
						setGroupIds([]);
						onOpenChange(false);
					}}
				>
					<MemberSelector
						includeGroups={allowGroups}
						includeUsers={shareUsers}
						includeSessionUser={false}
						accessGrants={accessGrants}
						userIds={userIds}
						groupIds={groupIds}
						onUserIdsChange={setUserIds}
						onGroupIdsChange={setGroupIds}
					/>
					<div className="flex justify-end pt-2">
						<Button type="submit">Add</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
