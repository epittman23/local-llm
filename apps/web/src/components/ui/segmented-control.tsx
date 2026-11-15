import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

/** `disabled`: shown but not choosable; say why next to the control (ACT-5). */
export type SegmentedOption<T extends string> = { value: T; label: string; icon?: LucideIcon; disabled?: boolean };

/**
 * FRM-4: two to five mutually exclusive choices shown side by side, each a
 * word with an optional line icon (never an emoji, WRD-6). A radio group
 * (Radix): Tab reaches the chosen segment, the arrow keys move and choose,
 * and the choice applies at once, so it belongs where a switch would (FRM-5).
 * Name it with `aria-label` or `aria-labelledby`. The one other use is a
 * required choice with nothing preselected, confirmed by a separate action
 * (the Share dialog's "who can open the link", then Create): a `value`
 * matching no option leaves every segment unchosen. A disabled segment gives
 * its reason in the help line under the control (ACT-5).
 * A disabled segment is drawn in the disabled colour (COL-2). Each segment
 * is a button-like item, so it takes SHP-1's 8 px corner.
 */
export function SegmentedControl<T extends string>({
	value,
	onValueChange,
	options,
	className,
	...aria
}: {
	value: T;
	onValueChange: (value: T) => void;
	options: SegmentedOption<T>[];
	className?: string;
	'aria-label'?: string;
	'aria-labelledby'?: string;
	'aria-describedby'?: string;
}) {
	return (
		<RadioGroupPrimitive.Root
			data-slot="segmented-control"
			value={value}
			onValueChange={(v) => onValueChange(v as T)}
			orientation="horizontal"
			loop
			// On a phone the segments share the width equally, on one row.
			style={{ '--segments': options.length } as CSSProperties}
			className={cn(
				'border-border-control bg-surface-1 inline-flex max-w-full gap-0.5 rounded-lg border p-0.5 max-sm:grid max-sm:w-full max-sm:grid-cols-[repeat(var(--segments),minmax(0,1fr))]',
				className
			)}
			{...aria}
		>
			{options.map(({ value: v, label, icon: Icon, disabled }) => (
				<RadioGroupPrimitive.Item
					key={v}
					value={v}
					disabled={disabled}
					data-slot="segmented-control-item"
					className={cn(
						'text-foreground-muted font-strong inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg px-3 text-body transition-colors hover:text-foreground-strong pointer-coarse:h-11 max-sm:px-1',
						'data-[state=checked]:bg-surface-3 data-[state=checked]:text-foreground-strong',
						// COL-2: a disabled segment's words are the disabled colour, never faded.
						'data-disabled:cursor-not-allowed data-disabled:text-foreground-disabled data-disabled:hover:text-foreground-disabled',
						'[&_svg]:size-4 [&_svg]:shrink-0'
					)}
				>
					{Icon && <Icon aria-hidden />}
					{label}
				</RadioGroupPrimitive.Item>
			))}
		</RadioGroupPrimitive.Root>
	);
}
