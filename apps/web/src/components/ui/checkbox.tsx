import * as React from 'react';
import { cn } from '@/lib/utils';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { CheckIcon } from 'lucide-react';

// The box, shared by the control and the picture of one (CheckboxMark).
const box =
	'flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary';

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
	return (
		<CheckboxPrimitive.Root
			data-slot="checkbox"
			className={cn(
				box,
				// LAY-3: the 16px box answers clicks across a 40 by 32 area, and 44 by 44 on touch.
				'peer relative transition-[color,background-color,border-color] outline-none group-has-disabled/field:opacity-50 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input after:absolute after:-inset-x-3 after:-inset-y-2 pointer-coarse:after:-inset-3.5 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 group-has-[:focus-visible]/field-label:data-checked:border-primary',
				className
			)}
			{...props}
		>
			<CheckboxPrimitive.Indicator
				data-slot="checkbox-indicator"
				className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
			>
				<CheckIcon />
			</CheckboxPrimitive.Indicator>
		</CheckboxPrimitive.Root>
	);
}

/**
 * A checkbox's picture, not a control: for a row that is itself the checkbox
 * (a `RowButton` with `role="checkbox"` and `aria-checked`), where a real
 * Checkbox would be a button inside a button (A11Y-2, ACT-7).
 */
function CheckboxMark({ checked, className, ...props }: React.ComponentProps<'span'> & { checked: boolean }) {
	return (
		<span
			aria-hidden
			data-slot="checkbox-mark"
			data-state={checked ? 'checked' : 'unchecked'}
			data-checked={checked ? '' : undefined}
			className={cn(box, className)}
			{...props}
		>
			{checked && <CheckIcon className="size-3.5" />}
		</span>
	);
}

export { Checkbox, CheckboxMark };
