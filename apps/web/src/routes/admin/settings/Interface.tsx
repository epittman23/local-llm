import { useQuery } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AdvancedParams } from '@/components/common/AdvancedParams';
import { ExperimentalBadge } from '@/components/common/ExperimentalBadge';
import {
	SettingField,
	SettingNumber,
	SettingRow,
	SettingSelect,
	SettingSwitch,
	SettingsForm,
	SettingsSection,
	SettingTextarea
} from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import { RowButton } from '@/components/ui/row-button';
import { getModels, getTaskConfig, getTaskConfigDefaults, updateTaskConfig } from '@/lib/apis';
import { getChatConfig, updateChatConfig } from '@/lib/apis/chats';
import { errorMessage } from '@/lib/apis/errors';
import { getBaseModels } from '@/lib/apis/models';
import { toastSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import { configuredParams, type ModelOption, mergeModelOptions, normalizeModelSelection } from './interfaceTasks';

type Cfg = Record<string, any>;
type Draft = { task: Cfg; chat: Cfg };

/** A model `<select>` whose first choice is "Current Model" (follow the active chat's model). */
function ModelSelect({
	label,
	description,
	value,
	options,
	onChange
}: {
	label: string;
	description?: string;
	value: string;
	options: ModelOption[];
	onChange: (id: string) => void;
}) {
	const pick = (id: string) => {
		const { value: next, warn } = normalizeModelSelection(id, options);
		if (warn) toast.error('This model is not publicly available. Please select another model.');
		onChange(next);
	};
	return (
		<SettingField label={label} description={description}>
			<SettingSelect value={value ?? ''} onChange={pick} className="w-full" aria-label={label}>
				<option value="">Current Model</option>
				{options.map((m) => (
					<option key={m.id} value={m.id}>
						{m.name}
						{m.connection_type === 'local' ? ' (Local)' : ''}
					</option>
				))}
			</SettingSelect>
		</SettingField>
	);
}

/**
 * A prompt template that may be left empty to use the built-in one (#1101).
 * With the built-in text (`builtIn`), it can be read, copied into the field
 * to adjust, and gone back to: an empty template is what "use the built-in"
 * means on the server.
 */
export function PromptField({
	label,
	description,
	value,
	onChange,
	builtIn,
	children
}: {
	label: string;
	description: string;
	value: string;
	onChange: (v: string) => void;
	builtIn?: string;
	children?: ReactNode;
}) {
	const [showBuiltIn, setShowBuiltIn] = useState(false);
	const builtInId = useId();
	const custom = (value ?? '') !== '';
	return (
		<SettingField label={label} description={description}>
			<SettingTextarea aria-label={label} rows={3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
			{children}
			<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
				<span className="text-foreground-muted text-dense">
					{custom ? 'Custom prompt.' : 'Empty, so the default prompt is used.'}
				</span>
				{builtIn !== undefined && (
					<>
						<Button
							type="button"
							variant="link"
							size="xs"
							aria-expanded={showBuiltIn}
							aria-controls={builtInId}
							onClick={() => setShowBuiltIn((v) => !v)}
						>
							{showBuiltIn ? 'Hide default' : 'Show default'}
						</Button>
						{custom ? (
							<Button type="button" variant="link" size="xs" onClick={() => onChange('')}>
								Reset to default
							</Button>
						) : (
							<Button type="button" variant="link" size="xs" onClick={() => onChange(builtIn)}>
								Start from default
							</Button>
						)}
					</>
				)}
			</div>
			{showBuiltIn && builtIn !== undefined && (
				<section id={builtInId} aria-label={`Default ${label.toLowerCase()}`}>
					<pre className="bg-surface-2 text-foreground mt-1.5 rounded-lg border px-3 py-2 font-mono text-dense whitespace-pre-wrap break-words">
						{builtIn}
					</pre>
				</section>
			)}
		</SettingField>
	);
}

/**
 * How one half of an Interface save ended (#606). A request can fail after
 * the server has stored it (a dropped connection, a proxy's 502), so a failed
 * half is read back: unchanged means it was refused, changed means it landed.
 */
export type HalfOutcome = { label: string; state: 'saved' | 'refused' | 'landed' | 'unknown'; reason?: string };

/** What the toast says after a save, or null when both halves were saved. */
export function saveMessage(halves: HalfOutcome[]): string | null {
	if (halves.every((h) => h.state === 'saved')) return null;
	const saved = halves.filter((h) => h.state === 'saved').map((h) => h.label);
	const refused = halves.filter((h) => h.state === 'refused');
	if (refused.length === halves.length) {
		const reasons = [...new Set(refused.map((h) => h.reason))];
		return reasons.length === 1
			? `Nothing was saved: ${reasons[0]}`
			: `Nothing was saved: ${refused.map((h) => `${h.label}: ${h.reason}`).join('; ')}`;
	}
	const sentence = (h: HalfOutcome) =>
		h.state === 'refused'
			? `The ${h.label} settings were not saved: ${h.reason}.`
			: h.state === 'landed'
				? `The ${h.label} settings were stored, but the server answered with an error: ${h.reason}. They now show what the server holds.`
				: `The ${h.label} settings may not have been saved: ${h.reason}. Reopen the tab to see what the server holds.`;
	const failed = halves.filter((h) => h.state !== 'saved');
	if (saved.length && failed.length === 1 && failed[0].state === 'refused')
		return `The ${saved.join(' and ')} settings were saved, but the ${failed[0].label} settings were not: ${failed[0].reason}`;
	return [saved.length ? `The ${saved.join(' and ')} settings were saved.` : '', ...failed.map(sentence)]
		.filter(Boolean)
		.join(' ');
}

const withParams = (task: Cfg) => ({ ...task, TASK_MODEL_PARAMS: task.TASK_MODEL_PARAMS ?? {} });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Ports admin/Settings/Interface.svelte: task models, chat behaviour, and the generation prompts. */
export default function Interface() {
	const token = useAuthStore((s) => s.token) ?? '';
	const setConfig = useConfigStore((s) => s.setConfig);
	const {
		draft,
		setDraft,
		saved: stored,
		dirty,
		discard,
		commit,
		isLoading
	} = useConfigDraft<Draft>(['interface'], async () => {
		const [task, chat] = await Promise.all([getTaskConfig(token), getChatConfig(token)]);
		return { task: { ...task, TASK_MODEL_PARAMS: task?.TASK_MODEL_PARAMS ?? {} }, chat };
	});
	const models = useQuery({
		queryKey: ['admin-settings', 'interface-models'],
		gcTime: 0,
		staleTime: Infinity,
		refetchOnWindowFocus: false,
		queryFn: async () => {
			const workspace = ((await getBaseModels(token)) ?? []) as ModelOption[];
			const base = ((await getModels(token, null, false)) ?? []) as ModelOption[];
			return mergeModelOptions(base, workspace);
		}
	});
	// The built-in prompts, for "Show default" and "Start from default" (#1101). Without them the fields still work.
	const builtIn = useQuery({
		queryKey: ['admin-settings', 'task-prompt-defaults'],
		staleTime: Infinity,
		refetchOnWindowFocus: false,
		queryFn: () => getTaskConfigDefaults(token)
	}).data;
	useEffect(() => {
		if (models.isError)
			toast.error(
				(models.error as { detail?: string; message?: string })?.detail ??
					(models.error as Error)?.message ??
					'Failed to load Interface settings'
			);
	}, [models.isError, models.error]);

	const [showTaskParameters, setShowTaskParameters] = useState(false);
	const taskParametersId = useId();
	const taskParameters = useRef<HTMLDivElement>(null);
	// #960: the panel opens below its row, so bring it into view in the tab's own scroller.
	useEffect(() => {
		if (showTaskParameters) taskParameters.current?.scrollIntoView?.({ block: 'nearest' });
	}, [showTaskParameters]);
	const [saving, setSaving] = useState(false);
	const options = models.data ?? [];
	const task = draft?.task;
	const chat = draft?.chat;
	const patchTask = (p: Cfg) => setDraft((d) => d && { ...d, task: { ...d.task, ...p } });
	const patchChat = (p: Cfg) => setDraft((d) => d && { ...d, chat: { ...d.chat, ...p } });
	const num = (v: number | '') => (v === '' ? null : v);

	/** One half's outcome, and the values the form should show for it (undefined: keep the edits). */
	const settle = async (
		half: keyof Draft,
		label: string,
		result: PromiseSettledResult<Cfg | null>,
		load: () => Promise<Cfg | null>,
		normalize: (c: Cfg) => Cfg
	): Promise<HalfOutcome & { value?: Cfg }> => {
		if (result.status === 'fulfilled')
			return { label, state: 'saved', value: result.value ? normalize(result.value) : undefined };
		const reason = errorMessage(result.reason);
		try {
			const now = await load();
			if (!now) return { label, state: 'unknown', reason };
			const value = normalize(now);
			// `stored`: what the server held when the tab loaded or last saved.
			return same(value, stored?.[half])
				? { label, state: 'refused', reason }
				: { label, state: 'landed', reason, value };
		} catch {
			return { label, state: 'unknown', reason };
		}
	};

	const save = async () => {
		if (!draft) return;
		setSaving(true);
		try {
			const [taskResult, chatResult] = await Promise.allSettled([
				updateTaskConfig(token, { ...draft.task, TASK_MODEL_PARAMS: configuredParams(draft.task.TASK_MODEL_PARAMS) }),
				updateChatConfig(token, draft.chat)
			]);
			const [task, chat] = await Promise.all([
				settle('task', 'Tasks and Generation', taskResult, () => getTaskConfig(token), withParams),
				settle(
					'chat',
					'Chat',
					chatResult,
					() => getChatConfig(token),
					(c) => c
				)
			]);
			// A half that was saved or landed shows what the server holds; a refused or unknown one keeps its edits.
			if (stored) commit({ task: task.value ?? stored.task, chat: chat.value ?? stored.chat });
			setDraft((d) => d && { task: task.value ?? d.task, chat: chat.value ?? d.chat });
			// The chat reads these two off /api/config, so tell it without a refetch.
			const current = useConfigStore.getState().config;
			if (current && chat.value) {
				setConfig({
					...current,
					features: {
						...current.features,
						enable_context_compaction: chat.value.ENABLE_CONTEXT_COMPACTION,
						enable_tool_permissions: chat.value.ENABLE_TOOL_PERMISSIONS
					}
				});
			}
			const message = saveMessage([task, chat]);
			if (message) toast.error(message);
			else toastSaved();
		} finally {
			setSaving(false);
		}
	};

	const toggle = (cfg: Cfg, patch: (p: Cfg) => void, key: string, label: string, description: string) => (
		<SettingRow label={label} description={description}>
			{(id) => <SettingSwitch checked={cfg[key]} onChange={(v) => patch({ [key]: v })} labelledBy={id} />}
		</SettingRow>
	);

	return (
		<SettingsForm
			title="Tasks & prompts"
			loading={isLoading || models.isLoading}
			onSubmit={save}
			saving={saving}
			dirty={dirty}
			onDiscard={discard}
		>
			{task && chat && (
				<>
					<SettingsSection title="Tasks" first>
						<div>
							<p className="text-foreground-muted mb-2 text-dense">
								Background tasks (chat titles, tags, follow-ups, search queries) run on a task model. A chat on a model
								from a connection marked Local uses the local one; every other chat, OpenRouter's and llama-server's
								included, uses the external one. Current Model uses the chat's own model.
							</p>
							<div className="grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2">
								<ModelSelect
									label="Local Task Model"
									value={task.TASK_MODEL}
									options={options}
									onChange={(v) => patchTask({ TASK_MODEL: v })}
								/>
								<ModelSelect
									label="External Task Model"
									value={task.TASK_MODEL_EXTERNAL}
									options={options}
									onChange={(v) => patchTask({ TASK_MODEL_EXTERNAL: v })}
								/>
							</div>
							<div className="mt-2.5" ref={taskParameters}>
								<RowButton
									className="-mx-2 flex items-center justify-between gap-4 px-2 py-2"
									aria-expanded={showTaskParameters}
									aria-controls={taskParametersId}
									onClick={() => setShowTaskParameters((v) => !v)}
								>
									<span className="text-foreground-strong font-strong">Task model parameters</span>
									<ChevronDownIcon
										aria-hidden
										className={cn(
											'text-foreground-muted size-4 shrink-0 transition-transform duration-(--motion-fast)',
											showTaskParameters && 'rotate-180'
										)}
									/>
								</RowButton>
								{showTaskParameters && (
									<div id={taskParametersId} className="mt-2 rounded-lg border p-3">
										<AdvancedParams
											admin
											custom
											params={task.TASK_MODEL_PARAMS}
											onChange={(p) => patchTask({ TASK_MODEL_PARAMS: p })}
										/>
									</div>
								)}
							</div>
						</div>
					</SettingsSection>

					<SettingsSection title="Chat">
						<SettingRow
							label={
								<span className="flex items-center gap-2">
									<span>Tool Permissions</span>
									<ExperimentalBadge />
								</span>
							}
							description="Show Full access and Ask for approval in the chat input menu."
						>
							{(id) => (
								<SettingSwitch
									checked={chat.ENABLE_TOOL_PERMISSIONS}
									onChange={(v) => patchChat({ ENABLE_TOOL_PERMISSIONS: v })}
									labelledBy={id}
								/>
							)}
						</SettingRow>
						{toggle(
							chat,
							patchChat,
							'ENABLE_CONTEXT_COMPACTION',
							'Context Compaction',
							'Summarize older chat history when the conversation context grows large.'
						)}
						{chat.ENABLE_CONTEXT_COMPACTION && (
							<>
								<ModelSelect
									label="Context Compaction Model"
									description="Choose a dedicated model for context compaction summaries. Current Model follows the active chat model."
									value={chat.CONTEXT_COMPACTION_MODEL}
									options={options}
									onChange={(v) => patchChat({ CONTEXT_COMPACTION_MODEL: v })}
								/>
								<SettingField
									label="Token Threshold"
									description="Older messages are summarized when estimated context exceeds this token limit."
									htmlFor="compaction-threshold"
								>
									<SettingNumber
										id="compaction-threshold"
										min={1}
										step={1}
										value={chat.CONTEXT_COMPACTION_TOKEN_THRESHOLD}
										onChange={(v) => patchChat({ CONTEXT_COMPACTION_TOKEN_THRESHOLD: num(v) })}
									/>
								</SettingField>
								<SettingField
									label="Token Cap"
									description="Model-specific context compaction thresholds cannot exceed this token limit."
									htmlFor="compaction-cap"
								>
									<SettingNumber
										id="compaction-cap"
										min={1}
										step={1}
										value={chat.CONTEXT_COMPACTION_TOKEN_CAP}
										onChange={(v) => patchChat({ CONTEXT_COMPACTION_TOKEN_CAP: num(v) })}
									/>
								</SettingField>
								<SettingField
									label="Retained Messages"
									description="Percentage of recent messages to keep after older messages are summarized."
									htmlFor="compaction-retention"
								>
									<SettingNumber
										id="compaction-retention"
										min={10}
										max={50}
										step={1}
										value={chat.CONTEXT_COMPACTION_RETENTION_PERCENTAGE}
										onChange={(v) => patchChat({ CONTEXT_COMPACTION_RETENTION_PERCENTAGE: num(v) })}
									/>
								</SettingField>
								<PromptField
									label="Context Compaction Prompt"
									description="Controls how older messages are rewritten into a running summary."
									value={chat.CONTEXT_COMPACTION_PROMPT_TEMPLATE}
									onChange={(v) => patchChat({ CONTEXT_COMPACTION_PROMPT_TEMPLATE: v })}
								>
									<p className="text-foreground-muted mt-1 text-dense">
										Available variables: <code>{'{{PREVIOUS_SUMMARY}}'}</code>, <code>{'{{COMPACTED_MESSAGES}}'}</code>,{' '}
										<code>{'{{RECENT_MESSAGES}}'}</code>, <code>{'{{MESSAGES}}'}</code>,{' '}
										<code>{'{{CURRENT_DATE}}'}</code>
									</p>
								</PromptField>
							</>
						)}
					</SettingsSection>

					<SettingsSection title="Generation">
						{toggle(
							task,
							patchTask,
							'ENABLE_TITLE_GENERATION',
							'Title Generation',
							'Allow automatic names for new chats.'
						)}
						{task.ENABLE_TITLE_GENERATION && (
							<PromptField
								label="Title Generation Prompt"
								description="Shapes the short label generated for each chat."
								value={task.TITLE_GENERATION_PROMPT_TEMPLATE}
								builtIn={builtIn?.TITLE_GENERATION_PROMPT_TEMPLATE}
								onChange={(v) => patchTask({ TITLE_GENERATION_PROMPT_TEMPLATE: v })}
							/>
						)}

						{toggle(
							task,
							patchTask,
							'ENABLE_VOICE_MODE_PROMPT',
							'Voice Mode',
							'Apply voice-specific instructions while voice mode is active.'
						)}
						{task.ENABLE_VOICE_MODE_PROMPT && (
							<PromptField
								label="Voice Mode Prompt"
								description="Defines the behavior used for spoken conversations."
								value={task.VOICE_MODE_PROMPT_TEMPLATE}
								builtIn={builtIn?.VOICE_MODE_PROMPT_TEMPLATE}
								onChange={(v) => patchTask({ VOICE_MODE_PROMPT_TEMPLATE: v })}
							/>
						)}

						{toggle(
							task,
							patchTask,
							'ENABLE_FOLLOW_UP_GENERATION',
							'Follow Up Generation',
							'Show suggested next questions after assistant responses.'
						)}
						{task.ENABLE_FOLLOW_UP_GENERATION && (
							<PromptField
								label="Follow Up Generation Prompt"
								description="Guides the suggestions shown after an assistant response."
								value={task.FOLLOW_UP_GENERATION_PROMPT_TEMPLATE}
								builtIn={builtIn?.FOLLOW_UP_GENERATION_PROMPT_TEMPLATE}
								onChange={(v) => patchTask({ FOLLOW_UP_GENERATION_PROMPT_TEMPLATE: v })}
							/>
						)}

						{toggle(
							task,
							patchTask,
							'ENABLE_TAGS_GENERATION',
							'Tags Generation',
							'Create chat tags from conversation content.'
						)}
						{task.ENABLE_TAGS_GENERATION && (
							<PromptField
								label="Tags Generation Prompt"
								description="Controls how chat tags are inferred."
								value={task.TAGS_GENERATION_PROMPT_TEMPLATE}
								builtIn={builtIn?.TAGS_GENERATION_PROMPT_TEMPLATE}
								onChange={(v) => patchTask({ TAGS_GENERATION_PROMPT_TEMPLATE: v })}
							/>
						)}

						{toggle(
							task,
							patchTask,
							'ENABLE_RETRIEVAL_QUERY_GENERATION',
							'Retrieval Query Generation',
							'Rewrite user requests for knowledge retrieval.'
						)}
						{toggle(
							task,
							patchTask,
							'ENABLE_SEARCH_QUERY_GENERATION',
							'Web Search Query Generation',
							'Rewrite user requests into web-search queries.'
						)}
						<PromptField
							label="Query Generation Prompt"
							description="Shared prompt for retrieval and web-search query rewriting."
							value={task.QUERY_GENERATION_PROMPT_TEMPLATE}
							builtIn={builtIn?.QUERY_GENERATION_PROMPT_TEMPLATE}
							onChange={(v) => patchTask({ QUERY_GENERATION_PROMPT_TEMPLATE: v })}
						/>

						{toggle(
							task,
							patchTask,
							'ENABLE_AUTOCOMPLETE_GENERATION',
							'Autocomplete Generation',
							'Suggest completions while users type chat messages.'
						)}
						{task.ENABLE_AUTOCOMPLETE_GENERATION && (
							<>
								<SettingField
									label="Autocomplete Generation Input Max Length"
									description="Limit how much draft text is sent for suggestion generation."
									htmlFor="autocomplete-max"
								>
									<SettingNumber
										id="autocomplete-max"
										min={-1}
										step={1}
										placeholder="-1 for no limit, or a positive integer for a specific limit"
										value={task.AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH}
										onChange={(v) => patchTask({ AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH: num(v) })}
									/>
								</SettingField>
								<PromptField
									label="Autocomplete Generation Prompt"
									description="Guides inline completions while users type a message."
									value={task.AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE}
									builtIn={builtIn?.AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE}
									onChange={(v) => patchTask({ AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE: v })}
								/>
							</>
						)}

						<PromptField
							label="Image Prompt Generation Prompt"
							description="Rewrites user intent into an image-generation prompt."
							value={task.IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE}
							builtIn={builtIn?.IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE}
							onChange={(v) => patchTask({ IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE: v })}
						/>
						<PromptField
							label="Tools Function Calling Prompt"
							description="Guides how the assistant formats tool and function calls."
							value={task.TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE}
							builtIn={builtIn?.TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE}
							onChange={(v) => patchTask({ TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE: v })}
						/>
					</SettingsSection>
				</>
			)}
		</SettingsForm>
	);
}
