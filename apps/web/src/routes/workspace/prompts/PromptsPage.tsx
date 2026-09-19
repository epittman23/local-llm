import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import {
	Check,
	ChevronDown,
	ChevronUp,
	Clipboard,
	Copy,
	Download,
	MoreHorizontal,
	Pencil,
	Search,
	Share2,
	Trash2,
	X
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { PagePagination } from '@/components/common/PagePagination';
import { Spinner } from '@/components/common/Spinner';
import { TagSelector, ViewSelector } from '@/components/common/FilterSelects';
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
import {
	createNewPrompt,
	deletePromptById,
	getPromptItems,
	getPromptTags,
	togglePromptById
} from '@/lib/apis/prompts';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useWebUIName } from '@/lib/stores/configStore';
import { useWorkspaceStore } from '@/lib/stores/workspaceStore';
import { capitalizeFirstLetter, copyToClipboard, slugify } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { routePaths } from '@/routes/routePaths';
import { PromptCreateDialog } from './PromptCreateDialog';
import { type PromptDraft, type PromptListItem, toPromptDraft } from './promptTypes';

const PER_PAGE = 30;
const COMMUNITY_ORIGINS = ['https://openwebui.com', 'https://www.openwebui.com', 'http://localhost:9999'];

/**
 * Ports workspace/Prompts.svelte: the searchable, filterable, sortable,
 * paginated list of prompts, with per-row copy / enable-toggle / menu, and the
 * create dialog. `showCreateOnMount` is what `/workspace/prompts/create` sets
 * (the Svelte route is this same component with the modal pre-opened, closing
 * back to the list).
 *
 * Differences from the Svelte version worth knowing:
 * - Fetching is a TanStack query keyed on the filters, not a reactive block
 *   that re-runs on any of six variables changing (and needs `loading` set by
 *   hand). Search is debounced by debouncing the query value itself.
 * - "Export JSON" writes the rows currently *loaded* -- one page of 30, not
 *   every prompt. Same as the original, kept as-is rather than silently
 *   widened; a row's own Export exports just that prompt.
 */
export function PromptsPage({ showCreateOnMount = false }: { showCreateOnMount?: boolean }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const webuiName = useWebUIName();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { setActions, setCount } = useWorkspaceStore();

	const [query, setQuery] = useState('');
	const debouncedQuery = useDebouncedValue(query, 300);
	const [viewOption, setViewOption] = useState(() => localStorage.workspaceViewOption || '');
	const [selectedTag, setSelectedTag] = useState('');
	const [sortKey, setSortKey] = useState('updated_at');
	const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
	const [page, setPage] = useState(1);

	const [showCreate, setShowCreate] = useState(showCreateOnMount);
	const [createDraft, setCreateDraft] = useState<PromptDraft | null>(null);
	const [deleting, setDeleting] = useState<PromptListItem | null>(null);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [shiftKey, setShiftKey] = useState(false);
	// Enable/disable is optimistic: the switch flips at once and rolls back if the call fails.
	const [activeOverride, setActiveOverride] = useState<Record<string, boolean>>({});
	const importInput = useRef<HTMLInputElement>(null);

	const isAdmin = user?.role === 'admin';
	const canImport = isAdmin || Boolean(user?.permissions?.workspace?.prompts_import);
	const canExport = isAdmin || Boolean(user?.permissions?.workspace?.prompts_export);

	const list = useQuery({
		queryKey: ['prompts', debouncedQuery, viewOption, selectedTag, sortKey, sortDirection, page],
		queryFn: async () => {
			const res = await getPromptItems(
				token,
				debouncedQuery,
				viewOption,
				selectedTag,
				sortKey,
				sortDirection,
				page
			);
			return res as { items: PromptListItem[]; total: number };
		},
		placeholderData: keepPreviousData
	});
	const tagsQuery = useQuery({
		queryKey: ['prompt-tags'],
		queryFn: () => getPromptTags(token).catch(() => [] as string[])
	});
	const prompts = list.data?.items ?? null;
	const total = list.data?.total ?? 0;
	const tags = tagsQuery.data ?? [];

	useEffect(() => {
		if (list.isError) toast.error(`${list.error}`);
	}, [list.isError, list.error]);
	useEffect(() => {
		if (list.data) setCount('prompts', list.data.total);
	}, [list.data, setCount]);
	const refetchList = () => queryClient.invalidateQueries({ queryKey: ['prompts'] });

	// --- the layout's Create button --------------------------------------
	useEffect(() => {
		setActions([
			{
				id: 'prompts-new',
				label: 'Create',
				onClick: () => {
					setCreateDraft(null);
					setShowCreate(true);
				}
			},
			{
				id: 'prompts-import',
				label: 'Import JSON',
				onClick: () => importInput.current?.click(),
				visible: canImport
			},
			{
				id: 'prompts-export',
				label: 'Export JSON',
				onClick: () => {
					const blob = new Blob([JSON.stringify(prompts)], { type: 'application/json' });
					saveAs(blob, `prompts-export-${Date.now()}.json`);
				},
				visible: canExport
			}
		]);
	}, [setActions, canImport, canExport, prompts]);

	// --- Shift turns each row's copy/menu into a one-click delete --------
	useEffect(() => {
		const down = (e: KeyboardEvent) => e.key === 'Shift' && setShiftKey(true);
		const up = (e: KeyboardEvent) => e.key === 'Shift' && setShiftKey(false);
		const blur = () => setShiftKey(false);
		window.addEventListener('keydown', down);
		window.addEventListener('keyup', up);
		window.addEventListener('blur', blur);
		return () => {
			window.removeEventListener('keydown', down);
			window.removeEventListener('keyup', up);
			window.removeEventListener('blur', blur);
		};
	}, []);

	// --- prompts arriving from the Open WebUI community site -------------
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (!COMMUNITY_ORIGINS.includes(event.origin)) return;
			try {
				setCreateDraft(toPromptDraft(JSON.parse(event.data)));
				setShowCreate(true);
			} catch (error) {
				console.error('Ignoring malformed prompt from community site', error);
			}
		};
		window.addEventListener('message', onMessage);
		if (window.opener) window.opener.postMessage('loaded', '*');

		const stashed = sessionStorage.prompt;
		if (stashed) {
			sessionStorage.removeItem('prompt');
			try {
				setCreateDraft(toPromptDraft(JSON.parse(stashed)));
				setShowCreate(true);
			} catch (error) {
				console.error('Ignoring malformed stashed prompt', error);
			}
		}
		return () => window.removeEventListener('message', onMessage);
	}, []);

	// --- mutations -------------------------------------------------------
	const closeCreate = () => {
		setShowCreate(false);
		setCreateDraft(null);
		if (showCreateOnMount) navigate(routePaths.workspacePrompts);
	};

	const createPrompt = async (draft: PromptDraft) => {
		const res = await createNewPrompt(token, draft).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) {
			toast.success('Prompt created successfully');
			setPage(1);
			await refetchList();
			closeCreate();
		}
	};

	const deleteMutation = useMutation({
		mutationFn: (prompt: PromptListItem) => deletePromptById(token, prompt.id),
		onSuccess: (res, prompt) => {
			if (res) toast.success(`Deleted ${prompt.command}`);
		},
		onError: (error) => toast.error(`${error}`),
		onSettled: () => {
			setPage(1);
			refetchList();
		}
	});

	const toggleActive = async (prompt: PromptListItem, next: boolean) => {
		setActiveOverride((prev) => ({ ...prev, [prompt.id]: next }));
		try {
			await togglePromptById(token, prompt.id);
		} catch (error) {
			toast.error(`${error}`);
			setActiveOverride((prev) => ({ ...prev, [prompt.id]: !next }));
		}
	};

	const cloneHandler = (prompt: PromptListItem) => {
		const base = prompt.command.startsWith('/') ? prompt.command.substring(1) : prompt.command;
		setCreateDraft(
			toPromptDraft({
				...prompt,
				name: `${prompt.name} (Clone)`,
				command: slugify(`${base} clone`)
			})
		);
		setShowCreate(true);
	};

	const copyHandler = async (prompt: PromptListItem) => {
		if (await copyToClipboard(prompt.content ?? '')) {
			setCopiedId(prompt.command);
			setTimeout(() => setCopiedId(null), 2000);
		}
	};

	const shareHandler = (prompt: PromptListItem) => {
		// LICENSE covers this Open WebUI Community wordmark.
		// Do not alter, remove, obscure, or replace it except as LICENSE permits:
		// https://docs.openwebui.com/license.
		toast.success('Redirecting you to Open WebUI Community');
		const url = 'https://openwebui.com';
		const tab = window.open(`${url}/prompts/create`, '_blank');
		window.addEventListener('message', (event) => {
			if (event.origin !== url) return;
			if (event.data === 'loaded') tab?.postMessage(JSON.stringify(prompt), '*');
		});
	};

	const importFile = (file: File) => {
		const reader = new FileReader();
		reader.onload = async (event) => {
			try {
				const saved = JSON.parse(String(event.target?.result)) as PromptListItem[];
				for (const prompt of saved) {
					await createNewPrompt(token, {
						command: prompt.command,
						name: prompt.name,
						content: prompt.content ?? ''
					}).catch((error) => {
						toast.error(typeof error === 'string' ? error : JSON.stringify(error));
						return null;
					});
				}
				setPage(1);
				await refetchList();
			} catch (error) {
				toast.error(`${error}`);
			} finally {
				if (importInput.current) importInput.current.value = '';
			}
		};
		reader.readAsText(file);
	};

	const sortBy = (key: string) => {
		if (sortKey === key) {
			setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
		} else {
			setSortKey(key);
			setSortDirection(key === 'updated_at' ? 'desc' : 'asc');
		}
		setPage(1);
	};
	const sortIndicator = (key: string) =>
		sortKey === key ? sortDirection === 'asc' ? <ChevronUp className="size-2" /> : <ChevronDown className="size-2" /> : null;

	const openPrompt = (prompt: PromptListItem) => navigate(`${routePaths.workspacePrompts}/${prompt.id}`);
	// A click on a control inside the row belongs to the control, not the row.
	const isControlClick = (target: EventTarget | null) =>
		target instanceof Element && !!target.closest('button, a, input, [role="menu"]');

	useEffect(() => {
		document.title = `Prompts / ${webuiName}`;
	}, [webuiName]);

	const rowIconButton = 'text-muted-foreground flex size-6 items-center justify-center rounded-lg transition';

	return (
		<div className="space-y-1">
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => !open && setDeleting(null)}
				title="Delete prompt?"
				confirmLabel="Delete"
				onConfirm={() => {
					if (deleting) deleteMutation.mutate(deleting);
					setDeleting(null);
				}}
			>
				This will delete <span className="font-normal">{deleting?.command}</span>.
			</ConfirmDialog>

			<PromptCreateDialog open={showCreate} draft={createDraft} onSubmit={createPrompt} onClose={closeCreate} />

			<input
				ref={importInput}
				id="prompts-import-input"
				type="file"
				accept=".json"
				hidden
				onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])}
			/>

			<div className="flex h-8 w-full items-center gap-2">
				<div className="flex min-w-0 flex-1 items-center">
					<Search className="text-muted-foreground mr-3 ml-1 size-3.5" />
					<input
						className="w-full rounded-r-xl bg-transparent py-1 pr-4 text-sm outline-hidden"
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setPage(1);
						}}
						aria-label="Search Prompts"
						placeholder="Search Prompts"
					/>
					{query && (
						<button
							type="button"
							className="hover:bg-muted rounded-full p-0.5 transition"
							aria-label="Clear search"
							onClick={() => {
								setQuery('');
								setPage(1);
							}}
						>
							<X className="size-3" strokeWidth={2} />
						</button>
					)}
				</div>
				<div className="flex max-w-[55%] shrink-0 overflow-x-auto">
					<div className="flex w-fit gap-0.5 whitespace-nowrap">
						<ViewSelector
							value={viewOption}
							onChange={(value) => {
								localStorage.workspaceViewOption = value;
								setViewOption(value);
								setPage(1);
							}}
						/>
						{tags.length > 0 && (
							<TagSelector
								value={selectedTag}
								tags={tags}
								onChange={(value) => {
									setSelectedTag(value);
									setPage(1);
								}}
							/>
						)}
					</div>
				</div>
			</div>

			{prompts === null ? (
				<div className="my-16 mb-24 flex h-full w-full items-center justify-center">
					<Spinner />
				</div>
			) : prompts.length !== 0 ? (
				<div className={list.isPlaceholderData ? 'my-1 opacity-60 transition' : 'my-1 transition'}>
					<div className="text-muted-foreground flex w-full items-center gap-2 px-1.5 pb-0.5 text-xs">
						<button
							type="button"
							className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
							onClick={() => sortBy('name')}
						>
							Title
							{sortIndicator('name')}
						</button>
						<div className="hidden w-44 shrink-0 md:block" />
						<button
							type="button"
							className="flex w-36 shrink-0 items-center justify-end gap-1 py-0.5 text-right"
							onClick={() => sortBy('updated_at')}
						>
							Updated at
							{sortIndicator('updated_at')}
						</button>
					</div>

					<div className="grid gap-y-0.5">
						{prompts.map((prompt) => {
							const updatedAt = (prompt.updated_at ?? prompt.created_at) * 1000;
							const isActive = activeOverride[prompt.id] ?? prompt.is_active !== false;
							return (
								<div
									key={prompt.id}
									role="button"
									tabIndex={0}
									className="group hover:bg-muted/50 flex min-h-8 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-xl px-2 py-1 text-left"
									onClick={(e) => !isControlClick(e.target) && openPrompt(prompt)}
									onKeyDown={(e) => {
										if (e.currentTarget !== e.target) return;
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											openPrompt(prompt);
										}
									}}
								>
									<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
										<div className="flex min-w-0 items-center gap-2 overflow-hidden">
											<Tip content={prompt.name} side="top">
												<div className="min-w-0 truncate text-[0.8125rem] leading-5 group-hover:underline">
													{prompt.name}
												</div>
											</Tip>
											<div className="text-muted-foreground max-w-[40%] min-w-0 shrink-0 truncate text-[0.6875rem] leading-5">
												/{prompt.command}
											</div>
											<Tip content={dayjs(updatedAt).format('LLLL')}>
												<div className="text-muted-foreground/70 shrink-0 truncate text-[0.6875rem] leading-5">
													{dayjs(updatedAt).fromNow()}
												</div>
											</Tip>
											{!prompt.write_access && <Badge variant="secondary">Read Only</Badge>}
										</div>
										{prompt.content && (
											<Tip content={prompt.content} side="top">
												<div className="text-muted-foreground/70 mt-0.5 truncate text-[0.6875rem] leading-4">
													{prompt.content}
												</div>
											</Tip>
										)}
									</div>

									<div className="text-muted-foreground hidden max-w-44 shrink-0 self-center truncate text-right text-[0.6875rem] leading-5 md:block">
										<Tip content={prompt.user?.email ?? 'Deleted User'} side="top">
											<div className="truncate">
												{capitalizeFirstLetter(prompt.user?.name ?? prompt.user?.email ?? 'Deleted User')}
											</div>
										</Tip>
									</div>

									<div className="ml-2 flex shrink-0 flex-row items-center self-center">
										{shiftKey ? (
											<Tip content="Delete">
												<button
													type="button"
													className={rowIconButton}
													aria-label="Delete"
													onClick={(e) => {
														e.stopPropagation();
														deleteMutation.mutate(prompt);
													}}
												>
													<Trash2 className="size-4" />
												</button>
											</Tip>
										) : (
											<>
												<Tip content="Copy Prompt">
													<button
														type="button"
														className={rowIconButton}
														aria-label="Copy Prompt"
														onClick={(e) => {
															e.stopPropagation();
															copyHandler(prompt);
														}}
													>
														{copiedId === prompt.command ? (
															<Check className="size-4" strokeWidth={1.5} />
														) : (
															<Clipboard className="size-4" strokeWidth={1.5} />
														)}
													</button>
												</Tip>

												<div className="ml-0.5 flex shrink-0 flex-row items-center gap-1.5 self-center">
													<DropdownMenu>
														<Tip content="More">
															<DropdownMenuTrigger asChild>
																<button
																	type="button"
																	className={rowIconButton}
																	aria-label="Prompt Menu"
																	onClick={(e) => e.stopPropagation()}
																>
																	<MoreHorizontal className="size-4" />
																</button>
															</DropdownMenuTrigger>
														</Tip>
														<DropdownMenuContent align="end" className="min-w-40">
															<DropdownMenuItem onSelect={() => openPrompt(prompt)}>
																<Pencil />
																Edit
															</DropdownMenuItem>
															{config?.features?.enable_community_sharing && (
																<DropdownMenuItem onSelect={() => shareHandler(prompt)}>
																	<Share2 />
																	Share
																</DropdownMenuItem>
															)}
															<DropdownMenuItem onSelect={() => cloneHandler(prompt)}>
																<Copy />
																Clone
															</DropdownMenuItem>
															{canExport && (
																<DropdownMenuItem
																	onSelect={() =>
																		saveAs(
																			new Blob([JSON.stringify([prompt])], { type: 'application/json' }),
																			`prompt-export-${Date.now()}.json`
																		)
																	}
																>
																	<Download />
																	Export
																</DropdownMenuItem>
															)}
															<DropdownMenuSeparator />
															<DropdownMenuItem onSelect={() => setDeleting(prompt)}>
																<Trash2 />
																Delete
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>

													<Tip content={isActive ? 'Enabled' : 'Disabled'}>
														<span className="flex h-6 items-center" onClick={(e) => e.stopPropagation()}>
															<Switch
																aria-label={isActive ? 'Enabled' : 'Disabled'}
																checked={isActive}
																onCheckedChange={(next) => toggleActive(prompt, next)}
															/>
														</span>
													</Tip>
												</div>
											</>
										)}
									</div>
								</div>
							);
						})}
					</div>
				</div>
			) : (
				<div className="flex w-full flex-col items-center justify-center py-16 pb-24">
					<div className="max-w-sm text-center">
						<div className="mb-1.5 text-sm">No prompts found</div>
						<div className="text-muted-foreground text-center text-xs leading-5">
							Try adjusting your search or filter to find what you are looking for.
						</div>
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
					<a
						className="flex w-full items-center justify-between gap-3 py-1 text-left transition"
						href="https://openwebui.com/prompts"
						target="_blank"
						rel="noreferrer"
					>
						<div className="min-w-0">
							<div className="line-clamp-1 text-[0.8125rem]">Discover a prompt</div>
							<div className="text-muted-foreground line-clamp-1 text-xs">
								Discover, download, and explore custom prompts
							</div>
						</div>
					</a>
				</div>
			)}
		</div>
	);
}
