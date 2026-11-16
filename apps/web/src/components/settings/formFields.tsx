import { ChevronRight, CircleCheck } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

// The form language of Admin's settings forms and the connection dialogs
// (#933): Add/Edit connection, Ollama, tool server, terminal server and
// knowledge source. Every field is the shared control with its label above and
// its line under (FRM-1, FRM-2); a rarely used group sits behind a closed
// disclosure (FRM-6), drawn as the model editor draws its Advanced.

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
 * FRM-6: a closed-by-default group, opened by a chevron button that says
 * whether it is open (`aria-expanded`). Opening it brings it into view in the
 * scroller around it (#960: it used to open below the fold, unseen).
 */
export function Disclosure({
	title,
	defaultOpen = false,
	open: openProp,
	onOpenChange,
	className,
	children
}: {
	title: ReactNode;
	defaultOpen?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	className?: string;
	children: ReactNode;
}) {
	const [own, setOwn] = useState(defaultOpen);
	const open = openProp ?? own;
	const id = useId();
	const body = useRef<HTMLDivElement>(null);
	const opened = useRef(false);
	useEffect(() => {
		if (open && opened.current) body.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
		opened.current = true;
	}, [open]);
	return (
		<div className={className}>
			<Button
				variant="ghost"
				type="button"
				className="text-body -ms-2"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => {
					setOwn(!open);
					onOpenChange?.(!open);
				}}
			>
				<ChevronRight aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
				{title}
			</Button>
			<div id={id} ref={body} hidden={!open} className="mt-3">
				{open && children}
			</div>
		</div>
	);
}

/** What a connection test found: a line in the success colour, or the reason, under the URL. */
export type TestResult = { ok: true; text: string } | { ok: false; text: string };

/** "Reachable: 2 models" from a model-list answer, or the reason it is not one. */
export function modelListResult(answer: unknown): TestResult {
	const data = (answer as { data?: unknown } | null)?.data;
	const list = Array.isArray(answer) ? answer : Array.isArray(data) ? data : null;
	if (!list) return { ok: false, text: "Reached the server, but it didn't return a model list." };
	return { ok: true, text: `Reachable: ${list.length} model${list.length === 1 ? '' : 's'}` };
}

/** FRM-2: the http/https check made before a URL is sent anywhere; null when it is fine. */
export function urlProblem(url: string): string | null {
	const value = url.trim();
	if (!value) return 'Enter the server’s URL.';
	try {
		const parsed = new URL(value);
		if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return null;
	} catch {
		/* not a URL at all */
	}
	return 'Enter a URL that starts with http:// or https://.';
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
