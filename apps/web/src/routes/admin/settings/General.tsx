import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Tip } from '@/components/common/Tip';
import { InterfaceSettings } from '@/components/settings/InterfaceSettings';
import {
	SettingField,
	SettingInput,
	SettingNumber,
	SettingRow,
	SettingSelect,
	SettingSwitch,
	SettingTextarea,
	SettingsForm,
	SettingsSection
} from '@/components/settings/controls';
import { getAdminConfig, updateAdminConfig } from '@/lib/apis/auths';
import { getBanners, setBanners } from '@/lib/apis/configs';
import { WEBUI_BUILD_HASH, WEBUI_VERSION } from '@/lib/constants';
import { useAdminConfigSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import type { Banner } from '@/lib/types';
import { Banners } from './Banners';
import { canAddBanner, newBanner } from './banners';
import { Events } from './Events';

type AdminConfig = Record<string, any>;
type Draft = { admin: AdminConfig; banners: Banner[] };

/** The installed version; there is no upstream release to check against. */
function AboutBlock() {
	return (
		<SettingsSection first>
			<div className="min-w-0 text-xs">
				<div className="text-muted-foreground">Version</div>
				<div className="mt-1">
					<Tip content={WEBUI_BUILD_HASH}>
						<span>v{WEBUI_VERSION}</span>
					</Tip>
				</div>
			</div>
		</SettingsSection>
	);
}

/** A labelled on/off row bound to one key of the admin config. */
function Toggle({
	config,
	patch,
	name,
	label,
	description,
	muted
}: {
	config: AdminConfig;
	patch: (p: AdminConfig) => void;
	name: string;
	label: string;
	description: string;
	muted?: boolean;
}) {
	return (
		<SettingRow label={label} description={description} labelClassName={muted ? 'text-muted-foreground/70' : undefined}>
			{(id) => <SettingSwitch checked={config[name]} onChange={(v) => patch({ [name]: v })} labelledBy={id} />}
		</SettingRow>
	);
}

/** Only a plain object counts as defaults; anything else (null, an array) is treated as none. */
export const interfaceDefaults = (value: unknown): Record<string, any> =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};

/**
 * "Default Interface Settings": the interface preferences every account starts
 * from (a user's own setting overrides one). Folded away by default; the edits
 * go into the draft and are saved with the rest of the tab.
 */
function DefaultInterfaceSettings({
	value,
	onChange
}: {
	value: unknown;
	onChange: (next: Record<string, any>) => void;
}) {
	const [open, setOpen] = useState(false);
	const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
	const autocompleteEnabled = useConfigStore((s) => Boolean(s.config?.features?.enable_autocomplete_generation));
	const defaults = interfaceDefaults(value);
	const count = Object.keys(defaults).length;
	return (
		<div>
			<div className="flex w-full items-start justify-between gap-4">
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground min-w-0 flex-1 text-left text-xs transition"
					aria-expanded={open}
					onClick={() => setOpen((v) => !v)}
				>
					<div>Default Interface Settings</div>
					<div className="text-muted-foreground/70 mt-1.5 text-[0.6875rem]">
						Set system-wide interface defaults for every account. Personal settings override these defaults.
					</div>
				</button>
				<button
					type="button"
					aria-label={`${open ? 'Close' : 'Configure'} Default Interface Settings`}
					className="text-muted-foreground hover:text-foreground shrink-0 text-[0.6875rem] transition"
					onClick={() => setOpen((v) => !v)}
				>
					{open ? 'Close' : 'Configure'}
				</button>
			</div>
			{open && (
				<div className="mt-2 space-y-2">
					<div className="flex items-center justify-between gap-4">
						<div className="text-muted-foreground/70 text-[0.6875rem]">{count} settings configured</div>
						{count > 0 && (
							<button
								type="button"
								className="text-muted-foreground hover:text-foreground text-[0.6875rem] transition"
								onClick={() => onChange({})}
							>
								Clear
							</button>
						)}
					</div>
					<div className="max-h-[28rem] overflow-y-auto rounded-lg border p-3">
						<InterfaceSettings
							mode="defaults"
							values={defaults}
							onChange={(p) => onChange({ ...defaults, ...p })}
							isAdmin={isAdmin}
							canTemporaryChat
							autocompleteEnabled={autocompleteEnabled}
						/>
					</div>
				</div>
			)}
		</div>
	);
}

/** Ports admin/Settings/General.svelte. */
export default function General() {
	const token = useAuthStore((s) => s.token) ?? '';
	const saved = useAdminConfigSaved();
	const { draft, setDraft, isLoading } = useConfigDraft<Draft>(['general'], async () => ({
		admin: await getAdminConfig(token),
		banners: await getBanners(token).catch(() => [] as Banner[])
	}));
	const [saving, setSaving] = useState(false);

	const patch = (changes: AdminConfig) => setDraft((d) => d && { ...d, admin: { ...d.admin, ...changes } });
	const setBannerList = (banners: Banner[]) => setDraft((d) => d && { ...d, banners });

	const save = async () => {
		if (!draft) return;
		setSaving(true);
		try {
			const res = await updateAdminConfig(token, draft.admin);
			await setBanners(token, draft.banners);
			if (res) await saved();
			else toast.error('Failed to update settings');
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			setSaving(false);
		}
	};

	const admin = draft?.admin;

	return (
		<SettingsForm title="General" loading={isLoading} onSubmit={save} saving={saving}>
			{draft && admin && (
				<>
					<AboutBlock />

					<SettingsSection title="Features">
						<Toggle
							config={admin}
							patch={patch}
							name="ENABLE_MESSAGE_RATING"
							label="Message Rating"
							description="Let users rate assistant responses."
						/>
						<Toggle
							config={admin}
							patch={patch}
							name="ENABLE_FOLDERS"
							label="Folders"
							description="Allow users to organize chats into folders."
						/>
						{admin.ENABLE_FOLDERS && (
							<SettingField
								label="Folder Max File Count"
								description="Maximum number of files allowed per folder."
								htmlFor="folder-max-file-count"
							>
								<SettingNumber
									id="folder-max-file-count"
									min={0}
									placeholder="Leave empty for unlimited"
									value={admin.FOLDER_MAX_FILE_COUNT}
									onChange={(v) => patch({ FOLDER_MAX_FILE_COUNT: v === '' ? null : v })}
								/>
							</SettingField>
						)}
						<Toggle
							config={admin}
							patch={patch}
							name="ENABLE_MEMORIES"
							label="Memories"
							description="Allow users to save memories for more personalized responses."
						/>
						{admin.ENABLE_MEMORIES && (
							<Toggle
								muted
								config={admin}
								patch={patch}
								name="ENABLE_MEMORY_SYSTEM_CONTEXT"
								label="Memory System Context"
								description="Include saved memories in the system context."
							/>
						)}
						<Toggle
							config={admin}
							patch={patch}
							name="ENABLE_NOTES"
							label="Notes"
							description="Allow users to create and manage notes."
						/>
						<Toggle
							config={admin}
							patch={patch}
							name="ENABLE_BENCHMARKS"
							label="Benchmarks"
							description="Show the Benchmarks section (admins only)."
						/>
						<Toggle
							config={admin}
							patch={patch}
							name="ENABLE_CHANNELS"
							label="Channels"
							description="Allow users to use channels for shared conversations."
						/>
						{admin.ENABLE_CHANNELS && (
							<SettingRow
								label="Model Response Mode"
								description="Choose where model responses to root-level channel mentions are posted."
								labelClassName="text-muted-foreground/70"
							>
								<SettingSelect
									value={admin.CHANNEL_MODEL_RESPONSE_MODE}
									onChange={(v) => patch({ CHANNEL_MODEL_RESPONSE_MODE: v })}
									aria-label="Model Response Mode"
								>
									<option value="thread">Thread</option>
									<option value="channel">Channel</option>
								</SettingSelect>
							</SettingRow>
						)}
						<Toggle
							config={admin}
							patch={patch}
							name="ENABLE_CALENDAR"
							label="Calendar"
							description="Allow users to access calendar features."
						/>
						<Toggle
							config={admin}
							patch={patch}
							name="ENABLE_AUTOMATIONS"
							label="Automations"
							description="Allow users to create and run automations."
						/>
						<Toggle
							config={admin}
							patch={patch}
							name="ENABLE_USER_WEBHOOKS"
							label="User Webhooks"
							description="Allow users to configure webhooks from their account."
						/>
						<Toggle
							config={admin}
							patch={patch}
							name="ENABLE_USER_STATUS"
							label="User Status"
							description="Show user status information in the app."
						/>

						<SettingField
							label="Response Watermark"
							description="Append a watermark to assistant responses when configured."
							htmlFor="response-watermark"
						>
							<SettingTextarea
								id="response-watermark"
								placeholder="Enter a watermark for the response. Leave empty for none."
								value={admin.RESPONSE_WATERMARK ?? ''}
								onChange={(e) => patch({ RESPONSE_WATERMARK: e.target.value })}
							/>
						</SettingField>

						<SettingField
							label="WebUI URL"
							description="Enter the public URL of your WebUI. This URL will be used to generate links in the notifications."
							htmlFor="webui-url"
						>
							<SettingInput
								id="webui-url"
								type="text"
								placeholder={`e.g.) "http://localhost:3000"`}
								value={admin.WEBUI_URL ?? ''}
								onChange={(e) => patch({ WEBUI_URL: e.target.value })}
							/>
						</SettingField>
					</SettingsSection>

					<Events />

					<SettingsSection title="UI">
						<div>
							<div className="mb-2 flex w-full items-start justify-between gap-4">
								<div className="min-w-0">
									<div className="text-muted-foreground text-xs">Banners</div>
									<p className="text-muted-foreground/70 mt-1.5 text-[0.6875rem]">
										Create announcements shown to users in the app.
									</p>
								</div>
								<button
									type="button"
									aria-label="Add banner"
									className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 items-center justify-center rounded-lg transition-colors"
									onClick={() => canAddBanner(draft.banners) && setBannerList([...draft.banners, newBanner()])}
								>
									<Plus className="size-4" />
								</button>
							</div>
							<Banners banners={draft.banners} onChange={setBannerList} />
						</div>
						<DefaultInterfaceSettings
							value={admin.DEFAULT_INTERFACE_SETTINGS}
							onChange={(DEFAULT_INTERFACE_SETTINGS) => patch({ DEFAULT_INTERFACE_SETTINGS })}
						/>
					</SettingsSection>
				</>
			)}
		</SettingsForm>
	);
}
