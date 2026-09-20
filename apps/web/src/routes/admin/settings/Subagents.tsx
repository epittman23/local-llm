import { useState } from 'react';
import { toast } from 'sonner';
import { SettingField, SettingRow, SettingSwitch, SettingsForm, SettingTextarea } from '@/components/settings/controls';
import { getSubagentsConfig, setSubagentsConfig } from '@/lib/apis/configs';
import { toastSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';
import { settingInputClass } from '@/components/settings/controls';

type Config = {
	ENABLE_SUBAGENTS?: boolean;
	SUBAGENTS_BACKGROUND_ENABLED?: boolean;
	SUBAGENTS_MAX_CONCURRENT?: number | string;
	SUBAGENTS_MAX_ASYNC?: number | string;
	SUBAGENTS_MAX_ITERATIONS?: number | string;
	SUBAGENTS_MAX_OUTPUT?: number | string;
	SUBAGENTS_SYSTEM_PROMPT?: string;
};

/** The form's own shape: the config with its defaults applied (a 0 or missing number means the default). */
const toForm = (c: Config | null) => ({
	enabled: c?.ENABLE_SUBAGENTS ?? false,
	backgroundEnabled: c?.SUBAGENTS_BACKGROUND_ENABLED ?? false,
	maxConcurrent: Number(c?.SUBAGENTS_MAX_CONCURRENT) || 20,
	maxAsync: Number(c?.SUBAGENTS_MAX_ASYNC) || 20,
	maxIterations: Number(c?.SUBAGENTS_MAX_ITERATIONS) || 30,
	maxOutput: Number(c?.SUBAGENTS_MAX_OUTPUT) || 30000,
	systemPrompt: c?.SUBAGENTS_SYSTEM_PROMPT ?? ''
});
type Form = ReturnType<typeof toForm>;

function NumberField({ id, label, unit, value, onChange, ...limits }: { id: string; label: string; unit: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number }) {
	return (
		<SettingField label={label} htmlFor={id}>
			<div className="flex items-center gap-2">
				<input id={id} type="number" className={`${settingInputClass} w-24`} value={value} onChange={(e) => onChange(Number(e.target.value))} {...limits} />
				<span className="text-muted-foreground text-xs">{unit}</span>
			</div>
		</SettingField>
	);
}

/** Ports admin/Settings/Subagents.svelte. Failing to load leaves the form on its defaults, as the original does. */
export default function Subagents() {
	const token = useAuthStore((s) => s.token) ?? '';
	const { draft, isLoading, isError } = useConfigDraft<Config>(['subagents'], () => getSubagentsConfig(token));
	const [edits, setEdits] = useState<Partial<Form>>({});
	const [saving, setSaving] = useState(false);
	const form: Form = { ...toForm(draft), ...edits };
	const set = (patch: Partial<Form>) => setEdits((e) => ({ ...e, ...patch }));

	const save = async () => {
		setSaving(true);
		try {
			await setSubagentsConfig(token, {
				ENABLE_SUBAGENTS: form.enabled,
				SUBAGENTS_BACKGROUND_ENABLED: form.backgroundEnabled,
				SUBAGENTS_MAX_CONCURRENT: form.maxConcurrent,
				SUBAGENTS_MAX_ASYNC: form.maxAsync,
				SUBAGENTS_MAX_ITERATIONS: form.maxIterations,
				SUBAGENTS_MAX_OUTPUT: form.maxOutput,
				SUBAGENTS_SYSTEM_PROMPT: form.systemPrompt
			});
			toastSaved();
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsForm title="Sub-agents" loading={isLoading && !isError} onSubmit={save} saving={saving}>
			<div className="flex flex-col gap-2.5">
				<SettingRow label="Enable sub-agents" description="Allow the AI to delegate tasks to sub-agents. Each sub-agent creates a real chat with full tool access. Uses additional LLM calls.">
					{(id) => <SettingSwitch checked={form.enabled} onChange={(enabled) => set({ enabled })} labelledBy={id} />}
				</SettingRow>
				{form.enabled && (
					<>
						<NumberField id="sa-concurrent" label="Max concurrent" unit="simultaneous sub-agents" value={form.maxConcurrent} onChange={(maxConcurrent) => set({ maxConcurrent })} min={-1} />
						<SettingRow label="Enable background sub-agents" description="Allow delegated sub-agents to keep running while the parent chat continues.">
							{(id) => <SettingSwitch checked={form.backgroundEnabled} onChange={(backgroundEnabled) => set({ backgroundEnabled })} labelledBy={id} />}
						</SettingRow>
						{form.backgroundEnabled && (
							<NumberField id="sa-async" label="Max background" unit="background sub-agents" value={form.maxAsync} onChange={(maxAsync) => set({ maxAsync })} min={-1} />
						)}
						<NumberField id="sa-iterations" label="Max iterations" unit="tool loops per sub-agent" value={form.maxIterations} onChange={(maxIterations) => set({ maxIterations })} min={1} max={100} />
						<NumberField id="sa-output" label="Max output" unit="chars" value={form.maxOutput} onChange={(maxOutput) => set({ maxOutput })} min={1000} max={100000} step={1000} />
						<SettingField label="System prompt" htmlFor="sa-prompt" description="Leave empty for the built-in default.">
							<SettingTextarea id="sa-prompt" rows={4} value={form.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} placeholder="You are a sub-agent..." />
						</SettingField>
					</>
				)}
			</div>
		</SettingsForm>
	);
}
