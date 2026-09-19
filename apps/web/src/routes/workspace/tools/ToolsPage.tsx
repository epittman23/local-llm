import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { Copy, Download, Heart, MoreHorizontal, Pencil, Settings, Share2, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ViewSelector } from '@/components/common/FilterSelects';
import { ImportUrlModal } from '@/components/common/ImportUrlModal';
import { ListEmptyState, ListSearchBar, SortHeaderButton, isControlClick } from '@/components/common/ListChrome';
import { ManifestModal } from '@/components/common/ManifestModal';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { ValvesModal } from '@/components/common/ValvesModal';
import { Badge } from '@/components/ui/badge';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { createNewTool, deleteToolById, exportTools, getToolById, getToolList, loadToolByUrl } from '@/lib/apis/tools';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useWebUIName } from '@/lib/stores/configStore';
import { useWorkspaceStore } from '@/lib/stores/workspaceStore';
import { capitalizeFirstLetter } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { useShiftKey } from '@/lib/utils/useShiftKey';
import { routePaths } from '@/routes/routePaths';
import { CodeExecutionWarning } from './ToolkitEditor';
import { type ToolListItem, filterAndSortTools, parseToolImport, toolSharePayload } from './toolTypes';

/**
 * Ports workspace/Tools.svelte. Unlike Prompts and Skills, the tools endpoint
 * returns every tool the user can see in one unpaginated list, so search, the
 * view filter and sorting all happen here in the browser (`filterAndSortTools`),
 * and the tab count is the *filtered* length, as in the original.
 *
 * Importing a tools file asks the user to acknowledge that tools run arbitrary
 * code before anything is created; importing from a link opens the create page
 * pre-filled instead of creating anything.
 *
 * "Share to Community" posts only the tool's own fields, to openwebui.com only
 * (the Svelte version posts the full record -- author email, grants -- to `*`).
 */
export function ToolsPage() {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const webuiName = useWebUIName();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const setActions = useWorkspaceStore((s) => s.setActions);
	const setCount = useWorkspaceStore((s) => s.setCount);
	const shiftKey = useShiftKey();

	const [query, setQuery] = useState('');
	const [viewOption, setViewOption] = useState(() => localStorage.workspaceViewOption || '');
	const [sortKey, setSortKey] = useState('updated_at');
	const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
	const [deleting, setDeleting] = useState<ToolListItem | null>(null);
	const [valvesFor, setValvesFor] = useState<ToolListItem | null>(null);
	const [manifestFor, setManifestFor] = useState<ToolListItem | null>(null);
	const [showImportUrl, setShowImportUrl] = useState(false);
	const [pendingImport, setPendingImport] = useState<File | null>(null);
	const importInput = useRef<HTMLInputElement>(null);

	const isAdmin = user?.role === 'admin';
	const can = (key: string) => isAdmin || Boolean(user?.permissions?.workspace?.[key]);
	const pluginsEnabled = Boolean(config?.features?.enable_plugins);
	const canImport = can('tools_import');
	const canExport = can('tools_export');

	const list = useQuery({
		queryKey: ['tools'],
		queryFn: async () => ((await getToolList(token)) ?? []) as ToolListItem[],
		enabled: pluginsEnabled
	});
	const items = useMemo(
		() =>
			filterAndSortTools(list.data ?? [], {
				query,
				view: viewOption,
				userId: user?.id,
				sortKey,
				direction: sortDirection
			}),
		[list.data, query, viewOption, user?.id, sortKey, sortDirection]
	);

	useEffect(() => {
		if (list.isError) toast.error(`${list.error}`);
	}, [list.isError, list.error]);
	useEffect(() => {
		if (list.data) setCount('tools', items.length);
	}, [list.data, items.length, setCount]);
	const refetch = () => queryClient.invalidateQueries({ queryKey: ['tools'] });

	useEffect(() => {
		setActions([
			{ id: 'tools-new', label: 'Create', href: routePaths.workspaceToolsCreate },
			{ id: 'tools-import-link', label: 'Import From Link', onClick: () => setShowImportUrl(true), visible: isAdmin },
			{ id: 'tools-import', label: 'Import JSON', onClick: () => importInput.current?.click(), visible: canImport },
			{
				id: 'tools-export',
				label: 'Export JSON',
				onClick: async () => {
					const all = await exportTools(token).catch((error) => {
						toast.error(`${error}`);
						return null;
					});
					if (all) saveAs(new Blob([JSON.stringify(all)], { type: 'application/json' }), `tools-export-${Date.now()}.json`);
				},
				visible: canExport
			}
		]);
		return () => setActions([]);
	}, [setActions, token, isAdmin, canImport, canExport]);

	useEffect(() => {
		document.title = `Tools / ${webuiName}`;
	}, [webuiName]);

	const openTool = (tool: ToolListItem) => navigate(`${routePaths.workspaceToolsEdit}?id=${encodeURIComponent(tool.id)}`);

	const deleteMutation = useMutation({
		mutationFn: (tool: ToolListItem) => deleteToolById(token, tool.id),
		onSuccess: (res) => res && toast.success('Tool deleted successfully'),
		onError: (error) => toast.error(`${error}`),
		onSettled: refetch
	});

	const fetchFull = (tool: ToolListItem) =>
		getToolById(token, tool.id).catch((error) => {
			toast.error(`${error}`);
			return null;
		});

	const cloneHandler = async (tool: ToolListItem) => {
		const full = await fetchFull(tool);
		if (!full) return;
		sessionStorage.tool = JSON.stringify({ ...full, id: `${full.id}_clone`, name: `${full.name} (Clone)` });
		navigate(routePaths.workspaceToolsCreate);
	};

	const exportHandler = async (tool: ToolListItem) => {
		const full = await fetchFull(tool);
		if (full) saveAs(new Blob([JSON.stringify([full])], { type: 'application/json' }), `tool-${full.id}-export-${Date.now()}.json`);
	};

	const shareHandler = async (tool: ToolListItem) => {
		const full = await fetchFull(tool);
		if (!full) return;
		// LICENSE covers this Open WebUI Community wordmark.
		// Do not alter, remove, obscure, or replace it except as LICENSE permits:
		// https://docs.openwebui.com/license.
		toast.success('Redirecting you to Open WebUI Community');
		const url = 'https://openwebui.com';
		const tab = window.open(`${url}/tools/create`, '_blank');
		const onMessage = (event: MessageEvent) => {
			if (event.origin !== url || event.data !== 'loaded') return;
			window.removeEventListener('message', onMessage);
			tab?.postMessage(JSON.stringify(toolSharePayload(full)), url);
		};
		window.addEventListener('message', onMessage);
		setTimeout(() => window.removeEventListener('message', onMessage), 60_000);
	};

	const runImport = (file: File) => {
		const reader = new FileReader();
		reader.onload = async (event) => {
			try {
				const tools = parseToolImport(String(event.target?.result));
				if (tools.length === 0) {
					toast.error('No valid tools found in that file.');
					return;
				}
				for (const tool of tools) {
					await createNewTool(token, tool).catch((error) => {
						toast.error(`${error}`);
						return null;
					});
				}
				toast.success('Tool imported successfully');
				refetch();
			} catch (error) {
				toast.error(`${error}`);
			}
		};
		reader.readAsText(file);
	};

	const sortBy = (key: string) => {
		if (sortKey === key) setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
		else {
			setSortKey(key);
			setSortDirection(key === 'updated_at' ? 'desc' : 'asc');
		}
	};

	// Tools.svelte's route redirects to /workspace when plugins are off.
	if (config && !pluginsEnabled) return <Navigate to={routePaths.workspace} replace />;

	const rowIconButton = 'text-muted-foreground flex size-6 items-center justify-center rounded-lg transition';

	return (
		<div className="space-y-1">
			<ImportUrlModal
				open={showImportUrl}
				onOpenChange={setShowImportUrl}
				loadUrl={(url) => loadToolByUrl(token, url)}
				successMessage="Tool imported successfully"
				onImport={(tool) => {
					sessionStorage.tool = JSON.stringify(tool);
					navigate(routePaths.workspaceToolsCreate);
				}}
			/>
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => !open && setDeleting(null)}
				title="Delete tool?"
				confirmLabel="Delete"
				onConfirm={() => {
					if (deleting) deleteMutation.mutate(deleting);
					setDeleting(null);
				}}
			>
				This will delete <span className="font-normal">{deleting?.name}</span>.
			</ConfirmDialog>
			<ConfirmDialog
				open={pendingImport !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingImport(null);
						if (importInput.current) importInput.current.value = '';
					}
				}}
				title="Confirm"
				onConfirm={() => {
					if (pendingImport) runImport(pendingImport);
					setPendingImport(null);
					if (importInput.current) importInput.current.value = '';
				}}
			>
				<CodeExecutionWarning />
			</ConfirmDialog>
			<ValvesModal open={valvesFor !== null} onOpenChange={(o) => !o && setValvesFor(null)} type="tool" id={valvesFor?.id ?? null} />
			<ManifestModal open={manifestFor !== null} onOpenChange={(o) => !o && setManifestFor(null)} manifest={manifestFor?.meta?.manifest ?? {}} />

			<input
				ref={importInput}
				id="documents-import-input"
				type="file"
				accept=".json"
				hidden
				onChange={(e) => e.target.files?.[0] && setPendingImport(e.target.files[0])}
			/>

			<ListSearchBar value={query} placeholder="Search Tools" onChange={setQuery}>
				<ViewSelector
					value={viewOption}
					onChange={(value) => {
						localStorage.workspaceViewOption = value;
						setViewOption(value);
					}}
				/>
			</ListSearchBar>

			{list.isPending ? (
				<div className="my-16 mb-24 flex h-full w-full items-center justify-center">
					<Spinner />
				</div>
			) : items.length !== 0 ? (
				<div className="my-1">
					<div className="text-muted-foreground flex w-full items-center gap-2 px-1.5 pb-0.5 text-xs">
						<SortHeaderButton
							label="Title"
							active={sortKey === 'name'}
							direction={sortDirection}
							className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
							onClick={() => sortBy('name')}
						/>
						<div className="hidden w-44 shrink-0 md:block" />
						<SortHeaderButton
							label="Updated at"
							active={sortKey === 'updated_at'}
							direction={sortDirection}
							className="flex w-36 shrink-0 items-center justify-end gap-1 py-0.5 text-right"
							onClick={() => sortBy('updated_at')}
						/>
					</div>

					<div className="grid gap-y-0.5">
						{items.map((tool) => {
							const version = tool.meta?.manifest?.version;
							return (
								<div
									key={tool.id}
									role="button"
									tabIndex={tool.write_access ? 0 : -1}
									className={`group flex min-h-8 w-full items-center gap-2 overflow-hidden rounded-xl px-2 py-1 text-left ${
										tool.write_access ? 'hover:bg-muted/50 cursor-pointer' : 'cursor-not-allowed opacity-60'
									}`}
									onClick={(e) => {
										if (!tool.write_access || isControlClick(e.target)) return;
										openTool(tool);
									}}
									onKeyDown={(e) => {
										if (!tool.write_access || e.currentTarget !== e.target) return;
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											openTool(tool);
										}
									}}
								>
									<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
										<div className="flex min-w-0 items-center gap-2 overflow-hidden">
											<Tip content={tool.id} side="top">
												<div className="min-w-0 truncate text-[0.8125rem] leading-5 group-hover:underline">{tool.name}</div>
											</Tip>
											{version && (
												<div className="text-muted-foreground max-w-[40%] min-w-0 shrink-0 truncate text-[0.6875rem] leading-5">
													v{version}
												</div>
											)}
											<Tip content={dayjs(tool.updated_at * 1000).format('LLLL')}>
												<div className="text-muted-foreground/70 shrink-0 truncate text-[0.6875rem] leading-5">
													{dayjs(tool.updated_at * 1000).fromNow()}
												</div>
											</Tip>
											{!tool.write_access && <Badge variant="secondary">Read Only</Badge>}
										</div>
										{tool.meta?.description && (
											<Tip content={tool.meta.description} side="top">
												<div className="text-muted-foreground/70 mt-0.5 truncate text-[0.6875rem] leading-4">
													{tool.meta.description}
												</div>
											</Tip>
										)}
									</div>

									<div className="text-muted-foreground hidden max-w-44 shrink-0 self-center truncate text-right text-[0.6875rem] leading-5 md:block">
										<Tip content={tool.user?.email ?? 'Deleted User'} side="top">
											<div className="truncate">{capitalizeFirstLetter(tool.user?.name ?? tool.user?.email ?? 'Deleted User')}</div>
										</Tip>
									</div>

									{tool.write_access && (
										<div className="ml-2 flex shrink-0 flex-row items-center gap-1.5 self-center">
											{shiftKey ? (
												<Tip content="Delete">
													<button
														type="button"
														className={rowIconButton}
														aria-label="Delete"
														onClick={(e) => {
															e.stopPropagation();
															deleteMutation.mutate(tool);
														}}
													>
														<Trash2 className="size-4" />
													</button>
												</Tip>
											) : (
												<>
													{tool.meta?.manifest?.funding_url && (
														<Tip content="Support">
															<button
																type="button"
																className={rowIconButton}
																aria-label="Support"
																onClick={(e) => {
																	e.stopPropagation();
																	setManifestFor(tool);
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
																setValvesFor(tool);
															}}
														>
															<Settings className="size-4" />
														</button>
													</Tip>
													<DropdownMenu>
														<Tip content="More">
															<DropdownMenuTrigger asChild>
																<button
																	type="button"
																	className={rowIconButton}
																	aria-label="Tool Menu"
																	onClick={(e) => e.stopPropagation()}
																>
																	<MoreHorizontal className="size-4" />
																</button>
															</DropdownMenuTrigger>
														</Tip>
														<DropdownMenuContent align="end" className="min-w-40">
															<DropdownMenuItem onSelect={() => openTool(tool)}>
																<Pencil />
																Edit
															</DropdownMenuItem>
															{config?.features?.enable_community_sharing && (
																<DropdownMenuItem onSelect={() => shareHandler(tool)}>
																	<Share2 />
																	Share
																</DropdownMenuItem>
															)}
															<DropdownMenuItem onSelect={() => cloneHandler(tool)}>
																<Copy />
																Clone
															</DropdownMenuItem>
															{canExport && (
																<DropdownMenuItem onSelect={() => exportHandler(tool)}>
																	<Download />
																	Export
																</DropdownMenuItem>
															)}
															<DropdownMenuSeparator />
															<DropdownMenuItem onSelect={() => setDeleting(tool)}>
																<Trash2 />
																Delete
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												</>
											)}
										</div>
									)}
								</div>
							);
						})}
					</div>
				</div>
			) : (
				<ListEmptyState title="No tools found" />
			)}

			{config?.features?.enable_community_sharing && (
				<div className="mt-6 px-2 pb-8">
					<div className="text-muted-foreground mb-0.5 text-[0.6875rem]">
						{/* LICENSE covers this Open WebUI Community wordmark.
						    Do not alter, remove, obscure, or replace it except as LICENSE permits:
						    https://docs.openwebui.com/license. */}
						Made by Open WebUI Community
					</div>
					<a className="flex w-full items-center justify-between gap-3 py-1 text-left" href="https://openwebui.com/tools" target="_blank" rel="noreferrer">
						<div className="min-w-0">
							<div className="line-clamp-1 text-[0.8125rem]">Discover a tool</div>
							<div className="text-muted-foreground line-clamp-1 text-xs">Discover, download, and explore custom tools</div>
						</div>
					</a>
				</div>
			)}
		</div>
	);
}
