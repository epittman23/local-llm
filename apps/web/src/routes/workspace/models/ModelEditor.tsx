import { useQuery } from '@tanstack/react-query';
import { Camera, ChevronLeft, ChevronRight, CircleAlert } from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import { AdvancedParams } from '@/components/common/AdvancedParams';
import { failureCause } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { Tags } from '@/components/common/Tags';
import { hasPicture, ProfileAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { ImageButton } from '@/components/ui/image-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SaveBar } from '@/components/ui/save-bar';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { getModels } from '@/lib/apis';
import { getVoices } from '@/lib/apis/audio';
import { getModelsDefaults } from '@/lib/apis/configs';
import { getFunctions } from '@/lib/apis/functions';
import { getBaseModelTags, getModelTags } from '@/lib/apis/models';
import { getSkills } from '@/lib/apis/skills';
import { getTerminalServers } from '@/lib/apis/terminal';
import { getTools } from '@/lib/apis/tools';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useUnsavedChanges } from '@/lib/ui/useUnsavedChanges';
import { cn } from '@/lib/utils';
import { routePaths } from '@/routes/routePaths';
import { useSingleUser } from '@/routes/workspace/workspaceAccess';
import { BaseModelSelect, CheckboxGrid, groupLabel, ItemPicker } from './EditorPickers';
import { KnowledgePicker } from './KnowledgePicker';
import {
	availableFeatures,
	builtinToolItems,
	capabilityItems,
	featureItems,
	markSwitchedOff
} from './modelEditorLabels';
import {
	buildModelInfo,
	type EditorErrors,
	type EditorField,
	type EditorState,
	firstError,
	getBaseModelItems,
	getChatVariablesPreview,
	initialEditorState,
	type ModelInfo,
	modelIdFromName,
	sameValue,
	validateEditor
} from './modelEditorLogic';
import { type PromptSuggestion, PromptSuggestionsEditor } from './PromptSuggestionsEditor';

/** An endpoint that fails or answers with something unexpected counts as an empty list. */
const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const PICTURE_TYPES = ['image/gif', 'image/jpeg', 'image/png', 'image/webp'];
const NO_TERMINAL = 'none';

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

/** One of the form's sections (FRM-6): an h3 over its fields. */
function Section({ title, children }: { title: string; children: ReactNode }) {
	const id = useId();
	return (
		<section aria-labelledby={id} className="flex flex-col gap-5">
			<h3 id={id} className="text-title font-title border-b pb-2">
				{title}
			</h3>
			{children}
		</section>
	);
}

/** A label above its field, with "(optional)" for an optional one (FRM-1, FRM-6). */
function FieldLabel({
	htmlFor,
	id,
	optional,
	children
}: {
	htmlFor?: string;
	id?: string;
	optional?: boolean;
	children: ReactNode;
}) {
	return (
		<Label htmlFor={htmlFor} id={id} className="text-body font-strong mb-1.5">
			{children}
			{optional && <span className="text-foreground-muted font-normal">(optional)</span>}
		</Label>
	);
}

/** A closed-by-default part of the form, opened by a disclosure button (FRM-6). */
function Disclosure({ title, children }: { title: string; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	return (
		<div>
			<Button
				variant="ghost"
				type="button"
				className="-ms-2"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen((v) => !v)}
			>
				<ChevronRight aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
				{title}
			</Button>
			<div id={id} hidden={!open} className="mt-3">
				{open && children}
			</div>
		</div>
	);
}

/**
 * Ports workspace/Models/ModelEditor.svelte (create, clone and edit), as a long
 * form in sections (FRM-6): Identity, Behaviour, Knowledge and tools,
 * Capabilities, and Advanced (closed). It saves on request (FRM-3): the save
 * bar says whether there are unsaved changes, and leaving with some asks
 * first. Errors appear under their fields (FRM-2); a failed save says so above
 * the save bar.
 *
 * The data flow is in modelEditorLogic.ts (`initialEditorState` in,
 * `buildModelInfo` out), so this file is layout and wiring. Loading: it waits
 * for the model list and the admin defaults (both feed the initial state),
 * then renders; the tool/skill/function lists load in the background.
 *
 * `onSubmit` saves and throws on failure; after a save the editor leaves
 * through `onBack`.
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
	return (
		<EditorForm
			model={model}
			edit={edit}
			preset={preset}
			allModels={models.data ?? []}
			defaults={defaults.data ?? {}}
			onSubmit={onSubmit}
			onBack={onBack}
		/>
	);
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
	const features = useConfigStore((s) => s.config?.features);
	const isAdmin = user?.role === 'admin';
	const singleUser = useSingleUser();
	const ids = useId();
	const fieldId = (name: string) => `${ids}-${name}`;

	// The baseline is the form as first rendered (blank, cloned or loaded), so
	// opening and leaving never asks; values are compared, not change events.
	const [baseline, setBaseline] = useState<EditorState>(() =>
		initialEditorState(model, defaults, { edit, baseModels: allModels })
	);
	const [state, setState] = useState<EditorState>(baseline);
	const dirty = !sameValue(state, baseline);
	const patch = (p: Partial<EditorState>) => setState((s) => ({ ...s, ...p }));
	const setMeta = (p: Record<string, unknown>) =>
		setState((s) => ({ ...s, info: { ...s.info, meta: { ...s.info.meta, ...p } } }));
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<unknown>(null);
	const [errors, setErrors] = useState<EditorErrors>({});
	const [showAccess, setShowAccess] = useState(false);
	const imageInput = useRef<HTMLInputElement>(null);
	const nameField = useRef<HTMLInputElement>(null);
	const idField = useRef<HTMLInputElement>(null);
	const baseField = useRef<HTMLButtonElement>(null);
	const knowledgeField = useRef<HTMLDivElement>(null);
	// Switching suggestions to Default and back keeps what was written.
	const lastSuggestions = useRef<PromptSuggestion[] | null>(null);

	const guard = useUnsavedChanges(dirty, {
		message: edit
			? `Your changes to “${baseline.name}” are not saved. They are lost if you leave.`
			: 'This model is not created yet. What you entered is lost if you leave.'
	});

	const tools = useQuery({
		queryKey: ['tools-all'],
		queryFn: async () => asArray<any>(await getTools(token).catch(() => null))
	});
	const skills = useQuery({
		queryKey: ['skills-all'],
		queryFn: async () => asArray<any>(await getSkills(token).catch(() => null))
	});
	const functions = useQuery({
		queryKey: ['functions-all'],
		queryFn: async () => asArray<any>(await getFunctions(token).catch(() => null))
	});
	const tagSuggestions = useQuery({
		queryKey: ['model-tags', preset],
		queryFn: async () => asArray<string>(await (preset ? getModelTags : getBaseModelTags)(token).catch(() => []))
	});
	const terminals = useQuery({
		queryKey: ['terminals'],
		queryFn: async () => asArray<{ id: string; name?: string }>(await getTerminalServers(token).catch(() => []))
	});
	const voices = useQuery({
		queryKey: ['voices'],
		queryFn: async () =>
			((await getVoices(token).catch(() => null))?.voices ?? []) as Array<{ id: string; name?: string }>
	});

	const fns = functions.data ?? [];
	const filters = fns.filter((f) => f.type === 'filter');
	const actions = fns.filter((f) => f.type === 'action');
	const toggleableFilters = filters.filter((f) => (state.filterIds.includes(f.id) || f.is_global) && f.meta?.toggle);

	const variables = getChatVariablesPreview(state.system ?? '');
	const baseItems = getBaseModelItems(allModels, {
		currentModelId: model?.id,
		edit,
		selectedBaseId: state.info.base_model_id,
		isAdmin
	});
	const meta = state.info.meta;
	const tags = ((meta.tags ?? []) as Array<{ name: string }>).map((t) => (typeof t === 'string' ? { name: t } : t));
	const available = availableFeatures(state.capabilities);
	const takenIds = edit ? [] : allModels.map((m) => m.id as string);
	const customSuggestions = (meta.suggestion_prompts ?? null) !== null;

	/** FRM-2: judge one field when the person leaves it, and clear its error once it is put right. */
	const check = (field: EditorField, next: EditorState = state, always = true) => {
		const message = validateEditor(next, { preset, takenIds })[field];
		setErrors((e) => (always || e[field] ? { ...e, [field]: message } : e));
	};

	const focusField = (field: EditorField) => {
		const target = { name: nameField, id: idField, base: baseField, knowledge: knowledgeField }[field].current;
		target?.scrollIntoView?.({ block: 'nearest' });
		target?.focus();
	};

	const submit = async () => {
		const found = validateEditor(state, { preset, takenIds });
		setErrors(found);
		const first = firstError(found);
		if (first) {
			focusField(first);
			return;
		}
		const result = buildModelInfo(state, { preset, takenIds });
		if (!result.ok) return;
		setSaving(true);
		setSaveError(null);
		try {
			await onSubmit(result.info);
		} catch (error) {
			setSaveError(error ?? 'unknown');
			setSaving(false);
			return;
		}
		setSaving(false);
		setBaseline(state);
		guard.allowNext();
		onBack();
	};

	const preview = buildModelInfo({ ...state, id: state.id || '(id)', name: state.name || '(name)' }, { preset: false });
	const failed = saveError === null ? null : failureCause(saveError);
	const nameNote = fieldId('name-note');
	const idNote = fieldId('id-note');
	const baseNote = fieldId('base-note');
	const systemNote = fieldId('system-note');
	const idHelp = edit ? "A model's ID can't be changed." : "Names the model in the API. It can't be changed later.";

	return (
		<div className="flex h-full min-h-0 w-full flex-col">
			{guard.dialog}
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

			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-3">
				<Button variant="ghost" size="sm" className="-ms-2" type="button" onClick={() => guard.confirmLeave(onBack)}>
					<ChevronLeft aria-hidden />
					Back
				</Button>
				<h2 className="text-heading font-title min-w-0 flex-1 truncate tracking-tight">
					{edit ? 'Edit model' : 'New model'}
				</h2>
				{/* WRD-4, S4-D1: sharing says nothing while the install has one account. */}
				{!singleUser && <AccessButton onClick={() => setShowAccess(true)} />}
			</div>

			<input
				ref={imageInput}
				type="file"
				hidden
				accept="image/*"
				onChange={async (e) => {
					const file = e.target.files?.[0];
					e.target.value = '';
					if (!file) return;
					if (!PICTURE_TYPES.includes(file.type)) {
						toast.error('Use a PNG, JPEG, WebP or GIF image.');
						return;
					}
					try {
						setMeta({ profile_image_url: await readProfileImage(file) });
					} catch (error) {
						toast.error(`Couldn't read “${file.name}”. Try another image.`, { description: String(error) });
					}
				}}
			/>

			<form
				noValidate
				className="flex min-h-0 w-full flex-1 flex-col"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div className="min-h-0 w-full flex-1 overflow-y-auto pe-1">
					<div className="flex max-w-[72rem] flex-col gap-10 pb-10">
						<Section title="Identity">
							<div className="flex min-w-0 items-start gap-4">
								<div className="flex shrink-0 flex-col items-center gap-1 pt-7">
									<ImageButton
										aria-label="Upload a picture"
										shape="circle"
										className="size-12 md:size-14"
										overlay={<Camera />}
										onClick={() => imageInput.current?.click()}
									>
										<ProfileAvatar src={meta.profile_image_url} name={state.name} className="size-full text-base" />
									</ImageButton>
									{hasPicture(meta.profile_image_url) && (
										<Button
											variant="ghost"
											size="xs"
											type="button"
											onClick={() => setMeta({ profile_image_url: null })}
										>
											Remove picture
										</Button>
									)}
								</div>
								<div className="flex min-w-0 flex-1 flex-col gap-4">
									<div>
										<FieldLabel htmlFor={fieldId('name')}>Model name</FieldLabel>
										<Input
											ref={nameField}
											id={fieldId('name')}
											placeholder="e.g. Statistics tutor"
											value={state.name}
											{...fieldProps(nameNote, { error: errors.name })}
											onBlur={() => check('name')}
											onChange={(e) => {
												// A new model's id follows its name, cleared name included, until the id is edited by hand.
												const name = e.target.value;
												const auto = !edit && state.id === modelIdFromName(state.name);
												const next = { ...state, name, ...(auto ? { id: modelIdFromName(name) } : {}) };
												setState(next);
												check('name', next, false);
												if (next.id !== state.id) check('id', next, false);
											}}
										/>
										<FieldMessage id={nameNote} error={errors.name} />
									</div>
									<div>
										<FieldLabel htmlFor={fieldId('id')}>Model ID</FieldLabel>
										<Input
											ref={idField}
											id={fieldId('id')}
											className="font-mono"
											placeholder="e.g. statistics-tutor"
											value={state.id}
											disabled={edit}
											{...fieldProps(idNote, { error: errors.id, help: idHelp })}
											onBlur={() => check('id')}
											onChange={(e) => {
												const next = { ...state, id: e.target.value };
												setState(next);
												check('id', next, false);
											}}
										/>
										<FieldMessage id={idNote} error={errors.id} help={idHelp} />
									</div>
								</div>
							</div>

							{preset && (
								<div>
									<FieldLabel id={fieldId('base-label')}>Base model</FieldLabel>
									<BaseModelSelect
										ref={baseField}
										labelId={fieldId('base-label')}
										items={baseItems}
										value={state.info.base_model_id}
										placeholder="Choose a model, e.g. qwen/qwen3.6-27b"
										invalid={Boolean(errors.base)}
										describedBy={baseNote}
										onChange={(base) => {
											const next = { ...state, info: { ...state.info, base_model_id: base } };
											setState(next);
											check('base', next, false);
										}}
									/>
									<FieldMessage
										id={baseNote}
										error={errors.base}
										help="The model that answers. This entry gives it a name, a prompt, knowledge and tools."
									/>
								</div>
							)}

							<div>
								<FieldLabel htmlFor={fieldId('description')} optional>
									Description
								</FieldLabel>
								<Textarea
									id={fieldId('description')}
									rows={2}
									placeholder="e.g. Explains statistics step by step"
									value={meta.description ?? ''}
									onChange={(e) => setMeta({ description: e.target.value })}
								/>
							</div>

							<div>
								<FieldLabel htmlFor={fieldId('tags')} optional>
									Tags
								</FieldLabel>
								<Tags
									id={fieldId('tags')}
									tags={tags}
									suggestionTags={(tagSuggestions.data ?? []).map((name) => ({ name }))}
									onAdd={(name) => setMeta({ tags: [...tags, { name }] })}
									onDelete={(name) => setMeta({ tags: tags.filter((t) => t.name !== name) })}
								/>
							</div>
						</Section>

						<Section title="Behaviour">
							<div>
								<FieldLabel htmlFor={fieldId('system')} optional>
									System prompt
								</FieldLabel>
								<Textarea
									id={fieldId('system')}
									className="resize-y"
									rows={8}
									placeholder="e.g. You are a careful statistics tutor. Show each step."
									aria-describedby={systemNote}
									value={state.system}
									onChange={(e) => patch({ system: e.target.value })}
								/>
								<FieldMessage id={systemNote} help="Sent at the start of every chat with this model." />
								{(variables.fields.length > 0 || variables.userFields.length > 0 || variables.warnings.length > 0) && (
									<div className="bg-surface-2 text-dense mt-2 rounded-lg px-3 py-2">
										<div className="font-strong">Detected variables</div>
										{variables.fields.length > 0 && (
											<div className="mt-1">
												<div className="text-foreground-muted">Chat variables</div>
												{variables.fields.map((f) => (
													<div key={f.key} className="font-mono">
														{f.key}{' '}
														<span className="text-foreground-muted">
															({f.type ?? 'text'}
															{f.required ? ', required' : ''})
														</span>
													</div>
												))}
											</div>
										)}
										{variables.userFields.length > 0 && (
											<div className="mt-1">
												<div className="text-foreground-muted">User variables</div>
												{variables.userFields.map((f) => (
													<div key={f.key} className="font-mono">
														{f.key}
													</div>
												))}
											</div>
										)}
										{variables.warnings.length > 0 && (
											<ul className="text-warning mt-1 list-disc ps-4">
												{variables.warnings.map((w) => (
													<li key={w}>{w}</li>
												))}
											</ul>
										)}
									</div>
								)}
							</div>

							<div>
								<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
									<h4 id={fieldId('suggestions')} className={groupLabel}>
										Prompt suggestions
									</h4>
									<SegmentedControl
										aria-labelledby={fieldId('suggestions')}
										value={customSuggestions ? 'custom' : 'default'}
										options={[
											{ value: 'default', label: 'Default' },
											{ value: 'custom', label: 'Custom' }
										]}
										onValueChange={(v) => {
											if (v === 'default') {
												lastSuggestions.current = (meta.suggestion_prompts as PromptSuggestion[]) ?? null;
												setMeta({ suggestion_prompts: null });
											} else {
												setMeta({
													suggestion_prompts: lastSuggestions.current ?? [{ content: '', title: ['', ''] }]
												});
											}
										}}
									/>
								</div>
								{customSuggestions ? (
									<div className="mt-3">
										<PromptSuggestionsEditor
											value={meta.suggestion_prompts as PromptSuggestion[]}
											onChange={(next) => setMeta({ suggestion_prompts: next })}
										/>
									</div>
								) : (
									<p className="text-foreground-muted text-dense mt-1">
										A new chat with this model shows the app's suggestions.
									</p>
								)}
							</div>
						</Section>

						<Section title="Knowledge and tools">
							<div ref={knowledgeField} tabIndex={-1}>
								<KnowledgePicker
									items={state.knowledge}
									error={errors.knowledge}
									onChange={(knowledge) => {
										const next = { ...state, knowledge };
										setState(next);
										check('knowledge', next, false);
									}}
								/>
							</div>
							<ItemPicker
								title="Tools"
								items={tools.data ?? []}
								selectedIds={state.toolIds}
								onChange={(toolIds) => patch({ toolIds })}
								labels={{ search: 'Search tools', trigger: 'Choose tools', noMatch: 'No tool matches that search.' }}
								empty={
									tools.isSuccess && (
										<>
											No tools yet.{' '}
											<Link to={routePaths.workspaceTools} className="text-link underline">
												Create one in Tools
											</Link>
											.
										</>
									)
								}
							/>
							<ItemPicker
								title="Skills"
								items={skills.data ?? []}
								selectedIds={state.skillIds}
								onChange={(skillIds) => patch({ skillIds })}
								labels={{ search: 'Search skills', trigger: 'Choose skills', noMatch: 'No skill matches that search.' }}
								empty={
									skills.isSuccess && (
										<>
											No skills yet.{' '}
											<Link to={routePaths.workspaceSkills} className="text-link underline">
												Create one in Skills
											</Link>
											.
										</>
									)
								}
							/>
							{filters.length > 0 && (
								<ItemPicker
									title="Filters"
									items={filters}
									lockGlobal
									selectedIds={state.filterIds}
									onChange={(filterIds) => patch({ filterIds })}
									labels={{
										search: 'Search filters',
										trigger: 'Choose filters',
										noMatch: 'No filter matches that search.'
									}}
								/>
							)}
							{toggleableFilters.length > 0 && (
								<ItemPicker
									title="Filters on by default"
									items={toggleableFilters}
									selectedIds={state.defaultFilterIds}
									onChange={(defaultFilterIds) => patch({ defaultFilterIds })}
									labels={{
										search: 'Search filters',
										trigger: 'Choose filters on by default',
										noMatch: 'No filter matches that search.'
									}}
								/>
							)}
							{actions.length > 0 && (
								<ItemPicker
									title="Actions"
									items={actions}
									lockGlobal
									selectedIds={state.actionIds}
									onChange={(actionIds) => patch({ actionIds })}
									labels={{
										search: 'Search actions',
										trigger: 'Choose actions',
										noMatch: 'No action matches that search.'
									}}
								/>
							)}
						</Section>

						<Section title="Capabilities">
							<CheckboxGrid
								title="What this model can do"
								items={markSwitchedOff(
									capabilityItems.filter((c) => !(c.id === 'file_context' && !state.capabilities.file_upload)),
									features
								)}
								isChecked={(id) => Boolean(state.capabilities[id])}
								onToggle={(id, checked) => patch({ capabilities: { ...state.capabilities, [id]: checked } })}
							/>
							{available.length > 0 && (
								<CheckboxGrid
									title="On by default in a new chat"
									items={markSwitchedOff(
										featureItems.filter((f) => available.includes(f.id)),
										features
									)}
									isChecked={(id) => state.defaultFeatureIds.includes(id)}
									onToggle={(id, checked) =>
										patch({
											defaultFeatureIds: checked
												? state.defaultFeatureIds.includes(id)
													? state.defaultFeatureIds
													: [...state.defaultFeatureIds, id]
												: state.defaultFeatureIds.filter((x) => x !== id)
										})
									}
								/>
							)}
							{state.capabilities.terminal && (terminals.data ?? []).length > 0 && (
								<div>
									<FieldLabel id={fieldId('terminal')}>Terminal server</FieldLabel>
									<Select
										value={state.terminalId || NO_TERMINAL}
										onValueChange={(v) => patch({ terminalId: v === NO_TERMINAL ? '' : v })}
									>
										<SelectTrigger aria-labelledby={fieldId('terminal')} className="w-full sm:w-80">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={NO_TERMINAL}>None</SelectItem>
											{(terminals.data ?? []).map((t) => (
												<SelectItem key={t.id} value={t.id}>
													{t.name || t.id}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							)}
						</Section>

						<Section title="Advanced">
							<Disclosure title="Builtin tools, voice and parameters">
								<div className="flex flex-col gap-8">
									{state.capabilities.builtin_tools ? (
										<CheckboxGrid
											title="Builtin tools"
											items={markSwitchedOff(builtinToolItems, features)}
											// Builtin tools are all on unless one is explicitly switched off.
											isChecked={(id) => state.builtinTools[id] !== false}
											onToggle={(id, checked) => {
												const next = { ...state.builtinTools };
												if (checked) delete next[id];
												else next[id] = false;
												patch({ builtinTools: next });
											}}
										/>
									) : (
										<p className="text-foreground-muted text-dense">
											Builtin tools are off for this model. Turn them on under Capabilities to choose which.
										</p>
									)}
									<div>
										<FieldLabel htmlFor={fieldId('voice')} optional>
											Voice for reading aloud
										</FieldLabel>
										<Input
											id={fieldId('voice')}
											list={fieldId('voices')}
											className="sm:w-80"
											autoComplete="off"
											aria-describedby={fieldId('voice-note')}
											value={state.tts.voice}
											onChange={(e) => patch({ tts: { voice: e.target.value } })}
										/>
										<datalist id={fieldId('voices')}>
											{(voices.data ?? []).map((v) => (
												<option key={v.id} value={v.id}>
													{v.name}
												</option>
											))}
										</datalist>
										<FieldMessage
											id={fieldId('voice-note')}
											help="Empty uses the voice set in Admin Settings > Audio."
										/>
									</div>
									<div>
										<h4 className={cn(groupLabel, 'mb-2')}>Parameters</h4>
										<AdvancedParams
											admin
											custom
											layout="grid"
											params={state.params}
											onChange={(params) => patch({ params })}
										/>
									</div>
									<Disclosure title="JSON preview">
										<pre className="bg-surface-2 text-dense max-h-96 overflow-auto rounded-lg p-3">
											{JSON.stringify(preview.ok ? preview.info : state.info, null, 2)}
										</pre>
									</Disclosure>
								</div>
							</Disclosure>
						</Section>
					</div>
				</div>

				{failed && (
					<div role="alert" className="text-danger mb-3 flex items-start gap-2">
						<CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
						<div className="min-w-0">
							<p>
								{edit ? "Couldn't save the model." : "Couldn't create the model."} {failed.cause}
							</p>
							{failed.detail && (
								<details className="text-foreground-muted text-dense mt-1">
									<summary className="cursor-pointer">Details</summary>
									<p className="mt-1 break-words">{failed.detail}</p>
								</details>
							)}
						</div>
					</div>
				)}
				<SaveBar
					creating={!edit}
					// An unsaved clone can be created as it is.
					dirty={dirty || (!edit && model !== null)}
					saving={saving}
					saveLabel={edit ? 'Save changes' : 'Create model'}
					onDiscard={() => {
						setState(baseline);
						setErrors({});
						setSaveError(null);
					}}
				/>
			</form>
		</div>
	);
}
