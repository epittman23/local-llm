import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ChatList, type ChatListSort, type ChatRow } from '@/components/common/ChatList';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getModelChats, getModelOverview } from '@/lib/apis/analytics';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import type { ActivityDay } from '../evaluations/activityChart';
import { ModelActivityChart } from '../evaluations/ModelActivityChart';

type Range = '30d' | '1y' | 'all';
const RANGES: { value: Range; label: string; days: number }[] = [
	{ value: '30d', label: '30 days', days: 30 },
	{ value: '1y', label: '1 year', days: 365 },
	{ value: 'all', label: 'All time', days: 0 }
];
const PAGE_SIZE = 50;

type ServerChat = { chat_id: string; first_message?: string; updated_at: number; user_id?: string; user_name?: string };
const toRow = (c: ServerChat): ChatRow => ({
	id: c.chat_id,
	title: c.first_message || 'No preview',
	updated_at: c.updated_at,
	user_id: c.user_id,
	user_name: c.user_name
});

/**
 * Ports Analytics/AnalyticsModelModal.svelte: one model's drill-down. Overview is
 * its feedback activity chart (the Evaluations chart) and tags; Chats (only when
 * admins may read chats) lists the conversations that used it within the
 * dashboard's date window, fifty at a time, sortable.
 *
 * #1028: the shared tabs and period control, the full name and id under the
 * title (no tooltip to take the first Escape), a failed load said in place,
 * and the tags as badges.
 */
export function AnalyticsModelModal({
	open,
	onOpenChange,
	model,
	startDate,
	endDate
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	model: { id: string; name: string } | null;
	startDate: number | null;
	endDate: number | null;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const chatAccess = useConfigStore((s) => Boolean(s.config?.features?.enable_admin_chat_access));
	const [tab, setTab] = useState<'overview' | 'chats'>('overview');
	const [range, setRange] = useState<Range>('30d');
	const [chats, setChats] = useState<ChatRow[]>([]);
	const [chatsLoading, setChatsLoading] = useState(false);
	const [allLoaded, setAllLoaded] = useState(false);
	const [orderBy, setOrderBy] = useState<ChatListSort>('updated_at');
	const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
	// Drops a slow response for a sort the user has already left.
	const generation = useRef(0);

	useEffect(() => {
		if (!open) return;
		setTab('overview');
		setRange('30d');
		setChats([]);
		setAllLoaded(false);
		setOrderBy('updated_at');
		setDirection('desc');
	}, [open, model?.id]);

	const days = RANGES.find((r) => r.value === range)?.days ?? 30;
	const overview = useQuery({
		queryKey: ['admin', 'analytics-overview', model?.id, days],
		queryFn: async () => {
			const res = await getModelOverview(token, model!.id, days);
			return {
				history: (res?.history ?? []) as ActivityDay[],
				tags: (res?.tags ?? []) as { tag: string; count: number }[]
			};
		},
		enabled: open && !!model?.id
	});

	const load = async (skip: number, by: ChatListSort, dir: 'asc' | 'desc') => {
		if (!model?.id) return;
		const mine = ++generation.current;
		setChatsLoading(true);
		try {
			const res = await getModelChats(token, model.id, startDate, endDate, skip, PAGE_SIZE, by, dir);
			if (generation.current !== mine) return;
			const rows = ((res?.chats ?? []) as ServerChat[]).map(toRow);
			const merged = skip === 0 ? rows : [...chats, ...rows.filter((r) => !chats.some((c) => c.id === r.id))];
			setChats(merged);
			setAllLoaded(merged.length >= (res?.total ?? merged.length));
		} catch (error) {
			console.error('Failed to load chats:', error);
			if (skip === 0) {
				setChats([]);
				setAllLoaded(true);
			}
		} finally {
			if (generation.current === mine) setChatsLoading(false);
		}
	};

	const selectTab = (next: 'overview' | 'chats') => {
		setTab(next);
		if (next === 'chats' && chats.length === 0) load(0, orderBy, direction);
	};
	const sort = (key: ChatListSort) => {
		const nextDir = orderBy === key ? (direction === 'asc' ? 'desc' : 'asc') : key === 'updated_at' ? 'desc' : 'asc';
		setOrderBy(key);
		setDirection(nextDir);
		setChats([]);
		load(0, key, nextDir);
	};

	if (!model) return null;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="truncate pe-8" title={model.name}>
						{model.name}
					</DialogTitle>
					<DialogDescription className="truncate" title={model.id}>
						{model.id}
					</DialogDescription>
				</DialogHeader>

				<Tabs value={tab} onValueChange={(v) => selectTab(v as 'overview' | 'chats')} className="min-w-0 gap-4">
					{chatAccess && (
						<TabsList variant="line" className="justify-start">
							<TabsTrigger value="overview" className="flex-none">
								Overview
							</TabsTrigger>
							<TabsTrigger value="chats" className="flex-none">
								Chats
							</TabsTrigger>
						</TabsList>
					)}

					<TabsContent value="overview" className="flex flex-col gap-4">
						<section aria-labelledby="model-feedback" className="flex flex-col gap-2">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<h3 id="model-feedback" className="text-foreground-strong font-strong">
									Feedback
								</h3>
								<SegmentedControl aria-label="Period" value={range} onValueChange={setRange} options={RANGES} />
							</div>
							<p className="text-foreground-muted text-dense">
								Replies rated up or down, and arena comparisons won or lost.
							</p>
							{overview.isError ? (
								<LoadFailed
									what="feedback"
									error={overview.error}
									onRetry={() => overview.refetch()}
									retrying={overview.isFetching}
								/>
							) : (
								<ModelActivityChart
									history={overview.data?.history ?? []}
									loading={overview.isPending}
									weekly={range === '1y' || range === 'all'}
								/>
							)}
						</section>
						<section aria-labelledby="model-tags" className="flex flex-col gap-2">
							<h3 id="model-tags" className="text-foreground-strong font-strong">
								Tags
							</h3>
							{overview.data?.tags.length ? (
								<ul className="flex flex-wrap gap-1.5">
									{overview.data.tags.map((t) => (
										<li key={t.tag}>
											<Badge variant="secondary">
												{t.tag} <span className="text-foreground-muted tabular-nums">{t.count}</span>
											</Badge>
										</li>
									))}
								</ul>
							) : (
								<p className="text-foreground-muted">No tags in its chats.</p>
							)}
						</section>
					</TabsContent>

					{chatAccess && (
						<TabsContent value="chats">
							<ChatList
								chatList={chats}
								loading={chatsLoading}
								allLoaded={allLoaded}
								showUserInfo
								shareUrl
								orderBy={orderBy}
								direction={direction}
								onSort={sort}
								onLoadMore={() => !chatsLoading && !allLoaded && load(chats.length, orderBy, direction)}
								onChatClick={() => onOpenChange(false)}
							/>
						</TabsContent>
					)}
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
