import { Command as CommandPrimitive } from 'cmdk';
import { SearchIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A list you choose from by keyboard (the interface standard, NAV-5): the
 * arrow keys move the highlight, Enter chooses, Home and End jump, and the
 * field keeps focus throughout (`aria-activedescendant`). Built on cmdk, in
 * the shape of shadcn/ui's `command`, restyled to the tokens. Pass
 * `shouldFilter={false}` when the items come already matched (a server
 * search); cmdk then only moves the highlight.
 */
function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
	return (
		<CommandPrimitive
			data-slot="command"
			className={cn('flex h-full w-full flex-col overflow-hidden text-foreground', className)}
			{...props}
		/>
	);
}

/** The search field: an icon, then the text. It holds focus while the arrows move through the list. */
function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
	return (
		<div
			data-slot="command-input-wrapper"
			data-composite-field
			className="flex h-(--control) items-center gap-2 rounded-lg border border-border-control bg-surface-1 px-3 pointer-coarse:h-(--control-touch)"
		>
			<SearchIcon aria-hidden className="size-4 shrink-0 text-foreground-muted" />
			<CommandPrimitive.Input
				data-slot="command-input"
				className={cn(
					'h-full w-full min-w-0 bg-transparent text-body outline-none placeholder:text-foreground-muted disabled:cursor-not-allowed',
					className
				)}
				{...props}
			/>
		</div>
	);
}

/** The scrolling list of groups and items (`role="listbox"`). */
function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
	return (
		<CommandPrimitive.List
			data-slot="command-list"
			className={cn('max-h-96 scroll-py-1 overflow-x-hidden overflow-y-auto', className)}
			{...props}
		/>
	);
}

/** Shown by cmdk when no item is rendered: say what was searched and what to do (STA-3). */
function CommandEmpty({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
	return (
		<CommandPrimitive.Empty
			data-slot="command-empty"
			className={cn('px-2 py-6 text-center text-foreground-muted', className)}
			{...props}
		/>
	);
}

/** A labelled run of items; the `heading` is a caption above them. */
function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
	return (
		<CommandPrimitive.Group
			data-slot="command-group"
			className={cn(
				'overflow-hidden py-1 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-caption **:[[cmdk-group-heading]]:font-strong **:[[cmdk-group-heading]]:text-foreground-muted',
				className
			)}
			{...props}
		/>
	);
}

/**
 * One choice (`role="option"`). The highlighted one is on `--surface-3`, as a
 * row under the pointer is; Enter or a press calls `onSelect`. 36 px with a
 * pointer, 44 px on touch (LAY-3).
 */
function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
	return (
		<CommandPrimitive.Item
			data-slot="command-item"
			className={cn(
				'relative flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-body outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:text-foreground-disabled data-[selected=true]:bg-surface-3 pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
				className
			)}
			{...props}
		/>
	);
}

function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
	return (
		<CommandPrimitive.Separator
			data-slot="command-separator"
			className={cn('-mx-1 h-px bg-border-divider', className)}
			{...props}
		/>
	);
}

/** Says the list is still loading, in place of the items (STA-2); give it the skeleton or words. */
function CommandLoading({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Loading>) {
	return <CommandPrimitive.Loading data-slot="command-loading" className={cn('py-1', className)} {...props} />;
}

export { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandLoading, CommandSeparator };
