import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { toastFailure } from '@/components/common/failureToast';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
	type CalendarEventModel,
	type CalendarModel,
	createCalendar,
	createCalendarEvent,
	deleteCalendarEvent,
	getCalendarEventById,
	updateCalendar,
	updateCalendarEvent
} from '@/lib/apis/calendar';
import { useAuthStore } from '@/lib/stores/authStore';
import { seriesHexes } from '@/lib/ui/tokenColour';
import { useFieldErrors } from '@/lib/ui/useFieldErrors';
import { cn } from '@/lib/utils';
import {
	CUSTOM_REPEAT,
	calendarColour,
	EVENT_FIELDS,
	type EventFields,
	eventFields,
	eventPayload,
	eventProblems,
	firstFreeColour,
	reminderOptions,
	repeatFromRrule,
	SCHEDULED_TASKS_ID,
	withStart
} from './calendarModel';

/** The Select's value for "No repeat": a Radix item cannot have an empty value. */
const NO_REPEAT = 'none';

const REPEATS: [string, string][] = [
	[NO_REPEAT, 'No repeat'],
	['daily', 'Daily'],
	['weekdays', 'Monday to Friday'],
	['weekly', 'Weekly'],
	['monthly', 'Monthly'],
	['yearly', 'Yearly']
];

/**
 * Ports components/calendar/CalendarEventModal.svelte: create or edit an event.
 * Rules (defaults, the payload, the problems) in calendarModel.ts.
 *
 * A visible title says which (#1105); the start and the end are two lines, a
 * date and a time each, with All day beside the heading. Moving the start
 * moves the end with it (#966), and an end that is not after the start is an
 * error under the end, never rewritten (FRM-2). The Svelte form never showed
 * an end *date* input, so a multi-day event could not be made or kept from
 * the form; this one shows it.
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
	const { errors, field, submit, reset } = useFieldErrors(eventProblems(f), EVENT_FIELDS);
	const set = (patch: Partial<EventFields>) => setF((prev) => ({ ...prev, ...patch }));
	const moveStart = (patch: Partial<Pick<EventFields, 'startDate' | 'startTime'>>) =>
		setF((prev) => withStart(prev, patch));
	const editing = event && !event.meta?.automation_id ? event : null;
	// An occurrence of a repeating event: saving or deleting it acts on the series.
	const occurrence = Boolean(editing?.instance_id);
	const endField = field('end');

	// Seeded once each time the dialog opens (during render, so it never shows the last event's values).
	const [seeded, setSeeded] = useState(false);
	if (open !== seeded) {
		setSeeded(open);
		if (open) {
			setF(eventFields(event, defaultCalendarId, defaultStartAt));
			reset();
		}
	}

	const save = async () => {
		if (!submit()) return;
		const checked = eventPayload(f, editing);
		if ('error' in checked) return;
		setLoading(true);
		try {
			let out = checked;
			if (editing && occurrence) {
				const series = await getCalendarEventById(token, editing.id);
				const shifted = eventPayload(f, editing, series.start_at);
				if ('form' in shifted) out = shifted;
			}
			const res = editing
				? await updateCalendarEvent(token, editing.id, out.form)
				: await createCalendarEvent(token, out.form);
			if (res) {
				toast.success(editing ? 'Event saved' : 'Event created');
				onSaved();
				onOpenChange(false);
			}
		} catch (err) {
			toastFailure(editing ? 'Couldn’t save the event' : 'Couldn’t create the event', err);
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
			toastFailure('Couldn’t delete the event', err);
		} finally {
			setLoading(false);
		}
	};

	const reminderValues = reminderOptions(f.alertMinutes, Math.max(event?.meta?.alert_minutes ?? 10, -1));

	return (
		<>
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={editing?.rrule ? 'Delete repeating event' : 'Delete event'}
				confirmLabel="Delete event"
				destructive
				onConfirm={remove}
			>
				{editing?.rrule
					? `This deletes every occurrence of “${editing.title}”, not just this one. This can’t be undone.`
					: `Delete “${editing?.title ?? ''}”? This can’t be undone.`}
			</ConfirmDialog>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
					<DialogHeader>
						<DialogTitle className="text-title font-title tracking-tight">
							{editing ? 'Edit event' : 'New event'}
						</DialogTitle>
						<DialogDescription className="sr-only">
							{editing ? 'Change this event.' : 'Add an event to a calendar.'}
						</DialogDescription>
					</DialogHeader>
					<form
						noValidate
						className="flex flex-col gap-4"
						onSubmit={(e) => {
							e.preventDefault();
							save();
						}}
					>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="event-title">Title</Label>
							<Input
								id="event-title"
								value={f.title}
								{...field('title')}
								{...fieldProps('event-title-message', { error: errors.title })}
								onChange={(e) => set({ title: e.target.value })}
							/>
							<FieldMessage id="event-title-message" error={errors.title} />
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="event-calendar">Calendar</Label>
							<Select value={f.calendarId} onValueChange={(v) => set({ calendarId: v })}>
								<SelectTrigger id="event-calendar" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{calendars
										.filter((c) => c.id !== SCHEDULED_TASKS_ID)
										.map((c) => (
											<SelectItem key={c.id} value={c.id}>
												<span
													aria-hidden
													className="size-2.5 rounded-sm"
													style={{ backgroundColor: calendarColour(c) }}
												/>
												{c.name}
											</SelectItem>
										))}
								</SelectContent>
							</Select>
						</div>
						<fieldset className="flex flex-col gap-2">
							<legend className="sr-only">When</legend>
							<div className="flex items-center justify-between gap-3">
								<span aria-hidden className="text-sm leading-none font-medium">
									When
								</span>
								<Label className="font-normal">
									<Checkbox checked={f.allDay} onCheckedChange={(v) => set({ allDay: v === true })} />
									All day
								</Label>
							</div>
							<div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
								<span aria-hidden className="text-foreground-muted">
									Starts
								</span>
								<Input
									type="date"
									aria-label="Start date"
									className={cn(f.allDay && 'col-span-2')}
									value={f.startDate}
									{...field('start')}
									{...fieldProps('event-start-message', { error: errors.start })}
									onChange={(e) => moveStart({ startDate: e.target.value })}
								/>
								{!f.allDay && (
									<Input
										type="time"
										aria-label="Start time"
										value={f.startTime}
										onChange={(e) => moveStart({ startTime: e.target.value })}
									/>
								)}
								<span aria-hidden className="text-foreground-muted">
									Ends
								</span>
								<Input
									type="date"
									aria-label="End date"
									className={cn(f.allDay && 'col-span-2')}
									value={f.endDate}
									{...endField}
									{...fieldProps('event-end-message', { error: errors.end })}
									onChange={(e) => set({ endDate: e.target.value })}
								/>
								{!f.allDay && (
									<Input
										type="time"
										aria-label="End time"
										value={f.endTime}
										onBlur={endField.onBlur}
										{...fieldProps('event-end-message', { error: errors.end })}
										onChange={(e) => set({ endTime: e.target.value })}
									/>
								)}
							</div>
							<FieldMessage id="event-start-message" error={errors.start} />
							<FieldMessage id="event-end-message" error={errors.end} />
						</fieldset>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="event-location">Location (optional)</Label>
							<Input id="event-location" value={f.location} onChange={(e) => set({ location: e.target.value })} />
						</div>
						<div className="grid gap-3 sm:grid-cols-2">
							<div className="flex min-w-0 flex-col gap-1.5">
								<Label htmlFor="event-reminder">Reminder</Label>
								<Select value={String(f.alertMinutes)} onValueChange={(v) => set({ alertMinutes: Number(v) })}>
									<SelectTrigger id="event-reminder" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{reminderValues.map(([v, l]) => (
											<SelectItem key={v} value={String(v)}>
												{l}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="flex min-w-0 flex-col gap-1.5">
								<Label htmlFor="event-repeat">Repeat</Label>
								<Select value={f.repeat || NO_REPEAT} onValueChange={(v) => set({ repeat: v === NO_REPEAT ? '' : v })}>
									<SelectTrigger id="event-repeat" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{REPEATS.map(([v, l]) => (
											<SelectItem key={v} value={v}>
												{l}
											</SelectItem>
										))}
										{/* Only for an event that has one: it keeps the stored rule (#510). */}
										{editing && repeatFromRrule(editing.rrule) === CUSTOM_REPEAT && (
											<SelectItem value={CUSTOM_REPEAT}>Custom rule</SelectItem>
										)}
									</SelectContent>
								</Select>
							</div>
						</div>
						{occurrence && (
							<p className="text-foreground-muted text-dense">
								This is one occurrence of a repeating event: changes apply to every occurrence.
							</p>
						)}
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="event-description">Description (optional)</Label>
							<Textarea
								id="event-description"
								rows={3}
								value={f.description}
								onChange={(e) => set({ description: e.target.value })}
							/>
						</div>
						<DialogFooter>
							{editing && (
								<Button
									type="button"
									variant="destructive"
									className="sm:mr-auto"
									disabled={loading}
									onClick={() => setConfirmDelete(true)}
								>
									Delete event
								</Button>
							)}
							<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={loading} aria-busy={loading || undefined}>
								{loading && <Spinner className="size-3.5" />}
								{loading ? 'Saving…' : editing ? 'Save event' : 'Create event'}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** The six series tokens' names, in order, for the colour presets' accessible names. */
const SERIES_NAMES = ['Blue', 'Yellow', 'Pink', 'Green', 'Orange', 'Violet'];

/**
 * Ports components/calendar/CreateCalendarModal.svelte, and edits a calendar
 * too (#1106): a name and a colour. The preset colours are the six
 * chart-series tokens' values in the current theme (#989, decision D1b); a new
 * calendar starts on the first one no calendar is drawn in, so it never looks
 * like Personal. The colour is saved as hex: the API stores a colour string,
 * and the custom colour input only takes hex.
 */
export function CalendarDialog({
	open,
	onOpenChange,
	calendar = null,
	calendars,
	onSaved
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The calendar to edit; none to create one. */
	calendar?: CalendarModel | null;
	calendars: CalendarModel[];
	onSaved: () => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [name, setName] = useState('');
	const [presets, setPresets] = useState(seriesHexes);
	const [color, setColor] = useState(presets[0]);
	const [loading, setLoading] = useState(false);
	const [nameError, setNameError] = useState<string | null>(null);
	const nameField = useRef<HTMLInputElement>(null);

	// Seeded once each time the dialog opens, from what is stored then.
	const [seeded, setSeeded] = useState(false);
	if (open !== seeded) {
		setSeeded(open);
		if (open) {
			const now = seriesHexes();
			setName(calendar?.name ?? '');
			setNameError(null);
			setPresets(now);
			setColor(calendar ? calendar.color || now[0] : firstFreeColour(now, calendars));
		}
	}

	const save = async () => {
		if (!name.trim()) {
			setNameError('Enter a name for the calendar');
			nameField.current?.focus();
			return;
		}
		setLoading(true);
		try {
			const form = { name: name.trim(), color };
			const res = calendar ? await updateCalendar(token, calendar.id, form) : await createCalendar(token, form);
			if (res) {
				toast.success(calendar ? 'Calendar saved' : 'Calendar created');
				onSaved();
				onOpenChange(false);
			}
		} catch (err) {
			toastFailure(calendar ? 'Couldn’t save the calendar' : 'Couldn’t create the calendar', err);
		} finally {
			setLoading(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle className="text-title font-title tracking-tight">
						{calendar ? 'Edit calendar' : 'New calendar'}
					</DialogTitle>
					<DialogDescription className="sr-only">
						{calendar ? 'Rename or recolour this calendar.' : 'Create a calendar.'}
					</DialogDescription>
				</DialogHeader>
				<form
					noValidate
					className="flex flex-col gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						save();
					}}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="calendar-name">Name</Label>
						<Input
							id="calendar-name"
							ref={nameField}
							value={name}
							{...fieldProps('calendar-name-message', { error: nameError })}
							onChange={(e) => {
								setName(e.target.value);
								if (e.target.value.trim()) setNameError(null);
							}}
						/>
						<FieldMessage id="calendar-name-message" error={nameError} />
					</div>
					<fieldset>
						<legend className="mb-1.5 text-sm leading-none font-medium">Colour</legend>
						<div className="flex flex-wrap items-center gap-2">
							{presets.map((c, i) => (
								<Button
									key={c}
									type="button"
									variant="ghost"
									size="icon-xs"
									aria-label={SERIES_NAMES[i] ?? c}
									aria-pressed={color === c}
									className={cn('rounded-full border-2', color === c ? 'border-foreground' : 'border-transparent')}
									style={{ backgroundColor: c }}
									onClick={() => setColor(c)}
								/>
							))}
							<label
								title="Custom colour"
								className={cn(
									'relative size-6 cursor-pointer overflow-hidden rounded-full border-2',
									!presets.includes(color) ? 'border-foreground' : 'border-transparent'
								)}
								style={{ backgroundColor: color }}
							>
								<input
									type="color"
									aria-label="Custom colour"
									className="absolute size-0 opacity-0"
									value={color}
									onChange={(e) => setColor(e.target.value)}
								/>
							</label>
						</div>
					</fieldset>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={loading} aria-busy={loading || undefined}>
							{loading && <Spinner className="size-3.5" />}
							{loading ? 'Saving…' : calendar ? 'Save calendar' : 'Create calendar'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
