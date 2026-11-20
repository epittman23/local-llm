import { Link, useNavigate } from 'react-router';
import { SectionTabs } from '@/components/layout/SectionTabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusChip } from '@/routes/benchmarks/BenchmarksLayout';
import { Sparkline } from '@/routes/benchmarks/LivePage';
import { OUTCOMES, OutcomeBadge } from '@/routes/benchmarks/OutcomeBadge';

// Benchmarks' patterns on /ui: the graded outcomes, a long table whose
// headings stay in view, a workflow's grouped tabs with its status chip, and
// a key figure with its sparkline. Every name and number is invented.

/** DAT-3: one word and one colour per graded outcome, on every page that shows one. */
export function OutcomeBadgesDemo() {
	return (
		<div className="flex flex-wrap items-center gap-2">
			{Object.keys(OUTCOMES).map((outcome) => (
				<OutcomeBadge key={outcome} outcome={outcome} />
			))}
		</div>
	);
}

const FAILURES = Array.from({ length: 24 }, (_, i) => ({
	config: ['demo1a2b', 'demo3c4d', 'demo5e6f'][i % 3],
	item: `Demo/${100 + i}`,
	outcome: ['fail_assert', 'fail_error', 'fail_timeout', 'no_code'][i % 4],
	reasoning: 400 + ((i * 937) % 6000)
}));

/**
 * DAT-6: a list long enough to scroll keeps its headings, and its first
 * column, in view; a row that opens another page has its item as a link.
 */
export function StickyTableDemo() {
	const navigate = useNavigate();
	const href = (item: string) => `#ui-failure-${item.replace('/', '-')}`;
	return (
		<div className="max-w-[40rem]">
			<Table aria-label="Failures, invented" stickyHeader stickyFirstColumn maxHeight="18rem">
				<TableHeader>
					<TableRow>
						<TableHead scope="col">Configuration</TableHead>
						<TableHead scope="col">Item</TableHead>
						<TableHead scope="col">Outcome</TableHead>
						<TableHead scope="col" className="text-right">
							Reasoning, characters
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{FAILURES.map((row) => (
						<TableRow key={row.item} onOpen={() => navigate(href(row.item))}>
							<TableCell className="font-mono">{row.config}</TableCell>
							<TableCell className="font-mono">
								<Link to={href(row.item)} className="text-brand underline-offset-2 hover:underline">
									{row.item}
								</Link>
							</TableCell>
							<TableCell>
								<OutcomeBadge outcome={row.outcome} />
							</TableCell>
							<TableCell className="text-right tabular-nums">{row.reasoning.toLocaleString()}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

const WORKFLOW_TABS = [
	{ to: '#ui-bench-prescreen', label: 'Pre-screen', group: 'Configure' },
	{ to: '#ui-bench-tune', label: 'Tune', group: 'Configure' },
	{ to: '#ui-bench-serve', label: 'Serve', group: 'Run', active: true },
	{ to: '#ui-bench-live', label: 'Live', group: 'Run' },
	{ to: '#ui-bench-tests', label: 'Tests', group: 'Run' },
	{ to: '#ui-bench-compare', label: 'Compare', group: 'Analyse' },
	{ to: '#ui-bench-answers', label: 'Answers', group: 'Analyse' },
	{ to: '#ui-bench-report', label: 'Report', group: 'Analyse' }
];

/** NAV-2: a workflow's tabs in groups, ended by the chip that says what is running, in its two looks. */
export function WorkflowTabsDemo() {
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap-reverse items-center justify-end gap-x-4 gap-y-1 border-b">
				<SectionTabs label="Benchmarks, demo" tabs={WORKFLOW_TABS} className="min-w-0 flex-[1_1_28rem]" />
				<StatusChip state={{ label: 'Serving demo-model', detail: 'demo1a2b', to: '#ui-bench-serve' }} />
			</div>
			<div className="flex justify-end">
				<StatusChip state={null} />
			</div>
		</div>
	);
}

/** COL-8: a key figure with its unit, a line under it, and one series drawn small. */
export function SparklineTileDemo() {
	const vram = [3120, 4410, 4980, 5025, 5010, 5060, 5048, 5071, 5066, 5080];
	return (
		<section
			aria-label="Peak VRAM, demo"
			className="bg-surface-1 flex max-w-[16rem] min-w-0 flex-col gap-1 rounded-panel border p-3"
		>
			<h3 className="text-foreground-muted text-dense">Peak VRAM</h3>
			<p className="text-title font-title tabular-nums">5,080 MiB</p>
			<p className="text-foreground-muted text-dense">1,064 MiB free of 6,144</p>
			<Sparkline values={vram} max={6144} label="Peak VRAM" unit="MiB" tone={1} />
		</section>
	);
}
