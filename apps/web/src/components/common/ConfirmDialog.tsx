import type { ReactNode } from 'react';
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle
} from '@/components/ui/alert-dialog';

/**
 * Ports common/ConfirmDialog.svelte's common shape: a title, a body, and
 * Confirm/Cancel. (Its `input` mode -- a text field the user must fill before
 * confirming -- is not ported; nothing in the workspace surface uses it.)
 */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	children,
	confirmLabel = 'Confirm',
	cancelLabel = 'Cancel',
	onConfirm,
	onCloseAutoFocus
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	children?: ReactNode;
	confirmLabel?: string;
	cancelLabel?: string;
	onConfirm: () => void | Promise<void>;
	/** Where focus goes when the dialog closes (Radix's own handler: call `preventDefault` to move it yourself). */
	onCloseAutoFocus?: (event: Event) => void;
}) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div>{children}</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
					<AlertDialogAction onClick={() => onConfirm()}>{confirmLabel}</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
