import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AdvancedParams } from '@/components/common/AdvancedParams';
import { ExperimentalBadge } from '@/components/common/ExperimentalBadge';
import { SettingField, SettingNumber, SettingRow, SettingSelect, SettingSwitch, SettingTextarea, SettingsForm, SettingsSection } from '@/components/settings/controls';
import { getModels, getTaskConfig, updateTaskConfig } from '@/lib/apis';
import { getChatConfig, updateChatConfig } from '@/lib/apis/chats';
import { getBaseModels } from '@/lib/apis/models';
import { toastSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { configuredParams, type ModelOption, mergeModelOptions, normalizeModelSelection } from './interfaceTasks';

type Cfg = Record<string, any>;
type Draft = { task: Cfg; chat: Cfg };

const PROMPT_PLACEHOLDER = 'Leave empty to use the default prompt, or enter a custom prompt';

/** A model `<select>` whose first choice is "Current Model" (follow the active chat's model). */
function ModelSelect({ label, description, value, options, onChange }: { label: string; description?: string; value: string; options: ModelOption[]; onChange: (id: string) => void }) {
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

function PromptField({ label, description, value, onChange }: { label: string; description: string; value: string; onChange: (v: string) => void }) {
	return (
		<SettingField label={label} description={description}>
			<SettingTextarea aria-label={label} placeholder={PROMPT_PLACEHOLDER} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
		</SettingField>
	);
}

/** Ports admin/Settings/Interface.svelte: task models, chat behaviour, and the generation prompts. */
export default function Interface() {
	const token = useAuthStore((s) => s.token) ?? '';
	const setConfig = useConfigStore((s) => s.setConfig);
	const { draft, setDraft, isLoading } = useConfigDraft<Draft>(['interface'], async () => {
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
	useEffect(() => {
		if (models.isError) toast.error((models.error as { detail?: string; message?: string })?.detail ?? (models.error as Error)?.message ?? 'Failed to load Interface settings');
	}, [models.isError, models.error]);

	const [showTaskParameters, setShowTaskParameters] = useState(false);
	const [saving, setSaving] = useState(false);
	const options = models.data ?? [];
	const task = draft?.task;
	const chat = draft?.chat;
	const patchTask = (p: Cfg) => setDraft((d) => d && { ...d, task: { ...d.task, ...p } });
	const patchChat = (p: Cfg) => setDraft((d) => d && { ...d, chat: { ...d.chat, ...p } });
	const num = (v: number | '') => (v === '' ? null : v);

	const save = async () => {
		if (!draft) return;
		setSaving(true);
		try {
			const [nextTask, nextChat] = await Promise.all([
				updateTaskConfig(token, { ...draft.task, TASK_MODEL_PARAMS: configuredParams(draft.task.TASK_MODEL_PARAMS) }),
				updateChatConfig(token, draft.chat)
			]);
			if (nextTask && nextChat) setDraft({ task: { ...nextTask, TASK_MODEL_PARAMS: nextTask.TASK_MODEL_PARAMS ?? {} }, chat: nextChat });
			// The chat reads these two off /api/config, so tell it without a refetch.
			const current = useConfigStore.getState().config;
			if (current && nextChat) {
				setConfig({ ...current, features: { ...current.features, enable_context_compaction: nextChat.ENABLE_CONTEXT_COMPACTION, enable_tool_permissions: nextChat.ENABLE_TOOL_PERMISSIONS } });
			}
			toastSaved();
		} catch (error) {
			toast.error((error as { detail?: string })?.detail ?? `${error}`);
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
		<SettingsForm title="Interface" loading={isLoading || models.isLoading} onSubmit={save} saving={saving}>
			{task && chat && (
				<>
					<SettingsSection title="Tasks" first>
						<div>
							<div className="mb-2">
								<div className="text-muted-foreground text-xs">Task Model</div>
								<p className="text-muted-foreground/70 mt-1.5 text-[0.6875rem]">Choose fallback models for background tasks. Current Model follows the active chat model.</p>
							</div>
							<div className="grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2">
								<ModelSelect label="Local Task Model" value={task.TASK_MODEL} options={options} onChange={(v) => patchTask({ TASK_MODEL: v })} />
								<ModelSelect label="External Task Model" value={task.TASK_MODEL_EXTERNAL} options={options} onChange={(v) => patchTask({ TASK_MODEL_EXTERNAL: v })} />
							</div>
							<div className="mt-2.5">
								<button type="button" className="flex w-full items-center justify-between gap-4 py-0.5 text-left" aria-expanded={showTaskParameters} onClick={() => setShowTaskParameters((v) => !v)}>
									<span className="text-muted-foreground text-xs">Task Model Parameters</span>
									<span className="text-muted-foreground/70 text-[0.6875rem]">{showTaskParameters ? 'Close' : 'Configure'}</span>
								</button>
								{showTaskParameters && (
									<div className="max-h-[24rem] overflow-y-auto pr-1 pb-2">
										<AdvancedParams admin custom params={task.TASK_MODEL_PARAMS} onChange={(p) => patchTask({ TASK_MODEL_PARAMS: p })} />
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
							{(id) => <SettingSwitch checked={chat.ENABLE_TOOL_PERMISSIONS} onChange={(v) => patchChat({ ENABLE_TOOL_PERMISSIONS: v })} labelledBy={id} />}
						</SettingRow>
						{toggle(chat, patchChat, 'ENABLE_CONTEXT_COMPACTION', 'Context Compaction', 'Summarize older chat history when the conversation context grows large.')}
						{chat.ENABLE_CONTEXT_COMPACTION && (
							<>
								<ModelSelect
									label="Context Compaction Model"
									description="Choose a dedicated model for context compaction summaries. Current Model follows the active chat model."
									value={chat.CONTEXT_COMPACTION_MODEL}
									options={options}
									onChange={(v) => patchChat({ CONTEXT_COMPACTION_MODEL: v })}
								/>
								<SettingField label="Token Threshold" description="Older messages are summarized when estimated context exceeds this token limit." htmlFor="compaction-threshold">
									<SettingNumber id="compaction-threshold" min={1} step={1} value={chat.CONTEXT_COMPACTION_TOKEN_THRESHOLD} onChange={(v) => patchChat({ CONTEXT_COMPACTION_TOKEN_THRESHOLD: num(v) })} />
								</SettingField>
								<SettingField label="Token Cap" description="Model-specific context compaction thresholds cannot exceed this token limit." htmlFor="compaction-cap">
									<SettingNumber id="compaction-cap" min={1} step={1} value={chat.CONTEXT_COMPACTION_TOKEN_CAP} onChange={(v) => patchChat({ CONTEXT_COMPACTION_TOKEN_CAP: num(v) })} />
								</SettingField>
								<SettingField label="Retained Messages" description="Percentage of recent messages to keep after older messages are summarized." htmlFor="compaction-retention">
									<SettingNumber id="compaction-retention" min={10} max={50} step={1} value={chat.CONTEXT_COMPACTION_RETENTION_PERCENTAGE} onChange={(v) => patchChat({ CONTEXT_COMPACTION_RETENTION_PERCENTAGE: num(v) })} />
								</SettingField>
								<SettingField label="Context Compaction Prompt" description="Controls how older messages are rewritten into a running summary.">
									<SettingTextarea aria-label="Context Compaction Prompt" placeholder={PROMPT_PLACEHOLDER} value={chat.CONTEXT_COMPACTION_PROMPT_TEMPLATE ?? ''} onChange={(e) => patchChat({ CONTEXT_COMPACTION_PROMPT_TEMPLATE: e.target.value })} />
									<p className="text-muted-foreground/70 mt-1 text-[0.6875rem]">
										Available variables: <code>{'{{PREVIOUS_SUMMARY}}'}</code>, <code>{'{{COMPACTED_MESSAGES}}'}</code>, <code>{'{{RECENT_MESSAGES}}'}</code>, <code>{'{{MESSAGES}}'}</code>, <code>{'{{CURRENT_DATE}}'}</code>
									</p>
								</SettingField>
							</>
						)}
					</SettingsSection>

					<SettingsSection title="Generation">
						{toggle(task, patchTask, 'ENABLE_TITLE_GENERATION', 'Title Generation', 'Allow automatic names for new chats.')}
						{task.ENABLE_TITLE_GENERATION && <PromptField label="Title Generation Prompt" description="Shapes the short label generated for each chat." value={task.TITLE_GENERATION_PROMPT_TEMPLATE} onChange={(v) => patchTask({ TITLE_GENERATION_PROMPT_TEMPLATE: v })} />}

						{toggle(task, patchTask, 'ENABLE_VOICE_MODE_PROMPT', 'Voice Mode Prompt', 'Apply voice-specific instructions while voice mode is active.')}
						{task.ENABLE_VOICE_MODE_PROMPT && <PromptField label="Prompt Template" description="Defines the behavior used for spoken conversations." value={task.VOICE_MODE_PROMPT_TEMPLATE} onChange={(v) => patchTask({ VOICE_MODE_PROMPT_TEMPLATE: v })} />}

						{toggle(task, patchTask, 'ENABLE_FOLLOW_UP_GENERATION', 'Follow Up Generation', 'Show suggested next questions after assistant responses.')}
						{task.ENABLE_FOLLOW_UP_GENERATION && <PromptField label="Follow Up Generation Prompt" description="Guides the suggestions shown after an assistant response." value={task.FOLLOW_UP_GENERATION_PROMPT_TEMPLATE} onChange={(v) => patchTask({ FOLLOW_UP_GENERATION_PROMPT_TEMPLATE: v })} />}

						{toggle(task, patchTask, 'ENABLE_TAGS_GENERATION', 'Tags Generation', 'Create chat tags from conversation content.')}
						{task.ENABLE_TAGS_GENERATION && <PromptField label="Tags Generation Prompt" description="Controls how chat tags are inferred." value={task.TAGS_GENERATION_PROMPT_TEMPLATE} onChange={(v) => patchTask({ TAGS_GENERATION_PROMPT_TEMPLATE: v })} />}

						{toggle(task, patchTask, 'ENABLE_RETRIEVAL_QUERY_GENERATION', 'Retrieval Query Generation', 'Rewrite user requests for knowledge retrieval.')}
						{toggle(task, patchTask, 'ENABLE_SEARCH_QUERY_GENERATION', 'Web Search Query Generation', 'Rewrite user requests into web-search queries.')}
						<PromptField label="Query Generation Prompt" description="Shared prompt for retrieval and web-search query rewriting." value={task.QUERY_GENERATION_PROMPT_TEMPLATE} onChange={(v) => patchTask({ QUERY_GENERATION_PROMPT_TEMPLATE: v })} />

						{toggle(task, patchTask, 'ENABLE_AUTOCOMPLETE_GENERATION', 'Autocomplete Generation', 'Suggest completions while users type chat messages.')}
						{task.ENABLE_AUTOCOMPLETE_GENERATION && (
							<>
								<SettingField label="Autocomplete Generation Input Max Length" description="Limit how much draft text is sent for suggestion generation." htmlFor="autocomplete-max">
									<SettingNumber id="autocomplete-max" min={-1} step={1} placeholder="-1 for no limit, or a positive integer for a specific limit" value={task.AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH} onChange={(v) => patchTask({ AUTOCOMPLETE_GENERATION_INPUT_MAX_LENGTH: num(v) })} />
								</SettingField>
								<PromptField label="Autocomplete Generation Prompt" description="Guides inline completions while users type a message." value={task.AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE} onChange={(v) => patchTask({ AUTOCOMPLETE_GENERATION_PROMPT_TEMPLATE: v })} />
							</>
						)}

						<PromptField label="Image Prompt Generation Prompt" description="Rewrites user intent into an image-generation prompt." value={task.IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE} onChange={(v) => patchTask({ IMAGE_PROMPT_GENERATION_PROMPT_TEMPLATE: v })} />
						<PromptField label="Tools Function Calling Prompt" description="Guides how the assistant formats tool and function calls." value={task.TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE} onChange={(v) => patchTask({ TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE: v })} />
					</SettingsSection>
				</>
			)}
		</SettingsForm>
	);
}
