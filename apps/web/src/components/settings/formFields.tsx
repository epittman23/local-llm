import { ChevronDown, CircleCheck } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { SensitiveInput } from '@/components/common/SensitiveInput';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RowButton } from '@/components/ui/row-button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { TestResult } from './connectionModel';

// The form language of Admin's settings forms and the connection dialogs
// (#933): Add/Edit connection, Ollama, tool server, terminal server and
// knowledge source. Every field is the shared control with its label above and
// its line under (FRM-1, FRM-2); a rarely used group sits behind a closed
// disclosure row (FRM-6), the one every settings form and the model editor use.

/** A field's label, with "(optional)" where the server does not need it (FRM-6). */
export function FieldLabel({
	htmlFor,
	children,
	optional
}: {
	htmlFor?: string;
	children: ReactNode;
	optional?: boolean;
}) {
	return (
		<Label htmlFor={htmlFor} className="text-body font-strong mb-1.5">
			{children}
			{optional && <span className="text-foreground-muted font-normal">(optional)</span>}
		</Label>
	);
}

/**
 * One field: label above, the control (given the id and `fieldProps(messageId,
 * …)` by `children`), and its help or error under it.
 */
export function FormField({
	id,
	label,
	optional,
	help,
	error,
	className,
	children
}: {
	id: string;
	label: ReactNode;
	optional?: boolean;
	help?: ReactNode;
	error?: ReactNode;
	className?: string;
	children: (props: { id: string } & ReturnType<typeof fieldProps>) => ReactNode;
}) {
	const messageId = `${id}-message`;
	return (
		<div className={cn('flex min-w-0 flex-col', className)}>
			<FieldLabel htmlFor={id} optional={optional}>
				{label}
			</FieldLabel>
			{children({ id, ...fieldProps(messageId, { error, help }) })}
			<FieldMessage id={messageId} error={error} help={help} className="mt-1.5" />
		</div>
	);
}

/**
 * A secret (an API key, a client secret): masked until its eye button is
 * pressed, edged like the shared `Input`. Pass the props `FormField` gives.
 */
export function SecretInput({
	value,
	onChange,
	placeholder,
	...props
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
} & ReturnType<typeof fieldProps>) {
	return (
		<div
			data-composite-field
			aria-invalid={props['aria-invalid']}
			className={cn(
				'border-border-control bg-surface-1 flex h-(--control) items-center rounded-lg border ps-3 pe-1 pointer-coarse:h-(--control-touch)',
				props['aria-invalid'] && 'border-danger'
			)}
		>
			<SensitiveInput
				className="text-body"
				outerClassName="min-w-0 items-center"
				value={value}
				onChange={onChange}
				placeholder={placeholder}
				autoComplete="off"
				required={false}
				{...props}
			/>
		</div>
	);
}

// Radix's Select keeps "" for "nothing chosen", so an option whose value is "" goes by this instead.
const EMPTY = '__empty__';

/** FRM-4: a list of choices in the shared `Select`, any of whose values may be "". */
export function SelectField<T extends string>({
	id,
	value,
	onChange,
	options,
	className,
	...props
}: {
	id: string;
	value: T;
	onChange: (value: T) => void;
	options: readonly (readonly [T, string])[];
	className?: string;
} & ReturnType<typeof fieldProps>) {
	return (
		<Select value={value === '' ? EMPTY : value} onValueChange={(v) => onChange((v === EMPTY ? '' : v) as T)}>
			<SelectTrigger id={id} className={cn('w-full', className)} {...props}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map(([v, label]) => (
					<SelectItem key={v || EMPTY} value={v || EMPTY}>
						{label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** A switch with its name beside it (FRM-1): "Enabled", never a bare toggle with a tooltip. */
export function SwitchField({
	id,
	label,
	checked,
	onCheckedChange
}: {
	id: string;
	label: string;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex items-center gap-2.5">
			<Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
			<Label htmlFor={id} className="text-body font-normal">
				{label}
			</Label>
		</div>
	);
}

/**
 * FRM-6: a folded group of settings. One full-width row holds its name, an
 * optional second line, optional `meta` (a count, a badge) and a chevron that
 * turns while open; it says whether it is open (`aria-expanded`) and which
 * panel it opens (`aria-controls`, a panel that is always in the document).
 * Opened, the panel grows in the scroller around it inside a `rounded-lg
 * border` frame, never an inner max-height, and the row and its panel scroll
 * into view together (#960: it used to open below the fold, unseen), with
 * `scroll-mt-3` so the focus outline shows and no smooth scrolling (MOT-2).
 * Only a click scrolls: a caller that opens it itself (a filter opening every
 * group that matches, a form opening Advanced at an error) keeps its place.
 * `level` puts the row in a heading of that level, for groups that are the
 * sections of what holds them.
 */
export function Disclosure({
	title,
	description,
	meta,
	level,
	defaultOpen = false,
	open: openProp,
	onOpenChange,
	className,
	children
}: {
	title: ReactNode;
	description?: ReactNode;
	meta?: ReactNode;
	level?: 3 | 4;
	defaultOpen?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	className?: string;
	children: ReactNode;
}) {
	const [own, setOwn] = useState(defaultOpen);
	const open = openProp ?? own;
	const id = useId();
	const wrapper = useRef<HTMLDivElement>(null);
	const clicked = useRef(false);
	useEffect(() => {
		if (open && clicked.current) wrapper.current?.scrollIntoView?.({ block: 'nearest' });
		clicked.current = false;
	}, [open]);
	const Heading = level ? (`h${level}` as const) : null;
	const row = (
		<RowButton
			className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-3 px-2 py-2"
			aria-expanded={open}
			aria-controls={id}
			// Named by everything it shows, title first (A11Y-2): a name that left out the second
			// line or the count would not contain the visible label (WCAG 2.5.3).
			onClick={() => {
				clicked.current = !open;
				setOwn(!open);
				onOpenChange?.(!open);
			}}
		>
			<span className="min-w-0 flex-1">
				<span className="text-foreground-strong font-strong block">{title}</span>
				{/* Spaces keep the parts apart in the name; the layout ignores them. */}
				{description && ' '}
				{description && <span className="text-foreground-muted mt-1 block text-dense">{description}</span>}
			</span>
			{meta && ' '}
			{meta && <span className="flex shrink-0 items-center gap-2">{meta}</span>}
			<ChevronDown
				aria-hidden
				className={cn(
					'text-foreground-muted mt-0.5 size-4 shrink-0 transition-transform duration-(--motion-fast)',
					open && 'rotate-180'
				)}
			/>
		</RowButton>
	);
	return (
		<div ref={wrapper} className={cn('scroll-mt-3', className)}>
			{Heading ? <Heading>{row}</Heading> : row}
			<div id={id} hidden={!open} className="mt-2 min-w-0 rounded-lg border p-3">
				{open && children}
			</div>
		</div>
	);
}

/**
 * FBK-1, #1018: a URL field with "Test connection" beside it. The result
 * stays under the field until the URL changes: the success line, or the
 * reason, which marks the field `aria-invalid`. `error` is the form's own
 * check of the URL (on leaving it or saving), shown in the same place.
 */
export function ConnectionUrlField({
	id,
	label = 'URL',
	value,
	onChange,
	placeholder,
	error,
	help,
	list,
	testLabel = 'Test connection',
	onTest,
	onBlur
}: {
	id: string;
	label?: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	error?: string | null;
	help?: ReactNode;
	list?: string;
	testLabel?: string;
	onTest: () => Promise<TestResult | null>;
	onBlur?: () => void;
}) {
	const [result, setResult] = useState<TestResult | null>(null);
	const [testing, setTesting] = useState(false);
	const messageId = `${id}-message`;
	const failure = error ?? (result && !result.ok ? result.text : null);
	const success =
		!failure && result?.ok ? (
			<span role="status" className="text-success inline-flex items-center gap-1.5">
				<CircleCheck aria-hidden className="size-3.5 shrink-0" />
				{result.text}
			</span>
		) : null;
	return (
		<div className="flex min-w-0 flex-col">
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<div className="flex flex-wrap items-start gap-2">
				<Input
					id={id}
					className="min-w-48 flex-1"
					type="url"
					inputMode="url"
					value={value}
					autoComplete="off"
					spellCheck={false}
					list={list}
					placeholder={placeholder}
					{...fieldProps(messageId, { error: failure, help: success ?? help })}
					onChange={(e) => {
						setResult(null);
						onChange(e.target.value);
					}}
					onBlur={onBlur}
				/>
				<Button
					type="button"
					variant="outline"
					disabled={testing}
					aria-busy={testing || undefined}
					onClick={async () => {
						setTesting(true);
						setResult(null);
						try {
							setResult(await onTest());
						} finally {
							setTesting(false);
						}
					}}
				>
					{testing && <Spinner className="size-3.5" />}
					{testing ? 'Testing…' : testLabel}
				</Button>
			</div>
			<FieldMessage id={messageId} error={failure} help={success ?? help} className="mt-1.5" />
		</div>
	);
}
