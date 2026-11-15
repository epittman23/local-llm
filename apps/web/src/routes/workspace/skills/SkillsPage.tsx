import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { Copy, Download, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ViewSelector } from '@/components/common/FilterSelects';
import { toastFailure } from '@/components/common/failureToast';
import { ListEmptyState, ListMatchCount, ListSearchBar, SortHeaderButton } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
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
import { RowButton } from '@/components/ui/row-button';
import { Switch } from '@/components/ui/switch';
import {
	createNewSkill,
	deleteSkillById,
	exportSkills,
	getSkillById,
	getSkillItems,
	toggleSkillById
} from '@/lib/apis/skills';
import { useAuthStore } from '@/lib/stores/authStore';
import { useDocumentTitle } from '@/lib/stores/configStore';
import { useWorkspaceStore } from '@/lib/stores/workspaceStore';
import { capitalizeFirstLetter, slugify } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { formatSkillName, parseFrontmatter } from '@/lib/utils/skills';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { routePaths } from '@/routes/routePaths';
import { useSingleUser } from '@/routes/workspace/workspaceAccess';
import { parseSkillImport, type SkillListItem } from './skillTypes';

const PER_PAGE = 30;

/**
 * Ports workspace/Skills.svelte. Same shape as the Prompts list (search, view
 * filter, sort, pagination, per-row menu and enable switch, shift-to-delete),
 * minus tags, plus: Create/Clone go to the editor *page* rather than a dialog
 * (Clone hands the skill over in `sessionStorage.skill`), and Import accepts a
 * `.json` (one skill or many) or a `.md` (frontmatter fills a new skill).
 *
 * Not ported: refreshing the app-wide `skills` store after each change. That
 * store feeds the chat and model editors, which do not exist here yet; when
 * they do, the mutations below should invalidate the ['skills'] query key.
 */
export function SkillsPage() {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const setActions = useWorkspaceStore((s) => s.setActions);
	const setCount = useWorkspaceStore((s) => s.setCount);

	const [query, setQuery] = useState('');
	const debouncedQuery = useDebouncedValue(query, 300);
	const [storedView, setViewOption] = useState(() => localStorage.workspaceViewOption || '');
	// WRD-4, S4-D1: with one account there is nothing to filter by owner, and a stored view is ignored.
	const singleUser = useSingleUser();
	const viewOption = singleUser ? '' : storedView;
	const [sortKey, setSortKey] = useState('updated_at');
	const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
	const [page, setPage] = useState(1);
	const [deleting, setDeleting] = useState<SkillListItem | null>(null);
	const [activeOverride, setActiveOverride] = useState<Record<string, boolean>>({});
	const importInput = useRef<HTMLInputElement>(null);

	const isAdmin = user?.role === 'admin';
	const can = (key: string) => isAdmin || Boolean(user?.permissions?.workspace?.[key]);
	const canCreate = can('skills');
	const canImport = can('skills_import');
	const canExport = can('skills_export');

	const list = useQuery({
		queryKey: ['skills', debouncedQuery, viewOption, page, sortKey, sortDirection],
		queryFn: async () =>
			(await getSkillItems(token, debouncedQuery, viewOption, page, sortKey, sortDirection)) as {
				items: SkillListItem[];
				total: number;
			},
		placeholderData: keepPreviousData
	});
	const skills = list.data?.items ?? null;
	const total = list.data?.total ?? 0;

	const failed = list.isError || (list.isPaused && list.data === undefined);
	// DAT-2, #955: the tab counts the whole list; a search or filter only narrows what is shown here.
	const filtered = debouncedQuery !== '' || viewOption !== '';
	const wholeCount = useWorkspaceStore((s) => s.counts.skills);
	useEffect(() => {
		if (list.data && !list.isPlaceholderData && !filtered) setCount('skills', list.data.total);
	}, [list.data, list.isPlaceholderData, filtered, setCount]);
	const refetchList = () => queryClient.invalidateQueries({ queryKey: ['skills'] });

	useEffect(() => {
		setActions([
			{ id: 'skills-new', label: 'New skill', href: routePaths.workspaceSkillsCreate, visible: canCreate },
			{
				id: 'skills-import',
				label: 'Import JSON',
				onClick: () => importInput.current?.click(),
				visible: canImport
			},
			{
				id: 'skills-export',
				label: 'Export JSON',
				onClick: async () => {
					const all = await exportSkills(token).catch((error) => {
						toastFailure("Couldn't export the skills.", error);
						return null;
					});
					if (all)
						saveAs(new Blob([JSON.stringify(all)], { type: 'application/json' }), `skills-export-${Date.now()}.json`);
				},
				visible: canExport
			}
		]);
		return () => setActions([]);
	}, [setActions, token, canCreate, canImport, canExport]);

	const openSkill = (skill: SkillListItem) =>
		navigate(`${routePaths.workspaceSkillsEdit}?id=${encodeURIComponent(skill.id)}`);

	const deleteMutation = useMutation({
		mutationFn: (skill: SkillListItem) => deleteSkillById(token, skill.id),
		onSuccess: (res) => res && toast.success('Skill deleted successfully'),
		onError: (error, skill) => toastFailure(`Couldn't delete “${skill.name}”.`, error),
		onSettled: () => {
			setPage(1);
			refetchList();
		}
	});

	const toggleActive = async (skill: SkillListItem, next: boolean) => {
		setActiveOverride((prev) => ({ ...prev, [skill.id]: next }));
		try {
			await toggleSkillById(token, skill.id);
		} catch (error) {
			toast.error(`${error}`);
			setActiveOverride((prev) => ({ ...prev, [skill.id]: !next }));
		}
	};

	const fetchFull = (skill: SkillListItem) =>
		getSkillById(token, skill.id).catch((error) => {
			toastFailure(`Couldn't load “${skill.name}”.`, error);
			return null;
		});

	const cloneHandler = async (skill: SkillListItem) => {
		const full = await fetchFull(skill);
		if (!full) return;
		sessionStorage.skill = JSON.stringify({ ...full, id: `${full.id}_clone`, name: `${full.name} (Clone)` });
		navigate(routePaths.workspaceSkillsCreate);
	};

	const exportHandler = async (skill: SkillListItem) => {
		const full = await fetchFull(skill);
		if (full) {
			saveAs(
				new Blob([JSON.stringify([full])], { type: 'application/json' }),
				`skill-${full.id}-export-${Date.now()}.json`
			);
		}
	};

	const importFile = (file: File) => {
		const ext = file.name.split('.').pop()?.toLowerCase();
		const reader = new FileReader();
		reader.onload = async (event) => {
			const text = event.target?.result;
			if (typeof text !== 'string') return;
			if (ext === 'json') {
				let items;
				try {
					items = parseSkillImport(text);
				} catch {
					toast.error("That file isn't a skills export (it isn't valid JSON).");
					return;
				}
				if (items.length === 0) {
					toast.error('No valid skills found in that file.');
					return;
				}
				for (const skill of items) {
					await createNewSkill(token, skill).catch((error) => {
						toastFailure(`Couldn't import “${skill.name}”.`, error);
					});
				}
				toast.success('Skill imported successfully');
				setPage(1);
				refetchList();
			} else {
				// Markdown: frontmatter names the skill; open the editor to finish it.
				const fm = parseFrontmatter(text);
				const rawName = fm.name || file.name.replace(/\.md$/, '');
				sessionStorage.skill = JSON.stringify({
					name: formatSkillName(rawName),
					id: slugify(rawName),
					description: fm.description || '',
					content: text,
					is_active: true,
					access_grants: []
				});
				navigate(routePaths.workspaceSkillsCreate);
			}
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

	useDocumentTitle('Skills');

	return (
		<div className="space-y-1">
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => !open && setDeleting(null)}
				title={`Delete “${deleting?.name ?? ''}”?`}
				confirmLabel="Delete skill"
				destructive
				onConfirm={() => {
					if (deleting) deleteMutation.mutate(deleting);
					setDeleting(null);
				}}
			>
				Models that use it lose it. It can't be undone.
			</ConfirmDialog>

			<input
				ref={importInput}
				type="file"
				accept=".md,.json"
				hidden
				onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])}
			/>

			<ListSearchBar
				value={query}
				placeholder="Search Skills"
				onChange={(value) => {
					setQuery(value);
					setPage(1);
				}}
			>
				{!singleUser && (
					<ViewSelector
						value={viewOption}
						onChange={(value) => {
							localStorage.workspaceViewOption = value;
							setViewOption(value);
							setPage(1);
						}}
					/>
				)}
			</ListSearchBar>

			{failed ? (
				<LoadFailed what="skills" error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />
			) : skills === null ? (
				<div className="my-16 mb-24 flex h-full w-full items-center justify-center">
					<Spinner />
				</div>
			) : skills.length !== 0 ? (
				<div className={list.isPlaceholderData ? 'my-1 opacity-60 transition' : 'my-1 transition'}>
					{filtered && !list.isPlaceholderData && <ListMatchCount shown={total} total={wholeCount} noun="skills" />}
					<div className="text-muted-foreground flex w-full items-center gap-2 px-1.5 pb-0.5 text-xs">
						<SortHeaderButton
							label="Title"
							active={sortKey === 'name'}
							direction={sortDirection}
							className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
							onClick={() => sortBy('name')}
						/>
						{!singleUser && <div className="hidden w-44 shrink-0 md:block" />}
						<SortHeaderButton
							label="Updated at"
							active={sortKey === 'updated_at'}
							direction={sortDirection}
							className="flex w-36 shrink-0 items-center justify-end gap-1 py-0.5 text-right"
							onClick={() => sortBy('updated_at')}
						/>
					</div>

					<div className="grid gap-y-0.5">
						{skills.map((skill) => {
							const updatedAt = (skill.updated_at ?? skill.created_at) * 1000;
							const isActive = activeOverride[skill.id] ?? skill.is_active;
							return (
								// The row's controls sit beside the button that opens it, not inside it (ACT-7).
								<div
									key={skill.id}
									className="group hover:bg-muted/50 flex min-h-8 w-full min-w-0 items-center gap-2 rounded-xl px-2 py-1"
								>
									<RowButton
										className="flex min-w-0 flex-1 items-center gap-2 self-stretch hover:bg-transparent"
										onClick={() => openSkill(skill)}
									>
										<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
											<div className="flex min-w-0 items-center gap-2 overflow-hidden">
												<Tip content={skill.id} side="top">
													<div className="min-w-0 truncate text-dense leading-5 group-hover:underline">
														{skill.name}
													</div>
												</Tip>
												<div
													aria-hidden
													className="text-muted-foreground hidden max-w-[40%] min-w-0 shrink-0 truncate text-caption leading-5 sm:block"
												>
													/{skill.id}
												</div>
												<Tip content={dayjs(updatedAt).format('LLLL')}>
													<div
														aria-hidden
														className="text-foreground-muted hidden shrink-0 text-caption leading-5 sm:block"
													>
														{dayjs(updatedAt).fromNow()}
													</div>
												</Tip>
												{!isActive && <Badge variant="secondary">Off</Badge>}
												{!skill.write_access && <Badge variant="secondary">Read only</Badge>}
											</div>
											{/* LAY-4: line 2 says what it is; below sm it also carries the time. */}
											<div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-caption leading-4">
												{skill.description && (
													<Tip content={skill.description} side="top">
														<span className="text-foreground-muted min-w-0 truncate">{skill.description}</span>
													</Tip>
												)}
												<span aria-hidden className="text-foreground-muted ms-auto shrink-0 sm:hidden">
													{dayjs(updatedAt).fromNow()}
												</span>
											</div>
										</div>

										{/* WRD-4: an owner says nothing with one account; it is not part of the row's name (A11Y-2). */}
										{!singleUser && (
											<div
												aria-hidden
												className="text-muted-foreground hidden max-w-44 shrink-0 self-center truncate text-right text-caption leading-5 md:block"
											>
												<Tip content={skill.user?.email ?? 'Deleted User'} side="top">
													<div className="truncate">
														{capitalizeFirstLetter(skill.user?.name ?? skill.user?.email ?? 'Deleted User')}
													</div>
												</Tip>
											</div>
										)}
									</RowButton>

									{skill.write_access && (
										<div className="ml-2 flex shrink-0 flex-row items-center self-center">
											<div className="flex shrink-0 flex-row items-center gap-1.5 self-center">
												<DropdownMenu>
													<Tip content="More">
														<DropdownMenuTrigger asChild>
															<Button
																variant="ghost"
																size="icon-sm"
																type="button"
																aria-label="Skill Menu"
																onClick={(e) => e.stopPropagation()}
															>
																<MoreHorizontal className="size-4" />
															</Button>
														</DropdownMenuTrigger>
													</Tip>
													<DropdownMenuContent align="end" className="min-w-40">
														<DropdownMenuItem onSelect={() => openSkill(skill)}>
															<Pencil />
															Edit
														</DropdownMenuItem>
														<DropdownMenuItem onSelect={() => cloneHandler(skill)}>
															<Copy />
															Clone
														</DropdownMenuItem>
														{canExport && (
															<DropdownMenuItem onSelect={() => exportHandler(skill)}>
																<Download />
																Export
															</DropdownMenuItem>
														)}
														<DropdownMenuSeparator />
														<DropdownMenuItem variant="destructive" onSelect={() => setDeleting(skill)}>
															<Trash2 />
															Delete
														</DropdownMenuItem>
													</DropdownMenuContent>
												</DropdownMenu>

												<span className="flex h-6 items-center">
													<Switch
														aria-label={`Enable ${skill.name}`}
														checked={isActive}
														onCheckedChange={(next) => toggleActive(skill, next)}
													/>
												</span>
											</div>
										</div>
									)}
								</div>
							);
						})}
					</div>
				</div>
			) : (
				<ListEmptyState
					title="No skills yet"
					description="A skill is a set of instructions a model can follow when a task calls for it."
					action={
						canCreate && (
							<Button size="sm" type="button" onClick={() => navigate(routePaths.workspaceSkillsCreate)}>
								New skill
							</Button>
						)
					}
					query={debouncedQuery}
					filtered={viewOption !== ''}
					onClear={() => {
						setQuery('');
						localStorage.workspaceViewOption = '';
						setViewOption('');
						setPage(1);
					}}
				/>
			)}

			{total > PER_PAGE && (
				<div className="mt-4 mb-2 flex justify-center">
					<PagePagination page={page} count={total} perPage={PER_PAGE} onPageChange={setPage} />
				</div>
			)}
		</div>
	);
}
