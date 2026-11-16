import { useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { CheckCircle, ChevronDown, Download, Eye, EyeOff, FileUp, Minus, Trash2, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { FilterMenu, TagSelector } from '@/components/common/FilterSelects';
import { toastFailure } from '@/components/common/failureToast';
import { ListEmptyState, ListMatchCount, ListSearchBar } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { SettingsForm, useSettingsHost } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { getBackendConfig, getModels } from '@/lib/apis';
import { getModelsConfig, setDefaultPromptSuggestions, setModelsConfig } from '@/lib/apis/configs';
import {
	createNewModel,
	deleteAllModels,
	getBaseModels,
	getBaseModelTags,
	getModelById,
	toggleModelById,
	updateModelAccessGrants,
	updateModelById
} from '@/lib/apis/models';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { useConfirmLeave } from '@/lib/ui/useUnsavedChanges';
import { copyToClipboard } from '@/lib/utils';
import { useAdminSingleUser } from '@/routes/admin/adminVisibility';
import { routePaths } from '@/routes/routePaths';
import { ModelEditor } from '@/routes/workspace/models/ModelEditor';
import { importModelFile } from '@/routes/workspace/models/modelImport';
import { useSingleUser } from '@/routes/workspace/workspaceAccess';
import {
	type DefaultsState,
	defaultsFromConfig,
	defaultsMetadata,
	defaultsSnapshot,
	filterModels,
	groupModels,
	importResultMessage,
	isPresetModel,
	type ModelItem,
	mergeModels,
	modelsConfigBody,
	nextAccessGrants,
	nonBlankSuggestions,
	orderIds,
	type PromptSuggestion,
	privacyOutcome,
	canReorder as reorderAllowed,
	reorderGroup,
	savedParams,
	splitIds,
	toggleId,
	togglePlan,
	upsertPlan,
	VIEW_OPTIONS,
	type ViewOption
} from './adminModels';
import { ManageModelsModal } from './ManageModelsModal';
import { ModelDefaultsPanel } from './ModelDefaultsPanel';
import { ModelRow, type RowHandlers } from './ModelRow';

type Rec = Record<string, any>;
const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const menuIcon = 'size-3.5';

/** A model's name for a sentence: its name, else its id, in quotes. */
const quoted = (model: ModelItem) => `“${model.name ?? model.id}”`;

/**
 * Ports admin/Settings/Models.svelte: every model an admin can manage, with its
 * enabled / hidden state, the default and pinned selections, a saved display
 * order, and the defaults new models start from.
 *
 * S5-D9 (#1030): two headed groups, the models from connections and the
 * workspace models built on them; a workspace model opens its editor in
 * Workspace. Rows reorder by drag (from the grip) or by Move up / Move down in
 * the row menu, within their group. The order and the Model Defaults are saved
 * on request (FRM-3: the SaveBar, and the host asks before they are lost);
 * every row action saves at once and says so. The model editor reports its
 * unsaved changes to the same host (#951), so a tab change, Escape or the close
 * button asks once.
 */
export default function AdminModels() {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const host = useSettingsHost();
	const singleUser = useSingleUser();
	// S5-D12: Pin by default only reaches other accounts, so it goes while Admin's one-account rule holds.
	const pinsByDefault = !useAdminSingleUser();
	const setBackendConfig = useConfigStore((s) => s.setConfig);
	const appSuggestions = useConfigStore((s) => s.config?.default_prompt_suggestions);
	const tabState = useSettingsModalStore((s) => s.tabState);
	const setTabState = useSettingsModalStore((s) => s.setTabState);
	const closeSettings = useSettingsModalStore((s) => s.closeSettings);
	const { pinnedModels: sidebarPinned, togglePinned: toggleSidebarPin } = useUserSettings();

	const [models, setModels] = useState<ModelItem[] | null>(null);
	const [loadError, setLoadError] = useState<unknown>(null);
	const [retrying, setRetrying] = useState(false);
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
	const [editorDirty, setEditorDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [importing, setImporting] = useState(false);
	const [showReset, setShowReset] = useState(false);
	const [showManage, setShowManage] = useState(false);
	const [dragFrom, setDragFrom] = useState<{ group: string; index: number } | null>(null);
	const [dropAt, setDropAt] = useState<number | null>(null);
	const importInput = useRef<HTMLInputElement>(null);
	const seededDefaults = useRef(false);
	// A reload after a change keeps an unsaved reorder rather than reading the saved order over it.
	const orderDirtyNow = useRef(orderDirty);
	orderDirtyNow.current = orderDirty;
	// Whether a list is on screen, for a failed reload: kept, with a toast, rather than replaced by the failure.
	const shown = useRef(false);
	shown.current = models !== null;

	const refreshApp = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ['models-all'] }),
			queryClient.invalidateQueries({ queryKey: ['workspace-models'] })
		]);

	/**
	 * Reads everything the list is built from. `quiet` keeps the current list on
	 * screen while it refreshes (after a change), instead of swapping it for a spinner.
	 */
	const init = useCallback(
		async (tag: string = selectedTag, quiet = true) => {
			if (!quiet) setModels(null);
			try {
				const [cfg, allTags] = await Promise.all([
					getModelsConfig(token),
					getBaseModelTags(token).then(asArray<string>)
				]);
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
				setLoadError(null);
				if (orderDirtyNow.current) setOrder((current) => orderIds(current, merged));
				else setOrder(orderIds(cfg?.MODEL_ORDER_LIST ?? [], merged));
				setSelectedIds(splitIds(cfg?.DEFAULT_MODELS));
				setPinnedIds(splitIds(cfg?.DEFAULT_PINNED_MODELS));
				if (!seededDefaults.current) {
					seededDefaults.current = true;
					const d = defaultsFromConfig(cfg, appSuggestions as PromptSuggestion[] | undefined);
					setDefaults(d);
					setBaseline(defaultsSnapshot(d));
				}
			} catch (error) {
				// STA-4: a first load that fails is shown in place; a refresh after a change keeps the list.
				if (quiet && shown.current) toastFailure("Couldn't refresh the model list.", error);
				else setLoadError(error);
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
	const filtered = useMemo(
		() => filterModels(models ?? [], { search, view, order, selectedIds: selectedSet, pinnedIds: pinnedSet }),
		[models, search, view, order, selectedSet, pinnedSet]
	);
	const groups = useMemo(() => groupModels(filtered), [filtered]);
	const canReorder = reorderAllowed({ search, view, selectedTag });
	const defaultsDirty = defaults !== null && defaultsSnapshot(defaults) !== baseline;
	const listDirty = orderDirty || defaultsDirty;
	const narrowed = search.trim() !== '' || view !== '' || selectedTag !== '';
	const workspaceCount = (models ?? []).filter((m) => isPresetModel(m)).length;

	// While the editor is open the list's form is gone; the host hears both: the list's unsaved
	// order and defaults, and the editor's own changes.
	useEffect(() => {
		if (editingId === null) return;
		host.setDirty(listDirty || editorDirty);
		return () => host.setDirty(false);
	}, [editingId, listDirty, editorDirty, host]);

	// The editor has its own back ("Models"), so a page drops its "All server settings" meanwhile.
	useEffect(() => {
		if (editingId === null) return;
		host.setOwnBack(true);
		return () => host.setOwnBack(false);
	}, [editingId, host]);

	// A way out that leaves Settings (a workspace model's editor, Clone) asks first in the dialog;
	// on a page the page's own guard asks as the navigation starts.
	const leaveGuard = useConfirmLeave(listDirty && host.kind !== 'page', {
		message: 'The model order and defaults are not saved. They are lost if you leave.'
	});
	const leaveSettings = (path: string) =>
		leaveGuard.confirmLeave(() => {
			closeSettings();
			navigate(path);
		});

	// --- one model ----------------------------------------------------------------

	const patchModel = (id: string, changes: Rec) =>
		setModels((ms) => ms && ms.map((m) => (m.id === id ? { ...m, ...changes } : m)));

	/** Stores a change to `model`; false (after saying why) if the server refused it. */
	const upsert = async (model: ModelItem, overrides: Rec = {}, notify = true): Promise<boolean> => {
		const plan = upsertPlan(model, overrides, recordIds);
		try {
			if (plan.action === 'update') await updateModelById(token, plan.id, plan.body);
			else {
				await createNewModel(token, plan.body);
				// A record now exists, so the next change updates it instead of
				// creating it again, which the server refuses (#249): upsertPlan
				// keys on recordIds, togglePlan on the row having base_model_id.
				// Recorded locally, not by re-reading everything, which would drop
				// an unsaved reorder and run once per model in a bulk action.
				setRecordIds((ids) => new Set(ids).add(plan.body.id));
				patchModel(plan.body.id, { base_model_id: plan.body.base_model_id ?? null });
			}
			if (notify) toast.success(`${quoted(model)} saved`);
			return true;
		} catch (error) {
			if (notify) toastFailure(`Couldn't save ${quoted(model)}.`, error);
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
			toastFailure(`Couldn't turn ${next ? 'on' : 'off'} ${quoted(model)}.`, error);
		}
	};

	const toggleHidden = async (model: ModelItem) => {
		const hidden = !(model.meta?.hidden ?? false);
		const meta = { ...model.meta, hidden };
		if (!(await upsert(model, { meta }, false))) {
			toastFailure(`Couldn't ${hidden ? 'hide' : 'show'} ${quoted(model)}.`);
			return;
		}
		patchModel(model.id, { meta });
		await refreshApp();
		toast.success(`${quoted(model)} is ${hidden ? 'hidden' : 'shown'}`);
	};

	const togglePrivacy = async (model: ModelItem) => {
		const grants = nextAccessGrants(model);
		try {
			const res = await updateModelAccessGrants(token, model.id, model.name ?? model.id, grants);
			if (!res) return;
			const outcome = privacyOutcome(grants, res);
			patchModel(model.id, { access_grants: outcome.grants });
			await refreshApp();
			toast[outcome.kind](outcome.text);
		} catch (error) {
			toastFailure(`Couldn't change who can use ${quoted(model)}.`, error);
		}
	};

	const fullModel = async (model: ModelItem): Promise<Rec> =>
		recordIds.has(model.id) || isPresetModel(model)
			? ((await getModelById(token, model.id).catch(() => null)) ?? model)
			: model;

	const openModel = (model: ModelItem) => {
		if (isPresetModel(model)) {
			leaveSettings(`${routePaths.workspaceModelsEdit}?id=${encodeURIComponent(model.id)}`);
			return;
		}
		setEditingId(model.id);
	};

	const cloneModel = async (model: ModelItem) => {
		const full = await fullModel(model);
		sessionStorage.model = JSON.stringify({
			...full,
			base_model_id: model.id,
			id: `${model.id}-clone`,
			name: `${model.name} (Clone)`
		});
		leaveSettings(routePaths.workspaceModelsCreate);
	};

	const exportModel = async (model: ModelItem) => {
		const full = await fullModel(model);
		saveAs(new Blob([JSON.stringify([full])], { type: 'application/json' }), `${model.id}-${Date.now()}.json`);
	};

	const copyLink = async (model: ModelItem) => {
		const ok = await copyToClipboard(`${window.location.origin}/?model=${encodeURIComponent(model.id)}`);
		if (ok) toast.success('Link copied');
		else toast.error("Couldn't copy the link. Your browser refused it.");
	};

	// --- default and pinned selections -------------------------------------------------

	const saveSelections = async (nextSelected: string[], nextPinned: string[], message: string) => {
		const [prevSelected, prevPinned] = [selectedIds, pinnedIds];
		setSelectedIds(nextSelected);
		setPinnedIds(nextPinned);
		try {
			const res = await setModelsConfig(
				token,
				modelsConfigBody(config, {
					selectedIds: nextSelected,
					pinnedIds: nextPinned,
					order: config?.MODEL_ORDER_LIST ?? []
				})
			);
			if (!res) throw new Error('The server returned nothing.');
			setConfig(res);
			toast.success(message);
		} catch (error) {
			setSelectedIds(prevSelected);
			setPinnedIds(prevPinned);
			toastFailure("Couldn't save the change.", error);
		}
	};

	const toggleSelected = (model: ModelItem) =>
		saveSelections(
			toggleId(selectedIds, model.id),
			pinnedIds,
			selectedSet.has(model.id)
				? `${quoted(model)} is no longer a default for new chats`
				: `${quoted(model)} is a default for new chats`
		);
	const toggleDefaultPinned = (model: ModelItem) =>
		saveSelections(
			selectedIds,
			toggleId(pinnedIds, model.id),
			pinnedSet.has(model.id)
				? `${quoted(model)} is no longer pinned by default`
				: `${quoted(model)} is pinned by default`
		);

	// --- bulk ----------------------------------------------------------------------------

	const bulk = async (
		targets: ModelItem[],
		overrides: (m: ModelItem) => Rec,
		apply: (m: ModelItem) => Rec,
		done: string
	) => {
		setModels((ms) => ms && ms.map((m) => (targets.some((t) => t.id === m.id) ? { ...m, ...apply(m) } : m)));
		const results = await Promise.all(targets.map((m) => upsert(m, overrides(m), false)));
		const failed = results.filter((ok) => !ok).length;
		// FBK-2: one toast for the whole action.
		if (failed > 0) toastFailure(`${failed} of ${targets.length} models couldn't be changed. Try again.`);
		else toast.success(done);
		await refreshApp();
		await init();
	};
	const enableAll = () =>
		bulk(
			filtered.filter((m) => !(m.is_active ?? true)),
			() => ({ is_active: true }),
			() => ({ is_active: true }),
			'All models turned on'
		);
	const disableAll = () =>
		bulk(
			filtered.filter((m) => m.is_active ?? true),
			() => ({ is_active: false }),
			() => ({ is_active: false }),
			'All models turned off'
		);
	const showAll = () =>
		bulk(
			filtered.filter((m) => m.meta?.hidden === true),
			(m) => ({ meta: { ...m.meta, hidden: false } }),
			(m) => ({ meta: { ...m.meta, hidden: false } }),
			'All models shown'
		);
	const hideAll = () =>
		bulk(
			filtered.filter((m) => !(m.meta?.hidden ?? false)),
			(m) => ({ meta: { ...m.meta, hidden: true } }),
			(m) => ({ meta: { ...m.meta, hidden: true } }),
			'All models hidden'
		);

	// --- import, export, reset --------------------------------------------------------------

	const importFile = async (file: File) => {
		setImporting(true);
		try {
			const result = await importModelFile(token, await file.text());
			if (result) {
				const message = importResultMessage(result);
				toast[message.kind](message.text);
				await refreshApp();
				await init();
			} else {
				toastFailure("Couldn't import the models. The server took none of them.");
			}
		} catch (error) {
			if (error instanceof SyntaxError) toastFailure(`Couldn't import “${file.name}”. It isn't a JSON file.`);
			else toastFailure(`Couldn't import “${file.name}”.`, error);
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
			toast.success('Models reset');
			await refreshApp();
			await init();
		} catch (error) {
			toastFailure("Couldn't reset the models.", error);
		}
	};

	// --- order and defaults ----------------------------------------------------------------------

	const reorder = (group: ModelItem[], from: number, to: number) => {
		setOrder(
			reorderGroup(
				order,
				group.map((m) => m.id),
				from,
				to
			)
		);
		setOrderDirty(true);
	};

	const discard = () => {
		setOrder(orderIds(config?.MODEL_ORDER_LIST ?? [], models ?? []));
		setOrderDirty(false);
		const d = defaultsFromConfig(config, appSuggestions as PromptSuggestion[] | undefined);
		setDefaults(d);
		setBaseline(defaultsSnapshot(d));
	};

	const saveAll = async () => {
		if (!defaults) return;
		setSaving(true);
		try {
			const res = await setModelsConfig(
				token,
				modelsConfigBody(config, {
					selectedIds,
					pinnedIds,
					order,
					...(defaultsDirty ? { metadata: defaultsMetadata(defaults), params: savedParams(defaults) } : {})
				})
			);
			if (!res) throw new Error('The server returned nothing.');
			setConfig(res);
			setOrderDirty(false);
			if (defaultsDirty) {
				const suggestions = nonBlankSuggestions(defaults.promptSuggestions);
				await setDefaultPromptSuggestions(token, suggestions);
				const fresh = await getBackendConfig().catch(() => null);
				if (fresh) setBackendConfig(fresh);
				const next = { ...defaults, promptSuggestions: suggestions };
				setDefaults(next);
				setBaseline(defaultsSnapshot(next));
				await queryClient.invalidateQueries({ queryKey: ['models-defaults'] });
			}
			toast.success('Model settings saved');
			await refreshApp();
		} catch (error) {
			toastFailure("Couldn't save the model settings.", error);
		} finally {
			setSaving(false);
		}
	};

	const changeTag = async (tag: string) => {
		setSelectedTag(tag);
		await init(tag);
	};

	const clearFilters = () => {
		setSearch('');
		setView('');
		if (selectedTag) void changeTag('');
	};

	// --- render --------------------------------------------------------------------------------------

	if (editingId !== null) {
		const model = (models ?? []).find((m) => m.id === editingId);
		return (
			<ModelEditor
				key={editingId}
				edit
				preset={false}
				model={model ? (model as { id: string; name: string }) : null}
				onDirtyChange={setEditorDirty}
				onSubmit={async (info) => {
					// A failure shows in the editor, above its save bar (FBK-1), not as a toast.
					if (!(await upsert(info as unknown as ModelItem, {}, false))) {
						throw new Error(`Couldn't save “${info.name}”. Try again.`);
					}
					toast.success(`“${info.name}” saved`);
					await refreshApp();
				}}
				backLabel="Models"
				onBack={async () => {
					setEditingId(null);
					setEditorDirty(false);
					await init();
				}}
			/>
		);
	}

	if (loadError !== null && models === null) {
		return (
			<SettingsForm title="Models" footer={false}>
				<LoadFailed
					what="models"
					error={loadError}
					retrying={retrying}
					onRetry={async () => {
						setRetrying(true);
						await init('', true);
						setRetrying(false);
					}}
				/>
			</SettingsForm>
		);
	}

	// One account: no access views (S4-D1), and no Pinned by default (S5-D12).
	const views = VIEW_OPTIONS.filter(
		([v]) => !((singleUser && (v === 'public' || v === 'private')) || (!pinsByDefault && v === 'pinned'))
	);
	const viewLabel = views.find(([v]) => v === view)?.[1] ?? 'All';
	const menuItem = (icon: React.ReactNode, label: string, onSelect: () => void, disabled = false) => (
		<DropdownMenuItem disabled={disabled} onSelect={onSelect}>
			{icon}
			{label}
		</DropdownMenuItem>
	);

	const renderGroup = (key: 'connection' | 'workspace', title: string, help: string) => {
		const group = groups[key];
		if (group.length === 0) return null;
		const headingId = `admin-models-${key}`;
		return (
			<section aria-labelledby={headingId} className="mt-4 first:mt-0">
				<h3 id={headingId} className="text-title font-title flex items-baseline gap-2">
					{title}
					<span className="text-foreground-muted text-dense font-normal tabular-nums">{group.length}</span>
				</h3>
				<p className="text-foreground-muted text-dense mb-1">{help}</p>
				<ul className="space-y-px">
					{group.map((model, i) => {
						const handlers: RowHandlers = {
							open: () => openModel(model),
							toggleActive: () => void toggleActive(model),
							toggleHidden: () => void toggleHidden(model),
							toggleSelected: () => void toggleSelected(model),
							toggleDefaultPinned: () => void toggleDefaultPinned(model),
							togglePrivacy: () => void togglePrivacy(model),
							togglePinnedInSidebar: () => toggleSidebarPin(model.id),
							copyLink: () => void copyLink(model),
							clone: () => void cloneModel(model),
							exportModel: () => void exportModel(model),
							moveUp: () => reorder(group, i, i - 1),
							moveDown: () => reorder(group, i, i + 1)
						};
						const fromHere = dragFrom?.group === key;
						return (
							<li key={model.id}>
								<ModelRow
									model={model}
									index={i}
									count={group.length}
									singleUser={singleUser}
									pinsByDefault={pinsByDefault}
									canReorder={canReorder}
									isSelected={selectedSet.has(model.id)}
									isDefaultPinned={pinnedSet.has(model.id)}
									isSidebarPinned={sidebarPinned.includes(model.id)}
									dragging={fromHere && dragFrom?.index === i}
									dropTarget={fromHere && dropAt === i && dragFrom?.index !== i}
									handlers={handlers}
									onDragStart={(e) => {
										setDragFrom({ group: key, index: i });
										e.dataTransfer.effectAllowed = 'move';
										e.dataTransfer.setData('text/plain', model.id);
										const row = (e.currentTarget as HTMLElement).closest('[data-model-row]');
										if (row) e.dataTransfer.setDragImage(row, 16, 16);
									}}
									onDragOver={(e) => {
										// A row moves only within its own group.
										if (!fromHere) return;
										e.preventDefault();
										setDropAt(i);
									}}
									onDrop={(e) => {
										e.preventDefault();
										if (fromHere && dragFrom) reorder(group, dragFrom.index, i);
										setDragFrom(null);
										setDropAt(null);
									}}
									onDragEnd={() => {
										setDragFrom(null);
										setDropAt(null);
									}}
								/>
							</li>
						);
					})}
				</ul>
			</section>
		);
	};

	return (
		<SettingsForm
			title="Models"
			loading={models === null || defaults === null}
			dirty={listDirty}
			saving={saving}
			onDiscard={discard}
			onSubmit={saveAll}
		>
			{leaveGuard.dialog}
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

			{defaults && <ModelDefaultsPanel value={defaults} onChange={setDefaults} />}

			<div className="mt-4 flex flex-col gap-2">
				<ListSearchBar value={search} onChange={setSearch} placeholder="Search models">
					<FilterMenu
						value={view}
						items={views.map(([value, label]) => ({ value, label }))}
						onChange={(v) => setView(v as ViewOption)}
						trigger={
							<Button variant="outline" size="sm" aria-label={`Show: ${viewLabel}`}>
								<span className="truncate">{viewLabel}</span>
								<ChevronDown aria-hidden />
							</Button>
						}
					/>
					{tags.length > 0 && <TagSelector value={selectedTag} tags={tags} onChange={(t) => void changeTag(t)} />}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="outline" size="sm">
								Actions
								<ChevronDown aria-hidden />
							</Button>
						</DropdownMenuTrigger>
						{/* OVL-3: grouped, with the destructive Reset last below a separator (ACT-3). */}
						<DropdownMenuContent align="end" className="w-auto min-w-44">
							{menuItem(
								<FileUp className={menuIcon} />,
								'Import models',
								() => importInput.current?.click(),
								importing
							)}
							{menuItem(<Download className={menuIcon} />, 'Export models', () => void exportAll())}
							{menuItem(<Wrench className={menuIcon} />, 'Manage models', () => setShowManage(true))}
							<DropdownMenuSeparator />
							{menuItem(<CheckCircle className={menuIcon} />, 'Turn all on', () => void enableAll())}
							{menuItem(<Minus className={menuIcon} />, 'Turn all off', () => void disableAll())}
							{menuItem(<Eye className={menuIcon} />, 'Show all', () => void showAll())}
							{menuItem(<EyeOff className={menuIcon} />, 'Hide all', () => void hideAll())}
							<DropdownMenuSeparator />
							<DropdownMenuItem variant="destructive" onSelect={() => setShowReset(true)}>
								<Trash2 className={menuIcon} />
								Reset models
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</ListSearchBar>
				{/* DAT-2: while a search or filter narrows the list, it says how many of the whole it shows. */}
				{narrowed && filtered.length > 0 && (
					<ListMatchCount shown={filtered.length} total={(models ?? []).length} noun="models" />
				)}
			</div>

			<div className="mt-2" data-testid="model-list">
				{filtered.length === 0 ? (
					<ListEmptyState
						title="No models yet"
						description="Models come from your connections. Add one in Connections."
						query={search}
						filtered={view !== '' || selectedTag !== ''}
						onClear={clearFilters}
					/>
				) : (
					<>
						{renderGroup(
							'connection',
							'From connections',
							'The models your connections serve. Settings here apply wherever the model is used.'
						)}
						{renderGroup(
							'workspace',
							'Workspace models',
							'Built in Workspace > Models on top of a connection model. Each opens its editor there.'
						)}
					</>
				)}
			</div>

			<ConfirmDialog
				open={showReset}
				onOpenChange={setShowReset}
				title="Reset all models?"
				confirmLabel="Reset models"
				destructive
				onConfirm={resetAll}
			>
				{workspaceCount > 0
					? `All ${workspaceCount} workspace model${workspaceCount === 1 ? '' : 's'} and every model setting are deleted: names, pictures, hidden and off states. This can't be undone.`
					: "Every model setting is deleted: names, pictures, hidden and off states. This can't be undone."}
			</ConfirmDialog>
			<ManageModelsModal open={showManage} onOpenChange={setShowManage} />
		</SettingsForm>
	);
}
