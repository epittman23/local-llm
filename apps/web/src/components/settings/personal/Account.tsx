import { Copy, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createAPIKey, deleteAPIKey, getAPIKey, getSessionUser, updateUserPassword, updateUserProfile } from '@/lib/apis/auths';
import { getUserVariables, updateUserVariables } from '@/lib/apis/users';
import { signOut } from '@/lib/auth/session';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { SettingField, SettingInput, SettingTextarea, SettingsForm, SettingsSection } from '../controls';
import { type VariableRow, variableRows, variablesPayload } from './personalSettings';

type Profile = { name: string; profile_image_url: string; bio?: string | null; gender?: string | null; date_of_birth?: string | null };
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
	const [customGender, setCustomGender] = useState(false);
	const [rows, setRows] = useState<VariableRow[]>([]);
	const [saving, setSaving] = useState(false);
	const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
	const [apiKey, setApiKey] = useState('');
	const [confirmDeleteKey, setConfirmDeleteKey] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);
	const perms = user?.permissions as { features?: { api_keys?: boolean } } | undefined;
	const canApiKeys = (features.enable_api_keys ?? true) !== false && (user?.role === 'admin' || Boolean(perms?.features?.api_keys));
	const canPassword = Boolean(features.enable_login_form) && Boolean(features.enable_password_change_form);

	useEffect(() => {
		let live = true;
		void (async () => {
			const u = ((await getSessionUser(token).catch(() => null)) ?? user ?? {}) as Profile;
			const vars = await getUserVariables(token).catch(() => null);
			if (!live) return;
			setProfile({ name: u.name ?? '', profile_image_url: u.profile_image_url ?? '', bio: u.bio ?? '', gender: u.gender ?? '', date_of_birth: u.date_of_birth ?? '' });
			setCustomGender(!GENDERS.includes(u.gender ?? ''));
			setRows(variableRows((vars as { variables?: unknown } | null)?.variables));
			if (canApiKeys) setApiKey(((await getAPIKey(token).catch(() => '')) as string) ?? '');
		})();
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [token]);

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
			const saved = await updateUserVariables(token, variables);
			if (updated && user) setSession(token, { ...user, name: profile.name, profile_image_url: profile.profile_image_url });
			setRows(variableRows((saved as { variables?: unknown } | null)?.variables ?? variables));
			toast.success('Settings saved successfully!');
		} catch (e) {
			toast.error(`${e}`);
		}
		setSaving(false);
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

	return (
		<SettingsForm title="Account" onSubmit={save} saving={saving} loading={!profile}>
			{profile && (
				<>
					<SettingsSection title="Profile" first>
						<div className="flex items-center gap-3">
							<img src={profile.profile_image_url || '/user.png'} alt="Profile" className="size-14 rounded-full object-cover" />
							<div className="flex flex-col items-start gap-1 text-xs">
								<input ref={fileRef} type="file" accept="image/*" hidden aria-label="Upload profile image" onChange={(e) => void onImage(e)} />
								<button type="button" className="underline" onClick={() => fileRef.current?.click()}>
									Upload image
								</button>
								<button type="button" className="text-muted-foreground underline" onClick={() => set({ profile_image_url: '/user.png' })}>
									Remove
								</button>
							</div>
						</div>
						<SettingField label="Name" htmlFor="account-name"><SettingInput id="account-name" value={profile.name} required onChange={(e) => set({ name: e.target.value })} /></SettingField>
						<SettingField label="Bio" htmlFor="account-bio"><SettingTextarea id="account-bio" rows={2} value={profile.bio ?? ''} placeholder="Share your background and interests" onChange={(e) => set({ bio: e.target.value })} /></SettingField>
						<SettingField label="Gender" htmlFor="account-gender">
								<div className="flex flex-col gap-1">
									<select
										id="account-gender"
										className="border-input h-8 rounded-md border bg-transparent px-2 text-xs"
										value={customGender ? 'custom' : (profile.gender ?? '')}
										onChange={(e) => {
											const v = e.target.value;
											setCustomGender(v === 'custom');
											set({ gender: v === 'custom' ? '' : v });
										}}
									>
										<option value="">Prefer not to say</option>
										<option value="female">Female</option>
										<option value="male">Male</option>
										<option value="custom">Custom</option>
									</select>
									{customGender && <SettingInput aria-label="Custom gender" value={profile.gender ?? ''} placeholder="Enter your gender" onChange={(e) => set({ gender: e.target.value })} />}
								</div>
						</SettingField>
						<SettingField label="Birth Date" htmlFor="account-birth-date"><SettingInput id="account-birth-date" type="date" value={profile.date_of_birth ?? ''} onChange={(e) => set({ date_of_birth: e.target.value })} /></SettingField>
					</SettingsSection>

					<SettingsSection title="User Variables">
						<p className="text-muted-foreground text-xs">
							Use them in prompts as <code>{'{{user.variables.key_name}}'}</code>.
						</p>
						{rows.length === 0 && <p className="text-muted-foreground text-xs">No user variables configured.</p>}
						<ul className="flex flex-col gap-1.5" aria-label="User variables">
							{rows.map((row, i) => (
								<li key={i} className="flex items-center gap-1.5">
									<SettingInput aria-label="Variable key" placeholder="key_name" value={row.key} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))} />
									<SettingInput aria-label="Variable value" placeholder="Value" value={row.value} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))} />
									<Button type="button" size="icon-sm" variant="ghost" aria-label="Remove variable" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
										<Trash2 className="size-3.5" />
									</Button>
								</li>
							))}
						</ul>
						<Button type="button" size="sm" variant="outline" className="self-start" onClick={() => setRows([...rows, { key: '', value: '' }])}>
							<Plus className="size-3.5" /> Add Variable
						</Button>
					</SettingsSection>

					{canPassword && (
						<SettingsSection title="Change Password">
							{/* Its own inputs, submitted by its own button: the tab's Save must not change the password. */}
							<SettingInput type="password" aria-label="Current Password" placeholder="Current Password" autoComplete="current-password" value={passwords.current} onChange={(e) => setPasswords({ ...passwords, current: e.target.value })} />
							<SettingInput type="password" aria-label="New Password" placeholder="New Password" autoComplete="new-password" value={passwords.next} onChange={(e) => setPasswords({ ...passwords, next: e.target.value })} />
							<SettingInput type="password" aria-label="Confirm Password" placeholder="Confirm Password" autoComplete="new-password" value={passwords.confirm} onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })} />
							<Button type="button" size="sm" variant="outline" className="self-start" disabled={!passwords.current || !passwords.next} onClick={() => void changePassword()}>
								Update password
							</Button>
						</SettingsSection>
					)}

					{canApiKeys && (
						<SettingsSection title="API Key">
							{apiKey ? (
								<div className="flex items-center gap-1.5">
									<Input readOnly type="password" aria-label="API Key" value={apiKey} className="h-8 text-xs" />
									<Button
										type="button"
										size="icon-sm"
										variant="ghost"
										aria-label="Copy API key"
										onClick={() => void navigator.clipboard.writeText(apiKey).then(() => toast.success('Copied to clipboard'))}
									>
										<Copy className="size-3.5" />
									</Button>
									<Button type="button" size="icon-sm" variant="ghost" aria-label="Regenerate API key" onClick={() => void createAPIKey(token).then((k) => k && setApiKey(k)).catch((e) => toast.error(`${e}`))}>
										<RefreshCw className="size-3.5" />
									</Button>
									<Button type="button" size="icon-sm" variant="ghost" aria-label="Delete API key" onClick={() => setConfirmDeleteKey(true)}>
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
