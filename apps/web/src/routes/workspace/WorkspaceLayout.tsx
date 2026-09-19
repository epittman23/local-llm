import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { SplitCreateButton } from '@/components/common/SplitCreateButton';
import { getModelItems } from '@/lib/apis/models';
import { searchKnowledgeBases } from '@/lib/apis/knowledge';
import { getPromptItems } from '@/lib/apis/prompts';
import { getSkillItems } from '@/lib/apis/skills';
import { getToolList } from '@/lib/apis/tools';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { type WorkspaceSection, useWorkspaceStore } from '@/lib/stores/workspaceStore';
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

const tabClass = ({ isActive }: { isActive: boolean }) =>
	cn(
		'inline-flex min-w-fit items-center gap-1 border-b-2 px-1 pb-2 text-sm transition-colors',
		isActive
			? 'border-foreground text-foreground font-medium'
			: 'border-transparent text-muted-foreground hover:text-foreground'
	);

/**
 * Ports apps/openwebui/src/routes/(app)/workspace/+layout.svelte: the
 * per-section permission redirect, the five tabs with their live counts, and
 * the split Create button whose actions each section registers itself.
 *
 * Two deliberate differences. Counts are fetched once on entry rather than on
 * every pathname change (the Svelte layout re-ran `loadWorkspaceCounts()` on
 * each navigation *inside* /workspace, which refetched five endpoints just to
 * open a create form); sections keep their own count fresh via `setCount` as
 * they load. And the actions list is cleared when the section changes, in an
 * effect, instead of by a reactive statement -- same behavior, but explicit
 * about being an effect.
 */
export function WorkspaceLayout() {
	const authStatus = useAuthStore((s) => s.status);
	const user = useAuthStore((s) => s.user);
	const token = useAuthStore((s) => s.token);
	const config = useConfigStore((s) => s.config);
	const { actions, counts, setCounts, setActions } = useWorkspaceStore();
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

	// Each section registers its own actions on mount; anything left over from
	// the previous section must not leak into the next one's Create button.
	useEffect(() => {
		setActions([]);
	}, [section, setActions]);

	useEffect(() => {
		if (!allowed || !token) return;
		let cancelled = false;
		const can = (s: WorkspaceSection) => canSeeTab(user, config, s);
		(async () => {
			const [models, knowledge, prompts, skills, tools] = await Promise.all([
				can('models') ? getModelItems(token, null, null, null, null, null, 1).catch(() => null) : null,
				can('knowledge') ? searchKnowledgeBases(token, null, null, 1, null).catch(() => null) : null,
				can('prompts') ? getPromptItems(token, null, null, null, null, null, 1).catch(() => null) : null,
				can('skills') ? getSkillItems(token, null, null, 1).catch(() => null) : null,
				can('tools') ? getToolList(token).catch(() => null) : null
			]);
			if (cancelled) return;
			setCounts({
				models: countOf(models),
				knowledge: countOf(knowledge),
				prompts: countOf(prompts),
				skills: countOf(skills),
				tools: countOf(tools)
			});
		})();
		return () => {
			cancelled = true;
		};
		// Once per entry to /workspace: user/config are settled by then, and the
		// sections keep their own count current after this initial fetch.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [allowed, token]);

	if (!allowed) {
		return (
			<div className="flex flex-1 items-center justify-center p-8">
				<p className="text-muted-foreground text-sm">{settled ? 'Redirecting…' : 'Loading…'}</p>
			</div>
		);
	}

	return (
		<div className="flex h-full min-w-0 flex-col">
			<nav className="flex items-end gap-4 border-b px-4 pt-3">
				<div className="flex min-w-0 gap-4 overflow-x-auto">
					{tabOrder
						.filter((s) => canSeeTab(user, config, s))
						.map((s) => (
							<NavLink key={s} to={sectionPaths[s]} className={tabClass}>
								<span>{tabLabels[s]}</span>
								<span className="text-sm opacity-60">{formatNumber(counts[s] ?? 0)}</span>
							</NavLink>
						))}
				</div>
				<div className="mb-1.5 ml-auto flex shrink-0 items-center gap-1">
					<SplitCreateButton actions={actions} />
				</div>
			</nav>
			<div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4" id="workspace-container">
				<Outlet />
			</div>
		</div>
	);
}
