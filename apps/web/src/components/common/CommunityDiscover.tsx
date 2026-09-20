/**
 * Ports workspace/common/CommunityDiscover.svelte: the "Made by Open WebUI
 * Community" footer link on the Tools / Functions lists.
 */
export function CommunityDiscover({ href, title, description }: { href: string; title: string; description: string }) {
	return (
		<div className="mt-6 px-2 pb-8">
			<div className="text-muted-foreground mb-0.5 text-[0.6875rem]">
				{/* LICENSE covers this Open WebUI Community wordmark.
				    Do not alter, remove, obscure, or replace it except as LICENSE permits:
				    https://docs.openwebui.com/license. */}
				Made by Open WebUI Community
			</div>
			<a className="flex w-full items-center justify-between gap-3 py-1 text-left" href={href} target="_blank" rel="noreferrer">
				<div className="min-w-0">
					<div className="line-clamp-1 text-[0.8125rem]">{title}</div>
					<div className="text-muted-foreground line-clamp-1 text-xs">{description}</div>
				</div>
			</a>
		</div>
	);
}
