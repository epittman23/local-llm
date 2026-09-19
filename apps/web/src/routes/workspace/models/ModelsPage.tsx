import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { CheckCircle, ChevronDown, Copy, Download, Eye, EyeOff, Link2, MoreHorizontal, Minus, Pencil, Pin, PinOff, Share2, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { TagSelector, ViewSelector } from '@/components/common/FilterSelects';
import { ListEmptyState, ListSearchBar, SortHeaderButton, isControlClick } from '@/components/common/ListChrome';
import { PagePagination } from '@/components/common/PagePagination';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { createNewModel, deleteModelById, getModelById, getModelItems, getModelTags, toggleModelById, updateModelById } from '@/lib/apis/models';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useWebUIName } from '@/lib/stores/configStore';
import { useWorkspaceStore } from '@/lib/stores/workspaceStore';
import { capitalizeFirstLetter, copyToClipboard } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { useShiftKey } from '@/lib/utils/useShiftKey';
import { routePaths } from '@/routes/routePaths';
import { DEFAULT_PROFILE_IMAGE } from './modelEditorLogic';
import { modelSharePayload, parseModelImport } from './modelImport';

const PER_PAGE = 30;

/** An endpoint that fails or answers with something unexpected counts as an empty list. */
const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

type ModelRow = {
	id: string;
	name: string;
	base_model_id?: string | null;
	is_active?: boolean;
	write_access?: boolean;
	updated_at: number;
	meta?: Record<string, any> | null;
	user?: { name?: string; email?: string } | null;
} & Record<string, any>;

/**
 * Ports workspace/Models.svelte: the searchable, filterable, sortable, paginated
 * list of model presets, with per-row menu, enable switch, and bulk Enable / Disable /
 * Show / Hide All. Differences from the Svelte version worth knowing:
 *
 * - Pinning ("Keep in Sidebar") reads and writes the user's saved UI settings
 *   through `useUserSettings`, optimistically, instead of a global store.
 * - The global `models` store the Svelte page refreshes after every change is
 *   the ['models-all'] query here, invalidated the same way.
 * - Importing a file never takes access grants from it, and "Share" sends only
 *   the model's own definition (see modelImport.ts).
 */
export function ModelsPage() {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const webuiName = useWebUIName();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const setActions = useWorkspaceStore((s) => s.setActions);
	const setCount = useWorkspaceStore((s) => s.setCount);
	const shiftKey = useShiftKey();
	const { pinnedModels, togglePinned } = useUserSettings();

	const [query, setQuery] = useState('');
	const debouncedQuery = useDebouncedValue(query, 300);
	const [viewOption, setViewOption] = useState(() => localStorage.workspaceViewOption ?? '');
	const [selectedTag, setSelectedTag] = useState('');
	const [sortKey, setSortKey] = useState('updated_at');
	const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
	const [page, setPage] = useState(1);
	const [deleting, setDeleting] = useState<ModelRow | null>(null);
	const [activeOverride, setActiveOverride] = useState<Record<string, boolean>>({});
	const importInput = useRef<HTMLInputElement>(null);

	const isAdmin = user?.role === 'admin';
	const can = (key: string) => isAdmin || Boolean(user?.permissions?.workspace?.[key]);
	const canImport = can('models_import');
	const canExport = can('models_export');

	const list = useQuery({
		queryKey: ['workspace-models', debouncedQuery, viewOption, selectedTag, sortKey, sortDirection, page],
		queryFn: async () => (await getModelItems(token, debouncedQuery, viewOption, selectedTag, sortKey, sortDirection, page)) as { items: ModelRow[]; total: number },
		placeholderData: keepPreviousData
	});
	const tags = useQuery({ queryKey: ['workspace-model-tags'], queryFn: async () => asArray<string>(await getModelTags(token).catch(() => [])) });
	const models = list.data?.items ?? null;
	const total = list.data?.total ?? 0;

	useEffect(() => {
		if (list.isError) toast.error(`${list.error}`);
	}, [list.isError, list.error]);
	useEffect(() => {
		if (list.data) setCount('models', list.data.total);
	}, [list.data, setCount]);
	useEffect(() => {
		document.title = `Models / ${webuiName}`;
	}, [webuiName]);

	const refetch = async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ['workspace-models'] }),
			queryClient.invalidateQueries({ queryKey: ['models-all'] })
		]);
	};

	const fullModel = async (m: ModelRow) => (await getModelById(token, m.id).catch(() => null)) ?? m;

	// --- the layout's Create button ------------------------------------------
	useEffect(() => {
		setActions([
			{ id: 'models-new', label: 'Create', href: routePaths.workspaceModelsCreate },
			{ id: 'models-import', label: 'Import JSON', onClick: () => importInput.current?.click(), visible: canImport },
			{
				id: 'models-export',
				label: 'Export JSON',
				onClick: async () => {
					const full = await Promise.all((models ?? []).map(fullModel));
					saveAs(new Blob([JSON.stringify(full)], { type: 'application/json' }), `models-export-${Date.now()}.json`);
				},
				visible: canExport
			}
		]);
		return () => setActions([]);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [setActions, canImport, canExport, models, token]);

	// --- row actions ----------------------------------------------------------
	const openModel = (m: ModelRow) => m.write_access && navigate(`${routePaths.workspaceModelsEdit}?id=${encodeURIComponent(m.id)}`);

	const deleteModel = async (m: ModelRow) => {
		const res = await deleteModelById(token, m.id).catch((e) => {
			toast.error(`${e}`);
			return null;
		});
		if (res) {
			toast.success(`Deleted ${m.id}`);
			setPage(1);
		}
		await refetch();
	};

	const setHidden = async (m: ModelRow, hidden: boolean) => {
		const updated = { ...m, meta: { ...m.meta, hidden } };
		try {
			if (await updateModelById(token, m.id, updated)) {
				toast.success(`Model ${m.id} is now ${hidden ? 'hidden' : 'visible'}`);
				setPage(1);
			}
		} catch (e) {
			toast.error(`${e}`);
		}
		await refetch();
	};

	const toggleActive = async (m: ModelRow, next: boolean) => {
		setActiveOverride((prev) => ({ ...prev, [m.id]: next }));
		try {
			await toggleModelById(token, m.id);
			queryClient.invalidateQueries({ queryKey: ['models-all'] });
		} catch (e) {
			toast.error(`${e}`);
			setActiveOverride((prev) => ({ ...prev, [m.id]: !next }));
		}
	};

	const cloneModel = async (m: ModelRow) => {
		const full = await fullModel(m);
		sessionStorage.model = JSON.stringify({ ...full, id: `${full.id}-clone`, name: `${full.name} (Clone)` });
		navigate(routePaths.workspaceModelsCreate);
	};

	const exportModel = async (m: ModelRow) => {
		const full = await fullModel(m);
		saveAs(new Blob([JSON.stringify([full])], { type: 'application/json' }), `${full.id}-${Date.now()}.json`);
	};

	const copyLink = async (m: ModelRow) => {
		const ok = await copyToClipboard(`${window.location.origin}/?model=${encodeURIComponent(m.id)}`);
		if (ok) toast.success('Copied link to clipboard');
		else toast.error('Failed to copy link');
	};

	const shareModel = async (m: ModelRow) => {
		// LICENSE covers this Open WebUI Community wordmark.
		// Do not alter, remove, obscure, or replace it except as LICENSE permits:
		// https://docs.openwebui.com/license.
		toast.success('Redirecting you to Open WebUI Community');
		const url = 'https://openwebui.com';
		const full = fullModel(m);
		const tab = window.open(`${url}/post?type=model`, '_blank');
		const onMessage = async (event: MessageEvent) => {
			if (event.origin !== url || event.data !== 'loaded') return;
			window.removeEventListener('message', onMessage);
			tab?.postMessage(JSON.stringify(modelSharePayload(await full)), url);
		};
		window.addEventListener('message', onMessage);
		setTimeout(() => window.removeEventListener('message', onMessage), 60_000);
	};

	// --- bulk actions over *every* page of the current search ----------------
	const fetchAll = async (): Promise<ModelRow[]> => {
		const all: ModelRow[] = [];
		for (let p = 1; ; p++) {
			const res = (await getModelItems(token, debouncedQuery, viewOption, selectedTag, null, null, p)) as { items: ModelRow[]; total: number } | null;
			if (!res?.items?.length) break;
			all.push(...res.items);
			if (all.length >= res.total) break;
		}
		return all;
	};
	const bulk = async (pick: (m: ModelRow) => boolean, apply: (m: ModelRow) => Promise<unknown>, after?: string) => {
		try {
			const targets = (await fetchAll()).filter(pick);
			if (targets.length === 0) return;
			await Promise.all(targets.map(apply));
			if (after) toast.success(after);
		} catch (e) {
			toast.error(`${e}`);
		}
		setActiveOverride({});
		await refetch();
	};
	const enableAll = () => bulk((m) => !(m.is_active ?? true), (m) => toggleModelById(token, m.id));
	const disableAll = () => bulk((m) => m.is_active ?? true, (m) => toggleModelById(token, m.id));
	const showAll = () => bulk((m) => m.meta?.hidden === true, (m) => updateModelById(token, m.id, { ...m, meta: { ...m.meta, hidden: false } }), 'All models are now visible');
	const hideAll = () => bulk((m) => !(m.meta?.hidden ?? false), (m) => updateModelById(token, m.id, { ...m, meta: { ...m.meta, hidden: true } }), 'All models are now hidden');

	// --- import ---------------------------------------------------------------
	const importFile = (file: File) => {
		const reader = new FileReader();
		reader.onload = async (event) => {
			let incoming;
			try {
				incoming = parseModelImport(String(event.target?.result));
			} catch {
				toast.error('Invalid JSON file');
				return;
			}
			for (const model of incoming) {
				// Update a model that already exists, create it otherwise.
				const exists = await getModelById(token, model.id).catch(() => null);
				await (exists ? updateModelById(token, model.id, model) : createNewModel(token, model)).catch((error) => {
					toast.error(`${error}`);
					return null;
				});
			}
			setPage(1);
			await refetch();
		};
		reader.readAsText(file);
		if (importInput.current) importInput.current.value = '';
	};

	const sortBy = (key: string) => {
		if (sortKey === key) setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
		else {
			setSortKey(key);
			setSortDirection(key === 'updated_at' ? 'desc' : 'asc');
		}
		setPage(1);
	};

	const rowIconButton = 'text-muted-foreground flex size-6 items-center justify-center rounded-lg transition';

	return (
		<div className="space-y-1">
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => !open && setDeleting(null)}
				title="Delete"
				confirmLabel="Delete"
				onConfirm={() => {
					if (deleting) deleteModel(deleting);
					setDeleting(null);
				}}
			>
				This will delete <span className="font-normal">{deleting?.name}</span>.
			</ConfirmDialog>

			<input ref={importInput} id="models-import-input" type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />

			<ListSearchBar
				value={query}
				placeholder="Search Models"
				onChange={(value) => {
					setQuery(value.slice(0, 500));
					setPage(1);
				}}
			>
				<ViewSelector
					value={viewOption}
					onChange={(value) => {
						localStorage.workspaceViewOption = value;
						setViewOption(value);
						setPage(1);
					}}
				/>
				{(tags.data ?? []).length > 0 && (
					<TagSelector
						value={selectedTag}
						tags={tags.data ?? []}
						onChange={(value) => {
							setSelectedTag(value);
							setPage(1);
						}}
					/>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="sm" aria-label="Actions">
							<span className="min-w-0 truncate">Actions</span>
							<ChevronDown />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-44">
						<DropdownMenuItem onSelect={enableAll}>
							<CheckCircle />
							Enable All
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={disableAll}>
							<Minus />
							Disable All
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={showAll}>
							<Eye />
							Show All
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={hideAll}>
							<EyeOff />
							Hide All
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</ListSearchBar>

			{models === null ? (
				<div className="flex h-full w-full items-center justify-center py-10">
					<Spinner className="size-4" />
				</div>
			) : models.length === 0 ? (
				<ListEmptyState title="No models found" />
			) : (
				<div id="model-list" className={list.isPlaceholderData ? 'my-1 opacity-60 transition' : 'my-1 transition'}>
					<div className="text-muted-foreground flex w-full items-center gap-2 px-1.5 pb-0.5 text-xs">
						<SortHeaderButton label="Title" active={sortKey === 'name'} direction={sortDirection} className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left" onClick={() => sortBy('name')} />
						<div className="hidden w-44 shrink-0 md:block" />
						<SortHeaderButton label="Updated at" active={sortKey === 'updated_at'} direction={sortDirection} className="flex w-36 shrink-0 items-center justify-end gap-1 py-0.5 text-right" onClick={() => sortBy('updated_at')} />
					</div>

					<div className="grid gap-y-0.5">
						{models.map((model) => {
							const isActive = activeOverride[model.id] ?? Boolean(model.is_active);
							const hidden = Boolean(model.meta?.hidden);
							const description = (model.meta?.description ?? '').trim() || model.base_model_id || 'No description';
							const pinned = pinnedModels.includes(model.id);
							return (
								<div
									key={model.id}
									id={`model-item-${model.id}`}
									role="button"
									tabIndex={model.write_access ? 0 : -1}
									className={`group flex min-h-8 w-full items-center gap-2 overflow-hidden rounded-xl px-2 py-1 text-left ${model.write_access ? 'hover:bg-muted/50 cursor-pointer' : ''} ${hidden ? 'opacity-50' : ''}`}
									onClick={(e) => !isControlClick(e.target) && openModel(model)}
									onKeyDown={(e) => {
										if (e.currentTarget !== e.target) return;
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											openModel(model);
										}
									}}
								>
									<div className="mr-1 shrink-0 self-center">
										<img
											className={`size-8 rounded-lg object-cover ${isActive ? '' : 'opacity-50'}`}
											src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${encodeURIComponent(model.id)}`}
											alt=""
											loading="lazy"
											decoding="async"
											onError={(e) => {
												// LICENSE covers this Open WebUI fallback logo.
												// Do not alter, remove, obscure, or replace it except as LICENSE permits:
												// https://docs.openwebui.com/license.
												e.currentTarget.src = DEFAULT_PROFILE_IMAGE;
											}}
										/>
									</div>
									<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
										<div className="flex min-w-0 items-center gap-2 overflow-hidden">
											<Tip content={model.name} side="top">
												<Link to={`${routePaths.home}?model=${encodeURIComponent(model.id)}`} className="min-w-0 truncate text-[0.8125rem] leading-5 hover:underline">
													{model.name}
												</Link>
											</Tip>
											<div className="text-muted-foreground max-w-[40%] min-w-0 shrink-0 truncate text-[0.6875rem] leading-5">{model.id}</div>
											<Tip content={dayjs(model.updated_at * 1000).format('LLLL')}>
												<div className="text-muted-foreground/70 shrink-0 truncate text-[0.6875rem] leading-5">{dayjs(model.updated_at * 1000).fromNow()}</div>
											</Tip>
											{!model.write_access && <Badge variant="secondary">Read Only</Badge>}
										</div>
										<Tip content={description} side="top">
											<div className="text-muted-foreground/70 mt-0.5 truncate text-[0.6875rem] leading-4">{description}</div>
										</Tip>
									</div>
									<div className="text-muted-foreground hidden max-w-44 shrink-0 self-center truncate text-right text-[0.6875rem] leading-5 md:block">
										<Tip content={model.user?.email ?? 'Deleted User'} side="top">
											<div className="truncate">{capitalizeFirstLetter(model.user?.name ?? model.user?.email ?? 'Deleted User')}</div>
										</Tip>
									</div>

									<div className="ml-2 flex shrink-0 flex-row items-center self-center">
										{shiftKey && model.write_access ? (
											<>
												<Tip content={hidden ? 'Show' : 'Hide'}>
													<button type="button" className={rowIconButton} aria-label={hidden ? 'Show' : 'Hide'} onClick={(e) => { e.stopPropagation(); setHidden(model, !hidden); }}>
														{hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
													</button>
												</Tip>
												<Tip content="Delete">
													<button type="button" className={rowIconButton} aria-label="Delete" onClick={(e) => { e.stopPropagation(); deleteModel(model); }}>
														<Trash2 className="size-4" />
													</button>
												</Tip>
											</>
										) : (
											<div className="flex shrink-0 flex-row items-center gap-1.5 self-center">
												<DropdownMenu>
													<Tip content="More">
														<DropdownMenuTrigger asChild>
															<button type="button" className={rowIconButton} aria-label="Model Menu" onClick={(e) => e.stopPropagation()}>
																<MoreHorizontal className="size-4" />
															</button>
														</DropdownMenuTrigger>
													</Tip>
													<DropdownMenuContent align="end" className="min-w-44">
														{model.write_access && (
															<DropdownMenuItem onSelect={() => openModel(model)}>
																<Pencil />
																Edit
															</DropdownMenuItem>
														)}
														{model.write_access && (
															<DropdownMenuItem onSelect={() => setHidden(model, !hidden)}>
																{hidden ? <Eye /> : <EyeOff />}
																{hidden ? 'Show Model' : 'Hide Model'}
															</DropdownMenuItem>
														)}
														<DropdownMenuItem onSelect={() => togglePinned(model.id)}>
															{pinned ? <PinOff /> : <Pin />}
															{pinned ? 'Hide from Sidebar' : 'Keep in Sidebar'}
														</DropdownMenuItem>
														{model.write_access && (
															<DropdownMenuItem onSelect={() => cloneModel(model)}>
																<Copy />
																Clone
															</DropdownMenuItem>
														)}
														<DropdownMenuItem onSelect={() => copyLink(model)}>
															<Link2 />
															Copy Link
														</DropdownMenuItem>
														{model.write_access && canExport && (
															<DropdownMenuItem onSelect={() => exportModel(model)}>
																<Download />
																Export
															</DropdownMenuItem>
														)}
														{model.write_access && config?.features?.enable_community_sharing && (
															<DropdownMenuItem onSelect={() => shareModel(model)}>
																<Share2 />
																Share
															</DropdownMenuItem>
														)}
														{model.write_access && (
															<>
																<DropdownMenuSeparator />
																<DropdownMenuItem onSelect={() => setDeleting(model)}>
																	<Trash2 />
																	Delete
																</DropdownMenuItem>
															</>
														)}
													</DropdownMenuContent>
												</DropdownMenu>
												{model.write_access && (
													<Tip content={isActive ? 'Enabled' : 'Disabled'}>
														<span className="flex h-6 items-center" onClick={(e) => e.stopPropagation()}>
															<Switch aria-label={isActive ? 'Enabled' : 'Disabled'} checked={isActive} onCheckedChange={(next) => toggleActive(model, next)} />
														</span>
													</Tip>
												)}
											</div>
										)}
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{total > PER_PAGE && (
				<div className="mt-4 mb-2 flex justify-center">
					<PagePagination page={page} count={total} perPage={PER_PAGE} onPageChange={setPage} />
				</div>
			)}

			{config?.features?.enable_community_sharing && (
				<div className="mt-6 px-2 pb-8">
					<div className="text-muted-foreground mb-0.5 text-[0.6875rem]">
						{/* LICENSE covers this Open WebUI Community wordmark.
						    Do not alter, remove, obscure, or replace it except as LICENSE permits:
						    https://docs.openwebui.com/license. */}
						Made by Open WebUI Community
					</div>
					<a className="flex w-full items-center justify-between gap-3 py-1 text-left" href="https://openwebui.com/models" target="_blank" rel="noreferrer">
						<div className="min-w-0">
							<div className="line-clamp-1 text-[0.8125rem]">Discover a model</div>
							<div className="text-muted-foreground line-clamp-1 text-xs">Discover, download, and explore model presets</div>
						</div>
					</a>
				</div>
			)}
		</div>
	);
}
