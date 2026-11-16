import { CircleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * FRM-2: the line under a field. Its help, or, when the field is wrong, an
 * error in its place: the danger colour with an icon, announced as it
 * appears. Give it the `id` the field names in `aria-describedby`, and set
 * the field's `aria-invalid` while there is an error (`fieldProps` does both).
 * Renders nothing when there is neither.
 */
export function FieldMessage({
	id,
	error,
	help,
	className
}: {
	id: string;
	error?: ReactNode;
	help?: ReactNode;
	className?: string;
}) {
	if (error) {
		return (
			<p
				id={id}
				role="alert"
				data-slot="field-message"
				className={cn('text-danger text-dense flex items-start gap-1.5', className)}
			>
				<CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
				<span>{error}</span>
			</p>
		);
	}
	if (!help) return null;
	return (
		<p id={id} data-slot="field-message" className={cn('text-foreground-muted text-dense', className)}>
			{help}
		</p>
	);
}

/** The attributes that tie a field to its `FieldMessage`: spread them on the input. */
export function fieldProps(
	id: string,
	{ error, help }: { error?: ReactNode; help?: ReactNode }
): { 'aria-describedby'?: string; 'aria-invalid'?: true } {
	return {
		'aria-describedby': error || help ? id : undefined,
		'aria-invalid': error ? true : undefined
	};
}
