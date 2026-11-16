import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { toastFailure } from '@/components/common/failureToast';
import { ProfileImageEditor } from '@/components/common/ProfileImageEditor';
import { SensitiveInput } from '@/components/common/SensitiveInput';
import { Spinner } from '@/components/common/Spinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getUserGroupsById, updateUserById } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { useFieldErrors } from '@/lib/ui/useFieldErrors';
import { cn } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { routePaths } from '@/routes/routePaths';
import { addUserProblem } from './AddUserModal';

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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELDS = ['name', 'email', 'password'] as const;
type FieldName = (typeof FIELDS)[number];
const OWN_ROLE = "You can't change your own role.";

/**
 * Ports admin/Users/UserList/EditUserModal.svelte. The password box starts
 * empty and an empty password means "leave it alone" on the server; the role
 * select is disabled on your own row so an admin cannot demote themselves.
 *
 * #1103/#933: edged, labelled fields in a `noValidate` form, errors under
 * their fields (a taken email under Email, a rejected password under New
 * password), and the dialog's words in sentence case.
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
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Edit user</DialogTitle>
					<DialogDescription className="sr-only">
						Change this user's role, name, email, password or picture.
					</DialogDescription>
				</DialogHeader>
				{/* Mounted per open, so every open starts from the user as stored. */}
				{open && selectedUser && (
					<EditUserForm user={selectedUser} onClose={() => onOpenChange(false)} onSaved={onSaved} />
				)}
			</DialogContent>
		</Dialog>
	);
}

function EditUserForm({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: () => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const sessionUserId = useAuthStore((s) => s.user?.id);
	const [form, setForm] = useState({
		profile_image_url: user.profile_image_url,
		role: user.role,
		name: user.name,
		email: user.email,
		password: ''
	});
	const [serverError, setServerError] = useState<{ field: FieldName; message: string } | null>(null);
	const [saving, setSaving] = useState(false);
	const id = useId();
	const ids = { role: `${id}-role`, name: `${id}-name`, email: `${id}-email`, password: `${id}-password` };
	const ownRow = user.id === sessionUserId;

	const groups = useQuery({
		queryKey: ['admin', 'user-groups', user.id],
		queryFn: () => getUserGroupsById(token, user.id) as Promise<{ id: string; name: string }[]>,
		gcTime: 0
	});

	const { errors, field, submit } = useFieldErrors<FieldName>(
		{
			name: form.name.trim() ? undefined : 'Enter their name.',
			email: !form.email.trim()
				? 'Enter their email address.'
				: EMAIL.test(form.email.trim())
					? undefined
					: 'Enter an email address like name@example.com.'
		},
		FIELDS
	);
	const errorOf = (name: FieldName) => errors[name] ?? (serverError?.field === name ? serverError.message : undefined);

	const change = (patch: Partial<typeof form>) => {
		setForm((f) => ({ ...f, ...patch }));
		if (serverError && Object.keys(patch).includes(serverError.field)) setServerError(null);
	};

	const save = async () => {
		if (!submit()) return;
		setSaving(true);
		const res = await updateUserById(token, user.id, {
			...form,
			name: form.name.trim(),
			email: form.email.trim()
		}).catch((error) => {
			const problem = addUserProblem(error);
			if (problem) {
				setServerError(problem);
				document.getElementById(ids[problem.field])?.focus();
			} else toastFailure("Couldn't save the user.", error);
			return null;
		});
		setSaving(false);
		if (res) {
			toast.success(`Saved “${form.name.trim()}”`);
			onSaved();
			onClose();
		}
	};

	const passwordError = errorOf('password');
	const passwordHelp = 'Leave it empty to keep their current password.';
	return (
		<form
			noValidate
			className="flex w-full flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<div className="flex items-start gap-4">
				<ProfileImageEditor
					imageClassName="size-14"
					value={form.profile_image_url}
					onChange={(profile_image_url) => change({ profile_image_url })}
					user={form}
				/>
				<div className="min-w-0 pt-3">
					<p className="font-strong truncate" title={user.name}>
						{user.name}
					</p>
					<p className="text-foreground-muted text-dense">Created {dayjs(user.created_at * 1000).format('LL')}</p>
				</div>
			</div>

			{(groups.data ?? []).length > 0 && (
				<div className="flex flex-col gap-1.5">
					<p className="text-foreground-muted text-dense">Groups</p>
					<ul className="flex flex-wrap gap-1.5">
						{groups.data!.map((group) => (
							<li key={group.id}>
								<Badge asChild variant="secondary">
									<Link to={`${routePaths.adminUsersGroups}?id=${group.id}`} onClick={onClose}>
										{group.name}
									</Link>
								</Badge>
							</li>
						))}
					</ul>
				</div>
			)}

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={ids.role}>Role</Label>
				<Select value={form.role} onValueChange={(role) => change({ role })} disabled={ownRow}>
					<SelectTrigger
						id={ids.role}
						className="w-full sm:w-48"
						{...fieldProps(`${ids.role}-msg`, { help: ownRow ? OWN_ROLE : undefined })}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="admin">Admin</SelectItem>
						<SelectItem value="user">User</SelectItem>
						<SelectItem value="pending">Pending</SelectItem>
					</SelectContent>
				</Select>
				<FieldMessage id={`${ids.role}-msg`} help={ownRow ? OWN_ROLE : undefined} />
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={ids.name}>Name</Label>
				<Input
					id={ids.name}
					{...field('name')}
					value={form.name}
					onChange={(e) => change({ name: e.target.value })}
					placeholder="Full name"
					autoComplete="off"
					{...fieldProps(`${ids.name}-msg`, { error: errorOf('name') })}
				/>
				<FieldMessage id={`${ids.name}-msg`} error={errorOf('name')} />
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={ids.email}>Email</Label>
				<Input
					id={ids.email}
					{...field('email')}
					type="email"
					value={form.email}
					onChange={(e) => change({ email: e.target.value })}
					placeholder="name@example.com"
					autoComplete="off"
					{...fieldProps(`${ids.email}-msg`, { error: errorOf('email') })}
				/>
				<FieldMessage id={`${ids.email}-msg`} error={errorOf('email')} />
			</div>

			{user.oauth && Object.keys(user.oauth).length > 0 && (
				<div className="flex flex-col gap-1.5">
					<p className="text-foreground-muted text-dense">Signs in with</p>
					<ul className="flex flex-col gap-1 break-all">
						{Object.keys(user.oauth).map((key) => (
							<li key={key}>
								<span className="text-foreground-muted">{key}</span> {user.oauth?.[key]?.sub}
							</li>
						))}
					</ul>
				</div>
			)}

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={ids.password}>New password</Label>
				<div
					data-composite-field
					aria-invalid={passwordError ? true : undefined}
					className={cn(
						'border-border-control bg-surface-1 flex h-(--control) items-center rounded-lg border ps-3 pe-1 pointer-coarse:h-(--control-touch)',
						passwordError && 'border-danger'
					)}
				>
					<SensitiveInput
						id={ids.password}
						className="text-body"
						outerClassName="min-w-0 items-center"
						value={form.password}
						onChange={(password) => change({ password })}
						placeholder="New password (optional)"
						autoComplete="new-password"
						required={false}
						{...fieldProps(`${ids.password}-msg`, { error: passwordError, help: passwordHelp })}
					/>
				</div>
				<FieldMessage id={`${ids.password}-msg`} error={passwordError} help={passwordHelp} />
			</div>

			<div className="flex justify-end gap-2">
				<Button variant="outline" type="button" onClick={onClose}>
					Cancel
				</Button>
				<Button type="submit" disabled={saving} aria-busy={saving || undefined}>
					{saving && <Spinner className="size-3.5" />}
					{saving ? 'Saving…' : 'Save user'}
				</Button>
			</div>
		</form>
	);
}
