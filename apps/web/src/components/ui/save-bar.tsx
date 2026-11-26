import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * FRM-3, "on request": the line that says whether a view's changes are saved,
 * Discard changes, and a Save button that is disabled until something
 * changed. Busy, Save reads "Saving…" with a spinner and cannot be pressed
 * twice (ACT-5). Inside a form, Save submits it; pass `onSave` to use it
 * outside one. The guard that asks before leaving with unsaved changes is the
 * caller's (Settings: `settingsModalStore`). On a create page (`creating`)
 * nothing is saved yet, so before the first change the line says "Nothing to
 * save yet" rather than "All changes saved". Toasts rise above it
 * (`data-keep-clear`, FBK-2), so a failure never covers Save.
 */
export function SaveBar({
	dirty,
	saving = false,
	disabled = false,
	note,
	onDiscard,
	onSave,
	saveLabel = 'Save',
	creating = false,
	className
}: {
	dirty: boolean;
	saving?: boolean;
	/** Saving is off for another reason (the form did not load); say why in `note`. */
	disabled?: boolean;
	/** A sentence after the status line: why Save is off, or what else the person should know. */
	note?: string;
	onDiscard: () => void;
	onSave?: () => void;
	saveLabel?: string;
	/** A create page: the thing does not exist until Save. */
	creating?: boolean;
	className?: string;
}) {
	return (
		<div data-slot="save-bar" data-keep-clear className={cn('flex flex-wrap items-center justify-end gap-2 border-t pt-3', className)}>
			<p role="status" className="text-foreground-muted me-auto inline-flex items-center gap-2 text-dense max-sm:w-full">
				{dirty && <span aria-hidden className="bg-warning size-2 rounded-full" />}
				{dirty ? 'Unsaved changes' : creating ? 'Nothing to save yet' : 'All changes saved'}
				{note && <span>{note}</span>}
			</p>
			<Button type="button" variant="ghost" disabled={!dirty || saving} onClick={onDiscard}>
				Discard changes
			</Button>
			<Button
				type={onSave ? 'button' : 'submit'}
				onClick={onSave}
				disabled={!dirty || saving || disabled}
				aria-busy={saving || undefined}
			>
				{saving && <Spinner className="size-3.5" />}
				{saving ? 'Saving…' : saveLabel}
			</Button>
		</div>
	);
}
