import { useState } from 'react';
import { toast } from 'sonner';
import { toastFailure } from '@/components/common/failureToast';
import { Badge } from '@/components/ui/badge';
import { RowButton } from '@/components/ui/row-button';
import type { Permissions } from '@/lib/access/permissions';
import { deleteGroupById, updateGroupById } from '@/lib/apis/groups';
import { useAuthStore } from '@/lib/stores/authStore';
import { EditGroupModal, type Group, type GroupFormValue } from './EditGroupModal';

/**
 * Ports admin/Users/Groups/GroupItem.svelte: one row, opening the edit modal.
 * `openOnMount` is the `?id=<group>` deep link (the Edit User modal's group
 * chips link there): the row whose id matches opens its editor on arrival.
 */
export function GroupItem({
	group,
	defaultPermissions,
	openOnMount,
	onChanged,
	onGroupUpdate
}: {
	group: Group;
	defaultPermissions: Partial<Permissions>;
	openOnMount: boolean;
	onChanged: () => void;
	onGroupUpdate: (group: Group) => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [showEdit, setShowEdit] = useState(openOnMount);
	const members = group.member_count ?? 0;
	const hasCustomPermissions = Object.keys(group?.permissions ?? {}).length > 0;

	const update = async (value: GroupFormValue) => {
		const res = await updateGroupById(token, group.id, value).catch((error) => {
			toastFailure("Couldn't save the group.", error);
			return null;
		});
		if (res) {
			toast.success(`Saved “${value.name}”`);
			onChanged();
		}
	};

	const remove = async () => {
		const res = await deleteGroupById(token, group.id).catch((error) => {
			toastFailure(`Couldn't delete “${group.name}”.`, error);
			return null;
		});
		if (res) {
			toast.success(`Deleted “${group.name}”`);
			onChanged();
		}
	};

	return (
		<>
			<EditGroupModal
				open={showEdit}
				onOpenChange={setShowEdit}
				edit
				group={group}
				defaultPermissions={defaultPermissions}
				tabs={['general', 'permissions', 'users', 'preview']}
				onSubmit={update}
				onDelete={remove}
				onMemberChange={onGroupUpdate}
			/>
			<RowButton className="flex items-center gap-3 px-2.5 py-2" onClick={() => setShowEdit(true)}>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-2">
						<span className="text-foreground-strong font-strong truncate" title={group.name}>
							{group.name}
						</span>
						<Badge variant="secondary" className="shrink-0">
							{members === 1 ? '1 member' : `${members} members`}
						</Badge>
					</div>
					<span className="text-foreground-muted text-dense truncate">
						{group.description || 'No description'} ·{' '}
						{hasCustomPermissions ? 'Custom permissions' : 'Uses the defaults'}
					</span>
				</div>
				<span className="text-foreground-muted shrink-0">Edit</span>
			</RowButton>
		</>
	);
}
