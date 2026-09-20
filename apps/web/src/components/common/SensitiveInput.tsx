import { Eye, EyeOff } from 'lucide-react';
import { type ComponentProps, useId, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Ports common/SensitiveInput.svelte: a text input that is masked until the
 * eye button is pressed. Only the `plain` variant is ported; the `settings`
 * variant (a bordered chip) is used by the admin Settings tabs, which style it
 * themselves through `outerClassName`/`className`.
 */
export function SensitiveInput({
	value,
	onChange,
	className,
	outerClassName = 'flex flex-1',
	required = true,
	readOnly = false,
	placeholder = '',
	...rest
}: Omit<ComponentProps<'input'>, 'onChange' | 'value'> & {
	value: string;
	onChange: (value: string) => void;
	outerClassName?: string;
}) {
	const id = useId();
	const [show, setShow] = useState(false);
	return (
		<div className={outerClassName}>
			<label className="sr-only" htmlFor={id}>
				{placeholder || 'Password'}
			</label>
			<input
				id={id}
				className={cn('w-full bg-transparent py-0.5 text-sm outline-hidden', className)}
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
				className="bg-transparent pl-1.5 transition"
				aria-pressed={show}
				aria-label="Make password visible in the user interface"
				onClick={() => setShow((s) => !s)}
			>
				{show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
			</button>
		</div>
	);
}
