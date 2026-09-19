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
function FilterMenu({
	value,
	items,
	onChange,
	trigger
}: {
	value: string;
	items: Item[];
	onChange: (value: string) => void;
	trigger: ReactNode;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-40">
				<DropdownMenuRadioGroup value={value} onValueChange={onChange}>
					{items.map((item) => (
						<DropdownMenuRadioItem key={item.value} value={item.value} className="capitalize">
							{item.label.length > 32 ? `${item.label.slice(0, 32)}...` : item.label}
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
export function ViewSelector({
	value,
	onChange
}: {
	value: string;
	onChange: (value: string) => void;
}) {
	const label = viewItems.find((item) => item.value === value)?.label ?? 'Select view';
	return (
		<FilterMenu
			value={value}
			items={viewItems}
			onChange={onChange}
			trigger={
				<Button variant="ghost" size="sm" aria-label="View">
					<span className="truncate">{label}</span>
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
	placeholder = 'Tag'
}: {
	value: string;
	tags: string[];
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	return (
		<div className="flex items-center">
			<FilterMenu
				value={value}
				items={tags.map((tag) => ({ value: tag, label: tag }))}
				onChange={onChange}
				trigger={
					<Button variant="ghost" size="sm" aria-label="Tag" className="capitalize">
						<span className="truncate">{value || placeholder}</span>
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
