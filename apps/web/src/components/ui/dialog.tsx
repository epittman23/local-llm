'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Dialog as DialogPrimitive } from 'radix-ui';

import { Button } from '@/components/ui/button';
import { XIcon } from 'lucide-react';
import { toastSafeOutside } from '@/components/ui/toastOutside';
import { useReturnFocus } from '@/lib/ui/returnFocus';

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
	return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
	return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
	return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
	return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
	return (
		<DialogPrimitive.Overlay
			data-slot="dialog-overlay"
			className={cn(
				'fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
				className
			)}
			{...props}
		/>
	);
}

/**
 * OVL-1: a dialog never outgrows the viewport. It is at most the viewport less
 * 1 rem each side, and content taller than that scrolls inside it, so the
 * title, Close and the footer's buttons can always be reached (at 390 px too).
 * A tall form puts its fields in `DialogBody`: then only the body scrolls and
 * the header and footer stay pinned. A `<form>` holding the body and its
 * buttons may sit between (`flex min-h-0 flex-1 flex-col gap-4`, buttons
 * `shrink-0`), so Enter still submits it. A caller with its own layout (Settings,
 * a full-height viewer) replaces `max-h-*` or `overflow-*` in `className`.
 */
function DialogContent({
	className,
	children,
	showCloseButton = true,
	onOpenAutoFocus,
	onCloseAutoFocus,
	onPointerDownOutside,
	onInteractOutside,
	onFocusOutside,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
	showCloseButton?: boolean;
}) {
	const returnFocus = useReturnFocus(onOpenAutoFocus, onCloseAutoFocus);
	return (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Content
				data-slot="dialog-content"
				className={cn(
					'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl has-[>[data-slot=dialog-body]]:flex has-[>[data-slot=dialog-body]]:flex-col has-[>[data-slot=dialog-body]]:overflow-hidden has-[>form>[data-slot=dialog-body]]:flex has-[>form>[data-slot=dialog-body]]:flex-col has-[>form>[data-slot=dialog-body]]:overflow-hidden bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
					className
				)}
				{...props}
				{...toastSafeOutside(onPointerDownOutside, onInteractOutside, onFocusOutside)}
				{...returnFocus}
			>
				{children}
				{showCloseButton && (
					<DialogPrimitive.Close data-slot="dialog-close" asChild>
						<Button variant="ghost" className="absolute top-2 right-2" size="icon-sm">
							<XIcon />
							<span className="sr-only">Close</span>
						</Button>
					</DialogPrimitive.Close>
				)}
			</DialogPrimitive.Content>
		</DialogPortal>
	);
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
	return <div data-slot="dialog-header" className={cn('flex shrink-0 flex-col gap-2', className)} {...props} />;
}

/**
 * OVL-1: the scrolling middle of a tall dialog, between a pinned header and footer. A direct child of `DialogContent`.
 * `relative`: what a field positions out of the flow (a Select's hidden native select, a switch's input) stays inside
 * the body, so the dialog is no taller than it looks and a centred scrollIntoView or find-in-page scrolls only the body.
 */
function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			data-slot="dialog-body"
			className={cn('relative -mx-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4', className)}
			{...props}
		/>
	);
}

function DialogFooter({
	className,
	showCloseButton = false,
	children,
	...props
}: React.ComponentProps<'div'> & {
	showCloseButton?: boolean;
}) {
	return (
		<div
			data-slot="dialog-footer"
			className={cn(
				'-mx-4 -mb-4 flex shrink-0 flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end',
				className
			)}
			{...props}
		>
			{children}
			{showCloseButton && (
				<DialogPrimitive.Close asChild>
					<Button variant="outline">Close</Button>
				</DialogPrimitive.Close>
			)}
		</div>
	);
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
	return (
		<DialogPrimitive.Title
			data-slot="dialog-title"
			className={cn('font-heading text-base leading-none font-medium', className)}
			{...props}
		/>
	);
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
	return (
		<DialogPrimitive.Description
			data-slot="dialog-description"
			className={cn(
				'text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
				className
			)}
			{...props}
		/>
	);
}

export {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogOverlay,
	DialogPortal,
	DialogTitle,
	DialogTrigger
};
