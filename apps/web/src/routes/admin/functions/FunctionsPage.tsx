import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { Copy, Download, Globe, Heart, MoreHorizontal, Pencil, Settings, Share2, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { CommunityDiscover } from '@/components/common/CommunityDiscover';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { TagSelector, ViewSelector } from '@/components/common/FilterSelects';
import { ImportUrlModal } from '@/components/common/ImportUrlModal';
import { ListEmptyState, ListSearchBar, SortHeaderButton, isControlClick } from '@/components/common/ListChrome';
import { ManifestModal } from '@/components/common/ManifestModal';
import { Spinner } from '@/components/common/Spinner';
import { SplitCreateButton } from '@/components/common/SplitCreateButton';
import { Tip } from '@/components/common/Tip';
import { ValvesModal } from '@/components/common/ValvesModal';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import {
	createNewFunction,
	deleteFunctionById,
	exportFunctions,
	getFunctionById,
	getFunctionList,
	loadFunctionByUrl,
	toggleFunctionById,
	toggleGlobalById
} from '@/lib/apis/functions';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useWebUIName } from '@/lib/stores/configStore';
import { capitalizeFirstLetter } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { useShiftKey } from '@/lib/utils/useShiftKey';
import { routePaths } from '@/routes/routePaths';
import { FunctionCodeWarning } from './FunctionEditor';
import {
	FUNCTION_TYPES,
	type FunctionListItem,
	filterAndSortFunctions,
	functionSharePayload,
	parseFunctionImport
} from './functionTypes';

const LIST_KEY = ['functions', 'list'];
const rowIconButton = 'text-muted-foreground flex size-6 items-center justify-center rounded-lg transition';

/**
 * Ports admin/Functions.svelte. Like Tools, the endpoint returns every function
 * in one unpaginated list, so search (debounced 300ms), the view and type
 * filters and sorting all happen here; the header count is the *filtered* length.
 *
 * Each row: a type badge, name, version, description, author, and on the right
 * the Support / Valves / More icons and the enable switch (Shift swaps them all
 * for a one-click Delete). Filters and Actions get a "Global" switch in the
 * menu. Toggles are optimistic and revert on failure -- the original's enable
 * switch does not, and leaves the switch lying when the request fails.
 *
 * The original refreshes the app-wide `functions` and `models` stores after
 * each change. Neither store exists here yet (chat, Phase 10, owns them), so the
 * `['functions']` and `['models']` query keys are invalidated instead, which is
 * what those consumers will subscribe to.
 */
export function FunctionsPage() {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const webuiName = useWebUIName();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const shiftKey = useShiftKey();

	const [query, setQuery] = useState('');
	const debouncedQuery = useDebouncedValue(query, 300);
	const [viewOption, setViewOption] = useState(() => localStorage.workspaceViewOption || '');
	const [selectedType, setSelectedType] = useState('');
	const [sortKey, setSortKey] = useState('updated_at');
	const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
	const [selected, setSelected] = useState<FunctionListItem | null>(null);
	const [showDelete, setShowDelete] = useState(false);
	const [showValves, setShowValves] = useState(false);
	const [showManifest, setShowManifest] = useState(false);
	const [showImportUrl, setShowImportUrl] = useState(false);
	const [pendingImport, setPendingImport] = useState<File | null>(null);
	const importInput = useRef<HTMLInputElement>(null);

	const list = useQuery({
		queryKey: LIST_KEY,
		queryFn: async () => ((await getFunctionList(token)) ?? []) as FunctionListItem[]
	});
	useEffect(() => {
		if (list.isError) toast.error(`${list.error}`);
	}, [list.isError, list.error]);

	const items = useMemo(
		() =>
			filterAndSortFunctions(list.data ?? [], {
				query: debouncedQuery,
				type: selectedType,
				view: viewOption,
				userId: user?.id,
				sortKey,
				direction: sortDirection
			}),
		[list.data, debouncedQuery, selectedType, viewOption, user?.id, sortKey, sortDirection]
	);

	useEffect(() => {
		document.title = `Functions / ${webuiName}`;
	}, [webuiName]);

	const refresh = () =>
		Promise.all([queryClient.invalidateQueries({ queryKey: ['functions'] }), queryClient.invalidateQueries({ queryKey: ['models'] })]);
	const patchItem = (id: string, patch: Partial<FunctionListItem>) =>
		queryClient.setQueryData<FunctionListItem[]>(LIST_KEY, (prev) => prev?.map((f) => (f.id === id ? { ...f, ...patch } : f)));

	const openFunction = (fn: FunctionListItem) => navigate(`${routePaths.adminFunctionsEdit}?id=${encodeURIComponent(fn.id)}`);

	const deleteMutation = useMutation({
		mutationFn: (fn: FunctionListItem) => deleteFunctionById(token, fn.id),
		onSuccess: (res, fn) => {
			if (!res) return;
			toast.success('Function deleted successfully');
			queryClient.setQueryData<FunctionListItem[]>(LIST_KEY, (prev) => prev?.filter((f) => f.id !== fn.id));
		},
		onError: (error) => toast.error(`${error}`),
		onSettled: refresh
	});

	const toggleActive = async (fn: FunctionListItem) => {
		const next = !fn.is_active;
		patchItem(fn.id, { is_active: next });
		try {
			await toggleFunctionById(token, fn.id);
		} catch (error) {
			patchItem(fn.id, { is_active: !next });
			toast.error(`${error}`);
		}
		refresh();
	};

	const toggleGlobal = async (fn: FunctionListItem) => {
		const next = !fn.is_global;
		patchItem(fn.id, { is_global: next });
		const noun = fn.type === 'filter' ? 'Filter' : 'Function';
		try {
			await toggleGlobalById(token, fn.id);
			toast.success(`${noun} is now globally ${next ? 'enabled' : 'disabled'}`);
		} catch (error) {
			patchItem(fn.id, { is_global: !next });
			toast.error(`${error}`);
		}
		refresh();
	};

	const fetchFull = (fn: FunctionListItem) =>
		getFunctionById(token, fn.id).catch((error) => {
			toast.error(`${error}`);
			return null;
		});

	const cloneHandler = async (fn: FunctionListItem) => {
		const full = await fetchFull(fn);
		if (!full) return;
		sessionStorage.function = JSON.stringify({ ...full, id: `${full.id}_clone`, name: `${full.name} (Clone)` });
		navigate(routePaths.adminFunctionsCreate);
	};

	const exportHandler = async (fn: FunctionListItem) => {
		const full = await fetchFull(fn);
		if (full) saveAs(new Blob([JSON.stringify([full])], { type: 'application/json' }), `function-${full.id}-export-${Date.now()}.json`);
	};

	const exportAll = async () => {
		const all = await exportFunctions(token).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (all) saveAs(new Blob([JSON.stringify(all)], { type: 'application/json' }), `functions-export-${Date.now()}.json`);
	};

	const shareHandler = async (fn: FunctionListItem) => {
		const full = await fetchFull(fn);
		if (!full) return;
		// LICENSE covers this Open WebUI Community wordmark.
		// Do not alter, remove, obscure, or replace it except as LICENSE permits:
		// https://docs.openwebui.com/license.
		toast.success('Redirecting you to Open WebUI Community');
		const url = 'https://openwebui.com';
		const tab = window.open(`${url}/functions/create`, '_blank');
		const onMessage = (event: MessageEvent) => {
			if (event.origin !== url || event.data !== 'loaded') return;
			window.removeEventListener('message', onMessage);
			// The function's own fields to openwebui.com only; the Svelte version posts the
			// full record (author email, ...) to '*'.
			tab?.postMessage(JSON.stringify(functionSharePayload(full)), url);
		};
		window.addEventListener('message', onMessage);
		setTimeout(() => window.removeEventListener('message', onMessage), 60_000);
	};

	const runImport = (file: File) => {
		const reader = new FileReader();
		reader.onload = async (event) => {
			try {
				const functions = parseFunctionImport(String(event.target?.result));
				if (functions.length === 0) {
					toast.error('No valid functions found in that file.');
					return;
				}
				for (const fn of functions) {
					await createNewFunction(token, fn).catch((error) => {
						toast.error(`${error}`);
						return null;
					});
				}
				toast.success('Functions imported successfully');
				refresh();
			} catch (error) {
				toast.error(`${error}`);
			}
		};
		reader.readAsText(file);
	};

	const changeSort = (key: string) => {
		if (sortKey === key) setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
		else {
			setSortKey(key);
			setSortDirection(key === 'updated_at' ? 'desc' : 'asc');
		}
	};

	const clearImportInput = () => {
		if (importInput.current) importInput.current.value = '';
	};

	if (list.isPending) {
		return (
			<div className="flex h-full w-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	const isAdmin = user?.role === 'admin';
	return (
		<div className="w-full px-2.5">
			<ImportUrlModal
				open={showImportUrl}
				onOpenChange={setShowImportUrl}
				loadUrl={(url) => loadFunctionByUrl(token, url)}
				successMessage="Function imported successfully"
				onImport={(fn) => {
					sessionStorage.function = JSON.stringify(fn);
					navigate(routePaths.adminFunctionsCreate);
				}}
			/>
			<ConfirmDialog
				open={showDelete}
				onOpenChange={setShowDelete}
				title="Delete function?"
				confirmLabel="Delete"
				onConfirm={() => {
					if (selected) deleteMutation.mutate(selected);
					setShowDelete(false);
				}}
			>
				This will delete <span className="font-normal">{selected?.name}</span>.
			</ConfirmDialog>
			<ConfirmDialog
				open={pendingImport !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingImport(null);
						clearImportInput();
					}
				}}
				title="Confirm"
				onConfirm={() => {
					if (pendingImport) runImport(pendingImport);
					setPendingImport(null);
					clearImportInput();
				}}
			>
				<FunctionCodeWarning />
			</ConfirmDialog>
			<ManifestModal open={showManifest} onOpenChange={setShowManifest} manifest={selected?.meta?.manifest ?? {}} />
			<ValvesModal
				open={showValves}
				onOpenChange={setShowValves}
				type="function"
				id={selected?.id ?? null}
				onSaved={() => queryClient.invalidateQueries({ queryKey: ['models'] })}
			/>

			<input
				ref={importInput}
				id="documents-import-input"
				type="file"
				accept=".json"
				hidden
				onChange={(e) => e.target.files?.[0] && setPendingImport(e.target.files[0])}
			/>

			<div className="mt-0.5 flex flex-col gap-1 px-1">
				<div className="mb-1 flex w-full items-center justify-between">
					<div className="flex shrink-0 items-center gap-1.5 px-0.5 text-sm font-normal md:self-center">
						<div>Functions</div>
						<div className="text-muted-foreground text-sm font-normal opacity-60">{items.length}</div>
					</div>
					<div className="flex w-full justify-end">
						<SplitCreateButton
							actions={[
								{ id: 'functions-new', label: 'Create', href: routePaths.adminFunctionsCreate },
								{ id: 'functions-import-link', label: 'Import From Link', onClick: () => setShowImportUrl(true) },
								{ id: 'functions-import', label: 'Import JSON', onClick: () => importInput.current?.click(), visible: isAdmin },
								{ id: 'functions-export', label: 'Export JSON', onClick: exportAll, visible: isAdmin && (list.data?.length ?? 0) > 0 }
							]}
						/>
					</div>
				</div>
			</div>

			<div className="space-y-1">
				<ListSearchBar value={query} placeholder="Search Functions" onChange={setQuery}>
					<ViewSelector
						value={viewOption}
						onChange={(value) => {
							localStorage.workspaceViewOption = value;
							setViewOption(value);
						}}
					/>
					<TagSelector
						value={selectedType}
						onChange={setSelectedType}
						tags={FUNCTION_TYPES.map((t) => t.value)}
						labels={Object.fromEntries(FUNCTION_TYPES.map((t) => [t.value, t.label]))}
						placeholder="Type"
					/>
				</ListSearchBar>

				{items.length !== 0 ? (
					<div className="my-1">
						<div className="text-muted-foreground flex w-full items-center gap-2 px-1.5 pb-0.5 text-xs">
							<SortHeaderButton
								label="Title"
								active={sortKey === 'name'}
								direction={sortDirection}
								className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
								onClick={() => changeSort('name')}
							/>
							<div className="hidden w-44 shrink-0 md:block" />
							<SortHeaderButton
								label="Updated at"
								active={sortKey === 'updated_at'}
								direction={sortDirection}
								className="flex w-36 shrink-0 items-center justify-end gap-1 py-0.5 text-right"
								onClick={() => changeSort('updated_at')}
							/>
						</div>

						<div className="grid gap-y-0.5">
							{items.map((fn) => (
								<div
									key={fn.id}
									role="button"
									tabIndex={0}
									className="group hover:bg-muted/50 flex min-h-8 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-xl px-2 py-1 text-left"
									onClick={(e) => {
										if (isControlClick(e.target)) return;
										openFunction(fn);
									}}
									onKeyDown={(e) => {
										if (e.currentTarget !== e.target) return;
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											openFunction(fn);
										}
									}}
								>
									<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
										<div className="flex min-w-0 items-center gap-2 overflow-hidden">
											<div className="bg-muted text-muted-foreground shrink-0 rounded-sm px-1 text-[0.625rem] leading-4 uppercase">{fn.type}</div>
											<Tip content={fn.id} side="top">
												<div className="min-w-0 truncate text-[0.8125rem] leading-5 group-hover:underline">{fn.name}</div>
											</Tip>
											{fn.meta?.manifest?.version && (
												<div className="text-muted-foreground max-w-[40%] min-w-0 shrink-0 truncate text-[0.6875rem] leading-5">
													v{fn.meta.manifest.version}
												</div>
											)}
											<Tip content={dayjs(fn.updated_at * 1000).format('LLLL')}>
												<div className="text-muted-foreground/70 shrink-0 truncate text-[0.6875rem] leading-5">
													{dayjs(fn.updated_at * 1000).fromNow()}
												</div>
											</Tip>
										</div>
										{fn.meta?.description && (
											<Tip content={fn.meta.description} side="top">
												<div className="text-muted-foreground/70 mt-0.5 truncate text-[0.6875rem] leading-4">{fn.meta.description}</div>
											</Tip>
										)}
									</div>

									<div className="text-muted-foreground hidden max-w-44 shrink-0 self-center truncate text-right text-[0.6875rem] leading-5 md:block">
										<Tip content={fn.user?.email ?? 'Deleted User'} side="top">
											<div className="truncate">{capitalizeFirstLetter(fn.user?.name ?? fn.user?.email ?? 'Deleted User')}</div>
										</Tip>
									</div>

									<div className="ml-2 flex shrink-0 flex-row items-center gap-1.5 self-center">
										{shiftKey ? (
											<Tip content="Delete">
												<button
													type="button"
													className={rowIconButton}
													aria-label="Delete"
													onClick={(e) => {
														e.stopPropagation();
														deleteMutation.mutate(fn);
													}}
												>
													<Trash2 className="size-4" />
												</button>
											</Tip>
										) : (
											<>
												{fn.meta?.manifest?.funding_url && (
													<Tip content="Support">
														<button
															type="button"
															className={rowIconButton}
															aria-label="Support"
															onClick={(e) => {
																e.stopPropagation();
																setSelected(fn);
																setShowManifest(true);
															}}
														>
															<Heart className="size-4" />
														</button>
													</Tip>
												)}
												<Tip content="Valves">
													<button
														type="button"
														className={rowIconButton}
														aria-label="Valves"
														onClick={(e) => {
															e.stopPropagation();
															setSelected(fn);
															setShowValves(true);
														}}
													>
														<Settings className="size-4" />
													</button>
												</Tip>
												<DropdownMenu>
													<Tip content="More">
														<DropdownMenuTrigger asChild>
															<button type="button" className={rowIconButton} aria-label="Function Menu" onClick={(e) => e.stopPropagation()}>
																<MoreHorizontal className="size-4" />
															</button>
														</DropdownMenuTrigger>
													</Tip>
													<DropdownMenuContent align="end" className="min-w-[11.25rem]">
														{(fn.type === 'filter' || fn.type === 'action') && (
															<>
																{/* A row with a switch, not an action: keep the menu open when it is used. */}
																<DropdownMenuItem onSelect={(e) => e.preventDefault()} className="justify-between">
																	<span className="flex items-center gap-2">
																		<Globe />
																		Global
																	</span>
																	<Switch size="sm" aria-label="Global" checked={Boolean(fn.is_global)} onCheckedChange={() => toggleGlobal(fn)} />
																</DropdownMenuItem>
																<DropdownMenuSeparator />
															</>
														)}
														<DropdownMenuItem onSelect={() => openFunction(fn)}>
															<Pencil />
															Edit
														</DropdownMenuItem>
														<DropdownMenuItem onSelect={() => shareHandler(fn)}>
															<Share2 />
															Share
														</DropdownMenuItem>
														<DropdownMenuItem onSelect={() => cloneHandler(fn)}>
															<Copy />
															Clone
														</DropdownMenuItem>
														<DropdownMenuItem onSelect={() => exportHandler(fn)}>
															<Download />
															Export
														</DropdownMenuItem>
														<DropdownMenuSeparator />
														<DropdownMenuItem
															onSelect={() => {
																setSelected(fn);
																setShowDelete(true);
															}}
														>
															<Trash2 />
															Delete
														</DropdownMenuItem>
													</DropdownMenuContent>
												</DropdownMenu>
												<div className="flex h-6 items-center" onClick={(e) => e.stopPropagation()}>
													<Tip content={fn.is_active ? 'Enabled' : 'Disabled'}>
														<Switch
															size="sm"
															aria-label={`Enable ${fn.name}`}
															checked={Boolean(fn.is_active)}
															onCheckedChange={() => toggleActive(fn)}
														/>
													</Tip>
												</div>
											</>
										)}
									</div>
								</div>
							))}
						</div>
					</div>
				) : (
					<ListEmptyState title="No functions found" />
				)}
			</div>

			{config?.features?.enable_community_sharing && (
				<CommunityDiscover
					href="https://openwebui.com/functions"
					title="Discover a function"
					description="Discover, download, and explore custom functions"
				/>
			)}
		</div>
	);
}
