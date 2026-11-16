import { Bold, Code, Italic, Link2, Strikethrough } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { CalendarEventModel } from '@/lib/apis/calendar';
import { formatChord } from '@/lib/shortcuts';
import { useToolbarKeys } from '@/lib/ui/useToolbarKeys';
import { cn } from '@/lib/utils';
import { useRovingDays } from '@/routes/calendar/CalendarViews';
import {
	dayKey,
	dayName,
	formatHour,
	isSameDay,
	layoutDay,
	localeWeekStart,
	monthGrid,
	monthLabel,
	NS,
	nsAt,
	timeRange,
	weekdayName
} from '@/routes/calendar/calendarModel';

// Demos for the standard's section 6 additions (Notes, Calendar, Automations):
// a highlight (CNT-1), a toggle group (COL-4), a time grid (DAT-7), and a
// toolbar and a grid of days that are each one tab stop (NAV-5).

/** CNT-1: a highlight reads like the text around it, `--highlight` under `--highlight-foreground`. */
export function HighlightDemo() {
	return (
		<p className="rich-text max-w-[72ch]">
			The sample mean is an unbiased estimator, and <mark>its variance falls as one over n</mark>, which is why a larger
			sample narrows the confidence interval.
		</p>
	);
}

const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

/** COL-4: a pressed toggle is the brand fill with `aria-pressed`; an unpressed one the outline Button. */
export function WeekdayTogglesDemo() {
	const [days, setDays] = useState<string[]>(['MO', 'WE', 'FR']);
	return (
		<fieldset className="flex min-w-0 flex-wrap gap-1">
			<legend className="sr-only">Days</legend>
			{DAYS.map((d, i) => {
				const on = days.includes(d);
				// 2024-01-01 was a Monday.
				const name = new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' });
				return (
					<Button
						key={d}
						type="button"
						variant={on ? 'default' : 'outline'}
						size="sm"
						aria-pressed={on}
						className="min-w-11"
						onClick={() => setDays(on ? days.filter((x) => x !== d) : [...days, d])}
					>
						{name}
					</Button>
				);
			})}
		</fieldset>
	);
}

// A fixed day, so the sample looks the same whenever it is opened.
const DAY = new Date(2026, 10, 16);
const FIRST_HOUR = 8;
const HOURS = [8, 9, 10, 11, 12];
const HOUR_PX = 48;

const event = (id: string, title: string, start: number, end: number): CalendarEventModel => ({
	id,
	calendar_id: 'demo',
	user_id: 'demo',
	title,
	description: null,
	start_at: nsAt(DAY, 0) + start * 60 * 60 * 1000 * NS,
	end_at: nsAt(DAY, 0) + end * 60 * 60 * 1000 * NS,
	all_day: false,
	rrule: null,
	color: null,
	location: null,
	data: null,
	meta: null,
	is_cancelled: false,
	attendees: [],
	created_at: 0,
	updated_at: 0
});

const EVENTS = [
	event('a', 'Stats reading group', 9, 10.5),
	event('b', 'Review the regression', 9.5, 11),
	event('c', 'Stand-up', 11.5, 11.75)
];

/** DAT-7: blocks placed by `layoutDay`, as tall as they are long, overlaps side by side, and a now-line. */
export function TimeGridDemo() {
	const top = (minutes: number) => (minutes - FIRST_HOUR * 60) * (HOUR_PX / 60);
	const minMinutes = Math.ceil((24 / HOUR_PX) * 60);
	return (
		<div
			role="img"
			aria-label="A morning on the time grid: two events overlapping at 9:30, side by side, a short stand-up at 11:30, and the now-line at 10:40"
			className="bg-background grid max-w-[28rem] grid-cols-[3.5rem_minmax(0,1fr)] overflow-hidden rounded-panel border"
		>
			<div className="relative" style={{ height: HOURS.length * HOUR_PX }}>
				{HOURS.map((h, i) => (
					<div
						key={h}
						className="text-foreground-muted absolute right-2 text-caption select-none"
						style={{ top: i * HOUR_PX + 2 }}
					>
						{formatHour(h)}
					</div>
				))}
			</div>
			<div data-today="" className="bg-surface-1 relative border-l" style={{ height: HOURS.length * HOUR_PX }}>
				{HOURS.map((h, i) => (
					<div key={h} className={i > 0 ? 'absolute inset-x-0 border-t' : undefined} style={{ top: i * HOUR_PX }} />
				))}
				{layoutDay(EVENTS, DAY, minMinutes).map((p) => {
					const short = p.height * (HOUR_PX / 60) < 40;
					return (
						<div
							key={p.event.id}
							data-block=""
							className={`text-foreground-strong absolute flex overflow-hidden border-l-4 px-1.5 py-0.5 text-dense ${short ? 'items-center gap-1.5' : 'flex-col'}`}
							style={{
								top: top(p.top),
								height: Math.max(p.height * (HOUR_PX / 60) - 1, 24),
								left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
								width: `calc(${100 / p.cols}% - 4px)`,
								backgroundColor: 'color-mix(in srgb, var(--series-1) 24%, var(--surface-1))',
								borderLeftColor: 'var(--series-1)'
							}}
						>
							<span className="min-w-0 truncate font-strong">{p.event.title}</span>
							<span className="min-w-0 truncate text-caption">{timeRange(p.event)}</span>
						</div>
					);
				})}
				<div data-now="" className="bg-brand absolute inset-x-0 h-0.5" style={{ top: top(10 * 60 + 40) }}>
					<span className="bg-brand absolute -top-1 -left-1 size-2.5 rounded-full" />
				</div>
			</div>
		</div>
	);
}

const TOOLS = [
	{ label: 'Bold', chord: 'Cmd+B', icon: Bold },
	{ label: 'Italic', chord: 'Cmd+I', icon: Italic },
	{ label: 'Strikethrough', chord: 'Cmd+Shift+S', icon: Strikethrough },
	{ label: 'Code', chord: 'Cmd+E', icon: Code },
	{ label: 'Link', chord: 'Cmd+K', icon: Link2 }
];

/** NAV-5: a toolbar is one tab stop; the arrow keys, Home and End move between tools, Escape returns to the text. */
export function ToolbarDemo() {
	const text = useRef<HTMLTextAreaElement>(null);
	const toolbar = useToolbarKeys(() => text.current?.focus());
	const [on, setOn] = useState<string[]>(['Bold']);
	return (
		<div className="flex max-w-[28rem] flex-col gap-1">
			<div {...toolbar} role="toolbar" aria-label="Formatting" className="flex items-center gap-0.5 [&_svg]:size-4">
				{TOOLS.map(({ label, chord, icon: Icon }) => {
					const pressed = on.includes(label);
					return (
						<Tip key={label} content={`${label}, ${formatChord(chord)}`}>
							<Button
								type="button"
								variant={pressed ? 'secondary' : 'ghost'}
								size="icon-sm"
								data-tool=""
								aria-label={label}
								aria-pressed={pressed}
								onClick={() => setOn(pressed ? on.filter((x) => x !== label) : [...on, label])}
							>
								<Icon />
							</Button>
						</Tip>
					);
				})}
			</div>
			<Textarea
				ref={text}
				aria-label="Sample text"
				defaultValue="The variance of the sample mean falls as one over n."
			/>
		</div>
	);
}

/** NAV-5: a grid of days is one tab stop; the arrows move a day or a week, Home and End the week's ends, and the edge pages the month. */
export function DayGridDemo() {
	const [chosen, setChosen] = useState(DAY);
	const [month, setMonth] = useState(() => new Date(DAY.getFullYear(), DAY.getMonth(), 1));
	const weekStart = useMemo(() => localeWeekStart(), []);
	const days = useMemo(() => monthGrid(month, weekStart), [month, weekStart]);
	const roving = useRovingDays(days, chosen, (d) => setMonth(new Date(d.getFullYear(), d.getMonth(), 1)));
	return (
		<div className="w-56">
			<div className="text-body font-strong mb-1 px-1">{monthLabel(month)}</div>
			<div aria-hidden className="text-foreground-muted grid grid-cols-7 text-center text-caption">
				{days.slice(0, 7).map((d) => (
					<div key={dayKey(d)} className="py-0.5">
						{weekdayName(d, 'narrow')}
					</div>
				))}
			</div>
			<div className="grid grid-cols-7 justify-items-center text-caption">
				{days.map((day) => (
					<Button
						key={dayKey(day)}
						{...roving(day)}
						type="button"
						variant={isSameDay(day, chosen) ? 'secondary' : 'ghost'}
						size="icon-xs"
						aria-label={dayName(day)}
						aria-current={isSameDay(day, chosen) ? 'true' : undefined}
						className={cn(
							'rounded-full text-caption font-normal',
							day.getMonth() !== month.getMonth() && 'text-foreground-muted'
						)}
						onClick={() => setChosen(day)}
					>
						{day.getDate()}
					</Button>
				))}
			</div>
		</div>
	);
}
