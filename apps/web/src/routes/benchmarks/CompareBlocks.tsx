import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CompareBlock, CompareRow } from '@/lib/apis/benchmarks';
import {
	blockFacts,
	formatCell,
	formatDiff,
	formatInterval,
	formatP,
	formatPpm,
	formatRateWithCi,
	pairVerdict,
	rowsByBlock
} from './compareFormat';

const verdictClass: Record<string, string> = {
	different: 'bg-green-500/15 text-green-800 dark:text-green-200',
	underpowered: 'bg-yellow-500/20 text-yellow-800 dark:text-yellow-200',
	'not different': 'text-muted-foreground',
	'not tested': 'text-muted-foreground'
};

const flagText = (flags: Record<string, string>): string =>
	Object.entries(flags)
		.map(([k, v]) => `${k}=${v}`)
		.join(' ') || '—';

/**
 * The config view: one section per block (tier, benchmark, adapter, system
 * prompt, release-date window, dataset revision), because rates are only
 * comparable inside one. Each row carries its interval and its group letter;
 * configurations sharing a letter are not distinguishable at the
 * Holm-corrected level, so the table reads as groups, not as a ranking.
 */
export function CompareBlocks({
	blocks,
	rows,
	baseline
}: {
	blocks: CompareBlock[];
	rows: CompareRow[];
	baseline: boolean;
}) {
	const byBlock = rowsByBlock(rows);
	if (blocks.length === 0) {
		return <p className="text-muted-foreground px-0.5 py-4 text-sm">No data</p>;
	}
	return (
		<div className="flex flex-col gap-6">
			{blocks.map((block) => (
				<section key={block.key} aria-label={block.key} className="flex flex-col gap-2">
					<div className="flex flex-wrap items-center gap-1.5">
						{blockFacts(block).map((fact) => (
							<Badge
								key={fact.label}
								variant={fact.label === 'Release-date window' ? 'default' : 'secondary'}
								className="font-normal"
							>
								{fact.label}: {fact.value}
							</Badge>
						))}
					</div>

					<div className="overflow-x-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead title="Configurations sharing a letter are not distinguishable (Holm-corrected)">
										Group
									</TableHead>
									<TableHead>Configuration</TableHead>
									<TableHead>Flags</TableHead>
									<TableHead>Passed / attempted</TableHead>
									<TableHead>Problems</TableHead>
									<TableHead>Pass rate [95% CI]</TableHead>
									<TableHead>SE</TableHead>
									<TableHead>Passes / min [95% CI]</TableHead>
									<TableHead>Gen t/s</TableHead>
									<TableHead>Prefill t/s</TableHead>
									{baseline && <TableHead>Vs baseline</TableHead>}
									<TableHead>Note</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{(byBlock.get(block.key) ?? []).map((row) => (
									<TableRow key={`${row.model}@${row.config_id}`}>
										<TableCell className="font-mono">{row.group}</TableCell>
										<TableCell>
											{row.model} @ <span className="font-mono">{row.config_id}</span>
										</TableCell>
										<TableCell className="text-muted-foreground text-xs">{flagText(row.flags)}</TableCell>
										<TableCell>
											{row.passed}/{row.attempted}
										</TableCell>
										<TableCell>
											{row.n_problems}
											{row.n_clusters !== null && (
												<span className="text-muted-foreground text-xs"> ({row.n_clusters} clusters)</span>
											)}
										</TableCell>
										<TableCell>{formatRateWithCi(row.pass_rate, row.pass_rate_ci)}</TableCell>
										<TableCell>
											{row.pass_rate_se === null ? '—' : `${(row.pass_rate_se * 100).toFixed(1)} pp`}
											<span className="text-muted-foreground text-xs"> ({row.se_kind})</span>
										</TableCell>
										<TableCell>{formatPpm(row.passes_per_minute, row.passes_per_minute_ci)}</TableCell>
										<TableCell>{formatCell(row.gen_tps)}</TableCell>
										<TableCell>{formatCell(row.prefill_tps)}</TableCell>
										{baseline && (
											<TableCell>
												{row.vs_baseline === null || row.vs_baseline === undefined
													? (row.vs_baseline_note ?? '—')
													: formatDiff(row.vs_baseline)}
											</TableCell>
										)}
										<TableCell className="text-muted-foreground text-xs">{row.note || ''}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>

					{block.pairs.length > 0 && (
						<div className="overflow-x-auto">
							<div className="text-muted-foreground px-0.5 pb-1 text-xs">
								Paired comparisons on shared problems, Holm across {block.holm_m} test(s) at alpha {block.alpha}
							</div>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>A</TableHead>
										<TableHead>B</TableHead>
										<TableHead>Shared</TableHead>
										<TableHead>A − B [95% CI]</TableHead>
										<TableHead>r</TableHead>
										<TableHead>Test</TableHead>
										<TableHead>p</TableHead>
										<TableHead>Holm p</TableHead>
										<TableHead title="Smallest difference detectable at 80% power, Holm worst case">MDE</TableHead>
										<TableHead>Verdict</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{block.pairs.map((pair) => {
										const verdict = pairVerdict(pair);
										return (
											<TableRow key={`${pair.a}|${pair.b}`}>
												<TableCell>{pair.a}</TableCell>
												<TableCell>{pair.b}</TableCell>
												<TableCell>{pair.n_shared}</TableCell>
												<TableCell>
													{formatDiff(pair.mean_diff)} {pair.ci ? `${formatInterval(pair.ci)} pp` : ''}
												</TableCell>
												<TableCell>{pair.corr === null ? '—' : pair.corr.toFixed(2)}</TableCell>
												<TableCell>{pair.test || '—'}</TableCell>
												<TableCell>{formatP(pair.p)}</TableCell>
												<TableCell>{formatP(pair.p_holm)}</TableCell>
												<TableCell>{pair.mde_holm === null ? '—' : `${(pair.mde_holm * 100).toFixed(1)} pp`}</TableCell>
												<TableCell>
													<span className={`rounded-sm px-1.5 py-0.5 text-xs ${verdictClass[verdict]}`}>{verdict}</span>
													{pair.note && <div className="text-muted-foreground mt-0.5 text-xs">{pair.note}</div>}
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						</div>
					)}
				</section>
			))}
		</div>
	);
}
