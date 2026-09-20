import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { Check, ChevronDown, ChevronUp, MoreHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PagePagination } from '@/components/common/PagePagination';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { deleteFeedbackById, exportAllFeedbacks, getFeedbackItems, getFeedbackModelIds } from '@/lib/apis/evaluations';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAdminStore } from '@/lib/stores/adminStore';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { dayjs } from '@/lib/utils/dates';
import { type FeedbackItem, FeedbackModal } from './FeedbackModal';
import { feedbacksToCsv, ratingOutcome } from './feedbackCsv';

const PER_PAGE = 30;

const OUTCOME_STYLE = {
	won: { label: 'Won', className: 'bg-blue-500/20 text-blue-700 dark:text-blue-200' },
	draw: { label: 'Draw', className: 'bg-muted text-muted-foreground' },
	lost: { label: 'Lost', className: 'bg-red-500/20 text-red-700 dark:text-red-200' }
} as const;

const COLUMNS: { key: string; label: string; className: string; inner?: string }[] = [
	{ key: 'user', label: 'User', className: 'w-3', inner: 'justify-end' },
	{ key: 'model_id', label: 'Models', className: '' },
	{ key: 'rating', label: 'Result', className: 'text-right w-fit', inner: 'justify-end' },
	{ key: 'updated_at', label: 'Updated At', className: 'text-right w-0', inner: 'justify-end' }
];

/**
 * Ports Evaluations/Feedbacks.svelte: the paginated (30/page), sortable feedback
 * table with a model filter and JSON / CSV export. Click a row for details.
 *
 * Differences from the Svelte version, all small fixes: the Result cell is
 * always rendered (the original omits it when the rating is falsy, shifting the
 * columns, and a numeric `0` "draw" is falsy); and the unused "share to
 * community" handler (it references an undefined variable) is not ported.
 */
export function Feedbacks() {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const setCount = useAdminStore((s) => s.setCount);
	const [page, setPage] = useState(1);
	const [orderBy, setOrderBy] = useState('updated_at');
	const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
	const [modelId, setModelId] = useState('');
	const [selected, setSelected] = useState<FeedbackItem | null>(null);
	const [showModal, setShowModal] = useState(false);

	const list = useQuery({
		queryKey: ['admin', 'feedbacks', { orderBy, direction, page, modelId }],
		queryFn: () => getFeedbackItems(token, orderBy, direction, page, modelId) as Promise<{ items: FeedbackItem[]; total: number }>,
		placeholderData: keepPreviousData
	});
	const modelIds = useQuery({ queryKey: ['admin', 'feedback-model-ids'], queryFn: async () => ((await getFeedbackModelIds(token)) ?? []) as string[] });

	const items = list.data?.items ?? null;
	const total = list.data?.total ?? null;
	useEffect(() => {
		if (list.isError) toast.error(`${list.error}`);
	}, [list.isError, list.error]);
	useEffect(() => {
		if (total !== null) setCount('feedback', total);
	}, [total, setCount]);

	const setSortKey = (key: string) => {
		if (orderBy === key) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
		else {
			setOrderBy(key);
			setDirection('asc');
		}
	};

	const deleteFeedback = async (id: string) => {
		const res = await deleteFeedbackById(token, id).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) {
			toast.success('Feedback deleted successfully');
			setPage(1);
			queryClient.invalidateQueries({ queryKey: ['admin', 'feedbacks'] });
			queryClient.invalidateQueries({ queryKey: ['admin', 'feedback-model-ids'] });
		}
	};

	const exportFeedbacks = async (format: 'json' | 'csv') => {
		const all = await exportAllFeedbacks(token, modelId).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (!all) return;
		if (format === 'csv') saveAs(new Blob([feedbacksToCsv(all)], { type: 'text/csv' }), `feedback-history-export-${Date.now()}.csv`);
		else saveAs(new Blob([JSON.stringify(all)], { type: 'application/json' }), `feedback-history-export-${Date.now()}.json`);
	};

	if (items === null || total === null) {
		return (
			<div className="my-10 flex justify-center">
				<Spinner />
			</div>
		);
	}

	const ids = modelIds.data ?? [];
	return (
		<div>
			<FeedbackModal open={showModal} onOpenChange={setShowModal} feedback={selected} />

			{(ids.length > 0 || total > 0) && (
				<div className="flex h-8 w-full flex-1 items-center gap-2">
					<div className="flex min-w-0 flex-1 overflow-x-auto bg-transparent">
						{ids.length > 0 && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										aria-label="Model"
										className="text-foreground/80 hover:text-foreground flex items-center gap-0.5 rounded-xl bg-transparent px-2.5 py-1.5 text-[0.8125rem] font-normal transition"
									>
										<span className="truncate px-0.5">{modelId || 'All'}</span>
										<ChevronDown className="size-3.5" strokeWidth={2.5} />
									</button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
									<DropdownMenuRadioGroup
										value={modelId}
										onValueChange={(value) => {
											setModelId(value);
											setPage(1);
										}}
									>
										{[{ value: '', label: 'All' }, ...ids.map((id) => ({ value: id, label: id }))].map((item) => (
											<DropdownMenuRadioItem key={item.value} value={item.value}>
												{item.label}
												{item.value === modelId && <Check className="ml-auto" />}
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuRadioGroup>
								</DropdownMenuContent>
							</DropdownMenu>
						)}
					</div>
					{total > 0 && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button type="button" className="hover:bg-muted flex h-8 shrink-0 items-center gap-1 rounded-xl px-2 py-1.5 text-xs transition">
									Export
									<ChevronDown className="size-3" strokeWidth={2.5} />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-[10.625rem]">
								<DropdownMenuItem onSelect={() => exportFeedbacks('json')}>Export as JSON</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => exportFeedbacks('csv')}>Export as CSV</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			)}

			<div className="relative max-w-full overflow-x-auto whitespace-nowrap">
				{items.length === 0 ? (
					<div className="flex w-full flex-col items-center justify-center py-16 pb-24">
						<div className="max-w-sm text-center">
							<div className="mb-1.5 text-sm">No feedback found</div>
							<div className="text-muted-foreground text-center text-xs leading-5">
								Try adjusting your search or filter to find what you are looking for.
							</div>
						</div>
					</div>
				) : (
					<table className="text-muted-foreground w-full max-w-full table-auto px-2 text-left text-sm">
						<thead className="text-foreground bg-transparent text-xs uppercase">
							<tr className="border-b">
								{COLUMNS.map((col) => (
									<th key={col.key} scope="col" className={cn('cursor-pointer px-2.5 py-2 font-normal select-none', col.className)} onClick={() => setSortKey(col.key)}>
										<div className={cn('flex items-center gap-1.5', col.inner)}>
											{col.label}
											{orderBy === col.key ? (
												direction === 'asc' ? <ChevronUp className="size-2" /> : <ChevronDown className="size-2" />
											) : (
												<ChevronUp className="invisible size-2" />
											)}
										</div>
									</th>
								))}
								<th scope="col" className="w-0 px-2.5 py-2 text-right font-normal" />
							</tr>
						</thead>
						<tbody>
							{items.map((feedback) => {
								const outcome = ratingOutcome(feedback.data?.rating);
								const siblings = feedback.data?.sibling_model_ids;
								return (
									<tr
										key={feedback.id}
										className="hover:bg-muted/50 cursor-pointer rounded-xl text-xs transition"
										onClick={() => {
											setSelected(feedback);
											setShowModal(true);
										}}
									>
										<td className="py-0.5 text-right font-normal">
											<div className="flex justify-center">
												<Tip content={feedback.user?.name}>
													<div className="shrink-0">
														{feedback.user && (
															<img
																src={`${WEBUI_API_BASE_URL}/users/${feedback.user.id}/profile/image`}
																alt={feedback.user.name}
																className="size-5 shrink-0 rounded-full object-cover"
															/>
														)}
													</div>
												</Tip>
											</div>
										</td>
										<td className="py-1 pl-3">
											<div className="flex h-full flex-col">
												{siblings ? (
													<>
														<Tip content={feedback.data?.model_id} side="top">
															<div className="text-muted-foreground line-clamp-1 flex-1 font-normal">{feedback.data?.model_id}</div>
														</Tip>
														<Tip content={siblings.join(', ')}>
															<div className="text-muted-foreground line-clamp-1 text-[0.65rem]">
																{siblings.length > 2 ? `${siblings.slice(0, 2).join(', ')}, and ${siblings.length - 2} more` : siblings.join(', ')}
															</div>
														</Tip>
													</>
												) : (
													<Tip content={feedback.data?.model_id} side="top">
														<div className="text-muted-foreground line-clamp-1 flex-1 py-1.5 text-sm font-normal">{feedback.data?.model_id}</div>
													</Tip>
												)}
											</div>
										</td>
										<td className="w-max px-3 py-1 text-right font-normal">
											<div className="flex justify-end">
												{outcome && (
													<span className={cn('inline-flex h-5 items-center rounded-full px-2 text-xs font-medium', OUTCOME_STYLE[outcome].className)}>
														{OUTCOME_STYLE[outcome].label}
													</span>
												)}
											</div>
										</td>
										<td className="px-3 py-1 text-right font-normal">{dayjs(feedback.updated_at * 1000).fromNow()}</td>
										<td className="px-3 py-1 text-right font-normal" onClick={(e) => e.stopPropagation()}>
											<DropdownMenu>
												<Tip content="More">
													<DropdownMenuTrigger asChild>
														<button type="button" aria-label="Feedback Menu" className="hover:bg-muted w-fit self-center rounded-xl p-1.5 text-sm">
															<MoreHorizontal className="size-4" />
														</button>
													</DropdownMenuTrigger>
												</Tip>
												<DropdownMenuContent align="end" className="min-w-[9.375rem]">
													<DropdownMenuItem onSelect={() => deleteFeedback(feedback.id)}>
														<Trash2 />
														Delete
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</div>
			{total > PER_PAGE && <PagePagination page={page} count={total} perPage={PER_PAGE} onPageChange={setPage} />}
		</div>
	);
}
