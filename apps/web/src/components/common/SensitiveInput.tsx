import { Eye, EyeOff } from 'lucide-react';
import { type ComponentProps, useId, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Ports common/SensitiveInput.svelte: a text input that is masked until the
 * eye button is pressed. `variant="settings"` is the compact bordered chip the
 * admin Settings tabs use.
 *
 * Always masked at first. The Svelte component only masks when `type="password"`
 * is passed, and the Settings tabs pass `type="text"` -- so their API keys and
 * tokens sit on screen in plain text until someone notices.
 */
export function SensitiveInput({
	value,
	onChange,
	className,
	outerClassName,
	variant = 'plain',
	required = true,
	readOnly = false,
	placeholder = '',
	...rest
}: Omit<ComponentProps<'input'>, 'onChange' | 'value'> & {
	value: string;
	onChange: (value: string) => void;
	outerClassName?: string;
	variant?: 'plain' | 'settings';
}) {
	const id = useId();
	const [show, setShow] = useState(false);
	const settings = variant === 'settings';
	return (
		<div
			className={cn(
				settings ? 'bg-muted/40 focus-within:border-ring flex h-7 flex-1 items-center rounded-lg border px-2 transition-colors' : 'flex flex-1',
				outerClassName
			)}
		>
			<label className="sr-only" htmlFor={id}>
				{placeholder || 'Password'}
			</label>
			<input
				id={id}
				className={cn(
					settings
						? 'placeholder:text-muted-foreground/50 min-w-0 flex-1 bg-transparent text-xs outline-hidden disabled:opacity-50'
						: 'w-full bg-transparent py-0.5 text-sm outline-hidden',
					!settings && className
				)}
				placeholder={placeholder}
				type={show ? 'text' : 'password'}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				required={required && !readOnly}
				disabled={readOnly}
				{...rest}
			/>
			<button
				type="button"
				className={cn('bg-transparent transition', settings ? 'text-muted-foreground hover:text-foreground ml-1.5' : 'pl-1.5')}
				aria-pressed={show}
				aria-label="Make password visible in the user interface"
				onClick={() => setShow((s) => !s)}
			>
				{show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
			</button>
		</div>
	);
}
