import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SensitiveInput } from '@/components/common/SensitiveInput';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { addUser } from '@/lib/apis/auths';
import { WEBUI_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { generateInitialsImage } from '@/lib/utils/auth-helpers';
import { cn } from '@/lib/utils';
import { parseUserCsv } from './userCsv';

const blank = { name: '', email: '', password: '', role: 'user' };
const BATCH_SIZE = 10;

const tabClass = (active: boolean) =>
	cn('min-w-fit p-1.5 text-sm transition', active ? '' : 'text-muted-foreground/60 hover:text-foreground');

/**
 * Ports admin/Users/UserList/AddUserModal.svelte: a form for one user, or a
 * CSV of many (Name, Email, Password, Role; rows go to the server ten at a
 * time so a large file does not open hundreds of requests at once).
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
	const token = useAuthStore((s) => s.token) ?? '';
	const [tab, setTab] = useState<'form' | 'import'>('form');
	const [user, setUser] = useState(blank);
	const [file, setFile] = useState<File | null>(null);
	const [loading, setLoading] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (open) {
			setUser(blank);
			setFile(null);
		}
	}, [open]);

	const submitOne = async () => {
		setLoading(true);
		const res = await addUser(token, user.name, user.email, user.password, user.role, generateInitialsImage(user.name)).catch(
			(error) => {
				toast.error(`${error}`);
				return null;
			}
		);
		setLoading(false);
		if (res) {
			onSaved();
			onOpenChange(false);
		}
	};

	const submitCsv = async () => {
		if (!file) {
			toast.error('File not found.');
			return;
		}
		setLoading(true);
		const { validRows, invalidRows } = parseUserCsv(await file.text());
		invalidRows.forEach((idx) => toast.error(`Row ${idx + 1}: invalid format.`));

		let userCount = 0;
		for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
			const results = await Promise.all(
				validRows.slice(i, i + BATCH_SIZE).map(({ idx, columns }) =>
					addUser(token, columns[0], columns[1], columns[2], columns[3].toLowerCase(), generateInitialsImage(columns[0])).catch(
						(error) => {
							toast.error(`Row ${idx + 1}: ${error}`);
							return null;
						}
					)
				)
			);
			userCount += results.filter(Boolean).length;
		}
		toast.success(`Successfully imported ${userCount} users.`);
		setFile(null);
		if (fileInput.current) fileInput.current.value = '';
		setLoading(false);
		onSaved();
	};

	const field = 'w-full bg-transparent text-sm outline-hidden';
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="text-sm font-medium">Add User</DialogTitle>
					<DialogDescription className="sr-only">Create a user, or import several from a CSV file.</DialogDescription>
				</DialogHeader>
				<form
					className="flex w-full flex-col"
					onSubmit={(e) => {
						e.preventDefault();
						tab === 'form' ? submitOne() : submitCsv();
					}}
				>
					<div className="-mt-2 mb-1.5 flex w-fit gap-1 overflow-x-auto text-center text-sm font-normal">
						<button type="button" className={tabClass(tab === 'form')} onClick={() => setTab('form')}>
							Form
						</button>
						<button type="button" className={tabClass(tab === 'import')} onClick={() => setTab('import')}>
							CSV Import
						</button>
					</div>

					<div className="px-1">
						{tab === 'form' ? (
							<>
								<div className="mb-3 flex w-full flex-col">
									<label className="text-muted-foreground mb-1 text-xs" htmlFor="add-user-role">
										Role
									</label>
									<select
										id="add-user-role"
										className={cn(field, 'rounded-lg capitalize')}
										value={user.role}
										onChange={(e) => setUser({ ...user, role: e.target.value })}
										required
									>
										<option value="pending">pending</option>
										<option value="user">user</option>
										<option value="admin">admin</option>
									</select>
								</div>
								<div className="mt-1 flex w-full flex-col">
									<label className="text-muted-foreground mb-1 text-xs" htmlFor="add-user-name">
										Name
									</label>
									<input
										id="add-user-name"
										className={field}
										type="text"
										value={user.name}
										onChange={(e) => setUser({ ...user, name: e.target.value })}
										placeholder="Enter Your Full Name"
										autoComplete="off"
										required
									/>
								</div>
								<hr className="my-2.5 w-full" />
								<div className="flex w-full flex-col">
									<label className="text-muted-foreground mb-1 text-xs" htmlFor="add-user-email">
										Email
									</label>
									<input
										id="add-user-email"
										className={field}
										type="email"
										value={user.email}
										onChange={(e) => setUser({ ...user, email: e.target.value })}
										placeholder="Enter Your Email"
										required
									/>
								</div>
								<div className="mt-1 flex w-full flex-col">
									<div className="text-muted-foreground mb-1 text-xs">Password</div>
									<SensitiveInput
										className="text-sm"
										value={user.password}
										onChange={(password) => setUser({ ...user, password })}
										placeholder="Enter Your Password"
										autoComplete="off"
									/>
								</div>
							</>
						) : (
							<div>
								<div className="mb-3 w-full">
									<input
										ref={fileInput}
										id="upload-user-csv-input"
										hidden
										type="file"
										accept=".csv"
										onChange={(e) => setFile(e.target.files?.[0] ?? null)}
									/>
									<button
										type="button"
										className="hover:bg-muted w-full rounded-xl border border-dashed bg-transparent py-3 text-center text-sm font-normal"
										onClick={() => fileInput.current?.click()}
									>
										{file ? '1 document(s) selected.' : 'Click here to select a csv file.'}
									</button>
								</div>
								<div className="text-muted-foreground text-xs">
									ⓘ Ensure your CSV file includes 4 columns in this order: Name, Email, Password, Role.{' '}
									<a className="text-foreground underline" href={`${WEBUI_BASE_URL}/static/user-import.csv`}>
										Click here to download user import template file.
									</a>
								</div>
							</div>
						)}
					</div>

					<div className="flex justify-end pt-3">
						<Button type="submit" size="sm" disabled={loading}>
							Save
							{loading && <Spinner className="size-3.5" />}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
