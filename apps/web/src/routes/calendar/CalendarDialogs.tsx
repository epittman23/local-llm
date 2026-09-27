import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { type CalendarEventModel, type CalendarModel, createCalendar, createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from '@/lib/apis/calendar';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { type EventFields, SCHEDULED_TASKS_ID, eventFields, eventPayload } from './calendarModel';

const bare = 'w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground/50';
const label = 'text-muted-foreground mb-1 text-xs';
const select = 'w-full cursor-pointer bg-transparent text-sm outline-hidden [&>option]:bg-popover';

const REMINDERS: [number, string][] = [
	[-1, 'None'],
	[0, 'At time of event'],
	[5, '5 minutes before'],
	[10, '10 minutes before'],
	[15, '15 minutes before'],
	[30, '30 minutes before'],
	[60, '1 hour before']
];
const REPEATS: [string, string][] = [
	['', 'No Repeat'],
	['daily', 'Daily'],
	['weekdays', 'Monday – Friday'],
	['weekly', 'Weekly'],
	['monthly', 'Monthly'],
	['yearly', 'Yearly']
];

/**
 * Ports components/calendar/CalendarEventModal.svelte: create or edit an event.
 * Rules (defaults, the payload, an end before the start) in calendarModel.ts.
 * The Svelte form never showed an end *date* input, so a multi-day event
 * could not be made or kept from the form; this one shows it.
 */
export function EventDialog({
	open,
	onOpenChange,
	event,
	calendars,
	defaultCalendarId,
	defaultStartAt,
	onSaved
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	event: CalendarEventModel | null;
	calendars: CalendarModel[];
	defaultCalendarId: string;
	defaultStartAt: number | null;
	onSaved: () => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [f, setF] = useState<EventFields>(() => eventFields(null, defaultCalendarId, null));
	const [loading, setLoading] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const set = (patch: Partial<EventFields>) => setF((prev) => ({ ...prev, ...patch }));
	const editing = event && !event.meta?.automation_id ? event : null;

	useEffect(() => {
		if (open) setF(eventFields(event, defaultCalendarId, defaultStartAt));
		// Seeded when the dialog opens.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const save = async () => {
		const out = eventPayload(f, editing);
		if ('error' in out) return void toast.error(out.error);
		setLoading(true);
		try {
			const res = editing ? await updateCalendarEvent(token, editing.id, out.form) : await createCalendarEvent(token, out.form);
			if (res) {
				toast.success(editing ? 'Event updated' : 'Event created');
				onSaved();
				onOpenChange(false);
			}
		} catch (err) {
			toast.error(`${err}`);
		} finally {
			setLoading(false);
		}
	};

	const remove = async () => {
		if (!editing) return;
		setLoading(true);
		try {
			await deleteCalendarEvent(token, editing.id);
			toast.success('Event deleted');
			onSaved();
			onOpenChange(false);
		} catch (err) {
			toast.error(`${err}`);
		} finally {
			setLoading(false);
		}
	};

	return (
		<>
			<ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete Event" confirmLabel="Delete" onConfirm={remove}>
				This action cannot be undone. Do you wish to continue?
			</ConfirmDialog>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle className="sr-only">{editing ? 'Edit event' : 'New event'}</DialogTitle>
						<DialogDescription className="sr-only">A calendar event.</DialogDescription>
					</DialogHeader>
					<form
						className="flex flex-col gap-2.5"
						onSubmit={(e) => {
							e.preventDefault();
							save();
						}}
					>
						<input className={cn(bare, 'text-base')} aria-label="Event title" placeholder="Event title" value={f.title} onChange={(e) => set({ title: e.target.value })} />
						<div>
							<label className={label} htmlFor="event-calendar">
								Calendar
							</label>
							<select id="event-calendar" className={select} value={f.calendarId} onChange={(e) => set({ calendarId: e.target.value })}>
								{calendars
									.filter((c) => c.id !== SCHEDULED_TASKS_ID)
									.map((c) => (
										<option key={c.id} value={c.id}>
											{c.name}
										</option>
									))}
							</select>
						</div>
						<div>
							<div className={label}>When</div>
							<div className="flex flex-wrap items-center gap-2 text-sm">
								<input type="date" aria-label="Start date" className="bg-transparent outline-hidden dark:[color-scheme:dark]" value={f.startDate} onChange={(e) => set({ startDate: e.target.value })} />
								{!f.allDay && <input type="time" aria-label="Start time" className="bg-transparent outline-hidden dark:[color-scheme:dark]" value={f.startTime} onChange={(e) => set({ startTime: e.target.value })} />}
								<span className="text-muted-foreground">–</span>
								<input type="date" aria-label="End date" className="bg-transparent outline-hidden dark:[color-scheme:dark]" value={f.endDate} onChange={(e) => set({ endDate: e.target.value })} />
								{!f.allDay && <input type="time" aria-label="End time" className="bg-transparent outline-hidden dark:[color-scheme:dark]" value={f.endTime} onChange={(e) => set({ endTime: e.target.value })} />}
								<label className="text-muted-foreground ml-auto flex cursor-pointer items-center gap-1.5 text-xs">
									<input type="checkbox" className="accent-blue-500" checked={f.allDay} onChange={(e) => set({ allDay: e.target.checked })} />
									All day
								</label>
							</div>
						</div>
						<div>
							<label className={label} htmlFor="event-location">
								Location
							</label>
							<input id="event-location" className={bare} placeholder="Add location" value={f.location} onChange={(e) => set({ location: e.target.value })} />
						</div>
						<div className="flex gap-3">
							<div className="flex-1">
								<label className={label} htmlFor="event-reminder">
									Reminder
								</label>
								<select id="event-reminder" className={select} value={f.alertMinutes} onChange={(e) => set({ alertMinutes: Number(e.target.value) })}>
									{REMINDERS.map(([v, l]) => (
										<option key={v} value={v}>
											{l}
										</option>
									))}
								</select>
							</div>
							<div className="flex-1">
								<label className={label} htmlFor="event-repeat">
									Repeat
								</label>
								<select id="event-repeat" className={select} value={f.repeat} onChange={(e) => set({ repeat: e.target.value })}>
									{REPEATS.map(([v, l]) => (
										<option key={v} value={v}>
											{l}
										</option>
									))}
								</select>
							</div>
						</div>
						<div>
							<label className={label} htmlFor="event-description">
								Description
							</label>
							<textarea id="event-description" className={cn(bare, 'min-h-16 resize-none')} rows={3} placeholder="Add description" value={f.description} onChange={(e) => set({ description: e.target.value })} />
						</div>
						<div className="flex items-center justify-between gap-2 pt-1">
							<div>
								{editing && (
									<Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => setConfirmDelete(true)}>
										Delete
									</Button>
								)}
							</div>
							<div className="flex items-center gap-2">
								<Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
									Cancel
								</Button>
								<Button type="submit" size="sm" disabled={loading}>
									{editing ? 'Save' : 'Create'}
									{loading && <Spinner className="size-3.5" />}
								</Button>
							</div>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

const PRESET_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];

/** Ports components/calendar/CreateCalendarModal.svelte: a name and a color. */
export function CreateCalendarDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [name, setName] = useState('');
	const [color, setColor] = useState(PRESET_COLORS[0]);
	const [loading, setLoading] = useState(false);
	useEffect(() => {
		if (!open) return;
		setName('');
		setColor(PRESET_COLORS[0]);
	}, [open]);

	const create = async () => {
		if (!name.trim()) return void toast.error('Name is required');
		setLoading(true);
		try {
			const res = await createCalendar(token, { name: name.trim(), color });
			if (res) {
				toast.success('Calendar created');
				onCreated();
				onOpenChange(false);
			}
		} catch (err) {
			toast.error(`${err}`);
		} finally {
			setLoading(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle className="text-base font-normal">New Calendar</DialogTitle>
					<DialogDescription className="sr-only">Create a calendar.</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						create();
					}}
				>
					<div>
						<label className={label} htmlFor="calendar-name">
							Name
						</label>
						<input id="calendar-name" className={cn(bare, 'rounded-lg border px-2.5 py-1.5')} placeholder="Calendar name" value={name} onChange={(e) => setName(e.target.value)} />
					</div>
					<div>
						<div className={label}>Color</div>
						<div className="flex flex-wrap items-center gap-2">
							{PRESET_COLORS.map((c) => (
								<button key={c} type="button" aria-label={c} aria-pressed={color === c} className={cn('size-6 rounded-full border-2 transition-all', color === c ? 'border-foreground scale-110' : 'border-transparent hover:scale-110')} style={{ backgroundColor: c }} onClick={() => setColor(c)} />
							))}
							<label
								title="Custom color"
								className={cn('relative size-6 cursor-pointer overflow-hidden rounded-full border-2 transition-all', !PRESET_COLORS.includes(color) ? 'border-foreground scale-110' : 'border-transparent hover:scale-110')}
								style={{ backgroundColor: color }}
							>
								<input type="color" aria-label="Custom color" className="absolute size-0 opacity-0" value={color} onChange={(e) => setColor(e.target.value)} />
							</label>
						</div>
					</div>
					<div className="flex justify-end gap-2 pt-1">
						<Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" size="sm" disabled={loading}>
							Create
							{loading && <Spinner className="size-3.5" />}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
