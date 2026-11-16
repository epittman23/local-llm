import { useQueryClient } from '@tanstack/react-query';
import { Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
	SettingRow,
	SettingSwitch,
	SettingsForm,
	SettingsSection,
	useSettingsHost
} from '@/components/settings/controls';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { getConfig, updateConfig } from '@/lib/apis/evaluations';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { toastSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { routePaths } from '@/routes/routePaths';
import { ArenaModelModal } from './ArenaModelModal';
import type { ArenaModel } from './arenaModels';

type Config = { ENABLE_EVALUATION_ARENA_MODELS: boolean; EVALUATION_ARENA_MODELS: ArenaModel[] };

/** Ports Evaluations/Model.svelte: one arena model row, click the cog to edit. */
function ArenaModelRow({
	model,
	onEdit,
	onDelete
}: {
	model: ArenaModel;
	onEdit: (m: ArenaModel) => void;
	onDelete: () => void;
}) {
	const [editing, setEditing] = useState(false);
	return (
		<>
			<ArenaModelModal
				open={editing}
				onOpenChange={setEditing}
				edit
				model={model}
				onSubmit={onEdit}
				onDelete={onDelete}
			/>
			<div className="flex items-center justify-between gap-2 rounded-lg px-1 py-1">
				<div className="flex min-w-0 items-center gap-2">
					<ProfileAvatar
						src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${encodeURIComponent(model.id)}`}
						name={model.name}
						className="size-7"
					/>
					<div className="min-w-0">
						<div className="truncate">{model.name}</div>
						<div className="text-foreground-muted truncate text-dense">
							{(model.meta as { description?: string | null })?.description ?? model.id}
						</div>
					</div>
				</div>
				<Button
					variant="ghost"
					size="icon-sm"
					className="shrink-0"
					type="button"
					aria-label={`Edit ${model.name}`}
					onClick={() => setEditing(true)}
				>
					<Settings className="size-4" />
				</Button>
			</div>
		</>
	);
}

/**
 * "Turn on Message rating": General's switch, in whichever host this tab is
 * shown. In the dialog it asks the dialog to change tab (which asks first if
 * this tab has unsaved changes) and flashes the setting; on a page it is a link.
 */
function RatingLink() {
	const host = useSettingsHost();
	const label = 'Turn on Message rating in General';
	if (host.kind === 'dialog')
		return (
			<Button
				variant="link"
				type="button"
				className="h-auto p-0 text-dense"
				onClick={() => useSettingsModalStore.getState().requestTab('admin:general', 'message-rating')}
			>
				{label}
			</Button>
		);
	return (
		<Link className="text-dense underline" to={`${routePaths.adminSettings}/general`}>
			{label}
		</Link>
	);
}

/**
 * Ports admin/Settings/Evaluations.svelte. Adding, editing or deleting an
 * arena model changes the draft like any other control, and the tab's Save
 * sends it with the switch (FRM-3, #951); the Svelte tab saved each one at
 * once. The server's answer becomes the new state, and the app-wide model
 * lists (`['models']` / `['models-all']`) are refetched, as the Svelte tab
 * reloaded its `models` store.
 */
export default function Evaluations() {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const ratingOn = useConfigStore(
		(s) => ((s.config?.features ?? {}) as Record<string, unknown>).enable_message_rating !== false
	);
	const { draft, patch, dirty, discard, commit, isLoading } = useConfigDraft<Config>(['evaluations'], () =>
		getConfig(token)
	);
	const [saving, setSaving] = useState(false);
	const [showAdd, setShowAdd] = useState(false);

	const save = async () => {
		if (!draft) return;
		setSaving(true);
		try {
			const res = await updateConfig(token, draft);
			if (res) {
				commit(res as Config, true);
				toastSaved();
				queryClient.invalidateQueries({ queryKey: ['models-all'] });
				queryClient.invalidateQueries({ queryKey: ['models'] });
			}
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			setSaving(false);
		}
	};
	const arena = draft?.EVALUATION_ARENA_MODELS ?? [];
	const setModels = (models: ArenaModel[]) => patch({ EVALUATION_ARENA_MODELS: models });

	return (
		<SettingsForm
			title="Evaluations"
			loading={isLoading}
			onSubmit={save}
			saving={saving}
			dirty={dirty}
			onDiscard={discard}
		>
			{draft && (
				<>
					<ArenaModelModal
						open={showAdd}
						onOpenChange={setShowAdd}
						onSubmit={(model) => setModels([...arena, model])}
					/>
					<SettingsSection first>
						<SettingRow
							label="Arena models"
							description="Adds an Arena model to the model picker. It answers with a model chosen at random, so you can rate replies without knowing which model wrote them."
						>
							{(id) => (
								<SettingSwitch
									checked={draft.ENABLE_EVALUATION_ARENA_MODELS}
									onChange={(v) => patch({ ENABLE_EVALUATION_ARENA_MODELS: v })}
									labelledBy={id}
								/>
							)}
						</SettingRow>
						{!ratingOn && (
							<div className="text-foreground-muted -mt-2 text-dense">
								<p>Arena models need Message rating, which is off.</p>
								<RatingLink />
							</div>
						)}
					</SettingsSection>

					{draft.ENABLE_EVALUATION_ARENA_MODELS && (
						<SettingsSection title="Arena models">
							<div className="flex flex-col gap-1">
								{arena.length > 0 ? (
									arena.map((model, index) => (
										<ArenaModelRow
											key={model.id}
											model={model}
											onEdit={(edited) => setModels(arena.map((m, i) => (i === index ? edited : m)))}
											onDelete={() => setModels(arena.filter((_, i) => i !== index))}
										/>
									))
								) : (
									<p className="text-foreground-muted text-dense">
										None yet, so the Arena model chooses among all your models.
									</p>
								)}
							</div>
							<div>
								<Button variant="outline" size="sm" type="button" onClick={() => setShowAdd(true)}>
									<Plus aria-hidden />
									Add arena model
								</Button>
							</div>
						</SettingsSection>
					)}
				</>
			)}
		</SettingsForm>
	);
}
