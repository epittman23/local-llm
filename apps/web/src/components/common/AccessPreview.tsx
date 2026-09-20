import { Spinner } from '@/components/common/Spinner';

type Named = { name: string };
type PreviewList = { items: Named[]; total: number };

/** The `preview` payload of both /users/:id/preview and /groups/:id/preview. */
export type AccessPreviewData = {
	groups?: Named[];
	models: PreviewList;
	knowledge: PreviewList;
	tools: PreviewList;
};

function Section({ title, list, empty }: { title: string; list: PreviewList; empty: string }) {
	return (
		<div>
			<div className="mb-2 text-sm font-normal">{title}</div>
			<div className="flex w-full flex-col">
				{list.items.length === 0 ? (
					<div className="text-muted-foreground my-1 text-xs">{empty}</div>
				) : (
					<>
						{list.items.map((item, i) => (
							<div key={i} className="my-1 text-xs font-normal">
								{item.name}
							</div>
						))}
						{list.total > list.items.length && (
							<div className="text-muted-foreground my-1 text-xs">
								{list.items.length} of {list.total} accessible
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

/**
 * What a user or group can reach: the identical Models / Knowledge / Tools
 * sections that UserPreviewModal.svelte and GroupPreviewPanel.svelte each
 * spell out by hand, preceded (users only) by the groups they belong to.
 */
export function AccessPreview({
	loading,
	error,
	preview
}: {
	loading: boolean;
	error: string;
	preview: AccessPreviewData | null;
}) {
	if (loading)
		return (
			<div className="flex items-center justify-center py-8">
				<Spinner className="size-5" />
			</div>
		);
	if (error) return <div className="py-4 text-center text-xs text-red-500">{error}</div>;
	if (!preview) return null;
	const rule = <hr className="my-1" />;
	return (
		<div className="space-y-2">
			{(preview.groups?.length ?? 0) > 0 && (
				<>
					<div>
						<div className="mb-2 text-sm font-normal">Groups</div>
						<div className="flex w-full flex-col">
							{preview.groups!.map((group, i) => (
								<div key={i} className="my-1 text-xs font-normal">
									{group.name}
								</div>
							))}
						</div>
					</div>
					{rule}
				</>
			)}
			<Section title="Models" list={preview.models} empty="No models accessible" />
			{rule}
			<Section title="Knowledge" list={preview.knowledge} empty="No knowledge bases accessible" />
			{rule}
			<Section title="Tools" list={preview.tools} empty="No tools accessible" />
		</div>
	);
}
