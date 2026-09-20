import { useState } from 'react';
import { toast } from 'sonner';
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
	const hasCustomPermissions = Object.keys(group?.permissions ?? {}).length > 0;

	const update = async (value: GroupFormValue) => {
		const res = await updateGroupById(token, group.id, value).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) {
			toast.success('Group updated successfully');
			onChanged();
		}
	};

	const remove = async () => {
		const res = await deleteGroupById(token, group.id).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) {
			toast.success('Group deleted successfully');
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
			<button type="button" className="group flex w-full cursor-pointer px-2.5 py-2 text-left" onClick={() => setShowEdit(true)}>
				<div className="flex w-full items-center gap-3">
					<div className="flex min-w-0 flex-1 flex-col gap-0.5 pl-1">
						<div className="flex min-w-0 items-center gap-2">
							<div className="line-clamp-1 text-sm font-normal group-hover:underline">{group.name}</div>
							<div className="bg-muted text-muted-foreground shrink-0 rounded-md px-1.5 py-0.5 text-[0.6875rem] leading-none font-normal">
								{group.member_count ?? 0} members
							</div>
						</div>
						<div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
							<div className="line-clamp-1 min-w-0">{group.description || 'No description'}</div>
							<div className="text-muted-foreground/50 shrink-0">/</div>
							<div className="shrink-0">{hasCustomPermissions ? 'Custom permissions' : 'Uses defaults'}</div>
						</div>
					</div>
					<div className="text-muted-foreground group-hover:text-foreground shrink-0 px-1.5 text-xs transition">Edit</div>
				</div>
			</button>
		</>
	);
}
