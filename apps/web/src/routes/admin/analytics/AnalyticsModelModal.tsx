import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ChatList, type ChatListSort, type ChatRow } from '@/components/common/ChatList';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getModelChats, getModelOverview } from '@/lib/apis/analytics';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import type { ActivityDay } from '../evaluations/activityChart';
import { ModelActivityChart } from '../evaluations/ModelActivityChart';

type Range = '30d' | '1y' | 'all';
const RANGES: { key: Range; label: string; days: number }[] = [
	{ key: '30d', label: '30D', days: 30 },
	{ key: '1y', label: '1Y', days: 365 },
	{ key: 'all', label: 'All', days: 0 }
];
const PAGE_SIZE = 50;

type ServerChat = { chat_id: string; first_message?: string; updated_at: number; user_id?: string; user_name?: string };
const toRow = (c: ServerChat): ChatRow => ({ id: c.chat_id, title: c.first_message || 'No preview', updated_at: c.updated_at, user_id: c.user_id, user_name: c.user_name });

/**
 * Ports Analytics/AnalyticsModelModal.svelte: one model's drill-down. Overview is
 * its feedback activity chart (the Evaluations chart) and tags; Chats (only when
 * admins may read chats) lists the conversations that used it within the
 * dashboard's date window, fifty at a time, sortable.
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

	const days = RANGES.find((r) => r.key === range)!.days;
	const overview = useQuery({
		queryKey: ['admin', 'analytics-overview', model?.id, days],
		queryFn: async () => {
			const res = await getModelOverview(token, model!.id, days);
			return { history: (res?.history ?? []) as ActivityDay[], tags: (res?.tags ?? []) as { tag: string; count: number }[] };
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
	const tabClass = (active: boolean) => cn('px-1 pb-1.5 text-sm transition', active ? 'border-foreground border-b-2 font-medium' : 'text-muted-foreground hover:text-foreground border-b-2 border-transparent');
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<Tip content={`${model.name} (${model.id})`} side="top">
						<DialogTitle className="line-clamp-1 text-sm font-medium">{model.name}</DialogTitle>
					</Tip>
					<DialogDescription className="sr-only">Usage of {model.name}.</DialogDescription>
				</DialogHeader>

				<div className="flex gap-3 border-b">
					<button type="button" className={tabClass(tab === 'overview')} onClick={() => selectTab('overview')}>
						Overview
					</button>
					{chatAccess && (
						<button type="button" className={tabClass(tab === 'chats')} onClick={() => selectTab('chats')}>
							Chats
						</button>
					)}
				</div>

				{tab === 'overview' ? (
					<>
						<div>
							<div className="mb-2 flex items-center justify-between">
								<Tip content="Thumbs up/down ratings from users on model responses">
									<div className="text-muted-foreground text-xs font-normal tracking-wide uppercase">Feedback Activity</div>
								</Tip>
								<div className="bg-muted inline-flex rounded-full p-0.5">
									{RANGES.map((r) => (
										<button
											key={r.key}
											type="button"
											aria-pressed={range === r.key}
											className={cn('rounded-full px-2.5 py-0.5 text-xs font-normal transition-all', range === r.key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
											onClick={() => setRange(r.key)}
										>
											{r.label}
										</button>
									))}
								</div>
							</div>
							<ModelActivityChart history={overview.data?.history ?? []} loading={overview.isPending} weekly={range === '1y' || range === 'all'} />
						</div>
						<div>
							<div className="text-muted-foreground mb-2 text-xs font-normal tracking-wide uppercase">Tags</div>
							{overview.data?.tags.length ? (
								<div className="-mx-1 flex flex-wrap gap-1">
									{overview.data.tags.map((t) => (
										<span key={t.tag} className="bg-muted rounded-full px-2 py-0.5 text-xs">
											{t.tag} <span className="text-muted-foreground font-normal">{t.count}</span>
										</span>
									))}
								</div>
							) : (
								<span className="text-muted-foreground text-sm">-</span>
							)}
						</div>
					</>
				) : (
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
				)}

				<div className="flex justify-end pt-2">
					<Button size="sm" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
