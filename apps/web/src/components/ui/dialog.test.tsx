import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogTitle } from '@/components/ui/alert-dialog';
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

// NAV-4: a dialog opened from state, not through its Trigger, still returns
// focus to what opened it when it closes.

type Kind = 'dialog' | 'alert' | 'sheet';

function Harness({
	kind,
	onCloseAutoFocus,
	onOpenAutoFocus
}: {
	kind: Kind;
	onCloseAutoFocus?: (event: Event) => void;
	onOpenAutoFocus?: (event: Event) => void;
}) {
	const [open, setOpen] = useState(false);
	const handlers = { onCloseAutoFocus, onOpenAutoFocus };
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open
			</button>
			<button type="button">Elsewhere</button>
			{kind === 'dialog' && (
				<Dialog open={open} onOpenChange={setOpen}>
					<DialogContent aria-describedby={undefined} {...handlers}>
						<DialogTitle>Add user</DialogTitle>
					</DialogContent>
				</Dialog>
			)}
			{kind === 'alert' && (
				<AlertDialog open={open} onOpenChange={setOpen}>
					<AlertDialogContent aria-describedby={undefined} {...handlers}>
						<AlertDialogTitle>Delete it?</AlertDialogTitle>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
					</AlertDialogContent>
				</AlertDialog>
			)}
			{kind === 'sheet' && (
				<Sheet open={open} onOpenChange={setOpen}>
					<SheetContent aria-describedby={undefined} {...handlers}>
						<SheetTitle>Panel</SheetTitle>
					</SheetContent>
				</Sheet>
			)}
		</>
	);
}

const roleOf = (kind: Kind) => (kind === 'alert' ? 'alertdialog' : 'dialog');

async function openThenEscape(kind: Kind) {
	const opener = screen.getByRole('button', { name: 'Open' });
	opener.focus();
	fireEvent.click(opener);
	const dialog = await screen.findByRole(roleOf(kind));
	expect(dialog.contains(document.activeElement)).toBe(true);
	await act(async () => {
		fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
	});
	expect(screen.queryByRole(roleOf(kind))).toBeNull();
	return opener;
}

describe.each<Kind>(['dialog', 'alert', 'sheet'])('%s focus return', (kind) => {
	it('returns focus to the button that opened it by state', async () => {
		render(<Harness kind={kind} />);
		const opener = await openThenEscape(kind);
		// Radix's FocusScope fires its unmount auto-focus on a later task.
		await waitFor(() => expect(document.activeElement).toBe(opener));
	});

	it('calls the caller’s handlers, and a caller that prevents default keeps focus where it put it', async () => {
		const onOpenAutoFocus = vi.fn();
		let elsewhere: HTMLElement | null = null;
		const onCloseAutoFocus = vi.fn((event: Event) => {
			event.preventDefault();
			elsewhere?.focus();
		});
		render(<Harness kind={kind} onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus} />);
		elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
		await openThenEscape(kind);
		await waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalledOnce());
		expect(onOpenAutoFocus).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(elsewhere);
	});
});

describe('focus return when the opener has gone', () => {
	it('leaves focus to Radix instead of focusing a detached element', async () => {
		function Gone() {
			const [open, setOpen] = useState(false);
			return (
				<>
					{!open && (
						<button type="button" onClick={() => setOpen(true)}>
							Open
						</button>
					)}
					<Dialog open={open} onOpenChange={setOpen}>
						<DialogContent aria-describedby={undefined}>
							<DialogTitle>Gone</DialogTitle>
						</DialogContent>
					</Dialog>
				</>
			);
		}
		render(<Gone />);
		const opener = screen.getByRole('button', { name: 'Open' });
		opener.focus();
		fireEvent.click(opener);
		await screen.findByRole('dialog');
		const focus = vi.spyOn(opener, 'focus');
		await act(async () => {
			fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
		});
		expect(opener.isConnected).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(focus).not.toHaveBeenCalled();
	});
});

describe('focus return when a menu item opened the dialog', () => {
	it('returns focus to the menu’s trigger, since the item has gone', async () => {
		function FromMenu() {
			const [open, setOpen] = useState(false);
			return (
				<>
					<DropdownMenu>
						<DropdownMenuTrigger>Row menu</DropdownMenuTrigger>
						<DropdownMenuContent>
							<DropdownMenuItem onSelect={() => setOpen(true)}>Delete</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					<AlertDialog open={open} onOpenChange={setOpen}>
						<AlertDialogContent aria-describedby={undefined}>
							<AlertDialogTitle>Delete it?</AlertDialogTitle>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
						</AlertDialogContent>
					</AlertDialog>
				</>
			);
		}
		render(<FromMenu />);
		const trigger = screen.getByRole('button', { name: 'Row menu' });
		trigger.focus();
		fireEvent.keyDown(trigger, { key: 'Enter' });
		const item = await screen.findByRole('menuitem', { name: 'Delete' });
		item.focus();
		fireEvent.click(item);
		await screen.findByRole('alertdialog');
		await act(async () => {
			fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
		});
		await waitFor(() => expect(document.activeElement).toBe(trigger));
	});
});

// OVL-1: a tall dialog stays inside the viewport and scrolls, so its title,
// Close and footer can be reached at 390 px (Default Permissions was 1807 px).
describe('a tall dialog', () => {
	it('caps its height at the viewport and scrolls its content', () => {
		render(
			<Dialog open>
				<DialogContent aria-describedby={undefined}>
					<DialogTitle>Permissions</DialogTitle>
				</DialogContent>
			</Dialog>
		);
		const content = screen.getByRole('dialog');
		expect(content.className).toContain('max-h-[calc(100dvh-2rem)]');
		expect(content.className).toContain('overflow-y-auto');
	});

	it('pins the header and footer around a scrolling DialogBody', () => {
		render(
			<Dialog open>
				<DialogContent aria-describedby={undefined}>
					<DialogHeader>
						<DialogTitle>Permissions</DialogTitle>
					</DialogHeader>
					<DialogBody>fields</DialogBody>
					<DialogFooter>buttons</DialogFooter>
				</DialogContent>
			</Dialog>
		);
		const body = screen.getByText('fields');
		expect(body).toHaveAttribute('data-slot', 'dialog-body');
		expect(body.className).toMatch(/min-h-0/);
		expect(body.className).toMatch(/overflow-y-auto/);
		// What a field positions out of the flow (a hidden native select) stays inside the body, so the
		// dialog is no taller than it looks and a scrollIntoView scrolls only the body (OVL-1).
		expect(body).toHaveClass('relative');
		// The content becomes a column that does not scroll itself once it holds a body.
		expect(screen.getByRole('dialog').className).toContain('has-[>[data-slot=dialog-body]]:overflow-hidden');
		expect(screen.getByText('buttons').className).toMatch(/shrink-0/);
		expect(screen.getByText('Permissions').parentElement?.className).toMatch(/shrink-0/);
	});

	it('lets a caller with its own layout replace the cap and the scroll', () => {
		render(
			<Dialog open>
				<DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-hidden">
					<DialogTitle>Viewer</DialogTitle>
				</DialogContent>
			</Dialog>
		);
		const content = screen.getByRole('dialog');
		expect(content.className).toContain('max-h-[90vh]');
		expect(content.className).not.toContain('max-h-[calc(100dvh-2rem)]');
		expect(content.className).not.toMatch(/(^| )overflow-y-auto/);
	});
});
