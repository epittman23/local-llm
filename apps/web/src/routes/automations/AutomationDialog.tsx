import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Folder as FolderIcon, Hash, MessageSquare, X } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { EditorError, type EditorProblem } from '@/components/common/EditorError';
import { failureCause } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { getModels } from '@/lib/apis';
import { type AutomationResponse, createAutomation, updateAutomationById } from '@/lib/apis/automations';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useFieldErrors } from '@/lib/ui/useFieldErrors';
import { useUnsavedChanges } from '@/lib/ui/useUnsavedChanges';
import { cn } from '@/lib/utils';
import { initialModel } from '@/routes/playground/playgroundModel';
import {
	AUTOMATION_FIELDS,
	type AutomationFields,
	automationFields,
	automationPayload,
	automationProblems,
	buildRrule,
	type Channel,
	channelOptions,
	type Folder,
	type Frequency,
	folderOptions,
	folderPath,
	localDate,
	localTimeZone,
	previewRuns,
	RULE_HELP,
	ruleProblemFromServer,
	runTimeText,
	type Schedule,
	timeFromInput,
	WEEKDAYS,
	withFrequency,
	withoutMissingDestinations
} from './automationModel';
import { useDestinations } from './useDestinations';

const FREQUENCIES: [Frequency, string][] = [
	['MINUTELY', 'Every few minutes'],
	['HOURLY', 'Hourly'],
	['DAILY', 'Daily'],
	['WEEKDAYS', 'Weekdays'],
	['WEEKLY', 'Weekly'],
	['MONTHLY', 'Monthly'],
	['ONCE', 'Once'],
	['CUSTOM', 'Custom rule']
];
const UNIT: Partial<Record<Frequency, [string, string]>> = {
	MINUTELY: ['minute', 'minutes'],
	HOURLY: ['hour', 'hours'],
	DAILY: ['day', 'days']
};
const pad = (n: number) => String(n).padStart(2, '0');
const whole = (value: string, min: number, max: number) =>
	Math.min(max, Math.max(min, Math.trunc(Number(value)) || min));

/** "Next: Thu, Nov 19, 9:00 AM; Fri, Nov 20, 9:00 AM (Europe/London)", or null when there is none. */
export function nextRunsText(rrule: string, now = new Date()) {
	const runs = previewRuns(rrule, 3, now);
	if (!runs.length) return null;
	return `Next: ${runs.map(runTimeText).join('; ')} (${localTimeZone()})`;
}

type FieldHooks = { ref: (element: HTMLElement | null) => void; onBlur: () => void };
type Described = { 'aria-describedby'?: string; 'aria-invalid'?: true };

/**
 * The schedule, in the form itself (#1032, #1104): a frequency, then what it
 * needs (an interval, a time, days, a date, or a rule), and under it the next
 * runs. Ports components/automations/ScheduleDropdown.svelte; the RRULE rules
 * live in automationModel.ts.
 */
function ScheduleField({
	value,
	onChange,
	error,
	field
}: {
	value: Schedule;
	onChange: (s: Schedule) => void;
	error?: string;
	field: FieldHooks;
}) {
	const ids = { frequency: useId(), message: useId(), every: useId(), time: useId(), day: useId(), date: useId() };
	const set = (patch: Partial<Schedule>) => onChange({ ...value, ...patch });
	const custom = value.frequency === 'CUSTOM';
	const preview = nextRunsText(buildRrule(value));
	const help = custom ? (
		<>
			{RULE_HELP}
			{preview && <span className="block">{preview}</span>}
		</>
	) : (
		preview
	);
	const unit = UNIT[value.frequency];
	const timed = ['DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY'].includes(value.frequency);
	const described = fieldProps(ids.message, { error, help });
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<Label htmlFor={ids.frequency}>Schedule</Label>
			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
				<Select value={value.frequency} onValueChange={(next) => onChange(withFrequency(value, next as Frequency))}>
					<SelectTrigger id={ids.frequency} className="min-w-40" {...(custom ? {} : { ...described, ...field })}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper" align="start">
						{FREQUENCIES.map(([k, l]) => (
							<SelectItem key={k} value={k}>
								{l}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{unit && (
					<span className="flex items-center gap-2">
						<Label htmlFor={ids.every} className="font-normal">
							Every
						</Label>
						<Input
							id={ids.every}
							type="number"
							inputMode="numeric"
							min={1}
							max={999}
							className="w-20"
							value={value.interval}
							onChange={(e) => set({ interval: whole(e.target.value, 1, 999) })}
						/>
						<span>{value.interval === 1 ? unit[0] : unit[1]}</span>
					</span>
				)}
				{value.frequency === 'HOURLY' && (
					<span className="flex items-center gap-2">
						<Label htmlFor={ids.time} className="font-normal">
							Minutes past
						</Label>
						<Input
							id={ids.time}
							type="number"
							inputMode="numeric"
							min={0}
							max={59}
							className="w-20"
							value={value.minute}
							onChange={(e) => set({ minute: whole(e.target.value, 0, 59) })}
						/>
					</span>
				)}
				{timed && (
					<span className="flex items-center gap-2">
						<Label htmlFor={ids.time} className="font-normal">
							At
						</Label>
						<Input
							id={ids.time}
							type="time"
							className="w-32"
							value={`${pad(value.hour)}:${pad(value.minute)}`}
							onChange={(e) => set(timeFromInput(e.target.value) ?? {})}
						/>
					</span>
				)}
				{value.frequency === 'MONTHLY' && (
					<span className="flex items-center gap-2">
						<Label htmlFor={ids.day} className="font-normal">
							Day
						</Label>
						<Input
							id={ids.day}
							type="number"
							inputMode="numeric"
							min={1}
							max={31}
							className="w-20"
							value={value.monthDay}
							onChange={(e) => set({ monthDay: whole(e.target.value, 1, 31) })}
						/>
					</span>
				)}
				{value.frequency === 'ONCE' && (
					<span className="flex flex-wrap items-center gap-2">
						<Label htmlFor={ids.date} className="font-normal">
							On
						</Label>
						<Input
							id={ids.date}
							type="date"
							className="w-40"
							min={localDate(new Date())}
							value={value.onceDate}
							onChange={(e) => set({ onceDate: e.target.value })}
						/>
						<Label htmlFor={ids.time} className="font-normal">
							at
						</Label>
						<Input
							id={ids.time}
							type="time"
							className="w-32"
							value={value.onceTime}
							onChange={(e) => set({ onceTime: e.target.value })}
						/>
					</span>
				)}
			</div>
			{value.frequency === 'WEEKLY' && (
				// COL-4: a chosen day is the brand fill, a day not chosen an outline (#1104).
				<fieldset className="flex min-w-0 flex-wrap gap-1">
					<legend className="sr-only">Days</legend>
					{WEEKDAYS.map((d) => {
						const on = value.days.includes(d);
						const name = new Date(2024, 0, 1 + WEEKDAYS.indexOf(d)).toLocaleDateString(undefined, {
							weekday: 'short'
						});
						return (
							<Button
								key={d}
								type="button"
								variant={on ? 'default' : 'outline'}
								size="sm"
								aria-pressed={on}
								className="min-w-11"
								onClick={() => set({ days: on ? value.days.filter((x) => x !== d) : [...value.days, d] })}
							>
								{name}
							</Button>
						);
					})}
				</fieldset>
			)}
			{custom && (
				// A textarea: a DTSTART line is followed by a newline, which an input strips.
				<Textarea
					aria-label="Rule"
					className="font-mono"
					placeholder="RRULE:FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17;BYMINUTE=0"
					rows={2}
					value={value.custom}
					{...described}
					{...field}
					onChange={(e) => set({ custom: e.target.value })}
				/>
			)}
			<FieldMessage id={ids.message} error={error} help={help} />
		</div>
	);
}

type ModelInfo = { id: string; name: string; info?: { meta?: { hidden?: boolean } } };

/** A button that opens a list to choose from, drawn as a field (FRM-1) showing its value. */
function PickerTrigger({
	icon,
	label,
	placeholder,
	open,
	...rest
}: {
	id: string;
	icon?: ReactNode;
	label: string | null;
	placeholder: string;
	open: boolean;
} & Described &
	Partial<FieldHooks>) {
	return (
		<Button
			type="button"
			variant="outline"
			aria-expanded={open}
			className="w-full min-w-0 shrink justify-between font-normal aria-invalid:border-danger"
			{...rest}
		>
			<span className={cn('flex min-w-0 items-center gap-2', !label && 'text-foreground-muted')}>
				{icon}
				<span className="truncate">{label ?? placeholder}</span>
			</span>
			<ChevronDown className="text-foreground-muted size-4" />
		</Button>
	);
}

/** Ports ModelDropdown.svelte: search the models (hidden ones left out) and choose one; the list closes on a choice. */
function ModelField({
	value,
	onChange,
	...trigger
}: { id: string; value: string; onChange: (id: string) => void } & Described & Partial<FieldHooks>) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [open, setOpen] = useState(false);
	const models = useQuery({
		queryKey: ['models-all'],
		queryFn: async () => ((await getModels(token)) ?? []) as ModelInfo[]
	});
	const list = (models.data ?? []).filter((m) => !m.info?.meta?.hidden);
	const label = value ? (list.find((m) => m.id === value)?.name ?? value) : null;
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<PickerTrigger label={label} placeholder="Choose a model" open={open} {...trigger} />
			</PopoverTrigger>
			<PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-64 p-0">
				<Command>
					<CommandInput placeholder="Search models" aria-label="Search models" />
					<CommandList>
						<CommandEmpty>{models.isLoading ? 'Loading models…' : 'No models match.'}</CommandEmpty>
						{list.map((m) => (
							<CommandItem
								key={m.id}
								value={`${m.name} ${m.id}`}
								onSelect={() => {
									onChange(m.id);
									setOpen(false);
								}}
							>
								<span className="truncate">{m.name}</span>
								{m.id === value && <Check className="ml-auto size-4 shrink-0" />}
							</CommandItem>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

/** Ports DestinationDropdown.svelte: a chat (optionally in a folder), or a channel; the list closes on a choice. */
function DestinationField({
	f,
	set,
	folders,
	channels,
	...trigger
}: {
	id: string;
	f: AutomationFields;
	set: (p: Partial<AutomationFields>) => void;
	folders: Folder[];
	channels: Channel[];
} & Described &
	Partial<FieldHooks>) {
	const [open, setOpen] = useState(false);
	const folderList = folderOptions(folders);
	const channelList = channelOptions(channels);
	const selectedFolder = folderList.find((x) => x.id === f.folderId);
	const selectedChannel = channelList.find((x) => x.id === f.channelId);
	const channel = f.targetType === 'channel';
	const label = channel
		? selectedChannel
			? `#${selectedChannel.name}`
			: null
		: selectedFolder
			? `Chat in ${selectedFolder.name}`
			: 'Chat';
	const choose = (patch: Partial<AutomationFields>) => {
		set(patch);
		setOpen(false);
	};
	const tick = (on: boolean) => on && <Check className="ml-auto size-4 shrink-0" />;
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<PickerTrigger
					open={open}
					label={label}
					placeholder="Choose a channel"
					icon={
						channel ? (
							<Hash className="size-4" />
						) : f.folderId ? (
							<FolderIcon className="size-4" />
						) : (
							<MessageSquare className="size-4" />
						)
					}
					{...trigger}
				/>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-64 p-0">
				<Command>
					<CommandInput placeholder="Search folders and channels" aria-label="Search folders and channels" />
					<CommandList>
						<CommandEmpty>Nothing matches.</CommandEmpty>
						<CommandGroup>
							<CommandItem value="chat" onSelect={() => choose({ targetType: 'chat', folderId: '', channelId: '' })}>
								<MessageSquare className="size-4" /> Chat, in no folder {tick(!channel && !f.folderId)}
							</CommandItem>
						</CommandGroup>
						{folderList.length > 0 && (
							<CommandGroup heading="Chat in a folder">
								{folderList.map((x) => {
									const path = folderPath(x, folderList);
									return (
										<CommandItem
											key={x.id}
											value={`folder ${x.name} ${path} ${x.id}`}
											onSelect={() => choose({ targetType: 'chat', folderId: x.id, channelId: '' })}
										>
											<FolderIcon className="size-4" />
											<span className="truncate">
												{x.name}
												{path && <span className="text-foreground-muted"> · {path}</span>}
											</span>
											{tick(!channel && f.folderId === x.id)}
										</CommandItem>
									);
								})}
							</CommandGroup>
						)}
						{channelList.length > 0 && (
							<CommandGroup heading="Channel">
								{channelList.map((x) => (
									<CommandItem
										key={x.id}
										value={`channel ${x.name} ${x.id}`}
										onSelect={() => choose({ targetType: 'channel', channelId: x.id, folderId: '' })}
									>
										<Hash className="size-4" />
										<span className="truncate">{x.name}</span>
										{tick(channel && f.channelId === x.id)}
									</CommandItem>
								))}
							</CommandGroup>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

/**
 * Ports components/AutomationModal.svelte: create, edit, or clone an
 * automation. A titled form (OVL-1, #1033): name, instructions, schedule with
 * its next runs, model (a new one starts on the user's default), where runs
 * go, and whether they all go into one chat (S6-D13). Each field says what is
 * wrong under itself (FRM-2); a schedule the server refuses is said under the
 * schedule. Rules in automationModel.ts.
 */
export function AutomationDialog({
	open,
	onOpenChange,
	automation = null,
	cloneFrom = null,
	onSaved
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	automation?: AutomationResponse | null;
	cloneFrom?: AutomationResponse | null;
	onSaved: (id: string | undefined) => void;
}) {
	// Escape, the scrim and Close go through the form, which asks first while it holds changes (FRM-3).
	const requestClose = useRef(() => onOpenChange(false));
	return (
		<Dialog open={open} onOpenChange={(next) => !next && requestClose.current()}>
			<DialogContent
				showCloseButton={false}
				// OVL-1: a short form is 32 rem.
				className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-lg"
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					(e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-initial-focus]')?.focus();
				}}
			>
				{/* Remounted per open, so the form always starts from what it was opened on. */}
				{open && (
					<AutomationForm
						automation={automation}
						cloneFrom={cloneFrom}
						onClose={() => onOpenChange(false)}
						onSaved={onSaved}
						requestClose={requestClose}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function AutomationForm({
	automation,
	cloneFrom,
	onClose,
	onSaved,
	requestClose
}: {
	automation: AutomationResponse | null;
	cloneFrom: AutomationResponse | null;
	onClose: () => void;
	onSaved: (id: string | undefined) => void;
	requestClose: RefObject<() => void>;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const defaults = useConfigStore((s) => s.config?.default_models as string | undefined);
	const settings = useUserSettings();
	const { folders, channels, loaded } = useDestinations(true);
	const [initial] = useState(() =>
		automation ? automationFields(automation) : automationFields(cloneFrom, { clone: true })
	);
	const [f, setF] = useState<AutomationFields>(initial);
	const [loading, setLoading] = useState(false);
	const [scheduleRefused, setScheduleRefused] = useState<string | null>(null);
	const [problem, setProblem] = useState<EditorProblem | null>(null);
	const set = (patch: Partial<AutomationFields>) => setF((prev) => ({ ...prev, ...patch }));
	const ids = {
		name: useId(),
		nameMsg: useId(),
		prompt: useId(),
		promptMsg: useId(),
		model: useId(),
		modelMsg: useId(),
		destination: useId(),
		destinationMsg: useId(),
		sameChat: useId(),
		sameChatMsg: useId(),
		problem: useId()
	};

	// A new automation starts on the model a new chat would (#1033), once settings have loaded.
	const startModel = initialModel(settings.settings?.models, defaults);
	useEffect(() => {
		if (!automation && !cloneFrom && startModel)
			setF((prev) => (prev.modelId ? prev : { ...prev, modelId: startModel }));
	}, [automation, cloneFrom, startModel]);
	// A clone may point at a folder or channel this user does not have: drop it
	// once the lists are known, without touching anything else being edited.
	useEffect(() => {
		if (cloneFrom && !automation && loaded) setF((prev) => withoutMissingDestinations(prev, folders, channels));
	}, [cloneFrom, automation, loaded, folders, channels]);

	const dirty =
		f.name !== initial.name ||
		f.prompt !== initial.prompt ||
		f.folderId !== initial.folderId ||
		f.channelId !== initial.channelId ||
		f.targetType !== initial.targetType ||
		f.sameChat !== initial.sameChat ||
		buildRrule(f.schedule) !== buildRrule(initial.schedule);
	const guard = useUnsavedChanges(dirty, {
		message: automation
			? 'Your changes to this automation are not saved. They are lost if you close it.'
			: 'This automation is not created yet. What you entered is lost if you close it.'
	});
	const close = () => guard.confirmLeave(onClose);
	requestClose.current = close;

	const problems = automationProblems(f);
	// A channel since deleted, or left, is as good as none (the picker shows none chosen).
	if (
		f.targetType === 'channel' &&
		f.channelId &&
		loaded &&
		!channelOptions(channels).some((c) => c.id === f.channelId)
	)
		problems.channel = 'Choose a channel, or post to a chat instead.';
	const { errors, field, submit: checkFields } = useFieldErrors(problems, AUTOMATION_FIELDS);
	const scheduleError = errors.schedule ?? scheduleRefused ?? undefined;

	const save = async () => {
		setProblem(null);
		if (!checkFields()) return;
		const out = automationPayload(f);
		if (!('form' in out)) return;
		setLoading(true);
		try {
			const saved = automation
				? await updateAutomationById(token, automation.id, out.form)
				: await createAutomation(token, out.form);
			guard.allowNext();
			onClose();
			onSaved(automation?.id ?? saved?.id);
			return;
		} catch (error) {
			const refused = ruleProblemFromServer(typeof error === 'string' ? error : `${error}`);
			if (refused) setScheduleRefused(refused);
			else {
				const { cause, detail } = failureCause(error);
				setProblem({
					message: `Couldn't ${automation ? 'save' : 'create'} the automation. ${detail ?? cause}`,
					detail: null
				});
			}
		}
		setLoading(false);
	};

	return (
		<>
			{guard.dialog}
			<div className="flex items-center justify-between px-5 pt-4 pb-2">
				<DialogTitle>{automation ? 'Edit automation' : 'New automation'}</DialogTitle>
				<DialogDescription className="sr-only">Instructions a model follows on a schedule.</DialogDescription>
				<Button variant="ghost" size="icon-sm" type="button" aria-label="Close" onClick={close}>
					<X className="size-5" />
				</Button>
			</div>
			<form
				className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pt-1 pb-4"
				noValidate
				onSubmit={(e) => {
					e.preventDefault();
					save();
				}}
			>
				<div className="flex min-w-0 flex-col gap-1.5">
					<Label htmlFor={ids.name}>Name</Label>
					<Input
						id={ids.name}
						data-initial-focus
						placeholder="e.g. Morning reading list"
						value={f.name}
						{...field('name')}
						{...fieldProps(ids.nameMsg, { error: errors.name })}
						onChange={(e) => set({ name: e.target.value })}
					/>
					<FieldMessage id={ids.nameMsg} error={errors.name} />
				</div>
				<div className="flex min-w-0 flex-col gap-1.5">
					<Label htmlFor={ids.prompt}>Instructions</Label>
					<Textarea
						id={ids.prompt}
						rows={5}
						placeholder="e.g. List three recent papers on Bayesian model checking, one line each."
						value={f.prompt}
						{...field('prompt')}
						{...fieldProps(ids.promptMsg, { error: errors.prompt, help: true })}
						onChange={(e) => set({ prompt: e.target.value })}
					/>
					<FieldMessage
						id={ids.promptMsg}
						error={errors.prompt}
						help="Sent to the model as a new message on each run."
					/>
				</div>
				<ScheduleField
					value={f.schedule}
					onChange={(schedule) => {
						setScheduleRefused(null);
						set({ schedule });
					}}
					error={scheduleError}
					field={field('schedule')}
				/>
				<div className="grid min-w-0 gap-4 sm:grid-cols-2">
					<div className="flex min-w-0 flex-col gap-1.5">
						<Label htmlFor={ids.model}>Model</Label>
						<ModelField
							id={ids.model}
							value={f.modelId}
							onChange={(modelId) => set({ modelId })}
							{...field('model')}
							{...fieldProps(ids.modelMsg, { error: errors.model })}
						/>
						<FieldMessage id={ids.modelMsg} error={errors.model} />
					</div>
					<div className="flex min-w-0 flex-col gap-1.5">
						<Label htmlFor={ids.destination}>Post to</Label>
						<DestinationField
							id={ids.destination}
							f={f}
							set={set}
							folders={folders}
							channels={channels}
							{...field('channel')}
							{...fieldProps(ids.destinationMsg, { error: errors.channel })}
						/>
						<FieldMessage id={ids.destinationMsg} error={errors.channel} />
					</div>
				</div>
				{f.targetType === 'chat' && (
					<div className="flex items-start gap-3">
						<Checkbox
							id={ids.sameChat}
							className="mt-0.5"
							checked={f.sameChat}
							aria-describedby={ids.sameChatMsg}
							onCheckedChange={(on) => set({ sameChat: on === true })}
						/>
						<div className="flex min-w-0 flex-col gap-0.5">
							<Label htmlFor={ids.sameChat}>Same chat every time</Label>
							<p id={ids.sameChatMsg} className="text-foreground-muted text-dense">
								Each run is added to the chat the last run used, instead of starting a new chat.
							</p>
						</div>
					</div>
				)}
				{problem && <EditorError id={ids.problem} problem={problem} />}
				<div className="flex flex-wrap justify-end gap-2 pt-1">
					<Button type="button" variant="ghost" onClick={close}>
						Cancel
					</Button>
					<Button type="submit" disabled={loading} aria-busy={loading || undefined}>
						{loading && <Spinner className="size-3.5" />}
						{automation ? 'Save changes' : 'Create automation'}
					</Button>
				</div>
			</form>
		</>
	);
}
