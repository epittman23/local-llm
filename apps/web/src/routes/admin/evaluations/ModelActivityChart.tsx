import { useEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from '@/components/common/Spinner';
import { type ActivityDay, activityBuckets, isEmptyActivity } from './activityChart';

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

/**
 * Ports Evaluations/ModelActivityChart.svelte: a diverging bar chart, wins up
 * and losses down, drawn with chart.js (imported on first use -- this is the
 * only chart.js consumer, so the library is code-split away from every other
 * page). The x axis is hidden and the y axis shows absolute values.
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
							label: 'Won',
							data: buckets.map((b) => b.won),
							backgroundColor: tokens.won,
							borderRadius: 2,
							barPercentage,
							categoryPercentage
						},
						// Negative, so losses draw below the zero line.
						{
							label: 'Lost',
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
	}, [show, buckets, weekly, tokens]);

	return (
		<div className="w-full">
			{loading ? (
				<div className="flex h-40 items-center justify-center">
					<Spinner />
				</div>
			) : empty ? (
				<div className="text-muted-foreground flex h-40 items-center justify-center text-sm">No activity data</div>
			) : (
				<div className="h-48">
					<canvas ref={canvas} aria-label="Model activity chart" role="img" />
				</div>
			)}
		</div>
	);
}
