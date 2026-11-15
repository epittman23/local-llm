import { Copy, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
	createAPIKey,
	deleteAPIKey,
	getAPIKey,
	getSessionUser,
	updateUserPassword,
	updateUserProfile
} from '@/lib/apis/auths';
import { errorMessage } from '@/lib/apis/errors';
import { getUserVariables, updateUserVariables } from '@/lib/apis/users';
import { signOut } from '@/lib/auth/session';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { SettingField, SettingInput, SettingsForm, SettingsSection, SettingTextarea } from '../controls';
import { type VariableRow, variableRows, variablesPayload } from './personalSettings';

type Profile = {
	name: string;
	profile_image_url: string;
	bio?: string | null;
	gender?: string | null;
	date_of_birth?: string | null;
};
const GENDERS = ['', 'female', 'male'];

/** Scales an uploaded image to fit 250x250 as a JPEG data URL, as UserProfileImage.svelte does. */
const scaledImage = (file: File) =>
	new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error);
		reader.onload = () => {
			const img = new Image();
			img.onerror = () => reject(new Error('Not an image'));
			img.onload = () => {
				const ratio = img.width / img.height;
				const [w, h] = ratio > 1 ? [250 * ratio, 250] : [250, 250 / ratio];
				const canvas = document.createElement('canvas');
				canvas.width = 250;
				canvas.height = 250;
				canvas.getContext('2d')?.drawImage(img, (250 - w) / 2, (250 - h) / 2, w, h);
				resolve(canvas.toDataURL('image/jpeg'));
			};
			img.src = String(reader.result);
		};
		reader.readAsDataURL(file);
	});

/**
 * Ports Settings/Account.svelte with its UpdatePassword and UserProfileImage:
 * name, picture (upload, scaled to 250px, or removed), bio, gender, birth
 * date and user variables saved together; password change (which signs you
 * out, as the original does); and the API key, where the server and your
 * permissions allow one.
 */
export default function Account() {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const setSession = useAuthStore((s) => s.setSession);
	const config = useConfigStore((s) => s.config);
	const features = (config?.features ?? {}) as Record<string, unknown>;
	const [profile, setProfile] = useState<Profile | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [customGender, setCustomGender] = useState(false);
	const [rows, setRows] = useState<VariableRow[]>([]);
	// The profile and variables as saved: what Discard changes goes back to (#951).
	const [saved, setSaved] = useState<{ profile: Profile; rows: VariableRow[] } | null>(null);
	const [saving, setSaving] = useState(false);
	const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
	// The password fields belong to a form of their own (#260), so Enter in one
	// changes the password instead of saving the tab. Forms cannot nest, so it
	// comes after the tab's form, and the fields name it with `form=`.
	const passwordForm = useId();
	// One password change at a time: a second Enter while the first is in flight
	// would send the old password again, and fail beside the first one's success.
	const changing = useRef(false);
	const [changingPassword, setChangingPassword] = useState(false);
	const [apiKey, setApiKey] = useState('');
	// Why the key did not load. Only a 404 means there is none; on any other
	// failure the tab must not offer to create one, which would replace it (#526).
	const [apiKeyError, setApiKeyError] = useState<string | null>(null);
	const [retryingKey, setRetryingKey] = useState(false);
	const [confirmDeleteKey, setConfirmDeleteKey] = useState(false);
	const [confirmRegenerateKey, setConfirmRegenerateKey] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);
	const perms = user?.permissions as { features?: { api_keys?: boolean } } | undefined;
	const canApiKeys =
		(features.enable_api_keys ?? true) !== false && (user?.role === 'admin' || Boolean(perms?.features?.api_keys));
	const canPassword = Boolean(features.enable_login_form) && Boolean(features.enable_password_change_form);

	const loadAPIKey = useCallback(
		async (live: () => boolean = () => true) => {
			try {
				const key = await getAPIKey(token);
				if (!live()) return;
				setApiKey(key ?? '');
				setApiKeyError(null);
			} catch (e) {
				if (live()) setApiKeyError(errorMessage(e));
			}
		},
		[token]
	);

	useEffect(() => {
		let live = true;
		let failed = false;
		const loadError = (e: unknown) => {
			failed = true;
			if (live) toast.error(`${e}`);
			return null;
		};
		void (async () => {
			const u = ((await getSessionUser(token).catch(loadError)) ?? user ?? {}) as Profile;
			const vars = await getUserVariables(token).catch(loadError);
			if (!live) return;
			// Saving sends the whole profile and every variable, so a part that didn't load would be overwritten.
			setLoadFailed(failed);
			const loaded = {
				name: u.name ?? '',
				profile_image_url: u.profile_image_url ?? '',
				bio: u.bio ?? '',
				gender: u.gender ?? '',
				date_of_birth: u.date_of_birth ?? ''
			};
			const loadedRows = variableRows((vars as { variables?: unknown } | null)?.variables);
			setProfile(loaded);
			setCustomGender(!GENDERS.includes(u.gender ?? ''));
			setRows(loadedRows);
			setSaved({ profile: loaded, rows: loadedRows });
			if (canApiKeys) await loadAPIKey(() => live);
		})();
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [token, loadAPIKey]);

	const save = async () => {
		if (!profile) return;
		let variables: Record<string, string>;
		try {
			variables = variablesPayload(rows);
		} catch (e) {
			toast.error((e as Error).message);
			return;
		}
		setSaving(true);
		try {
			const updated = await updateUserProfile(token, {
				name: profile.name,
				profile_image_url: profile.profile_image_url,
				bio: profile.bio || null,
				gender: profile.gender || null,
				date_of_birth: profile.date_of_birth || null
			});
			const savedVariables = await updateUserVariables(token, variables);
			if (updated && user)
				setSession(token, { ...user, name: profile.name, profile_image_url: profile.profile_image_url });
			const savedRows = variableRows((savedVariables as { variables?: unknown } | null)?.variables ?? variables);
			setRows(savedRows);
			setSaved({ profile, rows: savedRows });
			toast.success('Profile saved');
		} catch (e) {
			toast.error(`${e}`);
		}
		setSaving(false);
	};

	const submitPassword = async (e: FormEvent) => {
		e.preventDefault();
		if (!passwords.current || !passwords.next || changing.current) return;
		changing.current = true;
		setChangingPassword(true);
		try {
			await changePassword();
		} finally {
			changing.current = false;
			setChangingPassword(false);
		}
	};

	const changePassword = async () => {
		if (passwords.next !== passwords.confirm) {
			toast.error("The passwords you entered don't quite match. Please double-check and try again.");
			setPasswords({ ...passwords, next: '', confirm: '' });
			return;
		}
		try {
			if (await updateUserPassword(token, passwords.current, passwords.next)) {
				toast.success('Password updated. Please sign in again.');
				// The session was issued under the old password; the original signs out here too.
				await signOut();
				return;
			}
		} catch (e) {
			toast.error(`${e}`);
		}
		setPasswords({ current: '', next: '', confirm: '' });
	};

	const onImage = async (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = '';
		if (!file || !profile) return;
		try {
			setProfile({ ...profile, profile_image_url: await scaledImage(file) });
		} catch {
			toast.error('Please select a valid image file.');
		}
	};

	const set = (patch: Partial<Profile>) => profile && setProfile({ ...profile, ...patch });
	const dirty = Boolean(saved) && JSON.stringify({ profile, rows }) !== JSON.stringify(saved);
	const discard = () => {
		if (!saved) return;
		setProfile(saved.profile);
		setRows(saved.rows);
		setCustomGender(!GENDERS.includes(saved.profile.gender ?? ''));
	};

	return (
		<SettingsForm
			title="Account"
			onSubmit={save}
			saving={saving}
			dirty={dirty}
			onDiscard={discard}
			loading={!profile}
			disabled={loadFailed}
			after={canPassword && <form id={passwordForm} aria-label="Change Password" hidden onSubmit={submitPassword} />}
		>
			{profile && (
				<>
					{loadFailed && (
						<p role="alert" className="text-destructive mb-3 text-xs">
							Your account settings didn't load, so saving is off. Close Settings and open it again to retry.
						</p>
					)}
					<SettingsSection title="Profile" first>
						<div className="flex items-center gap-3">
							<ProfileAvatar
								src={profile.profile_image_url}
								name={profile.name}
								label="Profile picture"
								className="size-14 text-base"
							/>
							<div className="flex flex-col items-start gap-1 text-xs">
								<input
									ref={fileRef}
									type="file"
									accept="image/*"
									hidden
									aria-label="Upload profile image"
									onChange={(e) => void onImage(e)}
								/>
								<Button variant="link" size="xs" type="button" onClick={() => fileRef.current?.click()}>
									Upload image
								</Button>
								<Button variant="link" size="xs" type="button" onClick={() => set({ profile_image_url: '/user.png' })}>
									Remove
								</Button>
							</div>
						</div>
						<SettingField label="Name" htmlFor="account-name">
							<SettingInput
								id="account-name"
								value={profile.name}
								required
								onChange={(e) => set({ name: e.target.value })}
							/>
						</SettingField>
						{/* Bio, gender and birth date are not a profile anyone sees: each fills a
						    variable in any prompt that uses it (utils/task.py), so each says which (#1088). */}
						<SettingField
							label="Bio"
							optional
							htmlFor="account-bio"
							descriptionId="account-bio-help"
							description={
								<>
									Fills <code>{'{{USER_BIO}}'}</code> in any prompt that uses it.
								</>
							}
						>
							<SettingTextarea
								id="account-bio"
								rows={2}
								value={profile.bio ?? ''}
								aria-describedby="account-bio-help"
								onChange={(e) => set({ bio: e.target.value })}
							/>
						</SettingField>
						<SettingField
							label="Gender"
							optional
							htmlFor="account-gender"
							descriptionId="account-gender-help"
							description={
								<>
									Fills <code>{'{{USER_GENDER}}'}</code> in any prompt that uses it.
								</>
							}
						>
							<div className="flex flex-col gap-1.5">
								<Select
									value={customGender ? 'custom' : profile.gender || 'unset'}
									onValueChange={(v) => {
										setCustomGender(v === 'custom');
										set({ gender: v === 'custom' || v === 'unset' ? '' : v });
									}}
								>
									<SelectTrigger id="account-gender" aria-describedby="account-gender-help" className="w-56 max-w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{/* The shared Select cannot hold an empty value; "unset" stands for none. */}
										<SelectItem value="unset">Prefer not to say</SelectItem>
										<SelectItem value="female">Female</SelectItem>
										<SelectItem value="male">Male</SelectItem>
										<SelectItem value="custom">Custom</SelectItem>
									</SelectContent>
								</Select>
								{customGender && (
									<SettingInput
										aria-label="Custom gender"
										aria-describedby="account-gender-help"
										value={profile.gender ?? ''}
										onChange={(e) => set({ gender: e.target.value })}
									/>
								)}
							</div>
						</SettingField>
						<SettingField
							label="Birth date"
							optional
							htmlFor="account-birth-date"
							descriptionId="account-birth-date-help"
							description={
								<>
									Fills <code>{'{{USER_BIRTH_DATE}}'}</code> and <code>{'{{USER_AGE}}'}</code> in any prompt that uses
									them.
								</>
							}
						>
							<SettingInput
								id="account-birth-date"
								type="date"
								value={profile.date_of_birth ?? ''}
								aria-describedby="account-birth-date-help"
								className="w-56 max-w-full"
								onChange={(e) => set({ date_of_birth: e.target.value })}
							/>
						</SettingField>
					</SettingsSection>

					<SettingsSection title="User Variables">
						<p className="text-muted-foreground text-xs">
							Use them in prompts as <code>{'{{user.variables.key_name}}'}</code>.
						</p>
						{rows.length === 0 && <p className="text-muted-foreground text-xs">No user variables configured.</p>}
						<ul className="flex flex-col gap-1.5" aria-label="User variables">
							{rows.map((row, i) => (
								<li key={i} className="flex items-center gap-1.5">
									<SettingInput
										aria-label="Variable key"
										placeholder="key_name"
										value={row.key}
										onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
									/>
									<SettingInput
										aria-label="Variable value"
										placeholder="Value"
										value={row.value}
										onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
									/>
									<Button
										type="button"
										size="icon-sm"
										variant="ghost"
										aria-label="Remove variable"
										onClick={() => setRows(rows.filter((_, j) => j !== i))}
									>
										<Trash2 className="size-3.5" />
									</Button>
								</li>
							))}
						</ul>
						<Button
							type="button"
							size="sm"
							variant="outline"
							className="self-start"
							onClick={() => setRows([...rows, { key: '', value: '' }])}
						>
							<Plus className="size-3.5" /> Add Variable
						</Button>
					</SettingsSection>

					{canPassword && (
						<SettingsSection title="Change Password">
							{/* Its own form, submitted by its own button or Enter: the tab's Save must not change the password, nor Enter here save the tab. */}
							<SettingField label="Current password" htmlFor="account-password-current">
								<SettingInput
									id="account-password-current"
									type="password"
									form={passwordForm}
									autoComplete="current-password"
									value={passwords.current}
									onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
								/>
							</SettingField>
							<SettingField label="New password" htmlFor="account-password-new">
								<SettingInput
									id="account-password-new"
									type="password"
									form={passwordForm}
									autoComplete="new-password"
									value={passwords.next}
									onChange={(e) => setPasswords({ ...passwords, next: e.target.value })}
								/>
							</SettingField>
							<SettingField
								label="Confirm password"
								htmlFor="account-password-confirm"
								description="Changing it signs you out; sign in again with the new one."
							>
								<SettingInput
									id="account-password-confirm"
									type="password"
									form={passwordForm}
									autoComplete="new-password"
									value={passwords.confirm}
									onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })}
								/>
							</SettingField>
							{/* The section's own primary action (ACT-1): it saves nothing else, and the tab's Save never changes the password. */}
							<Button
								type="submit"
								form={passwordForm}
								className="self-start"
								disabled={!passwords.current || !passwords.next || changingPassword}
								aria-busy={changingPassword || undefined}
							>
								Update password
							</Button>
						</SettingsSection>
					)}

					{canApiKeys && (
						<SettingsSection title="API Key">
							{apiKeyError ? (
								<div className="flex flex-wrap items-center gap-2 text-xs">
									<span className="text-destructive">{`The API key could not be loaded: ${apiKeyError}`}</span>
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={retryingKey}
										onClick={() => {
											setRetryingKey(true);
											void loadAPIKey().finally(() => setRetryingKey(false));
										}}
									>
										Try again
									</Button>
								</div>
							) : apiKey ? (
								<div className="flex items-center gap-1.5">
									<Input readOnly type="password" aria-label="API Key" value={apiKey} className="h-8 text-xs" />
									<Button
										type="button"
										size="icon-sm"
										variant="ghost"
										aria-label="Copy API key"
										onClick={() =>
											void navigator.clipboard.writeText(apiKey).then(() => toast.success('Copied to clipboard'))
										}
									>
										<Copy className="size-3.5" />
									</Button>
									<Button
										type="button"
										size="icon-sm"
										variant="ghost"
										aria-label="Regenerate API key"
										onClick={() => setConfirmRegenerateKey(true)}
									>
										<RefreshCw className="size-3.5" />
									</Button>
									<Button
										type="button"
										size="icon-sm"
										variant="ghost"
										aria-label="Delete API key"
										onClick={() => setConfirmDeleteKey(true)}
									>
										<Trash2 className="size-3.5" />
									</Button>
								</div>
							) : (
								<Button
									type="button"
									size="sm"
									variant="outline"
									className="self-start"
									onClick={() =>
										void createAPIKey(token)
											.then((k) => {
												if (k) {
													setApiKey(k);
													toast.success('API Key created.');
												}
											})
											.catch((e) => toast.error(`${e}`))
									}
								>
									Create new secret key
								</Button>
							)}
						</SettingsSection>
					)}
				</>
			)}
			<ConfirmDialog
				open={confirmRegenerateKey}
				onOpenChange={setConfirmRegenerateKey}
				title="Regenerate API Key"
				onConfirm={() =>
					void createAPIKey(token)
						.then((k) => k && setApiKey(k))
						.catch((e) => toast.error(`${e}`))
				}
			>
				Anything using the current key will stop working.
			</ConfirmDialog>
			<ConfirmDialog
				open={confirmDeleteKey}
				onOpenChange={setConfirmDeleteKey}
				title="Delete API Key"
				onConfirm={() =>
					void deleteAPIKey(token)
						.then(() => setApiKey(''))
						.catch((e) => toast.error(`${e}`))
				}
			>
				Anything using this key will stop working.
			</ConfirmDialog>
		</SettingsForm>
	);
}
