import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { SplitCreateButton } from '@/components/common/SplitCreateButton';
import { SectionSkeleton, SectionTabs } from '@/components/layout/SectionTabs';
import { PageHeader } from '@/components/ui/page-header';
import { searchKnowledgeBases } from '@/lib/apis/knowledge';
import { getModelItems } from '@/lib/apis/models';
import { getPromptItems } from '@/lib/apis/prompts';
import { getSkillItems } from '@/lib/apis/skills';
import { getToolList } from '@/lib/apis/tools';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useWorkspaceStore, type WorkspaceSection } from '@/lib/stores/workspaceStore';
import { cn, formatNumber } from '@/lib/utils';
import { routePaths } from '@/routes/routePaths';
import { canEnterSection, canSeeTab, sectionOfPath, sectionPaths, tabOrder } from './workspaceAccess';

const tabLabels: Record<WorkspaceSection, string> = {
	models: 'Models',
	knowledge: 'Knowledge',
	prompts: 'Prompts',
	skills: 'Skills',
	tools: 'Tools'
};

// `res?.total ?? (Array.isArray(res) ? res.length : null)`, from the layout.
const countOf = (res: unknown): number | null => {
	const total = (res as { total?: number } | null)?.total;
	if (typeof total === 'number') return total;
	return Array.isArray(res) ? res.length : null;
};

/** A tab's count: an en dash while it is loading or could not be read, never 0 (DAT-2, STA-2). */
export const countLabel = (count: number | null | undefined) => (typeof count === 'number' ? formatNumber(count) : '–');

/** An editor's route (create or edit a model, skill or tool; edit a prompt), which has its own header and Back. */
const EDITOR_PATH = /^\/workspace\/((models|skills|tools)\/(create|edit)|prompts\/(?!create$)[^/]+)$/;

/**
 * Ports d863707:apps/openwebui/src/routes/(app)/workspace/+layout.svelte: the
 * per-section permission redirect, the five tabs with their live counts, and
 * the split Create button whose actions each section registers itself.
 *
 * Two deliberate differences. Counts are fetched once on entry rather than on
 * every pathname change (the Svelte layout re-ran `loadWorkspaceCounts()` on
 * each navigation *inside* /workspace, which refetched five endpoints just to
 * open a create form); sections keep their own count fresh via `setCount` as
 * they load. And a section clears its own actions when it unmounts, rather than
 * the layout clearing them when the path changes: React runs a child's effects
 * before its parent's, so a layout-side clear ran *after* the new section had
 * registered and wiped the Create button every time.
 */
export function WorkspaceLayout() {
	const authStatus = useAuthStore((s) => s.status);
	const user = useAuthStore((s) => s.user);
	const token = useAuthStore((s) => s.token);
	const config = useConfigStore((s) => s.config);
	const actions = useWorkspaceStore((s) => s.actions);
	const counts = useWorkspaceStore((s) => s.counts);
	const setCounts = useWorkspaceStore((s) => s.setCounts);
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const redirected = useRef(false);

	const settled = authStatus === 'authenticated' && config !== null;
	const section = sectionOfPath(pathname);
	const allowed = settled && (section === null || canEnterSection(user, config, section));

	useEffect(() => {
		if (!settled || allowed || redirected.current) return;
		redirected.current = true;
		navigate(routePaths.home, { replace: true });
	}, [settled, allowed, navigate]);

	// Fetched on each entry to /workspace, not on every move inside it (the
	// layout stays mounted), and again whenever something invalidates
	// ['workspace-counts'], such as reconnecting. The sections keep their own
	// count current in between through setCount.
	const countsQuery = useQuery({
		queryKey: ['workspace-counts'],
		enabled: allowed && !!token,
		queryFn: async (): Promise<Record<WorkspaceSection, number | null>> => {
			const can = (s: WorkspaceSection) => canSeeTab(user, config, s);
			const auth = token ?? '';
			const [models, knowledge, prompts, skills, tools] = await Promise.all([
				can('models') ? getModelItems(auth, null, null, null, null, null, 1).catch(() => null) : null,
				can('knowledge') ? searchKnowledgeBases(auth, null, null, 1, null).catch(() => null) : null,
				can('prompts') ? getPromptItems(auth, null, null, null, null, null, 1).catch(() => null) : null,
				can('skills') ? getSkillItems(auth, null, null, 1).catch(() => null) : null,
				can('tools') ? getToolList(auth).catch(() => null) : null
			]);
			return {
				models: countOf(models),
				knowledge: countOf(knowledge),
				prompts: countOf(prompts),
				skills: countOf(skills),
				tools: countOf(tools)
			};
		}
	});

	useEffect(() => {
		if (countsQuery.data) setCounts(countsQuery.data);
	}, [countsQuery.data, setCounts]);

	if (!allowed) return <SectionSkeleton label="the workspace" />;

	// LAY-4: on a phone an editor gets the height the workspace header and tabs
	// would take; its own header has Back, and the app bar names the page.
	const editing = EDITOR_PATH.test(pathname);

	return (
		<div className="flex h-full min-w-0 flex-col">
			{editing && <h1 className="sr-only sm:hidden">Workspace</h1>}
			<div className={cn('flex flex-col gap-3 border-b px-4 pt-4', editing && 'max-sm:hidden')}>
				<div className="ps-[var(--shell-menu-inset,0px)]">
					<PageHeader
						title="Workspace"
						description="The models, knowledge, prompts, skills and tools your chats draw on."
						action={<SplitCreateButton actions={actions} />}
					/>
				</div>
				<SectionTabs
					label="Workspace"
					tabs={tabOrder
						.filter((s) => canSeeTab(user, config, s))
						.map((s) => ({
							to: sectionPaths[s],
							label: (
								<>
									<span>{tabLabels[s]}</span>
									<span className="text-caption text-muted-foreground tabular-nums">{countLabel(counts[s])}</span>
								</>
							)
						}))}
				/>
			</div>
			<div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4" id="workspace-container">
				<Outlet />
			</div>
		</div>
	);
}
