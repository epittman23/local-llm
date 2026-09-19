import { useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { extractFrontmatter, nameToId } from '@/lib/utils/plugins';

type Imported = { id?: string; name: string; content: string; meta?: Record<string, unknown> } & Record<string, unknown>;

/**
 * Ports components/ImportModal.svelte: fetch a plugin from a URL (via the
 * backend's loader), fill in id/name/description from its docstring header, and
 * hand it to `onImport` -- which for Tools stashes it and opens the create page,
 * where the user still reviews it and confirms the code-execution warning.
 */
export function ImportUrlModal({
	open,
	onOpenChange,
	loadUrl,
	onImport,
	successMessage
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	loadUrl: (url: string) => Promise<Imported | null>;
	onImport: (item: Imported) => void;
	successMessage: string;
}) {
	const [url, setUrl] = useState('');
	const [loading, setLoading] = useState(false);

	const submit = async () => {
		if (!url) {
			toast.error('Please enter a valid URL');
			return;
		}
		setLoading(true);
		const res = await loadUrl(url).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		setLoading(false);
		if (!res) return;
		toast.success(successMessage);
		const fm = extractFrontmatter(res.content ?? '');
		const name = fm.title || res.name;
		onImport({
			...res,
			id: res.id || nameToId(res.name),
			name,
			meta: { ...(res.meta ?? {}), description: fm.description ?? name }
		});
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="text-sm">Import</DialogTitle>
					<DialogDescription className="sr-only">Import from a URL.</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<div className="text-muted-foreground mb-1 text-xs">URL</div>
					<input
						className="w-full bg-transparent text-sm outline-hidden"
						type="url"
						aria-label="URL"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						placeholder="Enter the URL to import"
						required
					/>
					<div className="flex justify-end pt-3">
						<Button type="submit" size="sm" disabled={loading}>
							Import
							{loading && <Spinner className="size-3.5" />}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
