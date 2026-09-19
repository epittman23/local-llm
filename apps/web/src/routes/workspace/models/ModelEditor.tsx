import { useQuery } from '@tanstack/react-query';
import { Camera, ChevronLeft } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { AdvancedParams } from '@/components/common/AdvancedParams';
import { Spinner } from '@/components/common/Spinner';
import { Tags } from '@/components/common/Tags';
import { Button } from '@/components/ui/button';
import { getModelsDefaults } from '@/lib/apis/configs';
import { getVoices } from '@/lib/apis/audio';
import { getFunctions } from '@/lib/apis/functions';
import { getBaseModelTags, getModelTags } from '@/lib/apis/models';
import { getSkills } from '@/lib/apis/skills';
import { getTerminalServers } from '@/lib/apis/terminal';
import { getTools } from '@/lib/apis/tools';
import { getModels } from '@/lib/apis';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { BaseModelSelect, CheckboxGrid, ItemPicker } from './EditorPickers';
import { KnowledgePicker } from './KnowledgePicker';
import { type PromptSuggestion, PromptSuggestionsEditor } from './PromptSuggestionsEditor';
import {
	DEFAULT_PROFILE_IMAGE,
	type EditorState,
	type ModelInfo,
	buildModelInfo,
	getBaseModelItems,
	getChatVariablesPreview,
	initialEditorState,
	modelIdFromName
} from './modelEditorLogic';
import { availableFeatures, builtinToolItems, capabilityItems, featureItems } from './modelEditorLabels';

const sectionLabel = 'text-xs text-muted-foreground';

/** An endpoint that fails or answers with something unexpected counts as an empty list. */
const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const fieldClass = 'bg-transparent outline-hidden placeholder:text-muted-foreground/50';

/** Resizes a picked image to a 250px square (cover-cropped) WebP data URL; animated formats are kept as they are. */
function readProfileImage(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error);
		reader.onload = () => {
			const original = `${reader.result}`;
			if (file.type === 'image/gif' || file.type === 'image/webp') return resolve(original);
			const img = new Image();
			img.onerror = () => reject(new Error('Could not read that image.'));
			img.onload = () => {
				const canvas = document.createElement('canvas');
				canvas.width = 250;
				canvas.height = 250;
				const aspect = img.width / img.height;
				const w = aspect > 1 ? 250 * aspect : 250;
				const h = aspect > 1 ? 250 : 250 / aspect;
				canvas.getContext('2d')?.drawImage(img, (250 - w) / 2, (250 - h) / 2, w, h);
				resolve(canvas.toDataURL('image/webp', 0.8));
			};
			img.src = original;
		};
		reader.readAsDataURL(file);
	});
}

/**
 * Ports workspace/Models/ModelEditor.svelte (create, clone and edit): name, id,
 * profile image, base model, description, tags, system prompt, advanced
 * parameters, suggestion prompts, knowledge, tools, skills, filters, actions,
 * capabilities, default features, builtin tools, terminal, TTS voice, access.
 *
 * The data flow is in modelEditorLogic.ts (`initialEditorState` in,
 * `buildModelInfo` out), so this file is layout and wiring. Loading: it waits for
 * the model list and the admin defaults (both feed the initial state), then
 * renders; the tool/skill/function lists load in the background.
 */
export function ModelEditor({
	model,
	edit = false,
	preset = true,
	onSubmit,
	onBack
}: {
	model: (Record<string, any> & { id: string; name: string }) | null;
	edit?: boolean;
	preset?: boolean;
	onSubmit: (info: ModelInfo) => Promise<void>;
	onBack: () => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const models = useQuery({ queryKey: ['models-all'], queryFn: async () => asArray<any>(await getModels(token)) });
	const defaults = useQuery({
		queryKey: ['models-defaults'],
		queryFn: async () => (await getModelsDefaults(token).catch(() => null))?.DEFAULT_MODEL_METADATA ?? {}
	});

	if (models.isPending || defaults.isPending) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}
	return <EditorForm model={model} edit={edit} preset={preset} allModels={models.data ?? []} defaults={defaults.data ?? {}} onSubmit={onSubmit} onBack={onBack} />;
}

function EditorForm({
	model,
	edit,
	preset,
	allModels,
	defaults,
	onSubmit,
	onBack
}: {
	model: (Record<string, any> & { id: string; name: string }) | null;
	edit: boolean;
	preset: boolean;
	allModels: any[];
	defaults: Record<string, any>;
	onSubmit: (info: ModelInfo) => Promise<void>;
	onBack: () => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const isAdmin = user?.role === 'admin';

	const [state, setState] = useState<EditorState>(() => initialEditorState(model, defaults, { edit, baseModels: allModels }));
	const patch = (p: Partial<EditorState>) => setState((s) => ({ ...s, ...p }));
	const setMeta = (p: Record<string, unknown>) => setState((s) => ({ ...s, info: { ...s.info, meta: { ...s.info.meta, ...p } } }));
	const [loading, setLoading] = useState(false);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [showPreview, setShowPreview] = useState(false);
	const [showAccess, setShowAccess] = useState(false);
	const imageInput = useRef<HTMLInputElement>(null);

	const tools = useQuery({ queryKey: ['tools-all'], queryFn: async () => asArray<any>(await getTools(token).catch(() => null)) });
	const skills = useQuery({ queryKey: ['skills-all'], queryFn: async () => asArray<any>(await getSkills(token).catch(() => null)) });
	const functions = useQuery({ queryKey: ['functions-all'], queryFn: async () => asArray<any>(await getFunctions(token).catch(() => null)) });
	const tagSuggestions = useQuery({ queryKey: ['model-tags', preset], queryFn: async () => asArray<string>(await (preset ? getModelTags : getBaseModelTags)(token).catch(() => [])) });
	const terminals = useQuery({ queryKey: ['terminals'], queryFn: async () => asArray<{ id: string; name?: string }>(await getTerminalServers(token).catch(() => [])) });
	const voices = useQuery({ queryKey: ['voices'], queryFn: async () => ((await getVoices(token).catch(() => null))?.voices ?? []) as Array<{ id: string; name?: string }> });

	const fns = functions.data ?? [];
	const filters = fns.filter((f) => f.type === 'filter');
	const actions = fns.filter((f) => f.type === 'action');
	const toggleableFilters = filters.filter((f) => (state.filterIds.includes(f.id) || f.is_global) && f.meta?.toggle);

	const variables = getChatVariablesPreview(state.system ?? '');
	const baseItems = getBaseModelItems(allModels, { currentModelId: model?.id, edit, selectedBaseId: state.info.base_model_id, isAdmin });
	const meta = state.info.meta;
	const tags = ((meta.tags ?? []) as Array<{ name: string }>).map((t) => (typeof t === 'string' ? { name: t } : t));
	const features = availableFeatures(state.capabilities);

	const submit = async () => {
		const result = buildModelInfo(state, { preset });
		if (!result.ok) {
			toast.error(result.error);
			return;
		}
		setLoading(true);
		try {
			await onSubmit(result.info);
		} finally {
			setLoading(false);
		}
	};

	const preview = buildModelInfo({ ...state, id: state.id || '(id)', name: state.name || '(name)' }, { preset: false });

	return (
		<div className="flex h-full min-h-0 w-full flex-col">
			<AccessControlModal
				open={showAccess}
				onOpenChange={setShowAccess}
				accessGrants={state.accessGrants}
				onChange={(accessGrants) => patch({ accessGrants })}
				accessRoles={preset ? ['read', 'write'] : ['read']}
				share={Boolean(user?.permissions?.sharing?.models) || isAdmin}
				sharePublic={Boolean(user?.permissions?.sharing?.public_models) || isAdmin}
				shareUsers={(user?.permissions?.access_grants?.allow_users ?? true) || isAdmin}
			/>

			<button
				type="button"
				className="text-muted-foreground hover:text-foreground mb-1 flex h-6 w-fit items-center gap-1 rounded-md text-xs transition-colors"
				onClick={onBack}
			>
				<ChevronLeft className="size-3" strokeWidth={2} />
				<span>Back</span>
			</button>

			<div className="min-h-0 w-full flex-1 overflow-y-auto pr-1">
				<input
					ref={imageInput}
					type="file"
					hidden
					accept="image/*"
					onChange={async (e) => {
						const file = e.target.files?.[0];
						e.target.value = '';
						if (!file || !['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
							if (file) toast.error(`Unsupported File Type '${file.type}'.`);
							return;
						}
						try {
							setMeta({ profile_image_url: await readProfileImage(file) });
						} catch (error) {
							toast.error(`${error}`);
						}
					}}
				/>

				<form
					className="flex w-full flex-col gap-2.5 md:flex-row"
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<div className="w-full px-1">
						<div className="flex w-full flex-col gap-3">
							<div className="flex w-full min-w-0 items-center gap-3 py-0.5">
								<div className="group relative size-12 shrink-0 md:size-14">
									<button
										type="button"
										aria-label="Upload profile image"
										className="ring-border hover:ring-foreground/30 relative flex size-full items-center overflow-hidden rounded-xl ring-1 transition"
										onClick={() => imageInput.current?.click()}
									>
										<img src={meta.profile_image_url || DEFAULT_PROFILE_IMAGE} alt="model profile" className="size-full object-cover" />
										<span className="bg-foreground text-background absolute right-0 bottom-0 m-1 rounded-full p-1 opacity-0 shadow-sm transition group-hover:opacity-100 group-focus-within:opacity-100">
											<Camera className="size-3" />
										</span>
									</button>
									{meta.profile_image_url && meta.profile_image_url !== DEFAULT_PROFILE_IMAGE && (
										<button
											type="button"
											className="text-muted-foreground hover:text-foreground absolute top-full left-1/2 mt-1 -translate-x-1/2 text-[0.5rem] leading-none opacity-0 transition group-hover:opacity-60"
											onClick={() => setMeta({ profile_image_url: DEFAULT_PROFILE_IMAGE })}
										>
											Reset
										</button>
									)}
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex min-w-0 items-center gap-2">
										<input
											className={cn(fieldClass, 'min-w-0 flex-1 text-base leading-tight')}
											placeholder="Model Name"
											aria-label="Model Name"
											value={state.name}
											required
											onChange={(e) => {
												// A new model's id follows its name until edited by hand.
												const name = e.target.value;
												patch(!edit && name ? { name, id: modelIdFromName(name) } : { name });
											}}
										/>
										<AccessButton onClick={() => setShowAccess(true)} />
									</div>
									<input
										className={cn(fieldClass, 'text-muted-foreground block w-full py-0.5 text-xs')}
										placeholder="Model ID"
										aria-label="Model ID"
										value={state.id}
										disabled={edit}
										required
										onChange={(e) => patch({ id: e.target.value })}
									/>
								</div>
							</div>

							{preset && (
								<div>
									<div className={cn(sectionLabel, 'mb-1')}>Base Model (From)</div>
									<BaseModelSelect
										items={baseItems}
										value={state.info.base_model_id}
										placeholder="Select a base model (e.g. llama3, gpt-4o)"
										onChange={(base) => setState((s) => ({ ...s, info: { ...s.info, base_model_id: base } }))}
									/>
								</div>
							)}

							<div>
								<div className="mb-1 flex w-full items-center justify-between">
									<div className={sectionLabel}>Description</div>
									<button
										type="button"
										className="text-muted-foreground hover:text-foreground rounded-sm px-2 py-0.5 text-xs"
										aria-label={state.enableDescription ? 'Custom description enabled' : 'Default description enabled'}
										onClick={() => patch({ enableDescription: !state.enableDescription })}
									>
										{state.enableDescription ? 'Custom' : 'Default'}
									</button>
								</div>
								{state.enableDescription && (
									<textarea
										className={cn(fieldClass, 'w-full resize-none text-xs')}
										rows={2}
										aria-label="Description"
										placeholder="Add a short description about what this model does"
										value={meta.description ?? ''}
										onChange={(e) => setMeta({ description: e.target.value })}
									/>
								)}
							</div>

							<Tags
								tags={tags}
								suggestionTags={(tagSuggestions.data ?? []).map((name) => ({ name }))}
								onAdd={(name) => setMeta({ tags: [...tags, { name }] })}
								onDelete={(name) => setMeta({ tags: tags.filter((t) => t.name !== name) })}
							/>
						</div>

						<hr className="my-3" />

						<div className="my-2">
							<div className="mb-1 text-sm">Model Params</div>
							<div className="my-2">
								<div className={cn(sectionLabel, 'mb-1')}>System Prompt</div>
								<textarea
									className={cn(fieldClass, 'w-full resize-none text-xs')}
									rows={4}
									aria-label="System Prompt"
									placeholder={`Write your model system prompt content here\ne.g.) You are Mario from Super Mario Bros, acting as an assistant.`}
									value={state.system}
									onChange={(e) => patch({ system: e.target.value })}
								/>
								{(variables.fields.length > 0 || variables.userFields.length > 0 || variables.warnings.length > 0) && (
									<div className="bg-muted/50 mt-1 rounded-lg px-3 py-2 text-xs">
										<div className="font-medium">Detected Variables</div>
										{variables.fields.length > 0 && (
											<div className="mt-1">
												<div className="text-muted-foreground">Chat Variables</div>
												{variables.fields.map((f) => (
													<div key={f.key} className="font-mono">
														{f.key} <span className="text-muted-foreground">({f.type ?? 'text'}{f.required ? ', required' : ''})</span>
													</div>
												))}
											</div>
										)}
										{variables.userFields.length > 0 && (
											<div className="mt-1">
												<div className="text-muted-foreground">User Variables</div>
												{variables.userFields.map((f) => (
													<div key={f.key} className="font-mono">
														{f.key}
													</div>
												))}
											</div>
										)}
										{variables.warnings.length > 0 && (
											<ul className="mt-1 list-disc pl-4 text-amber-600 dark:text-amber-400">
												{variables.warnings.map((w) => (
													<li key={w}>{w}</li>
												))}
											</ul>
										)}
									</div>
								)}
							</div>

							<div className="my-2">
								<div className="flex w-full items-center justify-between">
									<div className={sectionLabel}>Advanced Params</div>
									<button type="button" className="text-muted-foreground hover:text-foreground rounded-sm px-2 py-0.5 text-xs" onClick={() => setShowAdvanced((v) => !v)}>
										{showAdvanced ? 'Hide' : 'Show'}
									</button>
								</div>
								{showAdvanced && (
									<div className="mt-2">
										<AdvancedParams admin custom layout="grid" params={state.params} onChange={(params) => patch({ params })} />
									</div>
								)}
							</div>
						</div>

						<hr className="my-3" />

						<div className="my-2">
							<div className="mb-1 flex w-full items-center justify-between">
								<div className={sectionLabel}>Prompts</div>
								<button
									type="button"
									className="text-muted-foreground hover:text-foreground rounded-sm px-2 py-0.5 text-xs"
									aria-label={(meta.suggestion_prompts ?? null) === null ? 'Default prompt suggestions' : 'Custom prompt suggestions'}
									onClick={() => setMeta({ suggestion_prompts: (meta.suggestion_prompts ?? null) === null ? [{ content: '', title: ['', ''] }] : null })}
								>
									{(meta.suggestion_prompts ?? null) === null ? 'Default' : 'Custom'}
								</button>
							</div>
							{meta.suggestion_prompts && (
								<PromptSuggestionsEditor value={meta.suggestion_prompts as PromptSuggestion[]} onChange={(next) => setMeta({ suggestion_prompts: next })} />
							)}
						</div>

						<hr className="my-3" />

						<div className="my-3">
							<KnowledgePicker items={state.knowledge} onChange={(knowledge) => patch({ knowledge })} />
						</div>
						<div className="my-3">
							<ItemPicker
								title="Tools"
								items={tools.data ?? []}
								selectedIds={state.toolIds}
								onChange={(toolIds) => patch({ toolIds })}
								labels={{ search: 'Search tools', trigger: 'Select Tool', empty: 'No tools found' }}
								footnote='To select toolkits here, add them to the "Tools" workspace or enable a tool server first.'
							/>
						</div>
						<div className="my-3">
							<ItemPicker
								title="Skills"
								items={skills.data ?? []}
								selectedIds={state.skillIds}
								onChange={(skillIds) => patch({ skillIds })}
								labels={{ search: 'Search skills', trigger: 'Select Skill', empty: 'No skills found' }}
								footnote='To select skills here, add them to the "Skills" workspace first.'
							/>
						</div>

						{(filters.length > 0 || actions.length > 0) && (
							<>
								<hr className="my-3" />
								{filters.length > 0 && (
									<div className="my-3">
										<ItemPicker
											title="Filters"
											items={filters}
											lockGlobal
											selectedIds={state.filterIds}
											onChange={(filterIds) => patch({ filterIds })}
											labels={{ search: 'Search filters', trigger: 'Select Filter', empty: 'No filters found' }}
											footnote='To select filters here, add them to the "Functions" workspace first.'
										/>
									</div>
								)}
								{toggleableFilters.length > 0 && (
									<div className="my-3">
										<ItemPicker
											title="Default Filters"
											items={toggleableFilters}
											selectedIds={state.defaultFilterIds}
											onChange={(defaultFilterIds) => patch({ defaultFilterIds })}
											labels={{ search: 'Search filters', trigger: 'Select Filter', empty: 'No filters found' }}
											footnote="To select default filters here, enable toggleable filters for this model first."
										/>
									</div>
								)}
								{actions.length > 0 && (
									<div className="my-3">
										<ItemPicker
											title="Actions"
											items={actions}
											lockGlobal
											selectedIds={state.actionIds}
											onChange={(actionIds) => patch({ actionIds })}
											labels={{ search: 'Search actions', trigger: 'Select Action', empty: 'No actions found' }}
											footnote='To select actions here, add them to the "Functions" workspace first.'
										/>
									</div>
								)}
							</>
						)}

						<hr className="my-3" />

						<div className="my-3">
							<CheckboxGrid
								title="Capabilities"
								items={capabilityItems.filter((c) => !(c.id === 'file_context' && !state.capabilities.file_upload))}
								isChecked={(id) => Boolean(state.capabilities[id])}
								onToggle={(id, checked) => patch({ capabilities: { ...state.capabilities, [id]: checked } })}
							/>
						</div>

						{features.length > 0 && (
							<div className="my-3">
								<CheckboxGrid
									title="Default Features"
									items={featureItems.filter((f) => features.includes(f.id))}
									isChecked={(id) => state.defaultFeatureIds.includes(id)}
									onToggle={(id, checked) =>
										patch({ defaultFeatureIds: checked ? (state.defaultFeatureIds.includes(id) ? state.defaultFeatureIds : [...state.defaultFeatureIds, id]) : state.defaultFeatureIds.filter((x) => x !== id) })
									}
								/>
							</div>
						)}

						{state.capabilities.builtin_tools && (
							<div className="my-3">
								<CheckboxGrid
									title="Builtin Tools"
									items={builtinToolItems}
									// Builtin tools are all on unless one is explicitly switched off.
									isChecked={(id) => state.builtinTools[id] !== false}
									onToggle={(id, checked) => {
										const next = { ...state.builtinTools };
										if (checked) delete next[id];
										else next[id] = false;
										patch({ builtinTools: next });
									}}
								/>
							</div>
						)}

						{state.capabilities.terminal && (terminals.data ?? []).length > 0 && (
							<div className="my-3">
								<div className="text-muted-foreground mb-1 text-xs">Terminal</div>
								<select
									className="border-border bg-background w-full rounded-lg border px-2 py-1.5 text-sm"
									aria-label="Terminal"
									value={state.terminalId}
									onChange={(e) => patch({ terminalId: e.target.value })}
								>
									<option value="">None</option>
									{(terminals.data ?? []).map((t) => (
										<option key={t.id} value={t.id}>
											{t.name || t.id}
										</option>
									))}
								</select>
							</div>
						)}

						<div className="my-3">
							<div className="text-muted-foreground mb-1 text-xs">TTS Voice</div>
							<input
								className="border-border bg-background w-full rounded-lg border px-2 py-1.5 text-sm"
								list="tts-voices"
								aria-label="TTS Voice"
								placeholder="e.g. alloy, echo, shimmer"
								autoComplete="off"
								value={state.tts.voice}
								onChange={(e) => patch({ tts: { voice: e.target.value } })}
							/>
							<datalist id="tts-voices">
								{(voices.data ?? []).map((v) => (
									<option key={v.id} value={v.id}>
										{v.name}
									</option>
								))}
							</datalist>
						</div>

						<div className="my-4 flex justify-end pb-6">
							<Button type="submit" disabled={loading}>
								{edit ? 'Save & Update' : 'Save & Create'}
								{loading && <Spinner className="size-3.5" />}
							</Button>
						</div>

						<div className="pb-16">
							<div className="flex items-center justify-between">
								<div className="text-sm">JSON Preview</div>
								<button type="button" className="text-muted-foreground hover:text-foreground text-xs" onClick={() => setShowPreview((v) => !v)}>
									{showPreview ? 'Hide' : 'Show'}
								</button>
							</div>
							{showPreview && (
								<pre className="bg-muted/50 mt-2 max-h-96 overflow-auto rounded-lg p-3 text-xs">{JSON.stringify(preview.ok ? preview.info : state.info, null, 2)}</pre>
							)}
						</div>
					</div>
				</form>
			</div>
		</div>
	);
}
