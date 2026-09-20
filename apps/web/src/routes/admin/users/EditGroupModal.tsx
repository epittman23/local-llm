import { Eye, Settings, UserPlus, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { type Permissions as PermissionsShape, withDefaults } from '@/lib/access/permissions';
import { getUserDefaultPermissions, getUserDefaultPermissionsDefaults } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { GroupGeneral } from './GroupGeneral';
import { GroupPreviewPanel } from './GroupPreviewPanel';
import { GroupUsers } from './GroupUsers';
import { Permissions } from './Permissions';

export type Group = {
	id: string;
	name: string;
	description: string;
	permissions?: Record<string, unknown>;
	data?: Record<string, unknown> | null;
	member_count?: number;
};

export type GroupFormValue = { name: string; description: string; data: Record<string, unknown>; permissions: PermissionsShape };
type TabId = 'general' | 'permissions' | 'users' | 'preview';

const tabMeta: Record<TabId, { label: string; icon: typeof Settings }> = {
	general: { label: 'General', icon: Settings },
	permissions: { label: 'Permissions', icon: Wrench },
	users: { label: 'Users', icon: UserPlus },
	preview: { label: 'Preview', icon: Eye }
};

/**
 * Ports admin/Users/Groups/EditGroupModal.svelte. One modal, three jobs,
 * chosen by props: add a group (`edit` false, tabs General + Permissions), edit
 * one (all four tabs), or edit the all-users default permissions (`custom`
 * false, Permissions only -- there is no name to give).
 *
 * The Svelte modal is mounted once and keeps whatever a previous session left
 * in its `name`/`description`/`permissions` variables, so "New Group" reopens
 * showing the last group you created. Here every open starts from the group,
 * or (adding) from the default permissions.
 */
export function EditGroupModal({
	open,
	onOpenChange,
	edit = false,
	group = null,
	defaultPermissions,
	initialPermissions,
	tabs = ['general', 'permissions', 'users'],
	custom = true,
	onSubmit,
	onDelete,
	onMemberChange
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	edit?: boolean;
	group?: Group | null;
	/** The all-users defaults, used for the "will remain enabled" hints. */
	defaultPermissions?: Partial<PermissionsShape>;
	/** Where the switches start when there is no `group` (add / default-permissions modes). */
	initialPermissions?: Record<string, unknown>;
	tabs?: TabId[];
	custom?: boolean;
	onSubmit: (value: GroupFormValue) => void | Promise<void>;
	onDelete?: () => void | Promise<void>;
	onMemberChange?: (group: Group) => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [tab, setTab] = useState<TabId>(tabs[0]);
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [data, setData] = useState<Record<string, unknown>>({});
	const [permissions, setPermissions] = useState<PermissionsShape>(() => withDefaults(null));
	const [userCount, setUserCount] = useState(0);
	const [loading, setLoading] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [confirmReset, setConfirmReset] = useState(false);

	useEffect(() => {
		if (!open) return;
		setTab(tabs[0]);
		setName(group?.name ?? '');
		setDescription(group?.description ?? '');
		setData(structuredClone(group?.data ?? {}));
		setPermissions(withDefaults(group ? group.permissions : initialPermissions));
		setUserCount(group?.member_count ?? 0);
		// The inputs are read when the dialog opens; edits inside it are local state.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const submit = async () => {
		setLoading(true);
		try {
			await onSubmit({ name, description, data, permissions });
		} finally {
			setLoading(false);
		}
		onOpenChange(false);
	};

	// A group resets to the *current* all-users defaults; the default-permissions
	// modal itself resets to the stock/env-var configuration.
	const resetToDefaults = async () => {
		try {
			const defaults = custom ? await getUserDefaultPermissions(token) : await getUserDefaultPermissionsDefaults(token);
			if (defaults) {
				setPermissions(withDefaults(defaults));
				toast.success('Permissions reset to defaults');
			}
		} catch (error) {
			toast.error(`${error}`);
		}
	};

	const title = custom ? (edit ? 'Edit User Group' : 'Add User Group') : 'Edit Default Permissions';

	return (
		<>
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete group?"
				confirmLabel="Delete"
				onConfirm={async () => {
					setConfirmDelete(false);
					await onDelete?.();
					onOpenChange(false);
				}}
			>
				This will delete <span className="font-normal">{name}</span>.
			</ConfirmDialog>
			<ConfirmDialog
				open={confirmReset}
				onOpenChange={setConfirmReset}
				title="Reset to Defaults"
				onConfirm={() => {
					setConfirmReset(false);
					resetToDefaults();
				}}
			>
				Are you sure you want to reset all permissions to their default values? You will still need to save to apply the changes.
			</ConfirmDialog>

			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle className="text-sm font-medium">{title}</DialogTitle>
						<DialogDescription className="sr-only">{title}</DialogDescription>
					</DialogHeader>
					<form
						className="flex w-full flex-col"
						onSubmit={(e) => {
							e.preventDefault();
							submit();
						}}
					>
						<div className="flex h-full w-full flex-col pb-2 lg:flex-row lg:space-x-4">
							<div className="tabs flex max-w-full flex-row gap-2.5 overflow-x-auto text-left text-sm font-normal lg:w-40 lg:flex-none lg:flex-col lg:gap-1">
								{tabs.map((id) => {
									const { label, icon: Icon } = tabMeta[id];
									return (
										<button
											key={id}
											type="button"
											className={cn(
												'flex w-fit max-w-fit flex-1 items-center gap-2 rounded-lg px-0.5 py-1 text-right transition lg:flex-none',
												tab === id ? '' : 'text-muted-foreground/60 hover:text-foreground'
											)}
											onClick={() => setTab(id)}
										>
											<Icon className="size-4" />
											<span>{label}</span>
										</button>
									);
								})}
							</div>

							<div className="mt-1 flex flex-1 flex-col lg:h-[30rem] lg:max-h-[30rem]">
								<div className="h-full w-full overflow-y-auto">
									{tab === 'general' && (
										<GroupGeneral
											name={name}
											onNameChange={setName}
											description={description}
											onDescriptionChange={setDescription}
											data={data}
											onDataChange={setData}
											edit={edit}
											onDelete={() => setConfirmDelete(true)}
										/>
									)}
									{tab === 'permissions' && (
										<Permissions permissions={permissions} onChange={setPermissions} defaultPermissions={defaultPermissions} />
									)}
									{tab === 'users' && group && (
										<GroupUsers
											groupId={group.id}
											userCount={userCount}
											onUserCountChange={setUserCount}
											onMemberChange={(g) => onMemberChange?.(g as Group)}
										/>
									)}
									{tab === 'preview' && group && <GroupPreviewPanel groupId={group.id} />}
								</div>

								{(tab === 'general' || tab === 'permissions') && (
									<div className="flex items-center justify-between gap-1.5 pt-3 text-sm font-normal">
										<div>
											{tab === 'permissions' && (
												<Tip
													content={
														custom
															? 'Reset group permissions to match the current default user permissions'
															: 'Reset all permissions to their initial configuration values'
													}
												>
													<button
														type="button"
														className="text-muted-foreground hover:text-foreground text-sm font-normal transition hover:underline"
														onClick={() => setConfirmReset(true)}
													>
														Reset to Defaults
													</button>
												</Tip>
											)}
										</div>
										<Button type="submit" size="sm" disabled={loading}>
											Save
											{loading && <Spinner className="size-3.5" />}
										</Button>
									</div>
								)}
							</div>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
