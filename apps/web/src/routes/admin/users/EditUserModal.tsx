import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ProfileImageEditor } from '@/components/common/ProfileImageEditor';
import { SensitiveInput } from '@/components/common/SensitiveInput';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getUserGroupsById, updateUserById } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { dayjs } from '@/lib/utils/dates';
import { routePaths } from '@/routes/routePaths';

export type AdminUser = {
	id: string;
	name: string;
	email: string;
	role: string;
	profile_image_url: string;
	created_at: number;
	last_active_at: number;
	oauth?: Record<string, { sub?: string }> | null;
};

/**
 * Ports admin/Users/UserList/EditUserModal.svelte. The password box starts
 * empty and an empty password means "leave it alone" on the server; the role
 * select is disabled on your own row so an admin cannot demote themselves.
 */
export function EditUserModal({
	open,
	onOpenChange,
	selectedUser,
	onSaved
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	selectedUser: AdminUser | null;
	onSaved: () => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const sessionUserId = useAuthStore((s) => s.user?.id);
	const [form, setForm] = useState({ profile_image_url: '', role: 'pending', name: '', email: '', password: '' });

	useEffect(() => {
		if (open && selectedUser) setForm({ ...selectedUser, password: '' });
	}, [open, selectedUser]);

	const groups = useQuery({
		queryKey: ['admin', 'user-groups', selectedUser?.id],
		queryFn: () => getUserGroupsById(token, selectedUser!.id) as Promise<{ id: string; name: string }[]>,
		enabled: open && !!selectedUser?.id,
		gcTime: 0
	});

	if (!selectedUser) return null;

	const submit = async () => {
		const res = await updateUserById(token, selectedUser.id, form).catch((error) => {
			toast.error(`${error}`);
		});
		if (res) {
			onSaved();
			onOpenChange(false);
		}
	};

	const field = 'w-full bg-transparent text-sm outline-hidden';
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="text-sm font-medium">Edit User</DialogTitle>
					<DialogDescription className="sr-only">Change this user's role, name, email, password or picture.</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<div className="flex w-full">
						<div className="mr-6 h-full self-start">
							<ProfileImageEditor
								imageClassName="size-14"
								value={form.profile_image_url}
								onChange={(profile_image_url) => setForm({ ...form, profile_image_url })}
								user={form}
							/>
						</div>
						<div className="min-w-0 flex-1">
							<div className="mb-2 w-full overflow-hidden">
								<div className="truncate font-normal capitalize">{selectedUser.name}</div>
								<div className="text-muted-foreground text-xs">Created at {dayjs(selectedUser.created_at * 1000).format('LL')}</div>
							</div>

							<div className="flex flex-col space-y-1.5">
								{(groups.data ?? []).length > 0 && (
									<div className="flex w-full flex-col text-sm">
										<div className="text-muted-foreground mb-1 text-xs">User Groups</div>
										<div className="-mx-1 my-0.5 flex flex-wrap gap-1">
											{groups.data!.map((group) => (
												<span key={group.id} className="bg-muted rounded-xl px-1.5 py-0.5 text-xs">
													<Link to={`${routePaths.adminUsersGroups}?id=${group.id}`} onClick={() => onOpenChange(false)}>
														{group.name}
													</Link>
												</span>
											))}
										</div>
									</div>
								)}

								<div className="flex w-full flex-col">
									<label className="text-muted-foreground mb-1 text-xs" htmlFor="edit-user-role">
										Role
									</label>
									<select
										id="edit-user-role"
										className={`${field} disabled:opacity-60`}
										value={form.role}
										onChange={(e) => setForm({ ...form, role: e.target.value })}
										disabled={selectedUser.id === sessionUserId}
										required
									>
										<option value="admin">Admin</option>
										<option value="user">User</option>
										<option value="pending">Pending</option>
									</select>
								</div>

								<div className="flex w-full flex-col">
									<label className="text-muted-foreground mb-1 text-xs" htmlFor="edit-user-name">
										Name
									</label>
									<input
										id="edit-user-name"
										className={field}
										type="text"
										value={form.name}
										onChange={(e) => setForm({ ...form, name: e.target.value })}
										placeholder="Enter Your Name"
										autoComplete="off"
										required
									/>
								</div>

								<div className="flex w-full flex-col">
									<label className="text-muted-foreground mb-1 text-xs" htmlFor="edit-user-email">
										Email
									</label>
									<input
										id="edit-user-email"
										className={field}
										type="email"
										value={form.email}
										onChange={(e) => setForm({ ...form, email: e.target.value })}
										placeholder="Enter Your Email"
										autoComplete="off"
										required
									/>
								</div>

								{selectedUser.oauth && (
									<div className="flex w-full flex-col">
										<div className="text-muted-foreground mb-1 text-xs">OAuth ID</div>
										<div className="mb-1 flex flex-col space-y-1 text-sm break-all">
											{Object.keys(selectedUser.oauth).map((key) => (
												<div key={key}>
													<span className="text-muted-foreground">{key}</span> <span>{selectedUser.oauth?.[key]?.sub}</span>
												</div>
											))}
										</div>
									</div>
								)}

								<div className="flex w-full flex-col">
									<div className="text-muted-foreground mb-1 text-xs">New Password</div>
									<SensitiveInput
										className="text-sm"
										value={form.password}
										onChange={(password) => setForm({ ...form, password })}
										placeholder="Enter New Password"
										autoComplete="new-password"
										required={false}
									/>
								</div>
							</div>
						</div>
					</div>
					<div className="flex justify-end pt-3">
						<Button type="submit" size="sm">
							Save
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
