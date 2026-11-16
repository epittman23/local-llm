import { RotateCcw } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { toastFailure } from '@/components/common/failureToast';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { type Permissions as PermissionsShape, withDefaults } from '@/lib/access/permissions';
import { getUserDefaultPermissions, getUserDefaultPermissionsDefaults } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
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

export type GroupFormValue = {
	name: string;
	description: string;
	data: Record<string, unknown>;
	permissions: PermissionsShape;
};
type TabId = 'general' | 'permissions' | 'users' | 'preview';

const tabLabels: Record<TabId, string> = {
	general: 'General',
	permissions: 'Permissions',
	users: 'Members',
	preview: 'Preview'
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
 *
 * #1099: the tabs are a strip across the top (none for one tab), the dialog
 * keeps one height whichever tab is open, Reset is a button that asks first,
 * and deleting says what happens to the members (ACT-3).
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
	const [nameError, setNameError] = useState<string | null>(null);
	const [description, setDescription] = useState('');
	const [data, setData] = useState<Record<string, unknown>>({});
	const [permissions, setPermissions] = useState<PermissionsShape>(() => withDefaults(null));
	const [userCount, setUserCount] = useState(0);
	const [loading, setLoading] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [confirmReset, setConfirmReset] = useState(false);
	const nameId = useId();

	useEffect(() => {
		if (!open) return;
		setTab(tabs[0]);
		setName(group?.name ?? '');
		setNameError(null);
		setDescription(group?.description ?? '');
		setData(structuredClone(group?.data ?? {}));
		setPermissions(withDefaults(group ? group.permissions : initialPermissions));
		setUserCount(group?.member_count ?? 0);
		// The inputs are read when the dialog opens; edits inside it are local state.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const submit = async () => {
		if (custom && !name.trim()) {
			setNameError('Enter a name for the group.');
			setTab('general');
			setTimeout(() => document.getElementById(nameId)?.focus());
			return;
		}
		setLoading(true);
		try {
			await onSubmit({ name: name.trim(), description, data, permissions });
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
				toast.success('Permissions reset to defaults. Save to keep them.');
			}
		} catch (error) {
			toastFailure("Couldn't load the default permissions.", error);
		}
	};

	const title = custom ? (edit ? 'Edit group' : 'New group') : 'Default permissions';
	const saveLabel = custom ? (edit ? 'Save group' : 'Create group') : 'Save permissions';
	// The changed counts compare with what Reset restores: the all-users defaults
	// for a group, the stock configuration for the defaults themselves.
	const baseline = withDefaults(custom ? (defaultPermissions ?? initialPermissions) : null);
	const footer = tab === 'general' || tab === 'permissions';

	return (
		<>
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={`Delete “${group?.name ?? name}”?`}
				confirmLabel="Delete group"
				destructive
				onConfirm={async () => {
					setConfirmDelete(false);
					await onDelete?.();
					onOpenChange(false);
				}}
			>
				Its members keep their accounts and lose the permissions this group gives them.
			</ConfirmDialog>
			<ConfirmDialog
				open={confirmReset}
				onOpenChange={setConfirmReset}
				title="Reset permissions to defaults?"
				confirmLabel="Reset permissions"
				destructive
				onConfirm={() => {
					setConfirmReset(false);
					resetToDefaults();
				}}
			>
				{custom
					? 'Every switch goes back to the permissions every account has by default.'
					: "Every switch goes back to the server's starting configuration."}{' '}
				Nothing changes until you press {saveLabel}.
			</ConfirmDialog>

			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="flex h-[min(44rem,calc(100dvh-2rem))] flex-col overflow-hidden sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription className={custom ? 'sr-only' : undefined}>
							{custom
								? 'Name the group, choose what its members may do, and choose who is in it.'
								: 'What every account with the User role may do. A group can give its members more.'}
						</DialogDescription>
					</DialogHeader>
					<form
						noValidate
						className="flex min-h-0 flex-1 flex-col"
						onSubmit={(e) => {
							e.preventDefault();
							submit();
						}}
					>
						<Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="min-h-0 flex-1 gap-3">
							{tabs.length > 1 && (
								<TabsList variant="line" className="max-w-full shrink-0 justify-start overflow-x-auto">
									{tabs.map((id) => (
										<TabsTrigger key={id} value={id} className="flex-none">
											{tabLabels[id]}
										</TabsTrigger>
									))}
								</TabsList>
							)}
							<div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4">
								{tabs.includes('general') && (
									<TabsContent value="general">
										<GroupGeneral
											nameId={nameId}
											name={name}
											nameError={nameError}
											onNameChange={(value) => {
												setName(value);
												if (value.trim()) setNameError(null);
											}}
											description={description}
											onDescriptionChange={setDescription}
											data={data}
											onDataChange={setData}
											edit={edit}
											onDelete={() => setConfirmDelete(true)}
										/>
									</TabsContent>
								)}
								<TabsContent value="permissions">
									<Permissions
										permissions={permissions}
										onChange={setPermissions}
										defaultPermissions={defaultPermissions}
										baseline={baseline}
									/>
								</TabsContent>
								{group && tabs.includes('users') && (
									<TabsContent value="users">
										<GroupUsers
											groupId={group.id}
											groupName={group.name}
											userCount={userCount}
											onUserCountChange={setUserCount}
											onMemberChange={(g) => onMemberChange?.(g as Group)}
										/>
									</TabsContent>
								)}
								{group && tabs.includes('preview') && (
									<TabsContent value="preview">
										<GroupPreviewPanel groupId={group.id} />
									</TabsContent>
								)}
							</div>
						</Tabs>

						{footer && (
							<div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t pt-3">
								<div>
									{tab === 'permissions' && (
										<Button variant="outline" type="button" onClick={() => setConfirmReset(true)}>
											<RotateCcw aria-hidden data-icon="inline-start" />
											Reset to defaults
										</Button>
									)}
								</div>
								<div className="flex gap-2">
									<Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
										Cancel
									</Button>
									<Button type="submit" disabled={loading} aria-busy={loading || undefined}>
										{loading && <Spinner className="size-3.5" />}
										{saveLabel}
									</Button>
								</div>
							</div>
						)}
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
