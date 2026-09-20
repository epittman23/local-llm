import { useEffect, useMemo, useRef } from 'react';
import { Spinner } from '@/components/common/Spinner';
import { type ActivityDay, activityBuckets, isEmptyActivity } from './activityChart';

/**
 * Ports Evaluations/ModelActivityChart.svelte: a diverging bar chart, wins up
 * and losses down, drawn with chart.js (imported on first use -- this is the
 * only chart.js consumer, so the library is code-split away from every other
 * page). The x axis is hidden and the y axis shows absolute values.
 */
export function ModelActivityChart({ history, loading, weekly }: { history: ActivityDay[]; loading: boolean; weekly: boolean }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const empty = isEmptyActivity(history);
	const buckets = useMemo(() => activityBuckets(history, weekly), [history, weekly]);
	const show = !loading && !empty;

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
						{ label: 'Won', data: buckets.map((b) => b.won), backgroundColor: '#5ba3c8', borderRadius: 2, barPercentage, categoryPercentage },
						// Negative, so losses draw below the zero line.
						{ label: 'Lost', data: buckets.map((b) => -b.lost), backgroundColor: '#d97c5a', borderRadius: 2, barPercentage, categoryPercentage }
					]
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					interaction: { intersect: false, mode: 'index' },
					plugins: {
						legend: { display: false },
						tooltip: {
							backgroundColor: 'rgba(17, 24, 39, 0.9)',
							titleColor: '#f3f4f6',
							bodyColor: '#d1d5db',
							borderColor: 'rgba(75, 85, 99, 0.3)',
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
							grid: { color: 'rgba(107, 114, 128, 0.1)', drawTicks: false },
							ticks: { color: '#6b7280', font: { size: 10 }, padding: 8, stepSize: 1, precision: 0, callback: (value) => Math.abs(Number(value)) },
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
	}, [show, buckets, weekly]);

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
