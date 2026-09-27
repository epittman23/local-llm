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
	type Channel,
	type Folder,
	type Frequency,
	type Schedule,
	WEEKDAYS,
	automationFields,
	automationPayload,
	channelOptions,
	folderOptions,
	folderPath,
	localDate,
	withFrequency,
	withoutMissingDestinations
} from './automationModel';
import { useDestinations } from './useDestinations';

const chip = 'text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-2xl px-2.5 py-1.5 text-xs transition';
const small = 'bg-transparent text-[0.8125rem] outline-hidden dark:[color-scheme:dark]';

function Picker({ icon, label, children, ariaLabel }: { icon: ReactNode; label: string; children: ReactNode; ariaLabel: string }) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button type="button" className={chip} aria-label={ariaLabel}>
					{icon}
					<span className="max-w-32 truncate whitespace-nowrap">{label}</span>
					<ChevronDown className="size-3" />
				</button>
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
		<Picker icon={<Clock className="size-3.5" />} label={FREQUENCIES.find(([k]) => k === value.frequency)?.[1] ?? 'Schedule'} ariaLabel="Schedule">
			<div className="text-muted-foreground px-2 pt-0.5 text-[0.6875rem]">Schedule</div>
			<div className="px-1.5 py-0.5">
				<select aria-label="Frequency" className="w-full bg-transparent text-sm outline-hidden [&>option]:bg-popover" value={value.frequency} onChange={(e) => onChange(withFrequency(value, e.target.value as Frequency))}>
					{FREQUENCIES.map(([k, l]) => (
						<option key={k} value={k}>
							{l}
						</option>
					))}
				</select>
			</div>
			{value.frequency === 'CUSTOM' ? (
				<div className="px-2 pb-2">
					<input className="w-full rounded-lg border bg-transparent px-2 py-1 font-mono text-xs outline-hidden" aria-label="Custom RRULE" placeholder="RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0" value={value.custom} onChange={(e) => set({ custom: e.target.value })} />
				</div>
			) : value.frequency !== 'HOURLY' ? (
				<div className="flex flex-wrap items-center gap-2 px-3 pb-2">
					{value.frequency === 'ONCE' ? (
						<>
							<input type="date" aria-label="Date" className={small} min={localDate(new Date())} value={value.onceDate} onChange={(e) => set({ onceDate: e.target.value })} />
							<input type="time" aria-label="Time" className={small} value={value.onceTime} onChange={(e) => set({ onceTime: e.target.value })} />
						</>
					) : (
						<label className="flex items-center gap-1.5">
							<span className="text-muted-foreground text-xs">Time</span>
							<input
								type="time"
								aria-label="Time"
								className={small}
								value={`${pad(value.hour)}:${pad(value.minute)}`}
								onChange={(e) => {
									const [hour, minute] = e.target.value.split(':').map(Number);
									if (!Number.isNaN(hour)) set({ hour, minute });
								}}
							/>
						</label>
					)}
					{value.frequency === 'MONTHLY' && (
						<label className="flex items-center gap-1.5">
							<span className="text-muted-foreground text-xs">Day</span>
							<input type="number" aria-label="Day of month" className={cn(small, 'w-12')} min={1} max={31} value={value.monthDay} onChange={(e) => set({ monthDay: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })} />
						</label>
					)}
				</div>
			) : null}
			{value.frequency === 'WEEKLY' && (
				<div className="flex gap-1 px-2 pb-2">
					{WEEKDAYS.map((d) => {
						const on = value.days.includes(d);
						return (
							<button key={d} type="button" aria-pressed={on} className={cn('flex-1 rounded-xl py-1 text-xs transition', on ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')} onClick={() => set({ days: on ? value.days.filter((x) => x !== d) : [...value.days, d] })}>
								{d[0]}
								{d[1].toLowerCase()}
							</button>
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
	const models = useQuery({ queryKey: ['models-all'], queryFn: async () => ((await getModels(token)) ?? []) as ModelInfo[] });
	const [search, setSearch] = useState('');
	const list = (models.data ?? []).filter((m) => !m.info?.meta?.hidden);
	const q = search.toLowerCase();
	const shown = q ? list.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : list;
	return (
		<Picker icon={<Sparkles className="size-3.5" />} label={value ? (list.find((m) => m.id === value)?.name ?? value) : 'Select model'} ariaLabel="Model">
			<input className="mb-1 w-full rounded-lg border bg-transparent px-2 py-1 text-xs outline-hidden" aria-label="Search models" placeholder="Search models" value={search} onChange={(e) => setSearch(e.target.value)} />
			<div className="max-h-60 overflow-y-auto">
				{shown.length === 0 && <div className="text-muted-foreground px-2 py-1.5 text-xs">{models.isLoading ? 'Loading…' : 'No models found'}</div>}
				{shown.map((m) => (
					<button key={m.id} type="button" className="hover:bg-muted flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs" onClick={() => onChange(m.id)}>
						<span className="truncate">{m.name}</span>
						{m.id === value && <Check className="ml-auto size-3.5 shrink-0" />}
					</button>
				))}
			</div>
		</Picker>
	);
}

/** Ports DestinationDropdown.svelte: a new chat (optionally in a folder), or a channel. */
function DestinationField({ f, set, folders, channels }: { f: AutomationFields; set: (p: Partial<AutomationFields>) => void; folders: Folder[]; channels: Channel[] }) {
	const [tab, setTab] = useState<'' | 'folders' | 'channels'>('');
	const [search, setSearch] = useState('');
	const folderList = folderOptions(folders);
	const channelList = channelOptions(channels);
	const selectedFolder = folderList.find((x) => x.id === f.folderId);
	const selectedChannel = channelList.find((x) => x.id === f.channelId);
	const label = f.targetType === 'channel' ? (selectedChannel ? `#${selectedChannel.name}` : 'Choose channel') : (selectedFolder?.name ?? 'New chat');
	const q = search.trim().toLowerCase();
	const row = 'hover:bg-muted flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs';
	return (
		<Picker icon={f.targetType === 'channel' ? <Hash className="size-3.5" /> : f.folderId ? <FolderIcon className="size-3.5" /> : <MessageSquare className="size-3.5" />} label={label} ariaLabel="Destination">
			{tab === '' ? (
				<>
					<button type="button" className={row} onClick={() => set({ targetType: 'chat', folderId: '', channelId: '' })}>
						<MessageSquare className="size-3.5" /> New chat {f.targetType === 'chat' && !f.folderId && <Check className="ml-auto size-3.5" />}
					</button>
					<button type="button" className={row} onClick={() => setTab('folders')}>
						<FolderIcon className="size-3.5" /> In a folder… {f.targetType === 'chat' && f.folderId && <Check className="ml-auto size-3.5" />}
					</button>
					<button type="button" className={row} onClick={() => setTab('channels')}>
						<Hash className="size-3.5" /> In a channel… {f.targetType === 'channel' && <Check className="ml-auto size-3.5" />}
					</button>
				</>
			) : (
				<>
					<div className="mb-1 flex items-center gap-1">
						<button type="button" className="text-muted-foreground hover:text-foreground px-1 text-xs" onClick={() => setTab('')}>
							‹ Back
						</button>
						<input className="w-full rounded-lg border bg-transparent px-2 py-1 text-xs outline-hidden" aria-label={`Search ${tab}`} placeholder={`Search ${tab}`} value={search} onChange={(e) => setSearch(e.target.value)} />
					</div>
					<div className="max-h-60 overflow-y-auto">
						{tab === 'folders'
							? folderList
									.filter((x) => !q || `${x.name} ${folderPath(x, folderList)}`.toLowerCase().includes(q))
									.map((x) => {
										const path = folderPath(x, folderList);
										return (
											<button key={x.id} type="button" className={row} onClick={() => set({ targetType: 'chat', folderId: x.id, channelId: '' })}>
												<span className="truncate">
													{x.name}
													{path && <span className="text-muted-foreground"> · {path}</span>}
												</span>
												{f.targetType === 'chat' && f.folderId === x.id && <Check className="ml-auto size-3.5 shrink-0" />}
											</button>
										);
									})
							: channelList
									.filter((x) => !q || x.name.toLowerCase().includes(q))
									.map((x) => (
										<button key={x.id} type="button" className={row} onClick={() => set({ targetType: 'channel', channelId: x.id, folderId: '' })}>
											<span className="truncate">#{x.name}</span>
											{f.targetType === 'channel' && f.channelId === x.id && <Check className="ml-auto size-3.5 shrink-0" />}
										</button>
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
					<input className="placeholder:text-muted-foreground/50 w-full bg-transparent text-lg outline-hidden" aria-label="Automation title" placeholder="Automation title" value={f.name} onChange={(e) => set({ name: e.target.value })} />
					<div>
						<label className="text-muted-foreground mb-1 block text-xs" htmlFor="automation-prompt">
							Instructions
						</label>
						<textarea id="automation-prompt" className="placeholder:text-muted-foreground/50 w-full resize-none bg-transparent text-sm outline-hidden" rows={8} placeholder="Enter prompt here." value={f.prompt} onChange={(e) => set({ prompt: e.target.value })} />
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
