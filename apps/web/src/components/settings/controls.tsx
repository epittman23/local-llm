import { Check, ChevronDown } from 'lucide-react';
import {
	type ComponentProps,
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState
} from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { SaveBar } from '@/components/ui/save-bar';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { useUnsavedChanges } from '@/lib/ui/useUnsavedChanges';
import { cn } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';

// The form vocabulary of every Settings tab, personal and admin. In the Svelte
// app each tab repeats these class strings and (in the older tabs) hand-rolls
// the layout; admin/Settings/AdminSetting{Section,Row,Field}.svelte are the
// shared parts and are ported here. #999 brought them to the standard: one
// 40 rem column (LAY-6), labels at text-body/550 beside their control,
// descriptions at text-dense, section headings at text-title (TYP-2, TYP-3).

/** The standard field look (FRM-1, LAY-2) for a raw input that cannot be the shared `Input`. */
export const settingInputClass =
	'h-9 w-full min-w-0 rounded-lg border border-border-control bg-surface-1 px-3 text-body transition-colors placeholder:text-foreground-muted focus:border-focus disabled:text-foreground-disabled';
export const settingTextareaClass =
	'w-full rounded-lg border border-border-control bg-surface-1 px-3 py-2 text-body transition-colors placeholder:text-foreground-muted focus:border-focus';

/** `Speech playback speed` -> `speech-playback-speed`: the `data-setting` a search result scrolls to (#1001). */
export const settingSlug = (label: string) =>
	label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');

/**
 * Where a settings tab is shown, and how it reports unsaved changes (FRM-3,
 * #951). A tab never asks "Discard changes?" itself; its host does, once:
 *
 * - `dialog`: the Settings dialog, which asks before another tab or closing
 *   (`settingsModalStore`).
 * - `page`: an admin settings page (`/admin/settings/<tab>`), whose one page
 *   guard (`useUnsavedChanges`) asks before any navigation, another tab
 *   included.
 * - `null`: not inside a settings host (a page elsewhere, a test); dirty
 *   state goes to the dialog's store, as it always has.
 *
 * Something with its own guard that a tab may embed (Admin > Models' model
 * editor) turns that guard off while `kind` is set and reports through
 * `setDirty` instead, so one leave never asks twice.
 */
export type SettingsHost = {
	kind: 'dialog' | 'page' | null;
	setDirty: (dirty: boolean) => void;
	/**
	 * The tab shows its own way back (an editor swapped in for its list), so a
	 * page drops its "All server settings" back: one back at a time (NAV-4).
	 */
	setOwnBack: (own: boolean) => void;
};

const storeSetDirty = (dirty: boolean) => useSettingsModalStore.getState().setDirty(dirty);
const noOwnBack = () => {};
const dialogHost: SettingsHost = { kind: 'dialog', setDirty: storeSetDirty, setOwnBack: noOwnBack };
const SettingsHostContext = createContext<SettingsHost>({ kind: null, setDirty: storeSetDirty, setOwnBack: noOwnBack });

/** The settings host around this component: see `SettingsHost`. */
export const useSettingsHost = () => useContext(SettingsHostContext);

/** Marks its children as shown in the Settings dialog. */
export function SettingsDialogHost({ children }: { children: ReactNode }) {
	return <SettingsHostContext.Provider value={dialogHost}>{children}</SettingsHostContext.Provider>;
}

/**
 * Hosts a settings tab on a page: the page's one unsaved-changes guard, fed
 * by whatever the tab reports. Leaving the page, or opening another tab (a
 * navigation), asks "Discard changes?" first while it is dirty.
 */
export function SettingsPageHost({
	children,
	onOwnBack = noOwnBack
}: {
	children: ReactNode;
	/** Told whether the tab shows its own way back (`SettingsHost.setOwnBack`). */
	onOwnBack?: (own: boolean) => void;
}) {
	const [dirty, setDirty] = useState(false);
	const { dialog } = useUnsavedChanges(dirty, {
		message: 'This tab has changes that are not saved. They are lost if you leave it.'
	});
	const host = useMemo<SettingsHost>(() => ({ kind: 'page', setDirty, setOwnBack: onOwnBack }), [onOwnBack]);
	return (
		<SettingsHostContext.Provider value={host}>
			{children}
			{dialog}
		</SettingsHostContext.Provider>
	);
}

/**
 * FRM-2 in a settings tab: what is wrong with each field, by the field's
 * element id. `SettingsForm` provides it (`errors`); `SettingField` shows a
 * field's error under it in place of its help, `SettingRow` under the row
 * (`fieldId`), and the Setting* controls mark themselves `aria-invalid`.
 */
const SettingErrorsContext = createContext<Readonly<Record<string, string>>>({});
const NO_ERRORS: Readonly<Record<string, string>> = {};

/** The id of the line that says what is wrong with the field `id`. */
export const settingErrorId = (id: string) => `${id}-error`;

/** The error for the field with element id `id`, and the attributes that tie the field to it. */
export function useSettingError(id: string | undefined) {
	const error = useContext(SettingErrorsContext)[id ?? ''];
	return { error, props: id && error ? fieldProps(settingErrorId(id), { error }) : {} };
}

/**
 * Checks a settings tab before it saves (FRM-2). `problems` is what is wrong
 * now, by the element id of the field it is about, in page order. `check()`
 * (or `check(some)`, for a part of the tab) shows the errors under their
 * fields, moves focus to the first wrong field on the page, and says whether
 * the save may go ahead. An error goes as soon as it is put right; a passed
 * check or `reset()` (Discard changes) stops showing them. A wrong field that
 * is not on the page (another engine's) is said in a toast instead, since
 * there is nothing to show it under. Pass `errors` to `SettingsForm`.
 */
export function useSettingErrors(problems: Readonly<Record<string, string>>) {
	const [checked, setChecked] = useState(false);
	return {
		errors: checked ? problems : NO_ERRORS,
		check: (some: Readonly<Record<string, string>> = problems): boolean => {
			const ids = Object.keys(some);
			setChecked(ids.length > 0);
			if (ids.length === 0) return true;
			// After the render this causes: the change that started the save (another engine) may remove the field.
			setTimeout(() => {
				const field = ids.map((id) => document.getElementById(id)).find((element) => element !== null);
				if (!field) {
					toast.error(some[ids[0]]);
					return;
				}
				// Its whole row, so its label shows too.
				(field.closest('[data-setting]') ?? field).scrollIntoView?.({ block: 'nearest' });
				field.focus();
			});
			return false;
		},
		reset: () => setChecked(false)
	};
}

/**
 * A settings tab: heading, scrolling body, and a footer, in one of FRM-3's two
 * ways of saving.
 *
 * - On request, with `dirty` (and `onDiscard`): the shared SaveBar, and its
 *   host (`SettingsHost`: the dialog or the page) asks "Discard changes?"
 *   before the tab is left while dirty (#951).
 * - At once, with `savesAtOnce`: no Save button, and a line under the heading
 *   says so; each control confirms its own save (`SavedNote`). While `saving`,
 *   that line says "Saving…" and the tab's controls are disabled, so a second
 *   change cannot overlap the first and show what the server does not hold
 *   (ACT-5); focus goes back to the control that had it.
 * - Neither (the admin tabs, until they adopt `dirty`): a Save button.
 *
 * Submitting the form saves; `saving` disables the button and shows a spinner
 * (the Svelte tabs each do this differently -- some do not guard double
 * submits at all); `disabled` turns saving off without one.
 */
export function SettingsForm({
	title,
	onSubmit,
	saving = false,
	loading = false,
	disabled = false,
	footer = true,
	dirty,
	onDiscard,
	savesAtOnce = false,
	errors = NO_ERRORS,
	after,
	children
}: {
	title: string;
	onSubmit?: () => void | Promise<void>;
	saving?: boolean;
	loading?: boolean;
	disabled?: boolean;
	footer?: boolean;
	/** Changes not yet saved: shows the SaveBar and guards leaving the tab. */
	dirty?: boolean;
	onDiscard?: () => void;
	/** Every control saves as it changes. */
	savesAtOnce?: boolean;
	/** What is wrong with each field, by its element id (`useSettingErrors`). */
	errors?: Readonly<Record<string, string>>;
	/** Rendered after the form, outside it: another form whose fields sit in this one and name it with `form=`. */
	after?: ReactNode;
	children: ReactNode;
}) {
	const guarded = dirty !== undefined;
	const { setDirty } = useSettingsHost();
	// An at-once save in flight holds the controls; disabling the focused one drops focus (Chromium
	// moves it to <body> as the fieldset is disabled), so the control focused last gets it back after.
	const holding = savesAtOnce && saving;
	const lastFocused = useRef<HTMLElement | null>(null);
	const wasHolding = useRef(false);
	useLayoutEffect(() => {
		const released = wasHolding.current && !holding;
		wasHolding.current = holding;
		if (!released) return;
		const held = lastFocused.current;
		const lost = document.activeElement === null || document.activeElement === document.body;
		if (lost && held?.isConnected) held.focus({ preventScroll: true });
	}, [holding]);
	useEffect(() => {
		if (!guarded) return;
		setDirty(Boolean(dirty));
	}, [guarded, dirty, setDirty]);
	useEffect(() => {
		if (guarded) return () => setDirty(false);
	}, [guarded, setDirty]);
	const form = (
		<form
			className="flex h-full flex-col text-body"
			onFocus={(e) => {
				if (e.target instanceof HTMLElement) lastFocused.current = e.target;
			}}
			onSubmit={(e) => {
				e.preventDefault();
				// A dialog rendered inside a tab (a portal, but still in React's tree) with
				// its own <form> bubbles its submit up to this one. That is the dialog's
				// business, not a request to save the tab.
				if (e.target !== e.currentTarget) return;
				if (!saving && !disabled) onSubmit?.();
			}}
		>
			<div className="mb-6 pe-10">
				<h2 className="text-heading font-title tracking-tight">{title}</h2>
				{savesAtOnce && (
					<p className="text-foreground-muted mt-1 flex items-center gap-2 text-dense">
						{saving && <Spinner className="size-3.5" />}
						{saving ? 'Saving…' : 'Changes are saved as you make them.'}
					</p>
				)}
			</div>
			<div data-settings-body className="relative min-h-0 flex-1 overflow-y-auto pe-2">
				{loading ? (
					<div className="flex h-full items-center justify-center">
						<Spinner className="size-6" />
					</div>
				) : (
					<div className="max-w-160 pb-6">
						{savesAtOnce ? (
							<fieldset disabled={holding} aria-busy={holding || undefined} className="contents">
								{children}
							</fieldset>
						) : (
							children
						)}
					</div>
				)}
			</div>
			{guarded && !loading && (
				<SaveBar
					className="max-w-160"
					dirty={Boolean(dirty)}
					saving={saving}
					disabled={disabled}
					onDiscard={() => onDiscard?.()}
				/>
			)}
			{footer && !guarded && !savesAtOnce && !loading && (
				<div className="flex max-w-160 justify-end border-t pt-3">
					<Button type="submit" disabled={saving || disabled} aria-busy={saving || undefined}>
						{saving && <Spinner className="size-3.5" />}
						{saving ? 'Saving…' : 'Save'}
					</Button>
				</div>
			)}
		</form>
	);
	return (
		<SettingErrorsContext.Provider value={errors}>
			{form}
			{after}
		</SettingErrorsContext.Provider>
	);
}

/** FRM-3 "at once": the line beside a control that confirms it saved. */
export function SavedNote() {
	return (
		<span role="status" className="text-success inline-flex items-center gap-1 text-dense">
			<Check aria-hidden className="size-3.5" />
			Saved
		</span>
	);
}

/** Which settings just saved, for their `SavedNote`: each shows for `ms` after `flash(keys)`. */
export function useSavedFlash(ms = 2000) {
	const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const flash = useCallback(
		(keys: Iterable<string>) => {
			setSaved(new Set(keys));
			clearTimeout(timer.current);
			timer.current = setTimeout(() => setSaved(new Set()), ms);
		},
		[ms]
	);
	return { isSaved: (key: string) => saved.has(key), flash };
}

/** Ports AdminSettingSection.svelte: an optional heading over a column of settings, below a divider. */
export function SettingsSection({
	title,
	first = false,
	className,
	children
}: {
	title?: string;
	first?: boolean;
	className?: string;
	children: ReactNode;
}) {
	return (
		<section
			aria-label={title}
			data-setting={title ? settingSlug(title) : undefined}
			className={cn(first ? '' : 'mt-8 border-t pt-6', className)}
		>
			{title && <h3 className="text-title font-title mb-4 tracking-tight">{title}</h3>}
			<div className="flex flex-col gap-4">{children}</div>
		</section>
	);
}

/**
 * Ports AdminSettingRow.svelte: the label (and its description under it)
 * beside the control, which wraps under the label when the column is narrow.
 * `children` may be a function of the label's id so the control can be
 * `aria-labelledby` it. A string label also names the row for the settings
 * search (`data-setting`, #1001).
 */
export function SettingRow({
	label,
	description,
	className,
	labelClassName,
	fieldId,
	children
}: {
	label: ReactNode;
	description?: string;
	className?: string;
	labelClassName?: string;
	/** The element id of the row's field, whose error (FRM-2) shows under the row. */
	fieldId?: string;
	children: ReactNode | ((labelId: string) => ReactNode);
}) {
	const labelId = useId();
	const { error } = useSettingError(fieldId);
	return (
		<div
			data-setting={typeof label === 'string' ? settingSlug(label) : undefined}
			className={cn(
				'-mx-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-lg px-2 py-1 transition-colors data-flash:bg-surface-3',
				className
			)}
		>
			<div className="min-w-0 flex-1 basis-48">
				<div id={labelId} className={cn('text-foreground-strong font-strong', labelClassName)}>
					{label}
				</div>
				{description && <p className="text-foreground-muted mt-0.5 text-dense">{description}</p>}
			</div>
			<div className="max-w-full min-w-0 shrink-0">{typeof children === 'function' ? children(labelId) : children}</div>
			{fieldId && error && <FieldMessage id={settingErrorId(fieldId)} error={error} className="basis-full" />}
		</div>
	);
}

/** Ports AdminSettingField.svelte: a stacked label / control / description. */
export function SettingField({
	label,
	description,
	descriptionId,
	optional,
	htmlFor,
	className,
	children
}: {
	label?: string;
	/** Marks the field optional after its label (FRM-6). */
	optional?: boolean;
	description?: ReactNode;
	/** The help line's id, for the field's `aria-describedby` (FRM-2). */
	descriptionId?: string;
	htmlFor?: string;
	className?: string;
	children: ReactNode;
}) {
	const { error } = useSettingError(htmlFor);
	return (
		<div
			data-setting={label ? settingSlug(label) : undefined}
			className={cn('-mx-2 rounded-lg px-2 py-1 transition-colors data-flash:bg-surface-3', className)}
		>
			{label && (
				<label className="text-foreground-strong font-strong" htmlFor={htmlFor}>
					{label}
					{optional && <span className="text-foreground-muted font-normal"> (optional)</span>}
				</label>
			)}
			<div className={label ? 'mt-1.5' : ''}>{children}</div>
			{htmlFor && error ? (
				<FieldMessage id={settingErrorId(htmlFor)} error={error} className="mt-1" />
			) : (
				description && (
					<p id={descriptionId} className="text-foreground-muted mt-1 text-dense">
						{description}
					</p>
				)
			)}
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
	return (
		<Switch
			checked={Boolean(checked)}
			onCheckedChange={onChange}
			aria-labelledby={labelledBy}
			aria-label={labelledBy ? undefined : label}
		/>
	);
}

/**
 * Ports common/SettingsSelect.svelte: a native select with a chevron. It stays
 * native because callers pass `<option>` children (some with an empty value,
 * which the shared Select cannot hold); standard.css gives it the field's edge,
 * fill and radius (FRM-4).
 */
export function SettingSelect({
	value,
	onChange,
	className,
	children,
	...rest
}: Omit<ComponentProps<'select'>, 'value' | 'onChange'> & {
	value: string | number | boolean | null | undefined;
	onChange: (value: string) => void;
}) {
	return (
		<div className={cn('relative inline-flex w-fit max-w-full', className)}>
			<select
				{...rest}
				value={String(value ?? '')}
				onChange={(e) => onChange(e.target.value)}
				className="h-9 w-full max-w-full appearance-none truncate ps-3 pe-9 text-left text-body [field-sizing:content] disabled:text-foreground-disabled"
			>
				{children}
			</select>
			<ChevronDown
				aria-hidden
				className="text-foreground-muted pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2"
			/>
		</div>
	);
}

/** A text/number/url input: the shared `Input`. */
export function SettingInput(props: ComponentProps<'input'>) {
	return <Input {...props} {...useSettingError(props.id).props} />;
}

/** A number field that keeps '' as '' (an empty box means "unset"), otherwise a number. */
export function SettingNumber({
	value,
	onChange,
	...rest
}: Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type'> & {
	value: number | string | null | undefined;
	onChange: (value: number | '') => void;
}) {
	const invalid = useSettingError(rest.id).props;
	return (
		<Input
			{...rest}
			{...invalid}
			type="number"
			value={value ?? ''}
			onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
		/>
	);
}

export function SettingTextarea(props: ComponentProps<'textarea'>) {
	return <Textarea {...props} {...useSettingError(props.id).props} />;
}

/** DAT-5: relative while recent (under a week), else the absolute record time; the exact time on hover. */
export function ChatTime({ seconds }: { seconds?: number }) {
	if (!seconds) return <span>–</span>;
	const date = dayjs(seconds * 1000);
	const exact = date.format('YYYY-MM-DD HH:mm');
	const recent = dayjs().diff(date, 'day') < 7;
	return (
		<time dateTime={date.toISOString()} title={exact}>
			{recent ? date.fromNow() : exact}
		</time>
	);
}
