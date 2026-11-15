import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { isValidHttpUrl } from '@/lib/utils/files';

/**
 * Ports chat/MessageInput/AttachWebpageModal.svelte: one URL per line, kept if
 * it is a valid http(s) URL, de-duplicated. (Lives in common/ because the chat
 * input uses the same dialog in Phase 10; the Svelte version's high-contrast
 * styling switch is not ported -- there is no settings store yet.) A 32 rem
 * form with Cancel and a button that repeats the action (OVL-1, ACT-2); a
 * caller may name both after its own menu item.
 */
export function AttachWebpageDialog({
	open,
	onOpenChange,
	onSubmit,
	title = 'Attach a web page',
	submitLabel = 'Add'
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (urls: string[]) => void;
	title?: string;
	submitLabel?: string;
}) {
	const [text, setText] = useState('');
	const submit = () => {
		const urls = [
			...new Set(
				text
					.split('\n')
					.map((u) => u.trim())
					.filter((u) => u !== '' && isValidHttpUrl(u))
			)
		];
		if (urls.length === 0) {
			toast.error('Enter at least one web address that starts with http:// or https://.');
			return;
		}
		onSubmit(urls);
		setText('');
		onOpenChange(false);
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription className="sr-only">Add the contents of web pages.</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="webpage-url">Webpage URLs</Label>
						<Textarea
							id="webpage-url"
							value={text}
							onChange={(e) => setText(e.target.value)}
							rows={3}
							placeholder="https://example.com"
							autoComplete="off"
							required
							aria-describedby="webpage-url-help"
						/>
						<p id="webpage-url-help" className="text-dense text-foreground-muted">
							One per line. Each page's text is added.
						</p>
					</div>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit">{submitLabel}</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
