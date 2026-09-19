import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** Only web links are ever rendered as links: a manifest is written by the plugin's author. */
export const safeHttpUrl = (raw: unknown): string | null => {
	if (typeof raw !== 'string') return null;
	try {
		const url = new URL(raw);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
};

/**
 * Ports workspace/common/ManifestModal.svelte ("Show your support!"). The
 * Svelte version puts `manifest.funding_url` straight into an `href`, so a
 * plugin declaring `funding_url: javascript:...` gets a link that runs script
 * when clicked. Here only http(s) URLs become links; anything else is shown as
 * inert text.
 */
export function ManifestModal({
	open,
	onOpenChange,
	manifest
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	manifest: { funding_url?: unknown };
}) {
	const link = safeHttpUrl(manifest.funding_url);
	const raw = typeof manifest.funding_url === 'string' ? manifest.funding_url : '';
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="text-sm">Show your support!</DialogTitle>
					<DialogDescription className="sr-only">Funding information for this plugin.</DialogDescription>
				</DialogHeader>
				<div className="px-1 text-sm">
					<div className="my-2">
						The developers behind this plugin are passionate volunteers from the community. If you find this plugin
						helpful, please consider contributing to its development.
					</div>
					<div className="my-2">
						{/* LICENSE covers this Open WebUI wordmark.
						    Do not alter, remove, obscure, or replace it except as LICENSE permits:
						    https://docs.openwebui.com/license. */}
						Your entire contribution will go directly to the plugin developer; Open WebUI does not take any
						percentage. However, the chosen funding platform might have its own fees.
					</div>
					<hr className="my-3" />
					<div className="my-2">
						Support this plugin:{' '}
						{link ? (
							<a href={link} target="_blank" rel="noreferrer noopener" className="text-blue-500 underline hover:text-blue-400">
								{link}
							</a>
						) : (
							<span className="break-all">{raw}</span>
						)}
					</div>
				</div>
				<div className="flex justify-end pt-1">
					<Button size="sm" onClick={() => onOpenChange(false)}>
						Done
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
