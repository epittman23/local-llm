import { ChevronDown } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId } from 'react';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

// The compact form vocabulary of the admin Settings tabs. In the Svelte app each
// tab repeats these class strings and (in the older tabs) hand-rolls the layout;
// admin/Settings/AdminSetting{Section,Row,Field}.svelte are the shared parts and
// are ported here, with the input classes that every tab copies.

export const settingInputClass =
	'h-7 w-full rounded-lg border bg-muted/40 px-2 text-xs outline-hidden transition-colors placeholder:text-muted-foreground/50 focus:border-ring disabled:opacity-50';
export const settingTextareaClass =
	'w-full rounded-lg border bg-muted/40 px-2 py-1.5 text-xs outline-hidden transition-colors placeholder:text-muted-foreground/50 focus:border-ring';

/**
 * A settings tab: heading, scrolling body, and (unless `footer` is false) a
 * Save button pinned below it. Submitting the form saves; `saving` disables the
 * button and shows a spinner (the Svelte tabs each do this differently -- some
 * do not guard double submits at all).
 */
export function SettingsForm({
	title,
	onSubmit,
	saving = false,
	loading = false,
	footer = true,
	children
}: {
	title: string;
	onSubmit?: () => void | Promise<void>;
	saving?: boolean;
	loading?: boolean;
	footer?: boolean;
	children: ReactNode;
}) {
	return (
		<form
			className="flex h-full flex-col justify-between text-sm"
			onSubmit={(e) => {
				e.preventDefault();
				// A dialog rendered inside a tab (a portal, but still in React's tree) with
				// its own <form> bubbles its submit up to this one. That is the dialog's
				// business, not a request to save the tab.
				if (e.target !== e.currentTarget) return;
				if (!saving) onSubmit?.();
			}}
		>
			<h2 className="mb-4 text-sm font-medium">{title}</h2>
			<div className="min-h-0 flex-1 overflow-y-auto pr-1.5">
				{loading ? (
					<div className="flex h-full items-center justify-center">
						<Spinner className="size-6" />
					</div>
				) : (
					children
				)}
			</div>
			{footer && !loading && (
				<div className="flex justify-end pt-3 text-sm font-normal">
					<Button type="submit" disabled={saving}>
						Save
						{saving && <Spinner className="size-3.5" />}
					</Button>
				</div>
			)}
		</form>
	);
}

/** Ports AdminSettingSection.svelte: an optional heading over a column of settings. */
export function SettingsSection({ title, first = false, className, children }: { title?: string; first?: boolean; className?: string; children: ReactNode }) {
	return (
		<section className={cn(first ? '' : 'mt-5', className)}>
			{title && <h3 className="text-muted-foreground mb-2 text-xs">{title}</h3>}
			<div className="flex flex-col gap-2.5">{children}</div>
		</section>
	);
}

/**
 * Ports AdminSettingRow.svelte: label (and a description underneath) on the
 * left, the control on the right. `children` may be a function of the label's
 * id so the control can be `aria-labelledby` it.
 */
export function SettingRow({
	label,
	description,
	className,
	labelClassName,
	children
}: {
	label: ReactNode;
	description?: string;
	className?: string;
	labelClassName?: string;
	children: ReactNode | ((labelId: string) => ReactNode);
}) {
	const labelId = useId();
	return (
		<>
			<div className={cn('flex items-center justify-between gap-4', className)}>
				<div id={labelId} className={cn('text-muted-foreground min-w-0 text-xs', labelClassName)}>
					{label}
				</div>
				<div className="min-w-0">{typeof children === 'function' ? children(labelId) : children}</div>
			</div>
			{description && <p className="text-muted-foreground/70 -mt-1 text-[0.6875rem]">{description}</p>}
		</>
	);
}

/** Ports AdminSettingField.svelte: a stacked label / control / description. */
export function SettingField({
	label,
	description,
	htmlFor,
	className,
	children
}: {
	label?: string;
	description?: string;
	htmlFor?: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={className}>
			{label && (
				<label className="text-muted-foreground text-xs" htmlFor={htmlFor}>
					{label}
				</label>
			)}
			<div className={label ? 'mt-1' : ''}>{children}</div>
			{description && <p className="text-muted-foreground/70 mt-0.5 text-[0.6875rem]">{description}</p>}
		</div>
	);
}

/** A switch bound to `checked`; pass the row's `labelId` as `labelledBy`. */
export function SettingSwitch({
	checked,
	onChange,
	labelledBy,
	label
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	labelledBy?: string;
	label?: string;
}) {
	return <Switch checked={Boolean(checked)} onCheckedChange={onChange} aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : label} />;
}

/** Ports common/SettingsSelect.svelte: a compact native select with a chevron. */
export function SettingSelect({
	value,
	onChange,
	className,
	children,
	...rest
}: Omit<ComponentProps<'select'>, 'value' | 'onChange'> & { value: string | number | boolean | null | undefined; onChange: (value: string) => void }) {
	return (
		<div className={cn('relative inline-flex w-fit max-w-full', className)}>
			<select
				{...rest}
				value={String(value ?? '')}
				onChange={(e) => onChange(e.target.value)}
				className="bg-muted/40 focus:border-ring h-7 w-full max-w-full appearance-none truncate rounded-lg border ps-2.5 pe-8 text-left text-xs outline-hidden transition-colors [field-sizing:content] disabled:opacity-50"
			>
				{children}
			</select>
			<ChevronDown className="text-muted-foreground pointer-events-none absolute end-2 top-1/2 size-3.5 -translate-y-1/2" strokeWidth={2} />
		</div>
	);
}

/** A text/number/url input in the compact style. */
export function SettingInput({ className, ...rest }: ComponentProps<'input'>) {
	return <input className={cn(settingInputClass, className)} {...rest} />;
}

/** `<input type="number">` that keeps '' as '' (an empty box means "unset"), otherwise a number. */
export function SettingNumber({
	value,
	onChange,
	...rest
}: Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type'> & { value: number | string | null | undefined; onChange: (value: number | '') => void }) {
	return (
		<input
			{...rest}
			type="number"
			className={settingInputClass}
			value={value ?? ''}
			onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
		/>
	);
}

export function SettingTextarea({ className, ...rest }: ComponentProps<'textarea'>) {
	return <textarea className={cn(settingTextareaClass, className)} {...rest} />;
}
