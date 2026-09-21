import { Plus } from 'lucide-react';
import DOMPurify from 'dompurify';
import { useState } from 'react';
import { toast } from 'sonner';
import { Tip } from '@/components/common/Tip';
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
import { getVersionUpdates } from '@/lib/apis';
import { getAdminConfig, updateAdminConfig } from '@/lib/apis/auths';
import { getBanners, setBanners } from '@/lib/apis/configs';
import { WEBUI_BUILD_HASH, WEBUI_VERSION } from '@/lib/constants';
import { useAdminConfigSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import type { Banner } from '@/lib/types';
import { compareVersion } from '@/lib/utils/plugins';
import { Banners } from './Banners';
import { canAddBanner, newBanner } from './banners';
import { Events } from './Events';

type AdminConfig = Record<string, any>;
type Draft = { admin: AdminConfig; banners: Banner[] };

const linkClass = 'hover:text-foreground transition-colors';
const externalLink = { target: '_blank', rel: 'noopener noreferrer' } as const;

type License = { type?: string; organization_name?: string; seats?: number | null; html?: string };

/** The version line, its update check, and the help and license blurbs. */
function AboutBlock() {
	const token = useAuthStore((s) => s.token) ?? '';
	const config = useConfigStore((s) => s.config);
	const [version, setVersion] = useState({ current: WEBUI_VERSION, latest: WEBUI_VERSION });
	// null while checking; otherwise whether a newer release exists.
	const [updateAvailable, setUpdateAvailable] = useState<boolean | null>(false);
	const license = config?.license_metadata as License | null | undefined;
	const checkEnabled = Boolean(config?.features?.enable_version_update_check);

	const check = async () => {
		setUpdateAvailable(null);
		const res = await getVersionUpdates(token).catch(() => ({ current: WEBUI_VERSION, latest: WEBUI_VERSION }));
		setVersion(res);
		setUpdateAvailable(compareVersion(res.latest, res.current));
	};

	return (
		<SettingsSection first>
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0 text-xs">
					<div className="text-muted-foreground">Version</div>
					<div className="mt-1 flex flex-wrap gap-x-1">
						<Tip content={WEBUI_BUILD_HASH}>
							<span>v{WEBUI_VERSION}</span>
						</Tip>
						{checkEnabled && (
							<a className="text-muted-foreground hover:text-foreground" href={`https://github.com/open-webui/open-webui/releases/tag/v${version.latest}`} {...externalLink}>
								{updateAvailable === null ? 'Checking for updates...' : updateAvailable ? `(v${version.latest} available!)` : '(latest)'}
							</a>
						)}
					</div>
				</div>
				{checkEnabled && (
					<button type="button" className="text-muted-foreground hover:text-foreground shrink-0 text-xs transition-colors" onClick={check}>
						Check for updates
					</button>
				)}
			</div>

			<div className="text-xs">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="text-muted-foreground">Help</div>
						{/* LICENSE covers this Open WebUI wordmark.
						    Do not alter, remove, obscure, or replace it except as LICENSE permits:
						    https://docs.openwebui.com/license. */}
						<p className="text-muted-foreground/70 mt-0.5">Discover how to use Open WebUI and seek support from the community.</p>
					</div>
					<a className="text-muted-foreground hover:text-foreground shrink-0 transition-colors" href="https://docs.openwebui.com/" {...externalLink}>
						Documentation
					</a>
				</div>
				<div className="text-muted-foreground/70 mt-1 flex flex-wrap gap-x-3 gap-y-1">
					<a className={linkClass} href="https://discord.gg/5rJgQTnV4s" {...externalLink}>
						Discord
					</a>
					<a className={linkClass} href="https://twitter.com/OpenWebUI" {...externalLink}>
						X
					</a>
					<a className={linkClass} href="https://github.com/open-webui/open-webui" {...externalLink}>
						GitHub
					</a>
				</div>
			</div>

			<div className="text-xs">
				{/* LICENSE covers this Open WebUI license attribution.
				    Do not alter, remove, obscure, or replace it except as LICENSE permits:
				    https://docs.openwebui.com/license. */}
				<div className="text-muted-foreground">License</div>
				{license ? (
					<>
						<a href="https://docs.openwebui.com/enterprise" className="text-muted-foreground mt-0.5 block" {...externalLink}>
							<span className="text-foreground capitalize">{license.type} license</span> registered to <span className="text-foreground capitalize">{license.organization_name}</span> for{' '}
							<span className="text-foreground">{license.seats ?? 'Unlimited'} users.</span>
						</a>
						{license.html && <div className="text-muted-foreground mt-0.5" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(license.html) }} />}
					</>
				) : (
					<a className="text-muted-foreground/70 hover:text-foreground mt-0.5 block transition-colors" href="https://docs.openwebui.com/enterprise" {...externalLink}>
						Upgrade to a licensed plan for enhanced capabilities, including custom theming and branding, and dedicated support.
					</a>
				)}
			</div>
		</SettingsSection>
	);
}

/** A labelled on/off row bound to one key of the admin config. */
function Toggle({ config, patch, name, label, description, muted }: { config: AdminConfig; patch: (p: AdminConfig) => void; name: string; label: string; description: string; muted?: boolean }) {
	return (
		<SettingRow label={label} description={description} labelClassName={muted ? 'text-muted-foreground/70' : undefined}>
			{(id) => <SettingSwitch checked={config[name]} onChange={(v) => patch({ [name]: v })} labelledBy={id} />}
		</SettingRow>
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
						<Toggle config={admin} patch={patch} name="ENABLE_COMMUNITY_SHARING" label="Community Sharing" description="Allow users to share chats with the Open WebUI community." />
						<Toggle config={admin} patch={patch} name="ENABLE_MESSAGE_RATING" label="Message Rating" description="Let users rate assistant responses." />
						<Toggle config={admin} patch={patch} name="ENABLE_FOLDERS" label="Folders" description="Allow users to organize chats into folders." />
						{admin.ENABLE_FOLDERS && (
							<SettingField label="Folder Max File Count" description="Maximum number of files allowed per folder." htmlFor="folder-max-file-count">
								<SettingNumber id="folder-max-file-count" min={0} placeholder="Leave empty for unlimited" value={admin.FOLDER_MAX_FILE_COUNT} onChange={(v) => patch({ FOLDER_MAX_FILE_COUNT: v === '' ? null : v })} />
							</SettingField>
						)}
						<Toggle config={admin} patch={patch} name="ENABLE_MEMORIES" label="Memories" description="Allow users to save memories for more personalized responses." />
						{admin.ENABLE_MEMORIES && <Toggle muted config={admin} patch={patch} name="ENABLE_MEMORY_SYSTEM_CONTEXT" label="Memory System Context" description="Include saved memories in the system context." />}
						<Toggle config={admin} patch={patch} name="ENABLE_NOTES" label="Notes" description="Allow users to create and manage notes." />
						<Toggle config={admin} patch={patch} name="ENABLE_CHANNELS" label="Channels" description="Allow users to use channels for shared conversations." />
						{admin.ENABLE_CHANNELS && (
							<SettingRow label="Model Response Mode" description="Choose where model responses to root-level channel mentions are posted." labelClassName="text-muted-foreground/70">
								<SettingSelect value={admin.CHANNEL_MODEL_RESPONSE_MODE} onChange={(v) => patch({ CHANNEL_MODEL_RESPONSE_MODE: v })} aria-label="Model Response Mode">
									<option value="thread">Thread</option>
									<option value="channel">Channel</option>
								</SettingSelect>
							</SettingRow>
						)}
						<Toggle config={admin} patch={patch} name="ENABLE_CALENDAR" label="Calendar" description="Allow users to access calendar features." />
						<Toggle config={admin} patch={patch} name="ENABLE_AUTOMATIONS" label="Automations" description="Allow users to create and run automations." />
						<Toggle config={admin} patch={patch} name="ENABLE_USER_WEBHOOKS" label="User Webhooks" description="Allow users to configure webhooks from their account." />
						<Toggle config={admin} patch={patch} name="ENABLE_USER_STATUS" label="User Status" description="Show user status information in the app." />

						<SettingField label="Response Watermark" description="Append a watermark to assistant responses when configured." htmlFor="response-watermark">
							<SettingTextarea id="response-watermark" placeholder="Enter a watermark for the response. Leave empty for none." value={admin.RESPONSE_WATERMARK ?? ''} onChange={(e) => patch({ RESPONSE_WATERMARK: e.target.value })} />
						</SettingField>

						<SettingField label="WebUI URL" description="Enter the public URL of your WebUI. This URL will be used to generate links in the notifications." htmlFor="webui-url">
							<SettingInput id="webui-url" type="text" placeholder={`e.g.) "http://localhost:3000"`} value={admin.WEBUI_URL ?? ''} onChange={(e) => patch({ WEBUI_URL: e.target.value })} />
						</SettingField>
					</SettingsSection>

					<Events />

					<SettingsSection title="UI">
						<div>
							<div className="mb-2 flex w-full items-start justify-between gap-4">
								<div className="min-w-0">
									<div className="text-muted-foreground text-xs">Banners</div>
									<p className="text-muted-foreground/70 mt-1.5 text-[0.6875rem]">Create announcements shown to users in the app.</p>
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
					</SettingsSection>
				</>
			)}
		</SettingsForm>
	);
}
