import { Outlet } from 'react-router';
import { SectionSkeleton, SectionTabs } from '@/components/layout/SectionTabs';
import { PageHeader } from '@/components/ui/page-header';
import { routePaths } from '@/routes/routePaths';
import { useBenchmarksGate } from './useBenchmarksGate';

const tabs = [
	{ to: routePaths.benchmarksServe, label: 'Serve' },
	{ to: routePaths.benchmarksLive, label: 'Live' },
	{ to: routePaths.benchmarksTests, label: 'Tests' },
	{ to: routePaths.benchmarksCompare, label: 'Compare' },
	{ to: routePaths.benchmarksAnswers, label: 'Answers' },
	{ to: routePaths.benchmarksReport, label: 'Report' },
	{ to: routePaths.benchmarksTune, label: 'Tune' },
	{ to: routePaths.benchmarksPrescreen, label: 'Pre-screen' }
];

/**
 * Ports d863707:apps/openwebui/src/routes/(app)/benchmarks/+layout.svelte: the same
 * gate (admin + features.enable_benchmarks, see useBenchmarksGate.ts) and
 * the same seven tabs, as a horizontal nav bar over an <Outlet /> instead of
 * a Svelte <slot />, plus Pre-screen (2026-10-28), which the Svelte app never
 * had.
 */
export function BenchmarksLayout() {
	const gate = useBenchmarksGate();

	if (gate !== 'allowed') return <SectionSkeleton label="benchmarks" />;

	return (
		<div className="flex h-full flex-col">
			<div className="flex flex-col gap-3 border-b px-4 pt-4">
				<div className="ps-[var(--shell-menu-inset,0px)]">
					<PageHeader title="Benchmarks" description="Serve a local model, measure it, and compare configurations." />
				</div>
				<SectionTabs label="Benchmarks" tabs={tabs} />
			</div>
			<div className="flex-1 overflow-y-auto p-4">
				<Outlet />
			</div>
		</div>
	);
}
