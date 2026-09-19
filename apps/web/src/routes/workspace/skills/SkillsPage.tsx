import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { Copy, Download, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ViewSelector } from '@/components/common/FilterSelects';
import { ListEmptyState, ListSearchBar, SortHeaderButton, isControlClick } from '@/components/common/ListChrome';
import { PagePagination } from '@/components/common/PagePagination';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Badge } from '@/components/ui/badge';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
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
import { useWebUIName } from '@/lib/stores/configStore';
import { useWorkspaceStore } from '@/lib/stores/workspaceStore';
import { capitalizeFirstLetter, slugify } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { formatSkillName, parseFrontmatter } from '@/lib/utils/skills';
import { useDebouncedValue } from '@/lib/utils/useDebouncedValue';
import { useShiftKey } from '@/lib/utils/useShiftKey';
import { routePaths } from '@/routes/routePaths';
import { type SkillListItem, parseSkillImport } from './skillTypes';

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
	const webuiName = useWebUIName();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const setActions = useWorkspaceStore((s) => s.setActions);
	const setCount = useWorkspaceStore((s) => s.setCount);

	const [query, setQuery] = useState('');
	const debouncedQuery = useDebouncedValue(query, 300);
	const [viewOption, setViewOption] = useState(() => localStorage.workspaceViewOption || '');
	const [sortKey, setSortKey] = useState('updated_at');
	const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
	const [page, setPage] = useState(1);
	const [deleting, setDeleting] = useState<SkillListItem | null>(null);
	const [activeOverride, setActiveOverride] = useState<Record<string, boolean>>({});
	const shiftKey = useShiftKey();
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

	useEffect(() => {
		if (list.isError) toast.error(`${list.error}`);
	}, [list.isError, list.error]);
	useEffect(() => {
		if (list.data) setCount('skills', list.data.total);
	}, [list.data, setCount]);
	const refetchList = () => queryClient.invalidateQueries({ queryKey: ['skills'] });

	useEffect(() => {
		setActions([
			{ id: 'skills-new', label: 'Create', href: routePaths.workspaceSkillsCreate, visible: canCreate },
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
						toast.error(`${error}`);
						return null;
					});
					if (all) saveAs(new Blob([JSON.stringify(all)], { type: 'application/json' }), `skills-export-${Date.now()}.json`);
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
		onError: (error) => toast.error(`${error}`),
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
			toast.error(`${error}`);
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
			saveAs(new Blob([JSON.stringify([full])], { type: 'application/json' }), `skill-${full.id}-export-${Date.now()}.json`);
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
					toast.error('Invalid JSON file');
					return;
				}
				if (items.length === 0) {
					toast.error('No valid skills found in that file.');
					return;
				}
				for (const skill of items) {
					await createNewSkill(token, skill).catch((error) => {
						toast.error(`${error}`);
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

	useEffect(() => {
		document.title = `Skills / ${webuiName}`;
	}, [webuiName]);

	const rowIconButton = 'text-muted-foreground flex size-6 items-center justify-center rounded-lg transition';

	return (
		<div className="space-y-1">
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => !open && setDeleting(null)}
				title="Delete skill?"
				confirmLabel="Delete"
				onConfirm={() => {
					if (deleting) deleteMutation.mutate(deleting);
					setDeleting(null);
				}}
			>
				This will delete <span className="font-normal">{deleting?.name}</span>.
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
				<ViewSelector
					value={viewOption}
					onChange={(value) => {
						localStorage.workspaceViewOption = value;
						setViewOption(value);
						setPage(1);
					}}
				/>
			</ListSearchBar>

			{skills === null ? (
				<div className="my-16 mb-24 flex h-full w-full items-center justify-center">
					<Spinner />
				</div>
			) : skills.length !== 0 ? (
				<div className={list.isPlaceholderData ? 'my-1 opacity-60 transition' : 'my-1 transition'}>
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
						{skills.map((skill) => {
							const updatedAt = (skill.updated_at ?? skill.created_at) * 1000;
							const isActive = activeOverride[skill.id] ?? skill.is_active;
							return (
								<div
									key={skill.id}
									role="button"
									tabIndex={0}
									className="group hover:bg-muted/50 flex min-h-8 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-xl px-2 py-1 text-left"
									onClick={(e) => !isControlClick(e.target) && openSkill(skill)}
									onKeyDown={(e) => {
										if (e.currentTarget !== e.target) return;
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											openSkill(skill);
										}
									}}
								>
									<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
										<div className="flex min-w-0 items-center gap-2 overflow-hidden">
											<Tip content={skill.id} side="top">
												<div className="min-w-0 truncate text-[0.8125rem] leading-5 group-hover:underline">
													{skill.name}
												</div>
											</Tip>
											<div className="text-muted-foreground max-w-[40%] min-w-0 shrink-0 truncate text-[0.6875rem] leading-5">
												/{skill.id}
											</div>
											<Tip content={dayjs(updatedAt).format('LLLL')}>
												<div className="text-muted-foreground/70 shrink-0 truncate text-[0.6875rem] leading-5">
													{dayjs(updatedAt).fromNow()}
												</div>
											</Tip>
											{!isActive && <Badge variant="secondary">Inactive</Badge>}
											{!skill.write_access && <Badge variant="secondary">Read Only</Badge>}
										</div>
										{skill.description && (
											<Tip content={skill.description} side="top">
												<div className="text-muted-foreground/70 mt-0.5 truncate text-[0.6875rem] leading-4">
													{skill.description}
												</div>
											</Tip>
										)}
									</div>

									<div className="text-muted-foreground hidden max-w-44 shrink-0 self-center truncate text-right text-[0.6875rem] leading-5 md:block">
										<Tip content={skill.user?.email ?? 'Deleted User'} side="top">
											<div className="truncate">
												{capitalizeFirstLetter(skill.user?.name ?? skill.user?.email ?? 'Deleted User')}
											</div>
										</Tip>
									</div>

									{skill.write_access && (
										<div className="ml-2 flex shrink-0 flex-row items-center self-center">
											{shiftKey ? (
												<Tip content="Delete">
													<button
														type="button"
														className={rowIconButton}
														aria-label="Delete"
														onClick={(e) => {
															e.stopPropagation();
															deleteMutation.mutate(skill);
														}}
													>
														<Trash2 className="size-4" />
													</button>
												</Tip>
											) : (
												<div className="flex shrink-0 flex-row items-center gap-1.5 self-center">
													<DropdownMenu>
														<Tip content="More">
															<DropdownMenuTrigger asChild>
																<button
																	type="button"
																	className={rowIconButton}
																	aria-label="Skill Menu"
																	onClick={(e) => e.stopPropagation()}
																>
																	<MoreHorizontal className="size-4" />
																</button>
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
															<DropdownMenuItem onSelect={() => setDeleting(skill)}>
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
																onCheckedChange={(next) => toggleActive(skill, next)}
															/>
														</span>
													</Tip>
												</div>
											)}
										</div>
									)}
								</div>
							);
						})}
					</div>
				</div>
			) : (
				<ListEmptyState title="No skills found" />
			)}

			{total > PER_PAGE && (
				<div className="mt-4 mb-2 flex justify-center">
					<PagePagination page={page} count={total} perPage={PER_PAGE} onPageChange={setPage} />
				</div>
			)}
		</div>
	);
}
