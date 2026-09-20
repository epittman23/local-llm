import { useQueryClient } from '@tanstack/react-query';
import { Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Tip } from '@/components/common/Tip';
import { SettingRow, SettingSwitch, SettingsForm, SettingsSection } from '@/components/settings/controls';
import { getConfig, updateConfig } from '@/lib/apis/evaluations';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { toastSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';
import { ArenaModelModal } from './ArenaModelModal';
import type { ArenaModel } from './arenaModels';

type Config = { ENABLE_EVALUATION_ARENA_MODELS: boolean; EVALUATION_ARENA_MODELS: ArenaModel[] };

/** Ports Evaluations/Model.svelte: one arena model row, click the cog to edit. */
function ArenaModelRow({ model, onEdit, onDelete }: { model: ArenaModel; onEdit: (m: ArenaModel) => void; onDelete: () => void }) {
	const [editing, setEditing] = useState(false);
	return (
		<>
			<ArenaModelModal open={editing} onOpenChange={setEditing} edit model={model} onSubmit={onEdit} onDelete={onDelete} />
			<div className="flex items-center justify-between gap-2 rounded-lg px-1 py-1">
				<div className="flex min-w-0 items-center gap-2">
					<img src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${encodeURIComponent(model.id)}`} alt={model.name} className="size-7 shrink-0 rounded-full object-cover" />
					<div className="min-w-0">
						<div className="truncate text-xs font-normal">{model.name}</div>
						<div className="text-muted-foreground truncate text-[0.6875rem]">{(model.meta as { description?: string | null })?.description ?? model.id}</div>
					</div>
				</div>
				<button type="button" aria-label={`Edit ${model.name}`} className="text-muted-foreground hover:text-foreground shrink-0 rounded p-1 transition" onClick={() => setEditing(true)}>
					<Settings className="size-4" />
				</button>
			</div>
		</>
	);
}

/**
 * Ports admin/Settings/Evaluations.svelte. The Save button saves the whole
 * config; adding, editing or deleting an arena model saves immediately (with the
 * toggle as it currently stands), and the server's answer becomes the new state.
 * The Svelte tab then reloads the app-wide `models` store; the `['models']` /
 * `['models-all']` query keys are invalidated here for the same reason.
 */
export default function Evaluations() {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const { draft, setDraft, patch, isLoading } = useConfigDraft<Config>(['evaluations'], () => getConfig(token));
	const [saving, setSaving] = useState(false);
	const [showAdd, setShowAdd] = useState(false);

	const save = async (next: Config) => {
		setSaving(true);
		try {
			const res = await updateConfig(token, next);
			if (res) {
				setDraft(res as Config);
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
	const saveModels = (models: ArenaModel[]) => save({ ...draft!, EVALUATION_ARENA_MODELS: models });

	return (
		<SettingsForm title="Evaluations" loading={isLoading} onSubmit={async () => { if (draft) await save(draft); }} saving={saving}>
			{draft && (
				<>
					<ArenaModelModal open={showAdd} onOpenChange={setShowAdd} onSubmit={(model) => saveModels([...arena, model])} />
					<SettingsSection first>
						<SettingRow label="Arena Models" description="Message rating should be enabled to use this feature">
							{(id) => (
								<Tip content="Message rating should be enabled to use this feature">
									<span>
										<SettingSwitch checked={draft.ENABLE_EVALUATION_ARENA_MODELS} onChange={(v) => patch({ ENABLE_EVALUATION_ARENA_MODELS: v })} labelledBy={id} />
									</span>
								</Tip>
							)}
						</SettingRow>
					</SettingsSection>

					{draft.ENABLE_EVALUATION_ARENA_MODELS && (
						<SettingsSection title="Models">
							<div className="flex items-center justify-between">
								<div className="text-xs font-normal">Arena Models</div>
								<Tip content="Add Arena Model">
									<button type="button" aria-label="Add Arena Model" className="hover:bg-muted rounded p-1 transition" onClick={() => setShowAdd(true)}>
										<Plus className="size-3.5" />
									</button>
								</Tip>
							</div>
							<div className="flex flex-col gap-1">
								{arena.length > 0 ? (
									arena.map((model, index) => (
										<ArenaModelRow
											key={model.id}
											model={model}
											onEdit={(edited) => saveModels(arena.map((m, i) => (i === index ? edited : m)))}
											onDelete={() => saveModels(arena.filter((_, i) => i !== index))}
										/>
									))
								) : (
									<div className="text-muted-foreground text-xs">Using the default arena model with all models. Click the plus button to add custom models.</div>
								)}
							</div>
						</SettingsSection>
					)}
				</>
			)}
		</SettingsForm>
	);
}
