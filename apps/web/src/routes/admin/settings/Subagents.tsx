import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
	SettingField,
	SettingRow,
	SettingSwitch,
	SettingsForm,
	SettingTextarea,
	settingInputClass
} from '@/components/settings/controls';
import { getSubagentsConfig, setSubagentsConfig } from '@/lib/apis/configs';
import { toastSaved } from '@/lib/settings/useAdminSaved';
import { sameSettings, useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';

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

/**
 * A limit field: -1 means no limit, as the server reads it (#602); any other
 * value keeps the field's own lower bound; there is no upper bound, as the
 * server takes any count (#760). The browser's `min` is -1, so the lower
 * bound is checked here instead, and there is no `step`, whose base would be -1.
 */
function NumberField({
	id,
	label,
	unit,
	value,
	onChange,
	min
}: {
	id: string;
	label: string;
	unit: string;
	value: number;
	onChange: (n: number) => void;
	min?: number;
}) {
	const input = useRef<HTMLInputElement>(null);
	const below = min !== undefined && value !== -1 && value < min;
	useEffect(() => {
		input.current?.setCustomValidity(below ? `Enter -1 for no limit, or at least ${min}.` : '');
	}, [below, min]);
	return (
		<SettingField label={label} htmlFor={id} description="Set -1 for no limit.">
			<div className="flex items-center gap-2">
				<input
					ref={input}
					id={id}
					type="number"
					className={`${settingInputClass} w-24`}
					value={value}
					onChange={(e) => onChange(Number(e.target.value))}
					min={-1}
				/>
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
	// What the server holds: as loaded, until a save replaces it.
	const [base, setBase] = useState<Form | null>(null);
	const [saving, setSaving] = useState(false);
	const stored = base ?? toForm(draft);
	const form: Form = { ...stored, ...edits };
	const dirty = !sameSettings(form, stored);
	const set = (patch: Partial<Form>) => setEdits((e) => ({ ...e, ...patch }));

	const save = async () => {
		const sent = form;
		setSaving(true);
		try {
			await setSubagentsConfig(token, {
				ENABLE_SUBAGENTS: sent.enabled,
				SUBAGENTS_BACKGROUND_ENABLED: sent.backgroundEnabled,
				SUBAGENTS_MAX_CONCURRENT: sent.maxConcurrent,
				SUBAGENTS_MAX_ASYNC: sent.maxAsync,
				SUBAGENTS_MAX_ITERATIONS: sent.maxIterations,
				SUBAGENTS_MAX_OUTPUT: sent.maxOutput,
				SUBAGENTS_SYSTEM_PROMPT: sent.systemPrompt
			});
			setBase(sent);
			// Drop only the edits this save sent: a field typed into while it was in flight keeps its value.
			setEdits((e) => Object.fromEntries(Object.entries(e).filter(([k, v]) => v !== sent[k as keyof Form])));
			toastSaved();
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsForm
			title="Sub-agents"
			loading={isLoading && !isError}
			onSubmit={save}
			saving={saving}
			dirty={dirty}
			onDiscard={() => setEdits({})}
		>
			<div className="flex flex-col gap-2.5">
				<SettingRow
					label="Enable sub-agents"
					description="Allow the AI to delegate tasks to sub-agents. Each sub-agent creates a real chat with full tool access. Uses additional LLM calls."
				>
					{(id) => <SettingSwitch checked={form.enabled} onChange={(enabled) => set({ enabled })} labelledBy={id} />}
				</SettingRow>
				{form.enabled && (
					<>
						<NumberField
							id="sa-concurrent"
							label="Max concurrent"
							unit="simultaneous sub-agents"
							value={form.maxConcurrent}
							onChange={(maxConcurrent) => set({ maxConcurrent })}
						/>
						<SettingRow
							label="Enable background sub-agents"
							description="Allow delegated sub-agents to keep running while the parent chat continues."
						>
							{(id) => (
								<SettingSwitch
									checked={form.backgroundEnabled}
									onChange={(backgroundEnabled) => set({ backgroundEnabled })}
									labelledBy={id}
								/>
							)}
						</SettingRow>
						{form.backgroundEnabled && (
							<NumberField
								id="sa-async"
								label="Max background"
								unit="background sub-agents"
								value={form.maxAsync}
								onChange={(maxAsync) => set({ maxAsync })}
							/>
						)}
						<NumberField
							id="sa-iterations"
							label="Max iterations"
							unit="tool loops per sub-agent"
							value={form.maxIterations}
							onChange={(maxIterations) => set({ maxIterations })}
							min={1}
						/>
						<NumberField
							id="sa-output"
							label="Max output"
							unit="chars"
							value={form.maxOutput}
							onChange={(maxOutput) => set({ maxOutput })}
							min={1000}
						/>
						<SettingField label="System prompt" htmlFor="sa-prompt" description="Leave empty for the built-in default.">
							<SettingTextarea
								id="sa-prompt"
								rows={4}
								value={form.systemPrompt}
								onChange={(e) => set({ systemPrompt: e.target.value })}
								placeholder="You are a sub-agent..."
							/>
						</SettingField>
					</>
				)}
			</div>
		</SettingsForm>
	);
}
