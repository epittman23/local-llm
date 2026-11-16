import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { ChevronDown, MoreHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { TagSelector } from '@/components/common/FilterSelects';
import { toastFailure } from '@/components/common/failureToast';
import { ListEmptyState } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { PagePagination } from '@/components/common/PagePagination';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { Tip } from '@/components/common/Tip';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Table, TableRow, TableSortHead } from '@/components/ui/table';
import { deleteFeedbackById, exportAllFeedbacks, getFeedbackItems, getFeedbackModelIds } from '@/lib/apis/evaluations';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAdminStore } from '@/lib/stores/adminStore';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { useSingleUser } from '@/routes/workspace/workspaceAccess';
import { type FeedbackItem, FeedbackModal } from './FeedbackModal';
import { feedbacksToCsv } from './feedbackCsv';
import { feedbackResult, ResultBadge } from './feedbackResult';

const PER_PAGE = 30;

const SORTS: { key: string; label: string; className: string; align?: 'end' }[] = [
	{ key: 'model_id', label: 'Model', className: '' },
	{ key: 'rating', label: 'Result', className: 'w-24' },
	{ key: 'updated_at', label: 'Updated', className: 'hidden w-36 sm:table-cell', align: 'end' }
];

/**
 * Ports Evaluations/Feedbacks.svelte: the paginated (30/page), sortable
 * feedback table with a model filter and JSON / CSV export. A row opens its
 * details, from its model name (a button, NAV-5) or anywhere on the row.
 *
 * The User column shows only while the install has more than one account
 * (S4-D1). Deleting a rating asks first (ACT-3); a failure says what failed
 * with the server's words behind Details (FBK-4).
 */
export function Feedbacks() {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const setCount = useAdminStore((s) => s.setCount);
	const singleUser = useSingleUser();
	const [page, setPage] = useState(1);
	const [orderBy, setOrderBy] = useState('updated_at');
	const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
	const [modelId, setModelId] = useState('');
	const [selected, setSelected] = useState<FeedbackItem | null>(null);
	const [showModal, setShowModal] = useState(false);
	const [deleting, setDeleting] = useState<FeedbackItem | null>(null);

	const list = useQuery({
		queryKey: ['admin', 'feedbacks', { orderBy, direction, page, modelId }],
		queryFn: () =>
			getFeedbackItems(token, orderBy, direction, page, modelId) as Promise<{ items: FeedbackItem[]; total: number }>,
		placeholderData: keepPreviousData
	});
	const modelIds = useQuery({
		queryKey: ['admin', 'feedback-model-ids'],
		queryFn: async () => ((await getFeedbackModelIds(token)) ?? []) as string[]
	});

	const items = list.data?.items ?? null;
	const total = list.data?.total ?? null;
	useEffect(() => {
		// The tab keeps the whole count while the model filter narrows the list (DAT-2).
		if (total !== null && modelId === '') setCount('feedback', total);
	}, [total, modelId, setCount]);

	const setSortKey = (key: string) => {
		if (orderBy === key) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
		else {
			setOrderBy(key);
			setDirection('asc');
		}
	};
	const open = (feedback: FeedbackItem) => {
		setSelected(feedback);
		setShowModal(true);
	};

	const deleteFeedback = async (id: string) => {
		const res = await deleteFeedbackById(token, id).catch((error) => {
			toastFailure("Couldn't delete the rating.", error);
			return null;
		});
		if (res) {
			toast.success('Rating deleted');
			if (items?.length === 1 && page > 1) setPage(page - 1);
			queryClient.invalidateQueries({ queryKey: ['admin', 'feedbacks'] });
			queryClient.invalidateQueries({ queryKey: ['admin', 'feedback-model-ids'] });
			queryClient.invalidateQueries({ queryKey: ['admin', 'leaderboard'] });
		}
	};

	const exportFeedbacks = async (format: 'json' | 'csv') => {
		const all = await exportAllFeedbacks(token, modelId).catch((error) => {
			toastFailure("Couldn't export the ratings.", error);
			return null;
		});
		if (!all) return;
		if (format === 'csv')
			saveAs(new Blob([feedbacksToCsv(all)], { type: 'text/csv' }), `feedback-history-export-${Date.now()}.csv`);
		else
			saveAs(
				new Blob([JSON.stringify(all)], { type: 'application/json' }),
				`feedback-history-export-${Date.now()}.json`
			);
	};

	if (list.isError && items === null) {
		return <LoadFailed what="feedback" error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} />;
	}
	if (items === null || total === null) return <TableSkeleton label="feedback" />;

	const ids = modelIds.data ?? [];
	const deletingName = deleting?.data?.model_id;
	return (
		<div className="flex flex-col gap-2">
			<FeedbackModal open={showModal} onOpenChange={setShowModal} feedback={selected} />
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(next) => !next && setDeleting(null)}
				title="Delete this rating?"
				confirmLabel="Delete rating"
				destructive
				onConfirm={() => {
					if (deleting) deleteFeedback(deleting.id);
					setDeleting(null);
				}}
			>
				{deletingName ? `The rating of ${deletingName} is removed` : 'The rating is removed'}, and the leaderboard is
				worked out again without it. This can't be undone.
			</ConfirmDialog>

			{(ids.length > 0 || total > 0) && (
				<div className="flex w-full flex-wrap items-center justify-between gap-2">
					{ids.length > 0 ? (
						<TagSelector
							value={modelId}
							tags={ids}
							name="Model"
							placeholder="All models"
							onChange={(value) => {
								setModelId(value);
								setPage(1);
							}}
						/>
					) : (
						<span />
					)}
					{total > 0 && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="outline" size="sm" type="button">
									Export ratings
									<ChevronDown data-icon="inline-end" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onSelect={() => exportFeedbacks('json')}>Export as JSON</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => exportFeedbacks('csv')}>Export as CSV</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			)}

			{items.length === 0 ? (
				<ListEmptyState
					title="No feedback yet"
					description="The ratings you give replies in chat appear here."
					filtered={modelId !== ''}
					onClear={() => {
						setModelId('');
						setPage(1);
					}}
				/>
			) : (
				<Table aria-label="Feedback" className="text-dense table-fixed text-left">
					<thead>
						<tr className="border-b">
							{!singleUser && (
								<th scope="col" className="text-foreground-muted hidden w-40 px-2 py-1.5 font-normal md:table-cell">
									User
								</th>
							)}
							{SORTS.map((col) => (
								<TableSortHead
									key={col.key}
									label={col.label}
									active={orderBy === col.key}
									direction={direction}
									onSort={() => setSortKey(col.key)}
									className={cn('h-auto py-1 font-normal', col.align === 'end' && 'text-right', col.className)}
									buttonClassName="text-foreground-muted"
								/>
							))}
							<th scope="col" className="w-10">
								<span className="sr-only">Actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{items.map((feedback) => {
							const siblings = feedback.data?.sibling_model_ids;
							const when = dayjs(feedback.updated_at * 1000);
							const model = feedback.data?.model_id ?? 'Unknown model';
							return (
								<TableRow key={feedback.id} className="last:border-0" onOpen={() => open(feedback)}>
									{!singleUser && (
										<td className="hidden px-2 py-1.5 md:table-cell">
											{feedback.user && (
												<div className="flex min-w-0 items-center gap-2">
													<ProfileAvatar
														src={`${WEBUI_API_BASE_URL}/users/${feedback.user.id}/profile/image`}
														name={feedback.user.name}
														size="sm"
													/>
													<span className="truncate" title={feedback.user.name}>
														{feedback.user.name}
													</span>
												</div>
											)}
										</td>
									)}
									<td className="py-1">
										<div className="flex min-w-0 flex-col items-start">
											<Button
												variant="ghost"
												size="sm"
												type="button"
												title={model}
												className="text-foreground -mx-2.5 max-w-full shrink justify-start"
												onClick={() => open(feedback)}
											>
												<span className="truncate">{model}</span>
											</Button>
											{siblings && siblings.length > 0 && (
												<span
													className="text-foreground-muted text-caption max-w-full truncate"
													title={siblings.join(', ')}
												>
													Compared with{' '}
													{siblings.length > 2
														? `${siblings.slice(0, 2).join(', ')} and ${siblings.length - 2} more`
														: siblings.join(', ')}
												</span>
											)}
											{/* LAY-4: a phone shows when on the second line instead of a column. */}
											<span className="text-foreground-muted text-caption sm:hidden">{when.fromNow()}</span>
										</div>
									</td>
									<td className="px-2 py-1.5">
										<ResultBadge result={feedbackResult(feedback)} />
									</td>
									<td className="text-foreground-muted hidden px-2 py-1.5 text-right sm:table-cell">
										<Tip content={when.format('YYYY-MM-DD HH:mm')}>
											<span>{when.fromNow()}</span>
										</Tip>
									</td>
									<td className="px-1 py-1 text-right">
										<DropdownMenu>
											<Tip content="More actions">
												<DropdownMenuTrigger asChild>
													<Button variant="ghost" size="icon-sm" type="button" aria-label="More actions">
														<MoreHorizontal className="size-4" />
													</Button>
												</DropdownMenuTrigger>
											</Tip>
											<DropdownMenuContent align="end">
												<DropdownMenuItem variant="destructive" onSelect={() => setDeleting(feedback)}>
													<Trash2 />
													Delete rating
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>
									</td>
								</TableRow>
							);
						})}
					</tbody>
				</Table>
			)}
			{total > PER_PAGE && <PagePagination page={page} count={total} perPage={PER_PAGE} onPageChange={setPage} />}
		</div>
	);
}
