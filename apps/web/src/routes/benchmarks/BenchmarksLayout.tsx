import { NavLink, Outlet } from 'react-router';
import { cn } from '@/lib/utils';
import { routePaths } from '@/routes/routePaths';
import { useBenchmarksGate } from './useBenchmarksGate';

const tabs = [
	{ to: routePaths.benchmarksServe, label: 'Serve' },
	{ to: routePaths.benchmarksLive, label: 'Live' },
	{ to: routePaths.benchmarksTests, label: 'Tests' },
	{ to: routePaths.benchmarksCompare, label: 'Compare' },
	{ to: routePaths.benchmarksAnswers, label: 'Answers' },
	{ to: routePaths.benchmarksReport, label: 'Report' },
	{ to: routePaths.benchmarksTune, label: 'Tune' }
];

const tabClass = ({ isActive }: { isActive: boolean }) =>
	cn(
		'min-w-fit border-b-2 px-1 pb-2 text-sm transition-colors',
		isActive
			? 'border-foreground text-foreground font-medium'
			: 'border-transparent text-muted-foreground hover:text-foreground'
	);

/**
 * Ports apps/openwebui/src/routes/(app)/benchmarks/+layout.svelte: the same
 * gate (admin + features.enable_benchmarks, see useBenchmarksGate.ts) and
 * the same seven tabs, as a horizontal nav bar over an <Outlet /> instead of
 * a Svelte <slot />.
 */
export function BenchmarksLayout() {
	const gate = useBenchmarksGate();

	if (gate !== 'allowed') {
		return (
			<div className="flex flex-1 items-center justify-center p-8">
				<p className="text-muted-foreground text-sm">
					{gate === 'pending' ? 'Loading…' : 'Redirecting…'}
				</p>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<nav className="flex gap-4 overflow-x-auto border-b px-4 pt-3">
				{tabs.map((tab) => (
					<NavLink key={tab.to} to={tab.to} className={tabClass}>
						{tab.label}
					</NavLink>
				))}
			</nav>
			<div className="flex-1 overflow-y-auto p-4">
				<Outlet />
			</div>
		</div>
	);
}
