import { useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { CheckCircle, ChevronDown, Download, Eye, EyeOff, FileUp, Minus, Trash2, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { FilterMenu, TagSelector } from '@/components/common/FilterSelects';
import { ListEmptyState, ListSearchBar } from '@/components/common/ListChrome';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { getBackendConfig } from '@/lib/apis';
import { getModels } from '@/lib/apis';
import { getErrorMessage } from '@/lib/apis/openai';
import { getModelsConfig, setDefaultPromptSuggestions, setModelsConfig } from '@/lib/apis/configs';
import { createNewModel, deleteAllModels, getBaseModelTags, getBaseModels, getModelById, importModels, toggleModelById, updateModelAccessGrants, updateModelById } from '@/lib/apis/models';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { copyToClipboard } from '@/lib/utils';
import { useShiftKey } from '@/lib/utils/useShiftKey';
import { routePaths } from '@/routes/routePaths';
import { ModelEditor } from '@/routes/workspace/models/ModelEditor';
import { parseModelImport } from '@/routes/workspace/models/modelImport';
import { ManageModelsModal } from './ManageModelsModal';
import { ModelDefaultsPanel } from './ModelDefaultsPanel';
import { ModelRow, type RowHandlers } from './ModelRow';
import {
	type DefaultsState,
	type ModelItem,
	type PromptSuggestion,
	VIEW_OPTIONS,
	type ViewOption,
	canReorder as reorderAllowed,
	defaultsFromConfig,
	defaultsMetadata,
	defaultsSnapshot,
	filterModels,
	isPresetModel,
	mergeModels,
	modelsConfigBody,
	moveItem,
	nextAccessGrants,
	nonBlankSuggestions,
	orderIds,
	savedParams,
	splitIds,
	toggleId,
	togglePlan,
	upsertPlan
} from './adminModels';

type Rec = Record<string, any>;
const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const menuIcon = 'size-3.5';

/**
 * Ports admin/Settings/Models.svelte: every model an admin can manage, with its
 * enabled / hidden / public state, the default and pinned selections, a saved
 * display order, and the defaults new models start from.
 *
 * Differences from the Svelte tab worth knowing: rows reorder by drag (native
 * HTML5, from the grip) *or* by Move Up / Move Down in the row menu, which is the
 * keyboard route; a failed change says so (the original swallows the error and
 * leaves the switch where it was clicked); the Model Defaults panel and the
 * list save through one request built from the current lists, so a default model
 * toggled a moment ago cannot be overwritten by an older copy.
 */
export default function AdminModels() {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const setBackendConfig = useConfigStore((s) => s.setConfig);
	const appSuggestions = useConfigStore((s) => s.config?.default_prompt_suggestions);
	const tabState = useSettingsModalStore((s) => s.tabState);
	const setTabState = useSettingsModalStore((s) => s.setTabState);
	const closeSettings = useSettingsModalStore((s) => s.closeSettings);
	const shiftKey = useShiftKey();
	const { pinnedModels: sidebarPinned, togglePinned: toggleSidebarPin } = useUserSettings();

	const [models, setModels] = useState<ModelItem[] | null>(null);
	const [recordIds, setRecordIds] = useState<ReadonlySet<string>>(new Set());
	const [tags, setTags] = useState<string[]>([]);
	const [config, setConfig] = useState<Rec | null>(null);
	const [order, setOrder] = useState<string[]>([]);
	const [orderDirty, setOrderDirty] = useState(false);
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [pinnedIds, setPinnedIds] = useState<string[]>([]);
	const [defaults, setDefaults] = useState<DefaultsState | null>(null);
	const [baseline, setBaseline] = useState('');
	const [search, setSearch] = useState('');
	const [view, setView] = useState<ViewOption>('');
	const [selectedTag, setSelectedTag] = useState('');
	const [editingId, setEditingId] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [importing, setImporting] = useState(false);
	const [showReset, setShowReset] = useState(false);
	const [showManage, setShowManage] = useState(false);
	const [dragFrom, setDragFrom] = useState<number | null>(null);
	const [dropAt, setDropAt] = useState<number | null>(null);
	const importInput = useRef<HTMLInputElement>(null);
	const seededDefaults = useRef(false);

	const refreshApp = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['models-all'] }), queryClient.invalidateQueries({ queryKey: ['workspace-models'] })]);

	/**
	 * Reads everything the list is built from. `quiet` keeps the current list on
	 * screen while it refreshes (after a change), instead of swapping it for a spinner.
	 */
	const init = useCallback(
		async (tag: string = selectedTag, quiet = true) => {
			if (!quiet) setModels(null);
			try {
				const [cfg, allTags] = await Promise.all([getModelsConfig(token), getBaseModelTags(token).then(asArray<string>)]);
				const activeTag = tag && allTags.includes(tag) ? tag : '';
				const [baseModels, served, provider] = await Promise.all([
					getBaseModels(token, activeTag).then(asArray<ModelItem>),
					getModels(token).then(asArray<ModelItem>),
					getModels(token, null, true).then(asArray<ModelItem>)
				]);
				const merged = mergeModels(served, provider, baseModels, activeTag);
				setConfig(cfg);
				setTags(allTags);
				setSelectedTag(activeTag);
				setRecordIds(new Set(baseModels.map((m) => m.id)));
				setModels(merged);
				setOrder(orderIds(cfg?.MODEL_ORDER_LIST ?? [], merged));
				setOrderDirty(false);
				setSelectedIds(splitIds(cfg?.DEFAULT_MODELS));
				setPinnedIds(splitIds(cfg?.DEFAULT_PINNED_MODELS));
				if (!seededDefaults.current) {
					seededDefaults.current = true;
					const d = defaultsFromConfig(cfg, appSuggestions as PromptSuggestion[] | undefined);
					setDefaults(d);
					setBaseline(defaultsSnapshot(d));
				}
			} catch (error) {
				toast.error(getErrorMessage(error));
				setModels((m) => m ?? []);
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[token, selectedTag, appSuggestions]
	);

	useEffect(() => {
		void init('', false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// "Open this model": the modal can be asked for a tab with a state naming a model.
	useEffect(() => {
		if (typeof tabState?.id === 'string' && tabState.id) {
			setEditingId(tabState.id);
			setTabState(null);
		}
	}, [tabState, setTabState]);

	const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
	const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
	const filtered = useMemo(() => filterModels(models ?? [], { search, view, order, selectedIds: selectedSet, pinnedIds: pinnedSet }), [models, search, view, order, selectedSet, pinnedSet]);
	const canReorder = reorderAllowed({ search, view, selectedTag });
	const defaultsDirty = defaults !== null && defaultsSnapshot(defaults) !== baseline;

	// --- one model ----------------------------------------------------------------

	const patchModel = (id: string, changes: Rec) => setModels((ms) => ms && ms.map((m) => (m.id === id ? { ...m, ...changes } : m)));

	/** Stores a change to `model`; false (after saying why) if the server refused it. */
	const upsert = async (model: ModelItem, overrides: Rec = {}, notify = true): Promise<boolean> => {
		const plan = upsertPlan(model, overrides, recordIds);
		try {
			if (plan.action === 'update') await updateModelById(token, plan.id, plan.body);
			else await createNewModel(token, plan.body);
			if (notify) toast.success('Model updated successfully');
			return true;
		} catch (error) {
			toast.error(getErrorMessage(error));
			return false;
		}
	};

	const toggleActive = async (model: ModelItem) => {
		const next = !(model.is_active ?? true);
		patchModel(model.id, { is_active: next });
		const plan = togglePlan(model, next);
		try {
			if (plan.action === 'create') await createNewModel(token, plan.body);
			else await toggleModelById(token, plan.id);
			await refreshApp();
			// A record now exists for a model that had none, so later edits update it.
			if (plan.action === 'create') await init();
		} catch (error) {
			patchModel(model.id, { is_active: !next });
			toast.error(getErrorMessage(error));
		}
	};

	const toggleHidden = async (model: ModelItem) => {
		const hidden = !(model.meta?.hidden ?? false);
		const meta = { ...model.meta, hidden };
		if (!(await upsert(model, { meta }, false))) return;
		patchModel(model.id, { meta });
		await refreshApp();
		toast.success(hidden ? `Model ${model.id} is now hidden` : `Model ${model.id} is now visible`);
	};

	const togglePrivacy = async (model: ModelItem) => {
		const grants = nextAccessGrants(model);
		try {
			const res = await updateModelAccessGrants(token, model.id, model.name ?? model.id, grants);
			if (!res) return;
			patchModel(model.id, { access_grants: res.access_grants ?? grants });
			await refreshApp();
			toast.success(grants.length > 0 ? 'Model is now public' : 'Model is now private');
		} catch (error) {
			toast.error(getErrorMessage(error));
		}
	};

	const fullModel = async (model: ModelItem): Promise<Rec> => (recordIds.has(model.id) || isPresetModel(model) ? ((await getModelById(token, model.id).catch(() => null)) ?? model) : model);

	const openModel = async (model: ModelItem) => {
		if (isPresetModel(model)) {
			closeSettings();
			navigate(`${routePaths.workspaceModelsEdit}?id=${encodeURIComponent(model.id)}`);
			return;
		}
		setEditingId(model.id);
	};

	const cloneModel = async (model: ModelItem) => {
		const full = await fullModel(model);
		sessionStorage.model = JSON.stringify({ ...full, base_model_id: model.id, id: `${model.id}-clone`, name: `${model.name} (Clone)` });
		closeSettings();
		navigate(routePaths.workspaceModelsCreate);
	};

	const exportModel = async (model: ModelItem) => {
		const full = await fullModel(model);
		saveAs(new Blob([JSON.stringify([full])], { type: 'application/json' }), `${model.id}-${Date.now()}.json`);
	};

	const copyLink = async (model: ModelItem) => {
		const ok = await copyToClipboard(`${window.location.origin}/?model=${encodeURIComponent(model.id)}`);
		if (ok) toast.success('Copied link to clipboard');
		else toast.error('Failed to copy link');
	};

	// --- default and pinned selections -------------------------------------------------

	const saveSelections = async (nextSelected: string[], nextPinned: string[], message: string) => {
		const [prevSelected, prevPinned] = [selectedIds, pinnedIds];
		setSelectedIds(nextSelected);
		setPinnedIds(nextPinned);
		try {
			const res = await setModelsConfig(token, modelsConfigBody(config, { selectedIds: nextSelected, pinnedIds: nextPinned, order: config?.MODEL_ORDER_LIST ?? [] }));
			if (!res) throw new Error('Failed to save');
			setConfig(res);
			toast.success(message);
		} catch (error) {
			setSelectedIds(prevSelected);
			setPinnedIds(prevPinned);
			toast.error(getErrorMessage(error));
		}
	};

	const toggleSelected = (model: ModelItem) =>
		saveSelections(toggleId(selectedIds, model.id), pinnedIds, selectedSet.has(model.id) ? 'Model removed from selected models' : 'Model added to selected models');
	const toggleDefaultPinned = (model: ModelItem) =>
		saveSelections(selectedIds, toggleId(pinnedIds, model.id), pinnedSet.has(model.id) ? 'Model removed from pinned models' : 'Model added to pinned models');

	// --- bulk ----------------------------------------------------------------------------

	const bulk = async (targets: ModelItem[], overrides: (m: ModelItem) => Rec, apply: (m: ModelItem) => Rec, message?: string) => {
		setModels((ms) => ms && ms.map((m) => (targets.some((t) => t.id === m.id) ? { ...m, ...apply(m) } : m)));
		const results = await Promise.all(targets.map((m) => upsert(m, overrides(m), false)));
		if (results.some((ok) => !ok)) toast.error('Some models could not be updated');
		else if (message) toast.success(message);
		await refreshApp();
		await init();
	};
	const enableAll = () => bulk(filtered.filter((m) => !(m.is_active ?? true)), () => ({ is_active: true }), () => ({ is_active: true }));
	const disableAll = () => bulk(filtered.filter((m) => m.is_active ?? true), () => ({ is_active: false }), () => ({ is_active: false }));
	const showAll = () =>
		bulk(filtered.filter((m) => m.meta?.hidden === true), (m) => ({ meta: { ...m.meta, hidden: false } }), (m) => ({ meta: { ...m.meta, hidden: false } }), 'All models are now visible');
	const hideAll = () =>
		bulk(filtered.filter((m) => !(m.meta?.hidden ?? false)), (m) => ({ meta: { ...m.meta, hidden: true } }), (m) => ({ meta: { ...m.meta, hidden: true } }), 'All models are now hidden');

	// --- import, export, reset --------------------------------------------------------------

	const importFile = async (file: File) => {
		setImporting(true);
		try {
			const parsed = parseModelImport(await file.text());
			if (await importModels(token, parsed)) {
				toast.success('Models imported successfully');
				await refreshApp();
				await init();
			} else {
				toast.error('Failed to import models');
			}
		} catch (error) {
			toast.error(error instanceof SyntaxError ? 'Invalid JSON file' : ((error as Rec)?.detail ?? (error instanceof Error ? error.message : `${error}`)));
		} finally {
			setImporting(false);
		}
	};

	const exportAll = async () => {
		const full = await Promise.all((models ?? []).map(fullModel));
		saveAs(new Blob([JSON.stringify(full)], { type: 'application/json' }), `models-export-${Date.now()}.json`);
	};

	const resetAll = async () => {
		try {
			await deleteAllModels(token);
			toast.success('All models deleted successfully');
			await refreshApp();
			await init();
		} catch (error) {
			toast.error(getErrorMessage(error));
		}
	};

	// --- order and defaults ----------------------------------------------------------------------

	const reorder = (from: number, to: number) => {
		const ids = filtered.map((m) => m.id);
		const moved = moveItem(ids, from, to);
		const movedSet = new Set(moved);
		setOrder([...moved, ...order.filter((id) => !movedSet.has(id))]);
		setOrderDirty(true);
	};

	const saveAll = async () => {
		if (!defaults) return;
		setSaving(true);
		try {
			const res = await setModelsConfig(
				token,
				modelsConfigBody(config, { selectedIds, pinnedIds, order, ...(defaultsDirty ? { metadata: defaultsMetadata(defaults), params: savedParams(defaults) } : {}) })
			);
			if (!res) throw new Error('Failed to save models configuration');
			setConfig(res);
			if (orderDirty) {
				setOrderDirty(false);
				toast.success('Model order saved successfully');
			}
			if (defaultsDirty) {
				const suggestions = nonBlankSuggestions(defaults.promptSuggestions);
				await setDefaultPromptSuggestions(token, suggestions);
				const fresh = await getBackendConfig().catch(() => null);
				if (fresh) setBackendConfig(fresh);
				const next = { ...defaults, promptSuggestions: suggestions };
				setDefaults(next);
				setBaseline(defaultsSnapshot(next));
				await queryClient.invalidateQueries({ queryKey: ['models-defaults'] });
				toast.success('Models configuration saved successfully');
			}
			await refreshApp();
		} catch (error) {
			toast.error(getErrorMessage(error));
		} finally {
			setSaving(false);
		}
	};

	const changeTag = async (tag: string) => {
		setSelectedTag(tag);
		await init(tag);
	};

	// --- render --------------------------------------------------------------------------------------

	if (models === null || defaults === null) {
		return (
			<div className="flex h-full w-full items-center justify-center">
				<Spinner className="size-5" />
			</div>
		);
	}

	if (editingId !== null) {
		const model = models.find((m) => m.id === editingId);
		return (
			<ModelEditor
				key={editingId}
				edit
				preset={false}
				model={model ? (model as { id: string; name: string }) : null}
				onSubmit={async (info) => {
					await upsert(info as unknown as ModelItem);
					setEditingId(null);
					await refreshApp();
					await init();
				}}
				onBack={async () => {
					setEditingId(null);
					await init();
				}}
			/>
		);
	}

	const viewLabel = VIEW_OPTIONS.find(([v]) => v === view)?.[1] ?? 'All';
	const menuItem = (icon: React.ReactNode, label: string, onSelect: () => void, disabled = false) => (
		<DropdownMenuItem disabled={disabled} onSelect={onSelect}>
			{icon}
			{label}
		</DropdownMenuItem>
	);

	return (
		<div className="flex h-full min-h-0 flex-col text-sm">
			<div className="mb-2 flex items-center justify-between">
				<h2 className="text-sm font-medium">
					Models <span className="text-muted-foreground ml-2 font-normal">{filtered.length}</span>
				</h2>
			</div>

			<input
				ref={importInput}
				type="file"
				accept=".json"
				hidden
				aria-label="Import models file"
				onChange={(e) => {
					const file = e.target.files?.[0];
					e.target.value = '';
					if (file) void importFile(file);
				}}
			/>

			<div className="flex min-h-0 flex-1 flex-col space-y-1">
				<ModelDefaultsPanel value={defaults} onChange={setDefaults} />

				<ListSearchBar value={search} onChange={setSearch} placeholder="Search Models">
					<FilterMenu
						value={view}
						items={VIEW_OPTIONS.map(([value, label]) => ({ value, label }))}
						onChange={(v) => setView(v as ViewOption)}
						trigger={
							<Button variant="ghost" size="sm" aria-label="View">
								<span className="truncate">{viewLabel}</span>
								<ChevronDown />
							</Button>
						}
					/>
					{tags.length > 0 && <TagSelector value={selectedTag} tags={tags} onChange={(t) => void changeTag(t)} />}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="sm" aria-label="Actions">
								Actions
								<ChevronDown />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-auto min-w-44">
							{menuItem(<FileUp className={menuIcon} />, 'Import', () => importInput.current?.click(), importing)}
							{menuItem(<Download className={menuIcon} />, 'Export', () => void exportAll())}
							{menuItem(<Wrench className={menuIcon} />, 'Manage', () => setShowManage(true))}
							{menuItem(<Trash2 className={menuIcon} />, 'Reset', () => setShowReset(true))}
							<DropdownMenuSeparator />
							{menuItem(<CheckCircle className={menuIcon} />, 'Enable All', () => void enableAll())}
							{menuItem(<Minus className={menuIcon} />, 'Disable All', () => void disableAll())}
							<DropdownMenuSeparator />
							{menuItem(<Eye className={menuIcon} />, 'Show All', () => void showAll())}
							{menuItem(<EyeOff className={menuIcon} />, 'Hide All', () => void hideAll())}
						</DropdownMenuContent>
					</DropdownMenu>
				</ListSearchBar>

				<div className={filtered.length > 0 ? 'my-0.5 min-h-0 flex-1 space-y-px overflow-y-auto pr-1.5' : 'my-0.5 min-h-0 flex-1 overflow-hidden'} data-testid="model-list">
					{filtered.length === 0 ? (
						<ListEmptyState title="No models found" />
					) : (
						filtered.map((model, i) => {
							const handlers: RowHandlers = {
								open: () => void openModel(model),
								toggleActive: () => void toggleActive(model),
								toggleHidden: () => void toggleHidden(model),
								toggleSelected: () => void toggleSelected(model),
								toggleDefaultPinned: () => void toggleDefaultPinned(model),
								togglePrivacy: () => void togglePrivacy(model),
								togglePinnedInSidebar: () => toggleSidebarPin(model.id),
								copyLink: () => void copyLink(model),
								clone: () => void cloneModel(model),
								exportModel: () => void exportModel(model),
								moveUp: () => reorder(i, i - 1),
								moveDown: () => reorder(i, i + 1)
							};
							return (
								<ModelRow
									key={model.id}
									model={model}
									index={i}
									count={filtered.length}
									shiftKey={shiftKey}
									canReorder={canReorder}
									isSelected={selectedSet.has(model.id)}
									isDefaultPinned={pinnedSet.has(model.id)}
									isSidebarPinned={sidebarPinned.includes(model.id)}
									dragging={dragFrom === i}
									dropTarget={dragFrom !== null && dropAt === i && dragFrom !== i}
									handlers={handlers}
									onDragStart={(e) => {
										setDragFrom(i);
										e.dataTransfer.effectAllowed = 'move';
										e.dataTransfer.setData('text/plain', model.id);
										const row = (e.currentTarget as HTMLElement).closest('[data-model-row]');
										if (row) e.dataTransfer.setDragImage(row, 16, 16);
									}}
									onDragOver={(e) => {
										if (dragFrom === null) return;
										e.preventDefault();
										setDropAt(i);
									}}
									onDrop={(e) => {
										e.preventDefault();
										if (dragFrom !== null) reorder(dragFrom, i);
										setDragFrom(null);
										setDropAt(null);
									}}
									onDragEnd={() => {
										setDragFrom(null);
										setDropAt(null);
									}}
								/>
							);
						})
					)}
				</div>

				<div className="flex justify-end pt-6 text-sm font-normal">
					<Button type="button" disabled={(!orderDirty && !defaultsDirty) || saving} onClick={() => void saveAll()}>
						Save
						{saving && <Spinner className="size-3.5" />}
					</Button>
				</div>
			</div>

			<ConfirmDialog open={showReset} onOpenChange={setShowReset} title="Reset All Models" onConfirm={resetAll}>
				This will delete all models including custom models and cannot be undone.
			</ConfirmDialog>
			<ManageModelsModal open={showManage} onOpenChange={setShowManage} />
		</div>
	);
}
