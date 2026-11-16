import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import {
	SettingField,
	SettingInput,
	SettingNumber,
	SettingRow,
	SettingSelect,
	SettingSwitch,
	SettingsForm,
	SettingsSection,
	SettingTextarea
} from '@/components/settings/controls';
import { Disclosure } from '@/components/settings/formFields';
import { InterfaceSettings } from '@/components/settings/InterfaceSettings';
import { FORKED_FROM } from '@/components/settings/personal/About';
import { Button } from '@/components/ui/button';
import { getAdminConfig, updateAdminConfig } from '@/lib/apis/auths';
import { getBanners, setBanners } from '@/lib/apis/configs';
import { WEBUI_BUILD_HASH } from '@/lib/constants';
import { useAdminConfigSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import type { Banner } from '@/lib/types';
import { useAdminSingleUser } from '../adminVisibility';
import { Banners } from './Banners';
import { canAddBanner, newBanner } from './banners';
import { Events } from './Events';

type AdminConfig = Record<string, any>;
type Draft = { admin: AdminConfig; banners: Banner[] };

/**
 * What is installed (#1003): this app's own build, as Settings > About gives
 * it (the commit and the build day), and the Open WebUI release it was
 * derived from. It used to say "Version v0.11.3", the upstream version, as
 * if it were this app's. There is no upstream release to check against.
 */
function AboutBlock() {
	return (
		<SettingsSection first>
			<div className="min-w-0 text-dense">
				<div className="text-foreground-muted">Build</div>
				<div className="mt-1 font-mono">
					{WEBUI_BUILD_HASH} · {APP_BUILD_DATE}
				</div>
				<p className="text-foreground-muted mt-1">Derived from Open WebUI {FORKED_FROM} (see NOTICE).</p>
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
		<SettingRow label={label} description={description} labelClassName={muted ? 'text-foreground-muted' : undefined}>
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
export function DefaultInterfaceSettings({
	value,
	onChange
}: {
	value: unknown;
	onChange: (next: Record<string, any>) => void;
}) {
	const [open, setOpen] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);
	// Bumped by Clear, to start the rows' own state (an open font box and what
	// was typed in it) over with the cleared values.
	const [cleared, setCleared] = useState(0);
	const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
	const autocompleteEnabled = useConfigStore((s) => Boolean(s.config?.features?.enable_autocomplete_generation));
	const defaults = interfaceDefaults(value);
	const count = Object.keys(defaults).length;
	const counted = `${count} ${count === 1 ? 'setting' : 'settings'}`;
	// #960: the panel opens below the last row of the tab; the Disclosure brings it into view.
	return (
		<>
			<Disclosure
				title="Default interface settings"
				description="What every account starts from. A personal setting overrides its default."
				open={open}
				onOpenChange={setOpen}
			>
				<div className="space-y-2">
					<div className="flex items-center justify-between gap-4">
						<div className="text-foreground-muted text-dense">{counted} configured</div>
						{count > 0 && (
							<Button variant="outline" size="sm" type="button" onClick={() => setConfirmClear(true)}>
								Clear defaults
							</Button>
						)}
					</div>
					<InterfaceSettings
						key={cleared}
						mode="defaults"
						values={defaults}
						onChange={(p) => onChange({ ...defaults, ...p })}
						isAdmin={isAdmin}
						canTemporaryChat
						autocompleteEnabled={autocompleteEnabled}
					/>
				</div>
			</Disclosure>
			<ConfirmDialog
				open={confirmClear}
				onOpenChange={setConfirmClear}
				destructive
				title="Clear the default interface settings?"
				confirmLabel="Clear defaults"
				onConfirm={() => {
					onChange({});
					setCleared((n) => n + 1);
					setConfirmClear(false);
				}}
			>
				Removes the {counted} set here. Once you save, every account without its own setting uses the app's defaults.
			</ConfirmDialog>
		</>
	);
}

/** Ports admin/Settings/General.svelte. */
export default function General() {
	const token = useAuthStore((s) => s.token) ?? '';
	const saved = useAdminConfigSaved();
	const queryClient = useQueryClient();
	const { draft, setDraft, dirty, discard, commit, isLoading } = useConfigDraft<Draft>(['general'], async () => ({
		admin: await getAdminConfig(token),
		banners: await getBanners(token).catch(() => [] as Banner[])
	}));
	const [saving, setSaving] = useState(false);
	// S5-D2: while this is the only account and sign-ups are off, the parts for other people are hidden (stored values stay).
	const singleUser = useAdminSingleUser();

	const patch = (changes: AdminConfig) => setDraft((d) => d && { ...d, admin: { ...d.admin, ...changes } });
	const setBannerList = (banners: Banner[]) => setDraft((d) => d && { ...d, banners });

	const save = async () => {
		if (!draft) return;
		setSaving(true);
		try {
			const res = await updateAdminConfig(token, draft.admin);
			await setBanners(token, draft.banners);
			// The new chat's banners (ChatBanners) show the saved list, not a cached one.
			void queryClient.invalidateQueries({ queryKey: ['banners'] });
			if (res) {
				commit(draft);
				await saved();
			} else toast.error('Failed to update settings');
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			setSaving(false);
		}
	};

	const admin = draft?.admin;

	return (
		<SettingsForm title="General" loading={isLoading} onSubmit={save} saving={saving} dirty={dirty} onDiscard={discard}>
			{draft && admin && (
				<>
					<AboutBlock />

					<SettingsSection title="Features">
						<Toggle
							config={admin}
							patch={patch}
							name="ENABLE_MESSAGE_RATING"
							label="Message Rating"
							description="Show thumbs up and down under each reply, to rate it."
						/>
						<Toggle
							config={admin}
							patch={patch}
							name="ENABLE_FOLDERS"
							label="Folders"
							description="Organize chats into folders."
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
							description="Save facts about you that replies can draw on."
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
							description="Write and keep notes beside your chats."
						/>
						<Toggle
							config={admin}
							patch={patch}
							name="ENABLE_BENCHMARKS"
							label="Benchmarks"
							description="Show the Benchmarks section."
						/>
						{!singleUser && (
							<Toggle
								config={admin}
								patch={patch}
								name="ENABLE_CHANNELS"
								label="Channels"
								description="Rooms where several accounts and models talk together."
							/>
						)}
						{!singleUser && admin.ENABLE_CHANNELS && (
							<SettingRow
								label="Model Response Mode"
								description="Choose where model responses to root-level channel mentions are posted."
								labelClassName="text-foreground-muted"
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
							description="Show the calendar and its events."
						/>
						<Toggle
							config={admin}
							patch={patch}
							name="ENABLE_AUTOMATIONS"
							label="Automations"
							description="Create automations that run prompts on a schedule."
						/>
						{!singleUser && (
							<>
								<Toggle
									config={admin}
									patch={patch}
									name="ENABLE_USER_WEBHOOKS"
									label="User Webhooks"
									description="Let each account set a webhook for its own notifications."
								/>
								<Toggle
									config={admin}
									patch={patch}
									name="ENABLE_USER_STATUS"
									label="User Status"
									description="Let each account set a status: an emoji and a short message."
								/>

								<SettingField
									label="Response Watermark"
									description="Text added to the end of every reply. Leave empty for none."
									htmlFor="response-watermark"
								>
									<SettingTextarea
										id="response-watermark"
										placeholder="e.g. Written with local-llm."
										value={admin.RESPONSE_WATERMARK ?? ''}
										onChange={(e) => patch({ RESPONSE_WATERMARK: e.target.value })}
									/>
								</SettingField>
							</>
						)}

						<SettingField
							label="App URL"
							description="The address people open this app at. Links in notifications point here."
							htmlFor="webui-url"
						>
							<SettingInput
								id="webui-url"
								type="text"
								placeholder="e.g. http://127.0.0.1:4000"
								value={admin.WEBUI_URL ?? ''}
								onChange={(e) => patch({ WEBUI_URL: e.target.value })}
							/>
						</SettingField>
					</SettingsSection>

					<Events />

					<SettingsSection title="UI">
						{!singleUser && (
							<div>
								<div className="mb-2 flex w-full items-start justify-between gap-4">
									<div className="min-w-0">
										<div className="text-muted-foreground text-xs">Banners</div>
										<p className="text-foreground-muted mt-1.5 text-caption">
											Announcements shown above new chats, to every account.
										</p>
									</div>
									<Button
										variant="ghost"
										size="icon-sm"
										className="justify-center"
										type="button"
										aria-label="Add banner"
										onClick={() => canAddBanner(draft.banners) && setBannerList([...draft.banners, newBanner()])}
									>
										<Plus className="size-4" />
									</Button>
								</div>
								<Banners banners={draft.banners} onChange={setBannerList} />
							</div>
						)}
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
