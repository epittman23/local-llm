import { Check, ChevronDown } from 'lucide-react';
import { type ReactNode, type Ref, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/** A group's name inside a section (FRM-6): the body size, strong. */
export const groupLabel = 'text-body font-strong';

// --- a grid of labelled checkboxes, each with its description -------------------

/** `off`: the feature is switched off on this install; the row is disabled and says where to turn it on (S4-D3, ACT-5). */
export type CheckItem = { id: string; label: string; description: string; off?: string };

/**
 * The Capabilities / Default features / Builtin tools lists: a titled grid of
 * checkboxes, each with its label tied to it (one Tab stop, the label a
 * target too, LAY-3) and its description on a visible second line (A11Y-4).
 * A row for a feature that is off on this install is disabled and its second
 * line says where to turn it on. What "checked" means differs (a set
 * membership, a boolean, or "not explicitly false"), so the caller supplies
 * it. Ids are scoped to the grid: one capability appears in several lists.
 */
export function CheckboxGrid({
	title,
	items,
	isChecked,
	onToggle
}: {
	title: string;
	items: CheckItem[];
	isChecked: (id: string) => boolean;
	onToggle: (id: string, checked: boolean) => void;
}) {
	const scope = useId();
	return (
		<fieldset>
			<legend className={cn(groupLabel, 'mb-2')}>{title}</legend>
			<div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
				{items.map((item) => {
					const id = `${scope}-${item.id}`;
					return (
						<div key={item.id} className="flex min-w-0 items-start gap-2.5">
							<Checkbox
								id={id}
								className="mt-0.5"
								checked={isChecked(item.id)}
								disabled={Boolean(item.off)}
								aria-describedby={`${id}-help`}
								onCheckedChange={(c) => onToggle(item.id, c === true)}
							/>
							<div className="min-w-0">
								<Label htmlFor={id} className="text-body font-normal">
									{item.label}
								</Label>
								<p id={`${id}-help`} className="text-foreground-muted text-dense mt-0.5">
									{item.off ?? item.description}
								</p>
							</div>
						</div>
					);
				})}
			</div>
		</fieldset>
	);
}

// --- pick from a searchable list; picked items are shown as checkboxes -----------

export type PickItem = {
	id: string;
	name?: string;
	is_global?: boolean;
	meta?: { description?: string };
	description?: string;
};

/**
 * The Tools / Skills / Filters / Default filters / Actions selectors. "Choose
 * ..." opens a searchable list (NAV-5: the arrows move, Enter picks) that
 * toggles an item, then "Add all (n)". Picked items appear below as checked
 * boxes, then "Remove all"; global items (filters and actions that apply to
 * every model) are shown checked and cannot be turned off here. With nothing
 * to pick, `empty` says where to make one (STA-3).
 */
export function ItemPicker({
	title,
	items,
	selectedIds,
	onChange,
	labels,
	empty,
	lockGlobal = false
}: {
	title: string;
	items: PickItem[];
	selectedIds: string[];
	onChange: (ids: string[]) => void;
	labels: { search: string; trigger: string; noMatch: string };
	/** Shown when there is nothing to pick: what to do instead, with a link. */
	empty?: ReactNode;
	lockGlobal?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const scope = useId();

	const selectable = lockGlobal ? items.filter((i) => !i.is_global) : items;
	const shown = lockGlobal
		? items.filter((i) => i.is_global || selectedIds.includes(i.id))
		: items.filter((i) => selectedIds.includes(i.id));
	const toggle = (id: string) =>
		onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);

	return (
		<div>
			<div className="flex min-h-8 w-full flex-wrap items-center gap-x-3 gap-y-1">
				<h4 className={groupLabel}>{title}</h4>
				{selectable.length > 0 && (
					<Popover open={open} onOpenChange={setOpen}>
						<PopoverTrigger asChild>
							<Button variant="outline" size="sm" type="button">
								{labels.trigger}
							</Button>
						</PopoverTrigger>
						<PopoverContent align="start" aria-label={labels.trigger} className="w-[min(24rem,calc(100vw-2rem))] p-1">
							<Command label={labels.trigger}>
								<CommandInput placeholder={labels.search} aria-label={labels.search} />
								<CommandList className="mt-1 max-h-64">
									<CommandEmpty>{labels.noMatch}</CommandEmpty>
									<CommandGroup>
										{selectable.map((item) => (
											<CommandItem
												key={item.id}
												value={item.id}
												keywords={[item.name ?? '', item.description ?? item.meta?.description ?? '']}
												onSelect={() => {
													toggle(item.id);
													setOpen(false);
												}}
											>
												<span className="min-w-0 flex-1 truncate">{item.name || item.id}</span>
												{selectedIds.includes(item.id) && (
													<Check aria-label="Chosen" className="text-foreground-muted size-3.5" />
												)}
											</CommandItem>
										))}
									</CommandGroup>
								</CommandList>
							</Command>
							<Button
								variant="ghost"
								size="sm"
								className="mt-1 w-full justify-start"
								type="button"
								onClick={() => {
									onChange([...new Set([...selectedIds, ...selectable.map((m) => m.id)])]);
									setOpen(false);
								}}
							>
								Add all ({selectable.length})
							</Button>
						</PopoverContent>
					</Popover>
				)}
			</div>
			{shown.length > 0 && (
				<div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
					{shown.map((item) => {
						const id = `${scope}-${item.id}`;
						return (
							<div key={item.id} className="flex min-h-8 items-center gap-2">
								<Checkbox
									id={id}
									checked
									disabled={lockGlobal && item.is_global}
									onCheckedChange={(c) => c !== true && onChange(selectedIds.filter((x) => x !== item.id))}
								/>
								<Label htmlFor={id} className="text-body font-normal">
									{item.name || item.id}
								</Label>
							</div>
						);
					})}
					{shown.some((i) => !(lockGlobal && i.is_global)) && (
						<Button variant="ghost" size="sm" type="button" onClick={() => onChange([])}>
							Remove all
						</Button>
					)}
				</div>
			)}
			{items.length === 0 && empty && <p className="text-foreground-muted text-dense mt-1">{empty}</p>}
		</div>
	);
}

// --- base model ----------------------------------------------------------------

/**
 * A searchable single-choice list, for "Base model". Its name is the visible
 * label plus the visible value (`labelId`), so what it shows is what it is
 * called (A11Y-2). `invalid` and `describedBy` tie it to its error (FRM-2).
 */
export function BaseModelSelect({
	items,
	value,
	onChange,
	placeholder,
	labelId,
	invalid,
	describedBy,
	ref
}: {
	items: Array<{ value: string; label: string }>;
	value: string | null;
	onChange: (value: string) => void;
	placeholder: string;
	labelId: string;
	invalid?: boolean;
	describedBy?: string;
	ref?: Ref<HTMLButtonElement>;
}) {
	const [open, setOpen] = useState(false);
	const valueId = useId();
	const current = items.find((i) => i.value === value);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					ref={ref}
					variant="outline"
					className="w-full justify-between shrink"
					type="button"
					aria-labelledby={`${labelId} ${valueId}`}
					aria-invalid={invalid || undefined}
					aria-describedby={describedBy}
				>
					<span id={valueId} className={cn('truncate', !current && !value && 'text-foreground-muted font-normal')}>
						{current?.label ?? value ?? placeholder}
					</span>
					<ChevronDown aria-hidden className="size-3.5 shrink-0" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" aria-label="Choose a base model" className="w-(--radix-popover-trigger-width) p-1">
				<Command label="Choose a base model">
					<CommandInput placeholder="Search models" aria-label="Search models" />
					<CommandList className="mt-1 max-h-64">
						<CommandEmpty>No model matches that search.</CommandEmpty>
						<CommandGroup>
							{items.map((item) => (
								<CommandItem
									key={item.value}
									value={item.value}
									keywords={[item.label]}
									onSelect={() => {
										onChange(item.value);
										setOpen(false);
									}}
								>
									<span className="min-w-0 flex-1 truncate">{item.label}</span>
									{item.value === value && <Check aria-label="Chosen" className="size-3.5" />}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
