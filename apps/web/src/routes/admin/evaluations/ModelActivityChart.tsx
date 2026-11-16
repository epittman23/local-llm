import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table } from '@/components/ui/table';
import { type ActivityDay, activityBuckets, isEmptyActivity } from './activityChart';
import { figure } from './leaderboard';

const TOKENS = {
	won: '--series-1',
	lost: '--series-2',
	text: '--foreground',
	muted: '--foreground-muted',
	grid: '--border-divider',
	surface: '--surface-2',
	font: '--font-ui'
} as const;

export type ChartTokens = Record<keyof typeof TOKENS, string>;

/**
 * The standard's colours for a canvas chart, read from the page (COL-1,
 * COL-8): chart.js draws pixels, so it cannot follow CSS variables itself.
 */
export function readChartTokens(root: Element = document.documentElement): ChartTokens {
	const style = getComputedStyle(root);
	return Object.fromEntries(
		Object.entries(TOKENS).map(([key, name]) => [key, style.getPropertyValue(name).trim()])
	) as ChartTokens;
}

/** The chart tokens, read again whenever the theme changes the root element's class or data-theme. */
export function useChartTokens(): ChartTokens {
	const [tokens, setTokens] = useState(readChartTokens);
	useEffect(() => {
		const observer = new MutationObserver(() => setTokens(readChartTokens()));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
		return () => observer.disconnect();
	}, []);
	return tokens;
}

/** A legend swatch: the series colour as a square beside its name (COL-8). */
function Swatch({ token }: { token: string }) {
	return <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: `var(${token})` }} />;
}

/**
 * Ports Evaluations/ModelActivityChart.svelte: a diverging bar chart, wins up
 * and losses down, drawn with chart.js (imported on first use -- this is the
 * only chart.js consumer, so the library is code-split away from every other
 * page). The x axis is hidden and the y axis, titled, shows absolute values.
 *
 * DAT-1, COL-8, A11Y-4: a legend names the two colours, and "Show as table"
 * gives every bar's figures to the keyboard and to a screen reader, which
 * the canvas and its hover tooltip cannot.
 */
export function ModelActivityChart({
	history,
	loading,
	weekly
}: {
	history: ActivityDay[];
	loading: boolean;
	weekly: boolean;
}) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const empty = isEmptyActivity(history);
	const buckets = useMemo(() => activityBuckets(history, weekly), [history, weekly]);
	const show = !loading && !empty;
	const tokens = useChartTokens();
	const [asTable, setAsTable] = useState(false);
	const tableId = useId();
	const unit = weekly && history.length > 7 ? 'week' : 'day';

	useEffect(() => {
		if (!show || !canvas.current) return;
		let chart: { destroy: () => void } | null = null;
		let cancelled = false;
		import('chart.js/auto').then(({ default: Chart }) => {
			if (cancelled || !canvas.current) return;
			const barPercentage = weekly ? 0.95 : 0.9;
			const categoryPercentage = weekly ? 1.0 : 0.95;
			chart = new Chart(canvas.current, {
				type: 'bar',
				data: {
					labels: buckets.map((b) => b.label),
					datasets: [
						{
							label: 'Wins',
							data: buckets.map((b) => b.won),
							backgroundColor: tokens.won,
							borderRadius: 2,
							barPercentage,
							categoryPercentage
						},
						// Negative, so losses draw below the zero line.
						{
							label: 'Losses',
							data: buckets.map((b) => -b.lost),
							backgroundColor: tokens.lost,
							borderRadius: 2,
							barPercentage,
							categoryPercentage
						}
					]
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					interaction: { intersect: false, mode: 'index' },
					plugins: {
						legend: { display: false },
						tooltip: {
							backgroundColor: tokens.surface,
							titleColor: tokens.text,
							bodyColor: tokens.muted,
							borderColor: tokens.grid,
							borderWidth: 1,
							padding: 8,
							displayColors: true,
							boxWidth: 8,
							boxHeight: 8,
							callbacks: { label: (context) => `${context.dataset.label}: ${Math.abs(context.raw as number)}` }
						}
					},
					scales: {
						x: { stacked: true, grid: { display: false }, ticks: { display: false }, border: { display: false } },
						y: {
							stacked: true,
							title: {
								display: true,
								text: `Ratings per ${unit}`,
								color: tokens.muted,
								font: { size: 12, family: tokens.font }
							},
							grid: { color: tokens.grid, drawTicks: false },
							ticks: {
								color: tokens.muted,
								font: { size: 12, family: tokens.font },
								padding: 8,
								stepSize: 1,
								precision: 0,
								callback: (value) => Math.abs(Number(value))
							},
							border: { display: false }
						}
					},
					animation: { duration: 400, easing: 'easeOutQuart' }
				}
			});
		});
		return () => {
			cancelled = true;
			chart?.destroy();
		};
	}, [show, buckets, weekly, tokens, unit]);

	return (
		<div className="w-full">
			{loading ? (
				<div aria-busy="true" className="bg-surface-3 h-48 animate-pulse rounded">
					<span className="sr-only" role="status">
						Loading activity
					</span>
				</div>
			) : empty ? (
				<div className="text-foreground-muted flex h-40 items-center justify-center">No ratings in this period</div>
			) : (
				<div className="flex flex-col gap-2">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<ul aria-label="Legend" className="text-dense flex gap-4">
							<li className="flex items-center gap-1.5">
								<Swatch token={TOKENS.won} />
								Wins
							</li>
							<li className="flex items-center gap-1.5">
								<Swatch token={TOKENS.lost} />
								Losses
							</li>
						</ul>
						<Button
							variant="ghost"
							size="sm"
							type="button"
							aria-expanded={asTable}
							aria-controls={tableId}
							onClick={() => setAsTable((v) => !v)}
						>
							{asTable ? 'Hide table' : 'Show as table'}
							<ChevronDown className={asTable ? 'rotate-180' : undefined} />
						</Button>
					</div>
					<div className="h-48">
						<canvas
							ref={canvas}
							role="img"
							aria-label={`Wins and losses per ${unit}: ${buckets.reduce((n, b) => n + b.won, 0)} wins, ${buckets.reduce((n, b) => n + b.lost, 0)} losses`}
						/>
					</div>
					{asTable && (
						<div id={tableId}>
							<Table aria-label={`Wins and losses per ${unit}`} className="text-dense">
								<thead>
									<tr className="border-b">
										<th scope="col" className="text-foreground-muted px-2 py-1 text-left font-normal">
											{unit === 'week' ? 'Week of' : 'Day'}
										</th>
										<th scope="col" className="text-foreground-muted px-2 py-1 text-right font-normal">
											Wins
										</th>
										<th scope="col" className="text-foreground-muted px-2 py-1 text-right font-normal">
											Losses
										</th>
									</tr>
								</thead>
								<tbody>
									{buckets.map((b) => (
										<tr key={b.label} className="border-b last:border-0">
											<td className="px-2 py-1">{b.label}</td>
											<td className="px-2 py-1 text-right tabular-nums">{figure(b.won)}</td>
											<td className="px-2 py-1 text-right tabular-nums">{figure(b.lost)}</td>
										</tr>
									))}
								</tbody>
							</Table>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
