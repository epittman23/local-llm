import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Clock, Folder as FolderIcon, Hash, MessageSquare, Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { getModels } from '@/lib/apis';
import { type AutomationResponse, createAutomation, updateAutomationById } from '@/lib/apis/automations';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import {
	type AutomationFields,
	automationFields,
	automationPayload,
	type Channel,
	channelOptions,
	type Folder,
	type Frequency,
	folderOptions,
	folderPath,
	localDate,
	type Schedule,
	timeFromInput,
	WEEKDAYS,
	withFrequency,
	withoutMissingDestinations
} from './automationModel';
import { useDestinations } from './useDestinations';

const small = 'bg-transparent text-dense';

function Picker({
	icon,
	label,
	children,
	ariaLabel
}: {
	icon: ReactNode;
	label: string;
	children: ReactNode;
	ariaLabel: string;
}) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button type="button" variant="ghost" size="sm" className="rounded-2xl" aria-label={ariaLabel}>
					{icon}
					<span className="max-w-32 truncate whitespace-nowrap">{label}</span>
					<ChevronDown className="size-3" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-72 p-1.5">
				{children}
			</PopoverContent>
		</Popover>
	);
}

const FREQUENCIES: [Frequency, string][] = [
	['ONCE', 'Once'],
	['HOURLY', 'Hourly'],
	['DAILY', 'Daily'],
	['WEEKLY', 'Weekly'],
	['MONTHLY', 'Monthly'],
	['CUSTOM', 'Custom']
];
const pad = (n: number) => String(n).padStart(2, '0');

/** Ports components/automations/ScheduleDropdown.svelte; the RRULE rules live in automationModel.ts. */
function ScheduleField({ value, onChange }: { value: Schedule; onChange: (s: Schedule) => void }) {
	const set = (patch: Partial<Schedule>) => onChange({ ...value, ...patch });
	return (
		<Picker
			icon={<Clock className="size-3.5" />}
			label={FREQUENCIES.find(([k]) => k === value.frequency)?.[1] ?? 'Schedule'}
			ariaLabel="Schedule"
		>
			<div className="text-muted-foreground px-2 pt-0.5 text-caption">Schedule</div>
			<div className="px-1.5 py-0.5">
				<select
					aria-label="Frequency"
					className="w-full bg-transparent text-sm [&>option]:bg-popover"
					value={value.frequency}
					onChange={(e) => onChange(withFrequency(value, e.target.value as Frequency))}
				>
					{FREQUENCIES.map(([k, l]) => (
						<option key={k} value={k}>
							{l}
						</option>
					))}
				</select>
			</div>
			{value.frequency === 'CUSTOM' ? (
				<div className="px-2 pb-2">
					{/* A textarea: a DTSTART line is followed by a newline, which an input strips. */}
					<textarea
						className="w-full rounded-lg border bg-transparent px-2 py-1 font-mono text-xs"
						aria-label="Custom RRULE"
						placeholder="RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0"
						rows={2}
						value={value.custom}
						onChange={(e) => set({ custom: e.target.value })}
					/>
				</div>
			) : value.frequency !== 'HOURLY' ? (
				<div className="flex flex-wrap items-center gap-2 px-3 pb-2">
					{value.frequency === 'ONCE' ? (
						<>
							<input
								type="date"
								aria-label="Date"
								className={small}
								min={localDate(new Date())}
								value={value.onceDate}
								onChange={(e) => set({ onceDate: e.target.value })}
							/>
							<input
								type="time"
								aria-label="Time"
								className={small}
								value={value.onceTime}
								onChange={(e) => set({ onceTime: e.target.value })}
							/>
						</>
					) : (
						<label className="flex items-center gap-1.5">
							<span className="text-muted-foreground text-xs">Time</span>
							<input
								type="time"
								aria-label="Time"
								className={small}
								value={`${pad(value.hour)}:${pad(value.minute)}`}
								onChange={(e) => set(timeFromInput(e.target.value) ?? {})}
							/>
						</label>
					)}
					{value.frequency === 'MONTHLY' && (
						<label className="flex items-center gap-1.5">
							<span className="text-muted-foreground text-xs">Day</span>
							<input
								type="number"
								aria-label="Day of month"
								className={cn(small, 'w-12')}
								min={1}
								max={31}
								value={value.monthDay}
								onChange={(e) => set({ monthDay: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })}
							/>
						</label>
					)}
				</div>
			) : null}
			{value.frequency === 'WEEKLY' && (
				<div className="flex gap-1 px-2 pb-2">
					{WEEKDAYS.map((d) => {
						const on = value.days.includes(d);
						return (
							<Button
								key={d}
								type="button"
								variant={on ? 'secondary' : 'ghost'}
								size="sm"
								aria-pressed={on}
								className="flex-1 rounded-xl"
								onClick={() => set({ days: on ? value.days.filter((x) => x !== d) : [...value.days, d] })}
							>
								{d[0]}
								{d[1].toLowerCase()}
							</Button>
						);
					})}
				</div>
			)}
		</Picker>
	);
}

type ModelInfo = { id: string; name: string; info?: { meta?: { hidden?: boolean } } };

/** Ports ModelDropdown.svelte: search the models (hidden ones left out) and pick one. */
function ModelField({ value, onChange }: { value: string; onChange: (id: string) => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const models = useQuery({
		queryKey: ['models-all'],
		queryFn: async () => ((await getModels(token)) ?? []) as ModelInfo[]
	});
	const [search, setSearch] = useState('');
	const list = (models.data ?? []).filter((m) => !m.info?.meta?.hidden);
	const q = search.toLowerCase();
	const shown = q ? list.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : list;
	return (
		<Picker
			icon={<Sparkles className="size-3.5" />}
			label={value ? (list.find((m) => m.id === value)?.name ?? value) : 'Select model'}
			ariaLabel="Model"
		>
			<input
				className="mb-1 w-full rounded-lg border bg-transparent px-2 py-1 text-xs"
				aria-label="Search models"
				placeholder="Search models"
				value={search}
				onChange={(e) => setSearch(e.target.value)}
			/>
			<div className="max-h-60 overflow-y-auto">
				{shown.length === 0 && (
					<div className="text-muted-foreground px-2 py-1.5 text-xs">
						{models.isLoading ? 'Loading…' : 'No models found'}
					</div>
				)}
				{shown.map((m) => (
					<Button
						key={m.id}
						type="button"
						variant="ghost"
						size="sm"
						className="w-full justify-start text-left"
						onClick={() => onChange(m.id)}
					>
						<span className="truncate">{m.name}</span>
						{m.id === value && <Check className="ml-auto size-3.5 shrink-0" />}
					</Button>
				))}
			</div>
		</Picker>
	);
}

/** Ports DestinationDropdown.svelte: a new chat (optionally in a folder), or a channel. */
function DestinationField({
	f,
	set,
	folders,
	channels
}: {
	f: AutomationFields;
	set: (p: Partial<AutomationFields>) => void;
	folders: Folder[];
	channels: Channel[];
}) {
	const [tab, setTab] = useState<'' | 'folders' | 'channels'>('');
	const [search, setSearch] = useState('');
	const folderList = folderOptions(folders);
	const channelList = channelOptions(channels);
	const selectedFolder = folderList.find((x) => x.id === f.folderId);
	const selectedChannel = channelList.find((x) => x.id === f.channelId);
	const label =
		f.targetType === 'channel'
			? selectedChannel
				? `#${selectedChannel.name}`
				: 'Choose channel'
			: (selectedFolder?.name ?? 'New chat');
	const q = search.trim().toLowerCase();
	const row = 'w-full justify-start gap-2 text-left';
	return (
		<Picker
			icon={
				f.targetType === 'channel' ? (
					<Hash className="size-3.5" />
				) : f.folderId ? (
					<FolderIcon className="size-3.5" />
				) : (
					<MessageSquare className="size-3.5" />
				)
			}
			label={label}
			ariaLabel="Destination"
		>
			{tab === '' ? (
				<>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={row}
						onClick={() => set({ targetType: 'chat', folderId: '', channelId: '' })}
					>
						<MessageSquare className="size-3.5" /> New chat{' '}
						{f.targetType === 'chat' && !f.folderId && <Check className="ml-auto size-3.5" />}
					</Button>
					<Button type="button" variant="ghost" size="sm" className={row} onClick={() => setTab('folders')}>
						<FolderIcon className="size-3.5" /> In a folder…{' '}
						{f.targetType === 'chat' && f.folderId && <Check className="ml-auto size-3.5" />}
					</Button>
					<Button type="button" variant="ghost" size="sm" className={row} onClick={() => setTab('channels')}>
						<Hash className="size-3.5" /> In a channel…{' '}
						{f.targetType === 'channel' && <Check className="ml-auto size-3.5" />}
					</Button>
				</>
			) : (
				<>
					<div className="mb-1 flex items-center gap-1">
						<Button type="button" variant="ghost" size="xs" onClick={() => setTab('')}>
							‹ Back
						</Button>
						<input
							className="w-full rounded-lg border bg-transparent px-2 py-1 text-xs"
							aria-label={`Search ${tab}`}
							placeholder={`Search ${tab}`}
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
					</div>
					<div className="max-h-60 overflow-y-auto">
						{tab === 'folders'
							? folderList
									.filter((x) => !q || `${x.name} ${folderPath(x, folderList)}`.toLowerCase().includes(q))
									.map((x) => {
										const path = folderPath(x, folderList);
										return (
											<Button
												key={x.id}
												type="button"
												variant="ghost"
												size="sm"
												className={row}
												onClick={() => set({ targetType: 'chat', folderId: x.id, channelId: '' })}
											>
												<span className="truncate">
													{x.name}
													{path && <span className="text-muted-foreground"> · {path}</span>}
												</span>
												{f.targetType === 'chat' && f.folderId === x.id && (
													<Check className="ml-auto size-3.5 shrink-0" />
												)}
											</Button>
										);
									})
							: channelList
									.filter((x) => !q || x.name.toLowerCase().includes(q))
									.map((x) => (
										<Button
											key={x.id}
											type="button"
											variant="ghost"
											size="sm"
											className={row}
											onClick={() => set({ targetType: 'channel', channelId: x.id, folderId: '' })}
										>
											<span className="truncate">#{x.name}</span>
											{f.targetType === 'channel' && f.channelId === x.id && (
												<Check className="ml-auto size-3.5 shrink-0" />
											)}
										</Button>
									))}
					</div>
				</>
			)}
		</Picker>
	);
}

/**
 * Ports components/AutomationModal.svelte: create, edit, or clone an
 * automation -- a title, the instructions, and a schedule / model /
 * destination toolbar. Rules in automationModel.ts.
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
	const token = useAuthStore((s) => s.token) ?? '';
	const { folders, channels, loaded } = useDestinations(open);
	const [f, setF] = useState<AutomationFields>(() => automationFields(null));
	const [loading, setLoading] = useState(false);
	const set = (patch: Partial<AutomationFields>) => setF((prev) => ({ ...prev, ...patch }));

	useEffect(() => {
		if (open) setF(automation ? automationFields(automation) : automationFields(cloneFrom, { clone: true }));
		// Seeded when the dialog opens; edits inside it are local.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);
	// A clone may point at a folder or channel this user does not have: drop it
	// once the lists are known, without touching anything else being edited.
	useEffect(() => {
		if (open && cloneFrom && !automation && loaded) setF((prev) => withoutMissingDestinations(prev, folders, channels));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, loaded]);

	const save = async () => {
		const out = automationPayload(f);
		if ('error' in out) return void toast.error(out.error);
		setLoading(true);
		try {
			if (automation) {
				await updateAutomationById(token, automation.id, out.form);
				toast.success('Automation updated');
				onOpenChange(false);
				onSaved(automation.id);
			} else {
				const created = await createAutomation(token, out.form);
				toast.success('Automation created');
				onOpenChange(false);
				onSaved(created?.id);
			}
		} catch (e: any) {
			toast.error(e?.detail ?? `${e}`);
		} finally {
			setLoading(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle className="sr-only">{automation ? 'Edit automation' : 'New automation'}</DialogTitle>
					<DialogDescription className="sr-only">A prompt that runs on a schedule.</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						save();
					}}
				>
					<input
						className="placeholder:text-foreground-muted w-full bg-transparent text-lg"
						aria-label="Automation title"
						placeholder="Automation title"
						value={f.name}
						onChange={(e) => set({ name: e.target.value })}
					/>
					<div>
						<label className="text-muted-foreground mb-1 block text-xs" htmlFor="automation-prompt">
							Instructions
						</label>
						<textarea
							id="automation-prompt"
							className="placeholder:text-foreground-muted w-full resize-none bg-transparent text-sm"
							rows={8}
							placeholder="Enter prompt here."
							value={f.prompt}
							onChange={(e) => set({ prompt: e.target.value })}
						/>
					</div>
					<div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
						<div className="flex min-w-0 flex-wrap items-center gap-0.5">
							<ScheduleField value={f.schedule} onChange={(schedule) => set({ schedule })} />
							<ModelField value={f.modelId} onChange={(modelId) => set({ modelId })} />
							<DestinationField f={f} set={set} folders={folders} channels={channels} />
						</div>
						<div className="flex items-center gap-2">
							<Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" size="sm" disabled={loading}>
								{automation ? 'Save' : 'Create'}
								{loading && <Spinner className="size-3.5" />}
							</Button>
						</div>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
