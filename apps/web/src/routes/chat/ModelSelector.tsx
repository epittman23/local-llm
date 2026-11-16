import { AlertCircle, ArrowLeft, Check, ChevronDown, Minus, Plus, Star } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Tip } from '@/components/common/Tip';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RowButton } from '@/components/ui/row-button';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useUserSettings } from '@/lib/settings/userSettings';
import { formatChord, Shortcut } from '@/lib/shortcuts';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useKeybindings } from '@/lib/useShortcuts';
import { cn } from '@/lib/utils';
import { useModelPickerStore } from './modelPickerStore';
import type { ChatModel } from './useModels';

export const modelImage = (id: string) =>
	`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${encodeURIComponent(id)}`;

/**
 * The muted second line under a model's name (#990): what an Arena entry
 * does, else the entry's description, else the base model of a workspace
 * entry (an identifier, so monospaced: DAT-4). Where a model runs is not in
 * the model list, so it is not guessed.
 */
export function modelDetail(model: ChatModel): { text: string; mono?: boolean } | null {
	if (model.owned_by === 'arena') return { text: 'Answers with a random model' };
	const description = model.info?.meta?.description?.replace(/\s+/g, ' ').trim();
	if (description) return { text: description };
	const base = model.info?.base_model_id;
	return base ? { text: base, mono: true } : null;
}

/** A model as a two-line row: its picture, its name and the line above. Used by the picker and the "@" list. */
export function ModelRow({ model, current = false }: { model: ChatModel; current?: boolean }) {
	const detail = modelDetail(model);
	return (
		<>
			<ProfileAvatar src={modelImage(model.id)} name={model.name} size="sm" />
			<span className="flex min-w-0 flex-1 flex-col text-left">
				<span className="truncate" title={model.name}>
					{model.name}
				</span>
				{detail && (
					<span
						className={cn('truncate text-caption text-foreground-muted', detail.mono && 'font-mono')}
						title={detail.text}
					>
						{detail.text}
					</span>
				)}
			</span>
			{current && (
				<>
					<Check aria-hidden className="size-4" />
					<span className="sr-only">(current)</span>
				</>
			)}
		</>
	);
}

/** cmdk's filter: a plain "contains" on the id, the name and the tags, as the picker always searched. */
export const matchModel = (value: string, search: string, keywords: string[] = []) => {
	const q = search.trim().toLowerCase();
	return [value, ...keywords].some((k) => k.toLowerCase().includes(q)) ? 1 : 0;
};

/** The default the user saved, else the server's; empty ids never count. */
export function storedDefault(settings: unknown, serverDefault: unknown): string[] {
	const mine = (settings as { models?: unknown } | null)?.models;
	if (Array.isArray(mine) && mine.some(Boolean))
		return mine.filter((m): m is string => typeof m === 'string' && m !== '');
	return typeof serverDefault === 'string' ? serverDefault.split(',').filter(Boolean) : [];
}

/** Each slot with a key from its model id (the nth copy of an id gets #n), so a row keeps its state when another goes. */
const withKeys = (ids: string[]) => {
	const seen = new Map<string, number>();
	return ids.map((id, i) => {
		const n = seen.get(id) ?? 0;
		seen.set(id, n + 1);
		return { id, i, key: `${id}#${n}` };
	});
};

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** Whether an element is on screen: a CSS-hidden copy of the picker must not answer the shortcut. */
const onScreen = (el: HTMLElement | null) => !!el && (typeof el.checkVisibility !== 'function' || el.checkVisibility());

type Extra = { id: string; label: string; icon: ReactNode; onSelect: () => void };

/**
 * The searchable list of models (NAV-5): the field keeps focus, the arrows
 * move the highlight, Enter chooses. `extras` (Make default, Add model)
 * follow the models while nothing is typed.
 */
function ModelList({
	models,
	value,
	onPick,
	extras
}: {
	models: ChatModel[];
	value: string;
	onPick: (id: string) => void;
	extras: Extra[];
}) {
	const [query, setQuery] = useState('');
	const q = query.trim();
	return (
		<Command filter={matchModel} label="Search models">
			<CommandInput value={query} onValueChange={setQuery} placeholder="Search models" />
			<CommandList aria-label="Models" className="mt-1 max-h-80">
				<CommandEmpty>
					{q ? `No models match “${q}”` : 'No models yet. Connections are in Admin > Settings > Connections.'}
				</CommandEmpty>
				{models.map((m) => (
					<CommandItem
						key={m.id}
						value={m.id}
						keywords={[m.name, ...(m.info?.meta?.tags ?? []).map((t) => t.name)]}
						onSelect={() => onPick(m.id)}
					>
						<ModelRow model={m} current={m.id === value} />
					</CommandItem>
				))}
				{!q && extras.length > 0 && (
					<>
						<CommandSeparator className="my-1" />
						<CommandGroup>
							{extras.map((e) => (
								<CommandItem key={e.id} value={`action:${e.id}`} onSelect={e.onSelect}>
									{e.icon}
									{e.label}
								</CommandItem>
							))}
						</CommandGroup>
					</>
				)}
			</CommandList>
		</Command>
	);
}

/**
 * The chat's model picker (ports chat/ModelSelector.svelte and
 * ModelSelector/Selector.svelte). One picker per selected model on `Command`
 * (NAV-5, #943), "Add model" to answer with another model side by side (when
 * the user may) and "Remove model" to drop one. "Make default" sits in the
 * list, shown only when the selection differs from the saved default (#944).
 * An added model's picker opens at once and, dismissed without a choice,
 * goes again: the empty slot never leaves this component, so it is never
 * saved. An empty id that arrives anyway (old saved data) is marked as an
 * error under its picker (FRM-2).
 *
 * `compact` is the phone's form, for the message box's toolbar: one chip
 * ("Coder", or "2 models") opening the same list above it.
 *
 * `openModelPicker()` (modelPickerStore) opens it from elsewhere; the Open
 * model selector shortcut (Ctrl+Shift+M) does that.
 */
export function ModelSelector({
	models,
	selected,
	onChange,
	disabled,
	compact = false
}: {
	models: ChatModel[];
	selected: string[];
	onChange: (ids: string[]) => void;
	disabled?: boolean;
	compact?: boolean;
}) {
	const user = useAuthStore((s) => s.user);
	const { settings, update } = useUserSettings();
	const serverDefault = useConfigStore((s) => (s.config as { default_models?: unknown } | null)?.default_models);
	const bindings = useKeybindings();
	const chord = formatChord(bindings[Shortcut.OPEN_MODEL_SELECTOR] ?? '');
	const multiple =
		user?.role === 'admin' ||
		((user?.permissions as { chat?: { multiple_models?: boolean } } | undefined)?.chat?.multiple_models ?? true);
	const visible = useMemo(() => models.filter((m) => !m.info?.meta?.hidden), [models]);

	const [adding, setAdding] = useState(false);
	/** The slot whose list is open (compact: the slot being changed while the popover is open). */
	const [openSlot, setOpenSlot] = useState<number | null>(null);
	const [compactOpen, setCompactOpen] = useState(false);
	const slots = adding ? [...selected, ''] : selected;
	const root = useRef<HTMLDivElement>(null);
	const addButton = useRef<HTMLButtonElement>(null);
	const helpId = useId();

	const chosen = selected.filter(Boolean);
	const isDefault = sameIds(chosen, storedDefault(settings, serverDefault));
	const makeDefault = () => {
		setOpenSlot(null);
		setCompactOpen(false);
		update({ models: chosen }).then(
			() => toast.success('Default model saved'),
			(e) => toast.error(`${e?.message ?? e}`)
		);
	};
	const startAdding = () => {
		setAdding(true);
		setOpenSlot(selected.length);
	};
	const pick = (slot: number, id: string) => {
		if (slot >= selected.length) onChange([...selected, id]);
		else onChange(selected.map((s, i) => (i === slot ? id : s)));
		setAdding(false);
		setOpenSlot(null);
		setCompactOpen(false);
	};
	const remove = (slot: number) => {
		if (slot >= selected.length) setAdding(false);
		else onChange(selected.filter((_, i) => i !== slot));
	};
	const extrasFor = (slot: number): Extra[] => [
		...(compact && multiple && !adding && selected.length === 1
			? [{ id: 'add', label: 'Add model', icon: <Plus aria-hidden />, onSelect: startAdding }]
			: []),
		...(!isDefault && chosen.length > 0 && slot < selected.length
			? [{ id: 'default', label: 'Make default', icon: <Star aria-hidden />, onSelect: makeDefault }]
			: [])
	];

	// Opened from elsewhere (the shortcut, "Try another model"); only a picker on screen answers.
	const request = useModelPickerStore((s) => s.request);
	const seen = useRef(useModelPickerStore.getState().request?.n ?? 0);
	const latest = useRef({ disabled, compact, count: selected.length });
	latest.current = { disabled, compact, count: selected.length };
	useEffect(() => {
		if (!request || request.n <= seen.current) return;
		seen.current = request.n;
		const l = latest.current;
		if (l.disabled || !onScreen(root.current)) return;
		setOpenSlot(Math.max(0, Math.min(request.index, l.count - 1)));
		if (l.compact) setCompactOpen(true);
	}, [request]);

	const nameOf = (id: string) => visible.find((m) => m.id === id)?.name ?? (id || 'Choose a model');
	const tip = chord ? `Choose a model (${chord})` : 'Choose a model';

	if (compact) {
		const label = chosen.length > 1 ? `${chosen.length} models` : nameOf(selected[0] ?? '');
		// One slot: its list at once. Several: the slots first, until one is being changed.
		const editing = slots.length === 1 ? 0 : openSlot;
		return (
			<div ref={root} className="flex min-w-0">
				<Popover
					open={compactOpen}
					onOpenChange={(o) => {
						setCompactOpen(o);
						setOpenSlot(null);
						if (!o) setAdding(false);
					}}
				>
					{/* The chip's name may be cut short: the tooltip and the open list give it whole (TYP-7). */}
					<Tip content={`${label}. ${tip}`}>
						<PopoverTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={disabled}
								className="max-w-40 min-w-0 shrink"
								aria-label={`Model: ${label}`}
								aria-invalid={selected.includes('') || undefined}
							>
								<span className="truncate">{label}</span>
								<ChevronDown aria-hidden className="size-4 shrink-0" />
							</Button>
						</PopoverTrigger>
					</Tip>
					<PopoverContent side="top" align="start" className="w-80 max-w-[calc(100vw-2rem)] gap-1 p-1.5">
						{editing !== null ? (
							<>
								{slots.length > 1 && (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="self-start"
										onClick={() => {
											setAdding(false);
											setOpenSlot(null);
										}}
									>
										<ArrowLeft aria-hidden /> All models
									</Button>
								)}
								<ModelList
									models={visible}
									value={slots[editing] ?? ''}
									onPick={(id) => pick(editing, id)}
									extras={extrasFor(editing)}
								/>
							</>
						) : (
							<div className="flex flex-col gap-1">
								<ul aria-label="Models in this chat" className="flex flex-col gap-1">
									{withKeys(selected).map(({ id, i, key }) => {
										const m = visible.find((x) => x.id === id);
										return (
											<li key={key} className="flex items-center gap-1">
												<RowButton
													className="flex items-center gap-2 px-2 py-1.5"
													aria-label={`Change model ${i + 1}: ${nameOf(id)}`}
													onClick={() => setOpenSlot(i)}
												>
													{m ? <ModelRow model={m} /> : <span className="flex-1 text-danger">{nameOf(id)}</span>}
												</RowButton>
												{i > 0 && (
													<Button
														type="button"
														variant="ghost"
														size="icon-sm"
														aria-label={`Remove model ${i + 1}`}
														onClick={() => remove(i)}
													>
														<Minus aria-hidden />
													</Button>
												)}
											</li>
										);
									})}
								</ul>
								<div className="flex flex-wrap gap-1 border-t border-border-divider pt-1">
									{multiple && (
										<Button type="button" variant="ghost" size="sm" onClick={startAdding}>
											<Plus aria-hidden /> Add model
										</Button>
									)}
									{!isDefault && chosen.length > 0 && (
										<Button type="button" variant="ghost" size="sm" onClick={makeDefault}>
											<Star aria-hidden /> Make default
										</Button>
									)}
								</div>
							</div>
						)}
					</PopoverContent>
				</Popover>
			</div>
		);
	}

	return (
		// The start inset keeps the first row clear of the shell's floating menu
		// button on a short phone screen (AppShell, A11Y-5).
		<div ref={root} className="flex min-w-0 flex-col items-start gap-0.5 ps-[var(--shell-menu-inset,0px)]">
			{slots.map((id, idx) => {
				const stored = idx < selected.length;
				const invalid = stored && !id && openSlot !== idx;
				return (
					// Keyed by position: choosing another model keeps the row, and focus returns to its picker.
					<div key={idx} className="flex max-w-full flex-col items-start">
						<div className="flex max-w-full items-center gap-1">
							<Popover
								open={openSlot === idx}
								onOpenChange={(o) => {
									setOpenSlot(o ? idx : null);
									if (o || stored) return;
									// The added row goes: focus returns to what added it (NAV-4), once the list has closed.
									setAdding(false);
									setTimeout(() => addButton.current?.focus(), 0);
								}}
							>
								<Tip content={idx === 0 ? tip : undefined}>
									<PopoverTrigger asChild>
										<Button
											type="button"
											id={idx === 0 ? 'model-selector-model-button' : undefined}
											disabled={disabled}
											variant="ghost"
											className="text-title min-w-0 shrink"
											aria-label={`Model: ${nameOf(id)}`}
											aria-invalid={invalid || undefined}
											aria-describedby={invalid ? `${helpId}-${idx}` : undefined}
										>
											<span className="truncate">{nameOf(id)}</span>
											<ChevronDown aria-hidden className="size-4 shrink-0" />
										</Button>
									</PopoverTrigger>
								</Tip>
								<PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-1.5">
									<ModelList models={visible} value={id} onPick={(m) => pick(idx, m)} extras={extrasFor(idx)} />
								</PopoverContent>
							</Popover>
							{idx === 0 && multiple && (
								<Tip content="Add model">
									<Button
										ref={addButton}
										type="button"
										aria-label="Add model"
										variant="ghost"
										size="icon-xs"
										disabled={disabled}
										onClick={startAdding}
									>
										<Plus aria-hidden className="size-3.5" />
									</Button>
								</Tip>
							)}
							{idx > 0 && (
								<Tip content="Remove model">
									<Button
										type="button"
										aria-label="Remove model"
										variant="ghost"
										size="icon-xs"
										disabled={disabled}
										onClick={() => remove(idx)}
									>
										<Minus aria-hidden className="size-3.5" />
									</Button>
								</Tip>
							)}
						</div>
						{invalid && (
							<p id={`${helpId}-${idx}`} className="flex items-center gap-1 px-3 text-caption text-danger">
								<AlertCircle aria-hidden className="size-3.5" /> Choose a model or remove this one
							</p>
						)}
					</div>
				);
			})}
		</div>
	);
}
