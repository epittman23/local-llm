import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { isValidHttpUrl } from '@/lib/utils/files';

/**
 * Ports chat/MessageInput/AttachWebpageModal.svelte: one URL per line, kept if
 * it is a valid http(s) URL, de-duplicated. (Lives in common/ because the chat
 * input uses the same dialog in Phase 10; the Svelte version's high-contrast
 * styling switch is not ported -- there is no settings store yet.)
 */
export function AttachWebpageDialog({
	open,
	onOpenChange,
	onSubmit
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (urls: string[]) => void;
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
			toast.error('Please enter a valid URL.');
			return;
		}
		onSubmit(urls);
		setText('');
		onOpenChange(false);
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="text-sm">Attach Webpage</DialogTitle>
					<DialogDescription className="sr-only">Add the contents of web pages.</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<label htmlFor="webpage-url" className="text-muted-foreground mb-0.5 block text-xs">
						Webpage URLs
					</label>
					<textarea
						id="webpage-url"
						className="placeholder:text-muted-foreground/60 w-full bg-transparent text-sm outline-hidden"
						value={text}
						onChange={(e) => setText(e.target.value)}
						rows={3}
						placeholder="https://example.com"
						autoComplete="off"
						required
					/>
					<div className="flex justify-end pt-3">
						<Button type="submit" size="sm">
							Add
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
