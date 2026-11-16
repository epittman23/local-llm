import { ChevronDown } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table } from '@/components/ui/table';
import { dayjs } from '@/lib/utils/dates';

type Point = { date: string; models: Record<string, number> };

const W = 1000;
const PAD = { t: 8, r: 0, b: 20, l: 0 };

/**
 * The top of the y axis: the smallest round figure at or above `max` whose
 * half is a whole number, so the three ticks (0, half, top) read as counts.
 */
export function axisTop(max: number): number {
	if (max <= 2) return 2;
	const magnitude = 10 ** Math.floor(Math.log10(max));
	for (const m of [1, 2, 4, 5, 6, 8, 10]) {
		const top = m * magnitude;
		if (top >= max && Number.isInteger(top / 2)) return top;
	}
	return 10 * magnitude;
}

/**
 * Ports Analytics/ChartLine.svelte: a hand-rolled SVG line chart (one line per
 * model) with a hover crosshair, per-model dots, a tooltip listing the top five
 * models at that point, and HTML axis labels. No chart library: the SVG is
 * stretched with `preserveAspectRatio="none"`, so the lines are drawn in a fixed
 * 1000-wide coordinate space and scale to the container.
 *
 * DAT-1, COL-8, A11Y-4 (#1028): a legend names each line's colour, the y axis
 * has three ticks and a title, "Show as table" gives every value to the
 * keyboard and to a screen reader, and the hover tooltip opens away from the
 * nearer edge so it is never cut off.
 */
export function ChartLine({
	data,
	models,
	colors,
	height = 300,
	period = 'week',
	labelOf = (key) => key
}: {
	data: Point[];
	models: string[];
	colors: string[];
	height?: number;
	period?: 'hour' | 'week' | 'month' | 'year' | 'all';
	/** A series' name for the legend, tooltip and table (its key is a model id). */
	labelOf?: (key: string) => string;
}) {
	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
	const [mouseX, setMouseX] = useState(0);
	const [asTable, setAsTable] = useState(false);
	const tableId = useId();

	const colorMap = useMemo(() => new Map(models.map((m, i) => [m, colors[i % colors.length]])), [models, colors]);
	const maxCount = useMemo(() => Math.max(...data.flatMap((d) => Object.values(d.models || {})), 1), [data]);
	const top = axisTop(maxCount);
	const ticks = [top, top / 2, 0];
	const cw = W - PAD.l - PAD.r;
	const ch = height - PAD.t - PAD.b;
	const getX = (i: number) => (data.length <= 1 ? PAD.l + cw / 2 : PAD.l + (i / (data.length - 1)) * cw);
	const getY = (v: number) => PAD.t + ch - (v / top) * ch;
	const pathFor = (m: string) => {
		const pts = data.map((d, i) => `${getX(i)},${getY(d.models?.[m] || 0)}`);
		return pts.length > 1 ? `M${pts.join('L')}` : '';
	};

	const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		const x = (e.clientX - r.left) * (W / r.width);
		setMouseX(x);
		setHoveredIdx(Math.max(0, Math.min(data.length - 1, Math.round(((x - PAD.l) / cw) * (data.length - 1)))));
	};

	const hovered = hoveredIdx !== null ? data[hoveredIdx] : null;
	const isHourly = data[0]?.date?.includes(':');
	const unit = isHourly ? 'hour' : 'day';
	const dateFormat = isHourly ? 'h A' : period === 'year' || period === 'all' ? 'M/D/YY' : 'M/D';
	const longDate = (date: string) =>
		date.includes(':') ? dayjs(date).format('MMM D, h A') : dayjs(date).format('MMM D, YYYY');
	const labelCount = Math.min(7, data.length);
	const step = labelCount > 1 ? Math.floor((data.length - 1) / (labelCount - 1)) || 1 : 1;
	const total = hovered ? Object.values(hovered.models || {}).reduce((a, b) => a + b, 0) : 0;
	const allMessages = data.reduce((sum, d) => sum + Object.values(d.models || {}).reduce((a, b) => a + b, 0), 0);
	// The tooltip opens away from the nearer edge, so it stays inside the chart.
	const leftHalf = (mouseX / W) * 100 <= 50;
	const tipStyle = leftHalf ? { left: `${(mouseX / W) * 100}%` } : { right: `${100 - (mouseX / W) * 100}%` };

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<ul aria-label="Legend" className="text-dense flex min-w-0 flex-wrap gap-x-4 gap-y-1">
					{models.map((m) => (
						<li key={m} className="flex min-w-0 items-center gap-1.5">
							<span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: colorMap.get(m) }} />
							<span className="truncate" title={labelOf(m)}>
								{labelOf(m)}
							</span>
						</li>
					))}
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

			<p className="text-foreground-muted text-caption">Messages per {unit}</p>
			<div className="flex gap-2">
				<div aria-hidden className="text-foreground-muted text-caption relative w-8 shrink-0" style={{ height }}>
					{ticks.map((t) => (
						<span key={t} className="absolute right-0 -translate-y-1/2 tabular-nums" style={{ top: getY(t) }}>
							{t.toLocaleString()}
						</span>
					))}
				</div>
				<div className="relative min-w-0 flex-1" style={{ height }}>
					<svg
						role="img"
						aria-label={`Messages per ${unit}, ${data.length} ${unit}s: ${allMessages.toLocaleString()} messages across ${models.length} ${models.length === 1 ? 'model' : 'models'}`}
						viewBox={`0 0 ${W} ${height - 20}`}
						className="absolute inset-x-0 top-0 h-[calc(100%-20px)] w-full"
						preserveAspectRatio="none"
						onMouseMove={onMove}
						onMouseLeave={() => setHoveredIdx(null)}
					>
						{ticks.map((t) => (
							<line
								key={t}
								x1={0}
								x2={W}
								y1={getY(t)}
								y2={getY(t)}
								className="stroke-border-divider"
								strokeWidth="1"
								vectorEffect="non-scaling-stroke"
								data-tick={t}
							/>
						))}
						{models.map((m) => (
							<path
								key={m}
								d={pathFor(m)}
								fill="none"
								style={{ stroke: colorMap.get(m) }}
								strokeWidth="1.5"
								vectorEffect="non-scaling-stroke"
								className={hovered && !hovered.models?.[m] ? 'opacity-20' : ''}
							/>
						))}
						{hoveredIdx !== null && (
							<>
								<line
									x1={getX(hoveredIdx)}
									y1={PAD.t}
									x2={getX(hoveredIdx)}
									y2={ch + PAD.t}
									className="stroke-border-divider"
									strokeWidth="1"
									data-crosshair
								/>
								{models.map((m) => {
									const v = hovered?.models?.[m] || 0;
									return v > 0 ? (
										<circle key={m} cx={getX(hoveredIdx)} cy={getY(v)} r="3" style={{ fill: colorMap.get(m) }} />
									) : null;
								})}
							</>
						)}
					</svg>

					{data.length > 1 && (
						<div className="text-foreground-muted absolute inset-x-0 bottom-0 flex justify-between px-0.5 text-caption">
							{Array.from({ length: labelCount }, (_, i) => {
								const idx = i === labelCount - 1 ? data.length - 1 : Math.min(i * step, data.length - 1);
								return data[idx] ? (
									<span key={i} className={i === 0 ? 'text-left' : i === labelCount - 1 ? 'text-right' : 'text-center'}>
										{dayjs(data[idx].date).format(dateFormat)}
									</span>
								) : null;
							})}
						</div>
					)}

					{hovered && (
						<div className="pointer-events-none absolute top-1 max-w-full text-caption" style={tipStyle}>
							<div className="bg-surface-2 border-border-divider mx-2 min-w-36 rounded border px-2.5 py-1.5 shadow-sm">
								<div className="text-foreground-muted mb-1.5 text-caption">{longDate(hovered.date)}</div>
								{Object.entries(hovered.models || {})
									.sort(([, a], [, b]) => b - a)
									.slice(0, 5)
									.map(([key, count]) => (
										<div key={key} className="flex items-center justify-between gap-2 py-0.5">
											<span className="text-muted-foreground min-w-0 truncate">{labelOf(key)}</span>
											<span className="shrink-0 tabular-nums">
												{count.toLocaleString()}{' '}
												<span className="text-muted-foreground">
													({total > 0 ? ((count / total) * 100).toFixed(0) : 0}%)
												</span>
											</span>
										</div>
									))}
							</div>
						</div>
					)}
				</div>
			</div>

			{asTable && (
				<div id={tableId}>
					<Table aria-label={`Messages per ${unit}`} className="text-dense">
						<thead>
							<tr className="border-b">
								<th scope="col" className="text-foreground-muted px-2 py-1 text-left font-normal">
									{unit === 'hour' ? 'Hour' : 'Day'}
								</th>
								{models.map((m) => (
									<th key={m} scope="col" className="text-foreground-muted px-2 py-1 text-right font-normal">
										{labelOf(m)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{data.map((d) => (
								<tr key={d.date} className="border-b last:border-0">
									<td className="px-2 py-1">{longDate(d.date)}</td>
									{models.map((m) => (
										<td key={m} className="px-2 py-1 text-right tabular-nums">
											{(d.models?.[m] ?? 0).toLocaleString()}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</Table>
				</div>
			)}
		</div>
	);
}
