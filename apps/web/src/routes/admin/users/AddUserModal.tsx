import { Check, Copy, Download, FileText, KeyRound } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { toastFailure } from '@/components/common/failureToast';
import { SensitiveInput } from '@/components/common/SensitiveInput';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { addUser } from '@/lib/apis/auths';
import { WEBUI_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useCopy } from '@/lib/ui/useCopy';
import { useFieldErrors } from '@/lib/ui/useFieldErrors';
import { cn } from '@/lib/utils';
import { generateInitialsImage } from '@/lib/utils/auth-helpers';
import { parseUserCsv } from './userCsv';

const blank = { name: '', email: '', password: '', role: 'user' };
const BATCH_SIZE = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELDS = ['name', 'email', 'password'] as const;
type FieldName = (typeof FIELDS)[number];

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';

/**
 * A strong temporary password (S5-D8): 16 characters from the browser's
 * cryptographic random source, with at least one lower-case letter, capital,
 * digit and symbol, so it passes the server's default rule when that is on.
 * Look-alike characters (l, I, O, 0, 1) are left out: it is read and typed.
 */
export function generatePassword(length = 16): string {
	const all = LOWER + UPPER + DIGITS + SYMBOLS;
	const random = new Uint32Array(length);
	crypto.getRandomValues(random);
	const pick = (set: string, i: number) => set[random[i] % set.length];
	const chars = Array.from({ length }, (_, i) => pick(i < 4 ? [LOWER, UPPER, DIGITS, SYMBOLS][i] : all, i));
	// Shuffle so the four guaranteed classes are not always first.
	const order = new Uint32Array(length);
	crypto.getRandomValues(order);
	for (let i = length - 1; i > 0; i--) {
		const j = order[i] % (i + 1);
		[chars[i], chars[j]] = [chars[j], chars[i]];
	}
	return chars.join('');
}

/** Where a failed add belongs (FRM-2): the server's duplicate-email and password answers go under their fields. */
export function addUserProblem(error: unknown): { field: FieldName; message: string } | null {
	const text = String(error ?? '');
	if (/already registered/i.test(text))
		return { field: 'email', message: 'An account with this email already exists.' };
	if (/password/i.test(text)) return { field: 'password', message: text };
	return null;
}

/** "3 users added", "3 added, 1 failed", "No users were added" (FBK-2). */
export function importSummary(added: number, failed: number): string {
	if (failed === 0) return added === 1 ? '1 user added' : `${added} users added`;
	if (added === 0) return failed === 1 ? "1 user couldn't be added" : `${failed} users couldn't be added`;
	return `${added} added, ${failed} failed`;
}

const sizeLabel = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);

/**
 * Ports admin/Users/UserList/AddUserModal.svelte: a form for one user, or a
 * CSV of many (Name, Email, Password, Role; rows go to the server ten at a
 * time so a large file does not open hundreds of requests at once).
 *
 * #1103: labelled, edged fields whose errors show under them (no browser
 * bubbles), a duplicate email marked on Email, the server's password rule
 * shown under Password while it is on (S5-D8), and Generate to fill a strong
 * temporary password, with Copy. The CSV half names the chosen file, takes a
 * dropped one, and downloads the template from a button.
 */
export function AddUserModal({
	open,
	onOpenChange,
	onSaved
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved: () => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add user</DialogTitle>
					<DialogDescription>Create an account, or import several from a CSV file.</DialogDescription>
				</DialogHeader>
				{/* Mounted per open, so every open starts from an empty form. */}
				{open && <AddUserForm onClose={() => onOpenChange(false)} onSaved={onSaved} />}
			</DialogContent>
		</Dialog>
	);
}

function AddUserForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const features = useConfigStore((s) => s.config?.features);
	const [tab, setTab] = useState<'form' | 'import'>('form');
	const [user, setUser] = useState(blank);
	const [file, setFile] = useState<File | null>(null);
	const [fileError, setFileError] = useState<string | null>(null);
	const [serverError, setServerError] = useState<{ field: FieldName; message: string } | null>(null);
	const [loading, setLoading] = useState(false);
	const [dragging, setDragging] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const { copied, copy } = useCopy();
	const id = useId();
	const ids = {
		name: `${id}-name`,
		email: `${id}-email`,
		password: `${id}-password`,
		role: `${id}-role`,
		file: `${id}-file`
	};

	const ruleOn = features?.enable_password_validation === true;
	const passwordHelp = ruleOn
		? features?.password_validation_hint || 'The server checks new passwords against its password rule.'
		: 'They can change it after they sign in.';

	const { errors, field, submit } = useFieldErrors<FieldName>(
		{
			name: user.name.trim() ? undefined : 'Enter their name.',
			email: !user.email.trim()
				? 'Enter their email address.'
				: EMAIL.test(user.email.trim())
					? undefined
					: 'Enter an email address like name@example.com.',
			password: user.password ? undefined : 'Enter a password, or press Generate.'
		},
		FIELDS
	);
	const errorOf = (name: FieldName) => errors[name] ?? (serverError?.field === name ? serverError.message : undefined);

	const change = (patch: Partial<typeof blank>) => {
		setUser((u) => ({ ...u, ...patch }));
		const changed = Object.keys(patch);
		if (serverError && changed.includes(serverError.field)) setServerError(null);
	};

	const submitOne = async () => {
		if (!submit()) return;
		setLoading(true);
		const res = await addUser(
			token,
			user.name.trim(),
			user.email.trim(),
			user.password,
			user.role,
			generateInitialsImage(user.name)
		).catch((error) => {
			const problem = addUserProblem(error);
			if (problem) {
				setServerError(problem);
				document.getElementById(ids[problem.field])?.focus();
			} else toastFailure("Couldn't add the user.", error);
			return null;
		});
		setLoading(false);
		if (res) {
			toast.success(`Added “${user.name.trim()}”`);
			onSaved();
			onClose();
		}
	};

	const submitCsv = async () => {
		if (!file) {
			setFileError('Choose a CSV file to import.');
			return;
		}
		setLoading(true);
		const { validRows, invalidRows } = parseUserCsv(await file.text());
		let added = 0;
		const failures: string[] = invalidRows.map((idx) => `Row ${idx + 1}: not four columns`);
		for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
			const results = await Promise.all(
				validRows.slice(i, i + BATCH_SIZE).map(({ idx, columns }) =>
					addUser(
						token,
						columns[0],
						columns[1],
						columns[2],
						columns[3].toLowerCase(),
						generateInitialsImage(columns[0])
					).catch((error) => {
						failures.push(`Row ${idx + 1}: ${addUserProblem(error)?.message ?? String(error)}`);
						return null;
					})
				)
			);
			added += results.filter(Boolean).length;
		}
		const summary = importSummary(added, failures.length);
		if (failures.length) toastFailure(summary, failures.join('\n'));
		else toast.success(summary);
		setFile(null);
		if (fileInput.current) fileInput.current.value = '';
		setLoading(false);
		if (added > 0) onSaved();
	};

	const chooseFile = (chosen: File | null | undefined) => {
		setFile(chosen ?? null);
		setFileError(null);
	};

	const passwordError = errorOf('password');
	return (
		<form
			noValidate
			className="flex w-full flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				tab === 'form' ? submitOne() : submitCsv();
			}}
		>
			<SegmentedControl
				aria-label="How to add"
				value={tab}
				onValueChange={setTab}
				options={[
					{ value: 'form', label: 'One user' },
					{ value: 'import', label: 'Import from CSV' }
				]}
			/>

			{tab === 'form' ? (
				<>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={ids.name}>Name</Label>
						<Input
							id={ids.name}
							{...field('name')}
							value={user.name}
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
							value={user.email}
							onChange={(e) => change({ email: e.target.value })}
							placeholder="name@example.com"
							autoComplete="off"
							{...fieldProps(`${ids.email}-msg`, { error: errorOf('email') })}
						/>
						<FieldMessage id={`${ids.email}-msg`} error={errorOf('email')} />
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={ids.password}>Password</Label>
						<div className="flex flex-wrap items-center gap-2">
							<div
								data-composite-field
								aria-invalid={passwordError ? true : undefined}
								className={cn(
									'border-border-control bg-surface-1 flex h-(--control) min-w-48 flex-1 items-center rounded-lg border ps-3 pe-1 pointer-coarse:h-(--control-touch)',
									passwordError && 'border-danger'
								)}
							>
								<SensitiveInput
									id={ids.password}
									{...field('password')}
									className="text-body"
									outerClassName="min-w-0 items-center"
									value={user.password}
									onChange={(password) => change({ password })}
									placeholder="Temporary password"
									autoComplete="new-password"
									required={false}
									{...fieldProps(`${ids.password}-msg`, { error: passwordError, help: passwordHelp })}
								/>
							</div>
							<Button variant="outline" type="button" onClick={() => change({ password: generatePassword() })}>
								<KeyRound aria-hidden data-icon="inline-start" />
								Generate
							</Button>
							<Button
								variant="outline"
								type="button"
								disabled={!user.password}
								onClick={() => copy(user.password, 'password')}
							>
								{copied ? (
									<Check aria-hidden data-icon="inline-start" />
								) : (
									<Copy aria-hidden data-icon="inline-start" />
								)}
								{copied ? 'Copied' : 'Copy'}
							</Button>
						</div>
						<FieldMessage id={`${ids.password}-msg`} error={passwordError} help={passwordHelp} />
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={ids.role}>Role</Label>
						<Select value={user.role} onValueChange={(role) => change({ role })}>
							<SelectTrigger id={ids.role} className="w-full sm:w-48">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="user">User</SelectItem>
								<SelectItem value="admin">Admin</SelectItem>
								<SelectItem value="pending">Pending</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</>
			) : (
				<div className="flex flex-col gap-3">
					<input
						ref={fileInput}
						id={ids.file}
						hidden
						type="file"
						accept=".csv,text/csv"
						onChange={(e) => chooseFile(e.target.files?.[0])}
					/>
					<section
						aria-label="CSV file"
						data-dragging={dragging || undefined}
						onDragOver={(e) => {
							e.preventDefault();
							setDragging(true);
						}}
						onDragLeave={() => setDragging(false)}
						onDrop={(e) => {
							e.preventDefault();
							setDragging(false);
							chooseFile(e.dataTransfer.files?.[0]);
						}}
						className={cn(
							'border-border-control flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center data-dragging:bg-surface-3',
							fileError && 'border-danger'
						)}
					>
						{file ? (
							<p className="flex min-w-0 max-w-full items-center gap-2">
								<FileText aria-hidden className="text-foreground-muted size-4 shrink-0" />
								<span className="truncate font-strong" title={file.name}>
									{file.name}
								</span>
								<span className="text-foreground-muted shrink-0">{sizeLabel(file.size)}</span>
							</p>
						) : (
							<p className="text-foreground-muted">Drop a CSV file here, or choose one.</p>
						)}
						<Button
							variant="outline"
							type="button"
							onClick={() => fileInput.current?.click()}
							{...fieldProps(`${ids.file}-msg`, { error: fileError })}
						>
							{file ? 'Choose another file' : 'Choose CSV file'}
						</Button>
					</section>
					<FieldMessage
						id={`${ids.file}-msg`}
						error={fileError}
						help="Four columns, in this order: name, email, password, role."
					/>
					<Button asChild variant="ghost" className="self-start">
						<a href={`${WEBUI_BASE_URL}/static/user-import.csv`} download>
							<Download aria-hidden data-icon="inline-start" />
							Download template
						</a>
					</Button>
				</div>
			)}

			<div className="flex justify-end gap-2">
				<Button variant="outline" type="button" onClick={onClose}>
					Cancel
				</Button>
				<Button type="submit" disabled={loading} aria-busy={loading || undefined}>
					{loading && <Spinner className="size-3.5" />}
					{tab === 'form' ? (loading ? 'Adding…' : 'Add user') : loading ? 'Importing…' : 'Import users'}
				</Button>
			</div>
		</form>
	);
}
