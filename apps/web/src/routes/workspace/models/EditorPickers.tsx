import { Check, ChevronDown, Search } from 'lucide-react';
import { useState } from 'react';
import { Tip } from '@/components/common/Tip';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';

const sectionLabel = 'mb-1.5 text-xs text-muted-foreground';

// --- a grid of labelled checkboxes with a hover description ---------------------

export type CheckItem = { id: string; label: string; description: string };

/**
 * Ports the three near-identical Capabilities / Default Features / Builtin Tools
 * lists from workspace/Models/*.svelte: a titled grid of checkboxes whose label
 * shows a markdown description on hover. What "checked" means differs (a set
 * membership, a boolean, or "not explicitly false"), so the caller supplies it.
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
	return (
		<div>
			<div className={sectionLabel}>{title}</div>
			<div className="grid grid-cols-1 gap-x-5 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
				{items.map((item) => (
					<div key={item.id} className="flex min-h-6 items-center gap-2.5">
						<Checkbox aria-label={item.label} checked={isChecked(item.id)} onCheckedChange={(c) => onToggle(item.id, c === true)} />
						<button type="button" className="min-w-0 text-left" onClick={() => onToggle(item.id, !isChecked(item.id))}>
							<Tip content={<SafeMarkdown text={item.description} className="text-background" />} side="top">
								<span className="block truncate">{item.label}</span>
							</Tip>
						</button>
					</div>
				))}
			</div>
		</div>
	);
}

// --- pick from a searchable list; picked items are shown as checkboxes -----------

export type PickItem = { id: string; name?: string; is_global?: boolean; meta?: { description?: string }; description?: string };

/**
 * Ports the Tools / Skills / Filters / Default Filters / Actions selectors (they
 * are the same component five times over in the Svelte app, differing in labels).
 * A "Select ..." dropdown searches `items` by id, name or description and toggles
 * on click, with "Enable all (n)" for whatever the search currently matches. The
 * picked items appear below as checked boxes; global items (filters and actions
 * that apply to every model) are shown checked and cannot be turned off here.
 */
export function ItemPicker({
	title,
	items,
	selectedIds,
	onChange,
	labels,
	footnote,
	lockGlobal = false
}: {
	title: string;
	items: PickItem[];
	selectedIds: string[];
	onChange: (ids: string[]) => void;
	labels: { search: string; trigger: string; empty: string };
	footnote?: string;
	lockGlobal?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');

	const selectable = lockGlobal ? items.filter((i) => !i.is_global) : items;
	const shown = lockGlobal ? items.filter((i) => i.is_global || selectedIds.includes(i.id)) : items.filter((i) => selectedIds.includes(i.id));
	const q = query.trim().toLowerCase();
	const matches = selectable.filter(
		(i) =>
			q === '' ||
			i.id.toLowerCase().includes(q) ||
			(i.name ?? '').toLowerCase().includes(q) ||
			(i.description ?? i.meta?.description ?? '').toLowerCase().includes(q)
	);
	const toggle = (id: string) => onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);

	return (
		<div>
			<div className="mb-1 flex w-full items-center gap-2">
				<div className="text-muted-foreground self-center text-xs">{title}</div>
				{selectable.length > 0 && (
					<Popover
						open={open}
						onOpenChange={(next) => {
							setOpen(next);
							if (!next) setQuery('');
						}}
					>
						<PopoverTrigger asChild>
							<button type="button" className="text-muted-foreground min-w-0 truncate text-xs hover:underline">
								{labels.trigger}
							</button>
						</PopoverTrigger>
						<PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] p-0.5">
							<div className="flex w-full items-center space-x-1.5 px-1.5 pb-0.5">
								<Search className="mr-1.5 size-3.5 shrink-0 self-center" />
								<input
									autoFocus
									className="w-full bg-transparent py-0.5 text-[0.8125rem] outline-hidden"
									type="text"
									aria-label={labels.search}
									placeholder={labels.search}
									autoComplete="off"
									value={query}
									onChange={(e) => setQuery(e.target.value)}
								/>
							</div>
							<div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
								{matches.length > 0 && (
									<button
										type="button"
										className="hover:bg-muted/50 h-7 w-full rounded-xl px-2 text-left text-[0.8125rem]"
										onClick={() => {
											onChange([...new Set([...selectedIds, ...matches.map((m) => m.id)])]);
											setOpen(false);
										}}
									>
										Enable all ({matches.length})
									</button>
								)}
								{matches.length === 0 ? (
									<div className="text-muted-foreground pt-4 pb-6 text-center text-xs">{labels.empty}</div>
								) : (
									matches.map((item) => (
										<button
											key={item.id}
											type="button"
											aria-pressed={selectedIds.includes(item.id)}
											className="hover:bg-muted/50 flex h-7 w-full items-center justify-between gap-2 rounded-xl px-2 text-left text-[0.8125rem]"
											onClick={() => {
												toggle(item.id);
												setOpen(false);
											}}
										>
											<span className="min-w-0 flex-1 truncate">{item.name || item.id}</span>
											{selectedIds.includes(item.id) && <Check className="text-muted-foreground size-3.5 shrink-0" />}
										</button>
									))
								)}
							</div>
						</PopoverContent>
					</Popover>
				)}
			</div>
			<div className="mb-1 flex flex-col">
				<div className="mt-1 flex flex-wrap items-center">
					{shown.map((item) => (
						<div key={item.id} className="mr-3 flex items-center gap-2">
							<Checkbox
								aria-label={item.name ?? item.id}
								checked
								disabled={lockGlobal && item.is_global}
								onCheckedChange={(c) => c !== true && onChange(selectedIds.filter((x) => x !== item.id))}
							/>
							<Tip content={item.meta?.description ?? item.id}>
								<div className="py-0.5 text-xs capitalize">{item.name}</div>
							</Tip>
						</div>
					))}
					{shown.some((i) => !(lockGlobal && i.is_global)) && (
						<button type="button" className="text-muted-foreground text-xs hover:underline" onClick={() => onChange([])}>
							Disable all
						</button>
					)}
				</div>
			</div>
			{footnote && <div className="text-muted-foreground/70 text-xs">{footnote}</div>}
		</div>
	);
}

// --- base model ----------------------------------------------------------------

/** A searchable single-choice list, for "Base Model (From)". */
export function BaseModelSelect({
	items,
	value,
	onChange,
	placeholder
}: {
	items: Array<{ value: string; label: string }>;
	value: string | null;
	onChange: (value: string) => void;
	placeholder: string;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const q = query.trim().toLowerCase();
	const shown = items.filter((i) => q === '' || i.label.toLowerCase().includes(q) || i.value.toLowerCase().includes(q));
	const current = items.find((i) => i.value === value);

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setQuery('');
			}}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label="Base model"
					className={cn('border-border flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-left text-xs', !current && 'text-muted-foreground')}
				>
					<span className="truncate">{current?.label ?? value ?? placeholder}</span>
					<ChevronDown className="size-3.5 shrink-0" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0.5">
				<div className="flex items-center px-1.5 pb-0.5">
					<Search className="mr-1.5 size-3.5 shrink-0" />
					<input
						autoFocus
						className="w-full bg-transparent py-0.5 text-[0.8125rem] outline-hidden"
						aria-label="Search a model"
						placeholder="Search a model"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</div>
				<div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
					{shown.length === 0 ? (
						<div className="text-muted-foreground py-4 text-center text-xs">No results found</div>
					) : (
						shown.map((item) => (
							<button
								key={item.value}
								type="button"
								className="hover:bg-muted/50 flex h-7 w-full items-center justify-between gap-2 rounded-xl px-2 text-left text-[0.8125rem]"
								onClick={() => {
									onChange(item.value);
									setOpen(false);
								}}
							>
								<span className="min-w-0 flex-1 truncate">{item.label}</span>
								{item.value === value && <Check className="size-3.5 shrink-0" />}
							</button>
						))
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
