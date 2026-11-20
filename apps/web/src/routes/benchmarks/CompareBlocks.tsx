import { CircleCheckIcon, TriangleAlertIcon } from 'lucide-react';
import { Tip } from '@/components/common/Tip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { CompareBlock, CompareRow } from '@/lib/apis/benchmarks';
import { cn } from '@/lib/utils';
import {
	benchmarkName,
	blockFacts,
	flagsText,
	flagValue,
	formatDiff,
	formatDiffWithCi,
	formatP,
	formatPpm,
	formatRateWithCi,
	formatTime,
	isNumericFlag,
	type PairVerdict,
	pairSide,
	pairVerdict,
	rowsByBlock,
	splitFlags
} from './compareFormat';

/** DAT-3: a verdict is a status badge; a difference the test found is success, too little data a warning. */
const VERDICT_BADGE: Record<
	PairVerdict,
	{ variant: 'success' | 'warning' | 'secondary'; icon?: typeof CircleCheckIcon }
> = {
	different: { variant: 'success', icon: CircleCheckIcon },
	underpowered: { variant: 'warning', icon: TriangleAlertIcon },
	'not different': { variant: 'secondary' },
	'not tested': { variant: 'secondary' }
};

const NUM = 'text-right';

/**
 * The config view: one section per block (tier, benchmark, adapter, system
 * prompt, release-date window, dataset revision), because rates are only
 * comparable inside one. Each row carries its interval and its group letter;
 * configurations sharing a letter are not distinguishable at the
 * Holm-corrected level, so the table reads as groups, not as a ranking.
 *
 * Only the flags that tell a block's configurations apart get columns (#939);
 * the ones they share are listed once under "Shared flags", and every flag of
 * a configuration is in the tip on its id. The configuration column stays in
 * view while the rest scroll sideways (DAT-6).
 */
export function CompareBlocks({
	blocks,
	rows,
	baseline,
	baselinePending = false,
	onBaseline
}: {
	blocks: CompareBlock[];
	rows: CompareRow[];
	/** The baseline configuration's id, when one is chosen and present in these results. */
	baseline: string | null;
	/** The rows on screen were measured against another baseline, and this one's are loading. */
	baselinePending?: boolean;
	onBaseline: (configId: string) => void;
}) {
	const byBlock = rowsByBlock(rows);
	return (
		<div className="flex flex-col gap-8">
			{blocks.map((block) => {
				const blockRows = byBlock.get(block.key) ?? [];
				const { varying, shared } = splitFlags(blockRows);
				const oneModel = new Set(blockRows.map((row) => row.model)).size <= 1;
				const seKinds = new Set(blockRows.map((row) => row.se_kind));
				const seKind = seKinds.size === 1 ? [...seKinds][0] : null;
				const anyNote = blockRows.some((row) => row.note);
				const title = `${benchmarkName(block.benchmark || '?')}, ${block.tier}`;
				return (
					<section key={block.key} aria-label={title} className="flex flex-col gap-2">
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

						<Table aria-label={`Configurations, ${title}`} stickyFirstColumn>
							<TableHeader>
								<TableRow>
									<TableHead scope="col">Configuration</TableHead>
									<TableHead scope="col">Group</TableHead>
									{varying.map((flag) => (
										<TableHead
											key={flag}
											scope="col"
											className={cn('font-mono', isNumericFlag(blockRows, flag) && NUM)}
										>
											{flag}
										</TableHead>
									))}
									<TableHead scope="col" className={NUM}>
										Passed / attempted
									</TableHead>
									<TableHead scope="col" className={NUM}>
										Problems
									</TableHead>
									<TableHead scope="col" className={NUM}>
										Pass rate, % [95% CI]
									</TableHead>
									<TableHead scope="col" className={NUM}>
										SE, pp{seKind ? ` (${seKind})` : ''}
									</TableHead>
									<TableHead scope="col" className={NUM}>
										Passes / min [95% CI]
									</TableHead>
									<TableHead scope="col" className={NUM}>
										Gen, t/s
									</TableHead>
									<TableHead scope="col" className={NUM}>
										Prefill, t/s
									</TableHead>
									{baseline && (
										<TableHead scope="col" className={NUM}>
											Vs baseline, pp
										</TableHead>
									)}
									<TableHead scope="col">Last run</TableHead>
									{anyNote && <TableHead scope="col">Note</TableHead>}
									<TableHead scope="col">
										<span className="sr-only">Actions</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{blockRows.map((row) => {
									const isBaseline = row.config_id === baseline;
									return (
										<TableRow key={`${row.model}@${row.config_id}`} data-baseline={isBaseline || undefined}>
											<TableCell>
												<span className="inline-flex items-center gap-1.5">
													{!oneModel && <span>{row.model} @</span>}
													<Tip content={<span className="font-mono">{flagsText(row.flags)}</span>}>
														<Button
															variant="ghost"
															size="xs"
															className="-mx-2 font-mono"
															aria-label={`${row.config_id}, every flag`}
														>
															{row.config_id}
														</Button>
													</Tip>
													{isBaseline && <Badge variant="secondary">Baseline</Badge>}
												</span>
											</TableCell>
											<TableCell className="font-mono">{row.group}</TableCell>
											{varying.map((flag) => (
												<TableCell key={flag} className={cn('font-mono', isNumericFlag(blockRows, flag) && NUM)}>
													{flagValue(row.flags, flag)}
												</TableCell>
											))}
											<TableCell className={NUM}>
												{row.passed}/{row.attempted}
											</TableCell>
											<TableCell className={NUM}>
												{row.n_problems}
												{row.n_clusters !== null && (
													<span className="text-muted-foreground"> ({row.n_clusters} clusters)</span>
												)}
											</TableCell>
											<TableCell className={NUM}>{formatRateWithCi(row.pass_rate, row.pass_rate_ci)}</TableCell>
											<TableCell className={NUM}>
												{row.pass_rate_se === null ? '–' : (row.pass_rate_se * 100).toFixed(1)}
												{!seKind && <span className="text-muted-foreground"> ({row.se_kind})</span>}
											</TableCell>
											<TableCell className={NUM}>
												{formatPpm(row.passes_per_minute, row.passes_per_minute_ci)}
											</TableCell>
											<TableCell className={NUM}>{row.gen_tps === null ? '–' : row.gen_tps.toFixed(2)}</TableCell>
											<TableCell className={NUM}>
												{row.prefill_tps === null ? '–' : row.prefill_tps.toFixed(1)}
											</TableCell>
											{baseline && (
												<TableCell className={cn(NUM, row.vs_baseline_note && 'text-muted-foreground')}>
													{isBaseline ? (
														'0.0'
													) : baselinePending ? (
														// STA-2: the old baseline's numbers never stand under the new one.
														<>
															<span aria-hidden className="bg-surface-3 ml-auto block h-4 w-10 animate-pulse rounded" />
															<span className="sr-only">Loading</span>
														</>
													) : row.vs_baseline === null || row.vs_baseline === undefined ? (
														(row.vs_baseline_note ?? '–')
													) : (
														formatDiff(row.vs_baseline)
													)}
												</TableCell>
											)}
											<TableCell>
												{row.last_run ? <time dateTime={row.last_run}>{formatTime(row.last_run)}</time> : '–'}
											</TableCell>
											{anyNote && <TableCell className="text-muted-foreground">{row.note || '–'}</TableCell>}
											<TableCell>
												{!isBaseline && (
													<Button
														variant="ghost"
														size="xs"
														onClick={() => onBaseline(row.config_id)}
														aria-label={`Set as baseline, ${row.config_id}`}
													>
														Set as baseline
													</Button>
												)}
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>

						{shared.length > 0 && (
							<details className="text-dense px-0.5">
								<summary className="text-foreground-muted w-fit cursor-pointer">
									Shared flags ({shared.length}): every configuration here
								</summary>
								<dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 font-mono">
									{shared.map(({ flag, value }) => (
										<div key={flag} className="contents">
											<dt className="text-foreground-muted">{flag}</dt>
											<dd className="break-all">{value}</dd>
										</div>
									))}
								</dl>
							</details>
						)}

						{block.pairs.length > 0 && (
							<div className="mt-2 flex flex-col gap-1">
								<h3 className="font-strong px-0.5">Paired comparisons</h3>
								<p className="text-foreground-muted text-dense px-0.5">
									On the problems both configurations answered, Holm-corrected across {block.holm_m}{' '}
									{block.holm_m === 1 ? 'test' : 'tests'} at alpha {block.alpha}.
								</p>
								<Table aria-label={`Paired comparisons, ${title}`} stickyFirstColumn>
									<TableHeader>
										<TableRow>
											<TableHead scope="col">A</TableHead>
											<TableHead scope="col">B</TableHead>
											<TableHead scope="col" className={NUM}>
												Shared
											</TableHead>
											<TableHead scope="col" className={NUM}>
												A − B, pp [95% CI]
											</TableHead>
											<TableHead scope="col" className={NUM}>
												r
											</TableHead>
											<TableHead scope="col">Test</TableHead>
											<TableHead scope="col" className={NUM}>
												p
											</TableHead>
											<TableHead scope="col" className={NUM}>
												Holm p
											</TableHead>
											<TableHead scope="col" className={NUM}>
												MDE, pp
											</TableHead>
											<TableHead scope="col">Verdict</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{block.pairs.map((pair) => {
											const verdict = pairVerdict(pair);
											const badge = VERDICT_BADGE[verdict];
											const Icon = badge.icon;
											return (
												<TableRow key={`${pair.a}|${pair.b}`}>
													<TableCell className={cn(oneModel && 'font-mono')}>{pairSide(pair.a, oneModel)}</TableCell>
													<TableCell className={cn(oneModel && 'font-mono')}>{pairSide(pair.b, oneModel)}</TableCell>
													<TableCell className={NUM}>{pair.n_shared}</TableCell>
													<TableCell className={NUM}>{formatDiffWithCi(pair.mean_diff, pair.ci)}</TableCell>
													<TableCell className={NUM}>{pair.corr === null ? '–' : pair.corr.toFixed(2)}</TableCell>
													<TableCell>{pair.test || '–'}</TableCell>
													<TableCell className={NUM}>{formatP(pair.p)}</TableCell>
													<TableCell className={NUM}>{formatP(pair.p_holm)}</TableCell>
													<TableCell className={NUM}>
														{pair.mde_holm === null ? '–' : (pair.mde_holm * 100).toFixed(1)}
													</TableCell>
													<TableCell>
														<Badge variant={badge.variant}>
															{Icon && <Icon aria-hidden data-icon="inline-start" />}
															{verdict}
														</Badge>
														{pair.note && <div className="text-muted-foreground mt-0.5">{pair.note}</div>}
													</TableCell>
												</TableRow>
											);
										})}
									</TableBody>
								</Table>
							</div>
						)}
						<p className="text-foreground-muted text-dense px-0.5">
							Group: configurations sharing a letter are not distinguishable at the Holm-corrected level.
							{block.pairs.length > 0 &&
								" r: correlation of the two configurations' per-problem scores. Holm p: the p-value corrected for the number of tests. MDE: the smallest difference detectable at 80% power, Holm worst case."}
						</p>
					</section>
				);
			})}
		</div>
	);
}
