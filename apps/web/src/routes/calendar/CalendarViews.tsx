import { type KeyboardEvent, useMemo } from 'react';
import type { CalendarEventModel, CalendarModel } from '@/lib/apis/calendar';
import { Tip } from '@/components/common/Tip';
import { cn } from '@/lib/utils';
import { type CalendarViewMode, DAY_NAMES, NS, dayKey, eventsByDay, eventsInHour, formatHour, isSameDay, monthGrid, nsAt, weekDays } from './calendarModel';

const HOURS = Array.from({ length: 24 }, (_, i) => i);

/** One event in a grid cell: a colored dot, the start time (unless all-day), the title. Automation runs are dimmed. */
function EventChip({ event, color, onClick }: { event: CalendarEventModel; color: string | null | undefined; onClick: (e: CalendarEventModel) => void }) {
	const time = event.all_day ? null : new Date(event.start_at / NS).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(' ', '');
	return (
		<Tip content={`${event.title}${event.location ? ` · ${event.location}` : ''}`}>
			<button
				type="button"
				className={cn('hover:bg-muted flex w-full items-start gap-1.5 truncate rounded-md px-0.5 text-left text-xs transition', event.meta?.automation_id && 'opacity-60')}
				onClick={(e) => {
					e.stopPropagation();
					onClick(event);
				}}
			>
				<span className="mt-[0.3125rem] size-[0.4375rem] shrink-0 rounded-full" style={{ backgroundColor: event.color || color || '#3b82f6' }} />
				<span className="truncate">
					{time && <span className="text-muted-foreground">{time} </span>}
					{event.title}
				</span>
			</button>
		</Tip>
	);
}

function More({ count, onClick }: { count: number; onClick: () => void }) {
	return (
		<button
			type="button"
			className="text-muted-foreground hover:text-foreground mt-auto w-full truncate px-1 text-left text-[0.625rem]"
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
		>
			+{count} more
		</button>
	);
}

/**
 * Ports components/calendar/CalendarView.svelte: the month grid, the week and
 * day hour grids. Clicking empty space asks for a new event there (9 AM for a
 * day in the month grid); "+N more" opens that day.
 *
 * A grid cell is a `div` with `role="button"` rather than a `<button>`, because
 * it contains the event chips, which are buttons themselves (the Svelte markup
 * nests buttons, which is invalid HTML).
 */
export function CalendarViews({
	view,
	date,
	events,
	calendars,
	onCreate,
	onEventClick,
	onOpenDay
}: {
	view: CalendarViewMode;
	date: Date;
	events: CalendarEventModel[];
	calendars: CalendarModel[];
	onCreate: (startNs: number) => void;
	onEventClick: (e: CalendarEventModel) => void;
	onOpenDay: (day: Date) => void;
}) {
	const colors = useMemo(() => Object.fromEntries(calendars.map((c) => [c.id, c.color])), [calendars]);
	const byDay = useMemo(() => eventsByDay(events), [events]);
	const today = new Date();
	const chip = (e: CalendarEventModel) => <EventChip key={e.instance_id || e.id} event={e} color={colors[e.calendar_id]} onClick={onEventClick} />;
	const cell = (label: string, onActivate: () => void) => ({
		role: 'button' as const,
		tabIndex: 0,
		'aria-label': label,
		onClick: onActivate,
		onKeyDown: (e: KeyboardEvent) => {
			if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
				e.preventDefault();
				onActivate();
			}
		}
	});

	if (view === 'month') {
		return (
			<div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
				<div className="grid grid-cols-7">
					{DAY_NAMES.map((d) => (
						<div key={d} className="text-muted-foreground truncate px-2 py-1.5 text-xs">
							{d}
						</div>
					))}
				</div>
				<div className="bg-background grid min-h-0 flex-1 auto-rows-fr grid-cols-7 overflow-hidden rounded-2xl border">
					{monthGrid(date).map((day, i) => {
						const dayEvents = byDay[dayKey(day)] ?? [];
						return (
							<div
								key={day.toISOString()}
								{...cell(`New event on ${day.toDateString()}`, () => onCreate(nsAt(day, 9)))}
								className={cn('hover:bg-muted/50 flex min-h-0 cursor-pointer flex-col overflow-hidden p-1 text-left transition', day.getMonth() !== date.getMonth() && 'opacity-40', i % 7 > 0 && 'border-l', i >= 7 && 'border-t')}
							>
								<span className={cn('mb-0.5 flex size-6 items-center justify-center rounded-full text-xs', isSameDay(day, today) ? 'bg-blue-500 text-white' : 'text-muted-foreground')}>{day.getDate()}</span>
								<div className="flex flex-1 flex-col overflow-hidden">
									{dayEvents.slice(0, 3).map(chip)}
									{dayEvents.length > 3 && <More count={dayEvents.length - 3} onClick={() => onOpenDay(day)} />}
								</div>
							</div>
						);
					})}
				</div>
			</div>
		);
	}

	const days = view === 'week' ? weekDays(date) : [date];
	return (
		<div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
			<div className="bg-background flex-1 overflow-auto rounded-2xl border">
				<div className={cn('flex flex-col', view === 'week' && 'min-w-[43.75rem]')}>
					{view === 'week' && (
						<div className="bg-background sticky top-0 z-10 grid grid-cols-[52px_repeat(7,1fr)] border-b">
							<div />
							{days.map((day) => (
								<div key={day.toISOString()} className={cn('py-2.5 text-center', day.getDay() > 0 && 'border-l')}>
									<div className="text-muted-foreground text-[0.6875rem]">{DAY_NAMES[day.getDay()]}</div>
									<div className={cn('mx-auto mt-0.5 flex size-7 items-center justify-center rounded-full text-sm', isSameDay(day, today) && 'bg-blue-500 text-white')}>{day.getDate()}</div>
								</div>
							))}
						</div>
					)}
					{HOURS.map((hour) => (
						<div key={hour} className={cn('grid min-h-[3.25rem]', view === 'week' ? 'grid-cols-[52px_repeat(7,1fr)]' : 'grid-cols-[56px_1fr]', hour > 0 && 'border-t border-border/50')}>
							<div className="text-muted-foreground pt-1 pr-2 text-right text-[0.625rem] select-none">{view === 'day' || hour > 0 ? formatHour(hour) : ''}</div>
							{days.map((day) => {
								const hourEvents = eventsInHour(events, day, hour);
								const shown = view === 'week' ? hourEvents.slice(0, 3) : hourEvents;
								return (
									<div key={day.toISOString()} {...cell(`New event ${day.toDateString()} ${formatHour(hour)}`, () => onCreate(nsAt(day, hour)))} className="hover:bg-muted/40 flex min-w-0 cursor-pointer flex-col gap-0.5 border-l border-border/50 p-0.5 transition">
										{shown.map(chip)}
										{view === 'week' && hourEvents.length > 3 && <More count={hourEvents.length - 3} onClick={() => onOpenDay(day)} />}
									</div>
								);
							})}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
