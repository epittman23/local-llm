import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// The Serve page's and the profile form's own field parts, beside the shared
// FormField (components/settings/formFields.tsx).

/** WRD-2: a setting's name in words, with its flag in mono beside it and out of the accessible name. */
export function FlagLabel({ label, flag }: { label: string; flag?: string }) {
	return (
		<>
			{label}
			{flag && (
				<span aria-hidden className="text-foreground-muted font-mono font-normal">
					{flag}
				</span>
			)}
		</>
	);
}

// Radix's Select keeps "" for "nothing chosen", so the "default" option goes by this instead.
const DEFAULT_VALUE = '__default__';

/** FRM-4: the shared Select for a short list whose "" option means "the profile's own". */
export function ChoiceSelect({
	id,
	value,
	onChange,
	options,
	disabled,
	placeholder,
	...props
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
	options: readonly (readonly [string, string])[];
	disabled?: boolean;
	placeholder?: string;
	'aria-describedby'?: string;
	'aria-invalid'?: true;
}) {
	return (
		<Select
			value={value === '' && options.some(([v]) => v === '') ? DEFAULT_VALUE : value}
			onValueChange={(v) => onChange(v === DEFAULT_VALUE ? '' : v)}
			disabled={disabled}
		>
			<SelectTrigger id={id} className="w-full" {...props}>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent>
				{options.map(([v, label]) => (
					<SelectItem key={v || DEFAULT_VALUE} value={v || DEFAULT_VALUE}>
						{label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
