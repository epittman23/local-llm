import { ChevronDown, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

type Item = { value: string; label: string };

// Radix's <Select> refuses an item whose value is '' -- and '' is exactly what
// "All" and "no tag" are here, and what the backend's query param expects. A
// radio group in a dropdown has no such restriction, and is what the Svelte
// `common/Select.svelte` these two wrap looks like anyway (a button-styled
// trigger opening a menu of checkable rows).
export function FilterMenu({
	value,
	items,
	onChange,
	trigger,
	asWritten = false
}: {
	value: string;
	items: Item[];
	onChange: (value: string) => void;
	trigger: ReactNode;
	/** Identifiers (model ids): shown whole and as written, never capitalised or cut. */
	asWritten?: boolean;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className={asWritten ? 'max-w-[min(28rem,calc(100vw-2rem))] min-w-40' : 'min-w-40'}
			>
				<DropdownMenuRadioGroup value={value} onValueChange={onChange}>
					{items.map((item) => (
						<DropdownMenuRadioItem
							key={item.value}
							value={item.value}
							className={asWritten ? 'font-mono [overflow-wrap:anywhere]' : 'capitalize'}
						>
							{asWritten || item.label.length <= 32 ? item.label : `${item.label.slice(0, 32)}...`}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

const viewItems: Item[] = [
	{ value: '', label: 'All' },
	{ value: 'created', label: 'Created by you' },
	{ value: 'shared', label: 'Shared with you' }
];

/** Ports workspace/common/ViewSelector.svelte: All / Created by you / Shared with you. */
export function ViewSelector({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	const label = viewItems.find((item) => item.value === value)?.label ?? 'Select view';
	return (
		<FilterMenu
			value={value}
			items={viewItems}
			onChange={onChange}
			trigger={
				<Button variant="ghost" size="sm">
					<span className="truncate">View: {label}</span>
					<ChevronDown />
				</Button>
			}
		/>
	);
}

/**
 * Ports workspace/common/TagSelector.svelte. With a tag selected the chevron
 * becomes a clear button, as in the original -- the clear is a sibling of the
 * menu trigger rather than nested inside it (a button in a button is invalid
 * HTML, which the Svelte version gets away with).
 */
export function TagSelector({
	value,
	tags,
	onChange,
	placeholder = 'All tags',
	name = 'Tag',
	labels = {},
	asWritten = false
}: {
	value: string;
	tags: string[];
	onChange: (value: string) => void;
	placeholder?: string;
	/** What the filter chooses, read before its value (A11Y-2): "Source: All sources". */
	name?: string;
	/** Display text for a value, where it differs from the value itself. */
	labels?: Record<string, string>;
	/** The values are identifiers (model ids): shown as written, never capitalised. */
	asWritten?: boolean;
}) {
	return (
		<div className="flex items-center">
			<FilterMenu
				value={value}
				items={tags.map((tag) => ({ value: tag, label: labels[tag] ?? tag }))}
				onChange={onChange}
				asWritten={asWritten}
				trigger={
					<Button variant="ghost" size="sm" className="max-w-full shrink" title={value || undefined}>
						<span className="sr-only">{name}: </span>
						{/* A tag reads as written but capitalised, an id exactly as written; the placeholder is a sentence (WRD-1). */}
						<span className={!value ? 'truncate' : asWritten ? 'truncate font-mono' : 'truncate capitalize'}>
							{value ? (labels[value] ?? value) : placeholder}
						</span>
						{!value && <ChevronDown />}
					</Button>
				}
			/>
			{value && (
				<Button variant="ghost" size="icon-xs" aria-label="Clear tag" onClick={() => onChange('')}>
					<X />
				</Button>
			)}
		</div>
	);
}
