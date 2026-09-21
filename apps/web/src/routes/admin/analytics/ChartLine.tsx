import { useMemo, useState } from 'react';
import { dayjs } from '@/lib/utils/dates';

type Point = { date: string; models: Record<string, number> };

const W = 1000;
const PAD = { t: 8, r: 0, b: 20, l: 0 };

/**
 * Ports Analytics/ChartLine.svelte: a hand-rolled SVG line chart (one line per
 * model) with a hover crosshair, per-model dots, a tooltip listing the top five
 * models at that point, and HTML x-axis labels. No chart library: the SVG is
 * stretched with `preserveAspectRatio="none"`, so the lines are drawn in a fixed
 * 1000-wide coordinate space and scale to the container.
 */
export function ChartLine({
	data,
	models,
	colors,
	height = 300,
	period = 'week'
}: {
	data: Point[];
	models: string[];
	colors: string[];
	height?: number;
	period?: 'hour' | 'week' | 'month' | 'year' | 'all';
}) {
	const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
	const [mouseX, setMouseX] = useState(0);

	const colorMap = useMemo(() => new Map(models.map((m, i) => [m, colors[i % colors.length]])), [models, colors]);
	const maxCount = useMemo(() => Math.max(...data.flatMap((d) => Object.values(d.models || {})), 1), [data]);
	const cw = W - PAD.l - PAD.r;
	const ch = height - PAD.t - PAD.b;
	const getX = (i: number) => (data.length <= 1 ? PAD.l + cw / 2 : PAD.l + (i / (data.length - 1)) * cw);
	const getY = (v: number) => PAD.t + ch - (v / maxCount) * ch;
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
	const dateFormat = isHourly ? 'h A' : period === 'year' || period === 'all' ? 'M/D/YY' : 'M/D';
	const labelCount = Math.min(7, data.length);
	const step = labelCount > 1 ? Math.floor((data.length - 1) / (labelCount - 1)) || 1 : 1;
	const total = hovered ? Object.values(hovered.models || {}).reduce((a, b) => a + b, 0) : 0;

	return (
		<div className="relative w-full" style={{ height }}>
			<svg
				role="img"
				aria-label="Messages over time"
				viewBox={`0 0 ${W} ${height - 20}`}
				className="absolute inset-x-0 top-0 h-[calc(100%-20px)] w-full"
				preserveAspectRatio="none"
				onMouseMove={onMove}
				onMouseLeave={() => setHoveredIdx(null)}
			>
				{models.map((m) => (
					<path key={m} d={pathFor(m)} fill="none" stroke={colorMap.get(m)} strokeWidth="1.5" className={hovered && !hovered.models?.[m] ? 'opacity-20' : ''} />
				))}
				{hoveredIdx !== null && (
					<>
						<line x1={getX(hoveredIdx)} y1={PAD.t} x2={getX(hoveredIdx)} y2={ch + PAD.t} stroke="#ddd" strokeWidth="1" />
						{models.map((m) => {
							const v = hovered?.models?.[m] || 0;
							return v > 0 ? <circle key={m} cx={getX(hoveredIdx)} cy={getY(v)} r="3" fill={colorMap.get(m)} /> : null;
						})}
					</>
				)}
			</svg>

			{data.length > 1 && (
				<div className="text-muted-foreground absolute inset-x-0 bottom-0 flex justify-between px-0.5 text-[0.625rem]">
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
				<div className="pointer-events-none absolute top-1 text-[0.6875rem]" style={{ left: `${Math.min(Math.max((mouseX / W) * 100, 8), 92)}%` }}>
					<div className="bg-popover min-w-[8.75rem] -translate-x-1/2 rounded border px-2.5 py-1.5 shadow-sm">
						<div className="text-muted-foreground mb-1.5 text-[0.625rem]">
							{hovered.date?.includes(':') ? dayjs(hovered.date).format('MMM D, h A') : dayjs(hovered.date).format('MMM D, YYYY')}
						</div>
						{Object.entries(hovered.models || {})
							.sort(([, a], [, b]) => b - a)
							.slice(0, 5)
							.map(([name, count]) => (
								<div key={name} className="flex items-center justify-between gap-2 py-0.5">
									<span className="text-muted-foreground min-w-0 truncate">{name}</span>
									<span className="shrink-0 tabular-nums">
										{count.toLocaleString()} <span className="text-muted-foreground">({total > 0 ? ((count / total) * 100).toFixed(0) : 0}%)</span>
									</span>
								</div>
							))}
					</div>
				</div>
			)}
		</div>
	);
}
