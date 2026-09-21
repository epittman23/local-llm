import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { SettingSelect } from '@/components/settings/controls';
import { getModels } from '@/lib/apis';
import { getDailyStats, getModelAnalytics, getSummary, getTokenUsage, getUserAnalytics } from '@/lib/apis/analytics';
import { getGroups } from '@/lib/apis/groups';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { formatNumber } from '@/lib/utils';
import { AnalyticsModelModal } from './AnalyticsModelModal';
import {
	CHART_COLORS,
	type DailyPoint,
	type ModelSort,
	type ModelStat,
	PERIODS,
	type Period,
	type TokenStats,
	type UserSort,
	type UserStat,
	chartModels,
	chartPeriod,
	dateRange,
	isCustomIncomplete,
	parsePeriod,
	sharePercent,
	sortModels,
	sortUsers
} from './analytics';
import { ChartLine } from './ChartLine';

const store = {
	get: (key: string) => {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	set: (key: string, value: string) => {
		try {
			localStorage.setItem(key, value);
		} catch {
			/* private mode: the choice just is not remembered */
		}
	}
};

const th = 'cursor-pointer px-2.5 py-1.5 font-normal select-none';
const dateInput = 'bg-muted/40 h-7 rounded-lg border px-2 text-xs outline-hidden';

function Head({ label, active, direction, onClick, className = '' }: { label: string; active: boolean; direction: 'asc' | 'desc'; onClick: () => void; className?: string }) {
	return (
		<th scope="col" className={`${th} ${className}`} onClick={onClick}>
			<div className={`flex items-center gap-1.5 ${className.includes('text-right') ? 'justify-end' : ''}`}>
				{label}
				{active ? direction === 'asc' ? <ChevronUp className="size-2" /> : <ChevronDown className="size-2" /> : <ChevronUp className="invisible size-2" />}
			</div>
		</th>
	);
}

const Panel = ({ title, children }: { title: string; children: ReactNode }) => (
	<div className="min-w-0">
		<div className="mb-1 text-xs font-medium">{title}</div>
		<div className="max-h-80 overflow-auto rounded-lg border">{children}</div>
	</div>
);

/**
 * Ports admin/Analytics.svelte + Analytics/Dashboard.svelte: usage over a chosen
 * period (and optionally one group) -- totals, a messages-over-time line chart,
 * a model table (click a row for its dialog) and a user table.
 *
 * The period, and a custom range, are remembered in localStorage. In custom mode
 * nothing is fetched until both dates are set. Token counts are estimates (the
 * tooltip says so); message counts are assistant responses.
 */
export default function Analytics() {
	const token = useAuthStore((s) => s.token) ?? '';
	const [period, setPeriod] = useState<Period>(() => parsePeriod(store.get('analyticsPeriod')));
	const [customStart, setCustomStart] = useState(() => store.get('analyticsCustomStart') ?? '');
	const [customEnd, setCustomEnd] = useState(() => store.get('analyticsCustomEnd') ?? '');
	const [groupId, setGroupId] = useState<string | null>(null);
	const [modelSort, setModelSort] = useState<{ by: ModelSort; dir: 'asc' | 'desc' }>({ by: 'count', dir: 'desc' });
	const [userSort, setUserSort] = useState<{ by: UserSort; dir: 'asc' | 'desc' }>({ by: 'count', dir: 'desc' });
	const [selectedModel, setSelectedModel] = useState<{ id: string; name: string } | null>(null);
	const [showModel, setShowModel] = useState(false);

	useEffect(() => store.set('analyticsPeriod', period), [period]);
	useEffect(() => {
		store.set('analyticsCustomStart', customStart);
		store.set('analyticsCustomEnd', customEnd);
	}, [customStart, customEnd]);

	const groups = useQuery({ queryKey: ['admin', 'groups'], queryFn: async () => ((await getGroups(token)) ?? []) as { id: string; name: string }[] });
	const models = useQuery({ queryKey: ['models-all'], queryFn: async () => ((await getModels(token)) ?? []) as { id: string; name?: string }[] });

	const incomplete = isCustomIncomplete(period, customStart, customEnd);
	const data = useQuery({
		queryKey: ['admin', 'analytics', period, customStart, customEnd, groupId],
		enabled: !incomplete,
		queryFn: async () => {
			const { start, end } = dateRange(period, customStart, customEnd);
			const granularity = period === '24h' ? 'hourly' : 'daily';
			const [summary, byModel, byUser, daily, tokens] = await Promise.all([
				getSummary(token, start, end, groupId),
				getModelAnalytics(token, start, end, groupId),
				getUserAnalytics(token, start, end, 50, groupId),
				getDailyStats(token, start, end, granularity, groupId),
				getTokenUsage(token, start, end, groupId)
			]);
			return { summary, byModel, byUser, daily, tokens };
		}
	});

	const names = useMemo(() => new Map((models.data ?? []).map((m) => [m.id, m.name || m.id])), [models.data]);
	const summary = data.data?.summary ?? { total_messages: 0, total_chats: 0, total_users: 0 };
	const modelStats: ModelStat[] = useMemo(
		() => ((data.data?.byModel?.models ?? []) as Omit<ModelStat, 'name'>[]).map((m) => ({ ...m, name: names.get(m.model_id) || m.model_id })),
		[data.data, names]
	);
	const userStats: UserStat[] = data.data?.byUser?.users ?? [];
	const daily: DailyPoint[] = data.data?.daily?.data ?? [];
	const tokenStats: TokenStats = useMemo(
		() => Object.fromEntries(((data.data?.tokens?.models ?? []) as { model_id: string; input_tokens: number; output_tokens: number; total_tokens: number }[]).map((m) => [m.model_id, m])),
		[data.data]
	);
	const totalTokens = data.data?.tokens?.total_tokens ?? 0;

	const sortedModels = useMemo(() => sortModels(modelStats, tokenStats, modelSort.by, modelSort.dir), [modelStats, tokenStats, modelSort]);
	const sortedUsers = useMemo(() => sortUsers(userStats, userSort.by, userSort.dir), [userStats, userSort]);
	const totalModelMessages = modelStats.reduce((sum, m) => sum + m.count, 0);

	const toggleModel = (by: ModelSort) => setModelSort((s) => (s.by === by ? { by, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { by, dir: by === 'name' ? 'asc' : 'desc' }));
	const toggleUser = (by: UserSort) => setUserSort((s) => (s.by === by ? { by, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { by, dir: by === 'name' ? 'asc' : 'desc' }));

	const loading = data.isFetching && !incomplete;
	const chartSeries = chartModels(daily);
	const range = dateRange(period, customStart, customEnd);

	return (
		<div className="flex h-full w-full flex-col overflow-y-auto pr-1 pb-2">
			<AnalyticsModelModal open={showModel} onOpenChange={setShowModel} model={selectedModel} startDate={range.start} endDate={range.end} />

			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h2 className="text-sm font-medium">Analytics</h2>
				<div className="flex flex-wrap items-center gap-2">
					{(groups.data?.length ?? 0) > 0 && (
						<SettingSelect value={groupId ?? ''} onChange={(v) => setGroupId(v || null)} aria-label="Group">
							<option value="">All Users</option>
							{groups.data!.map((g) => (
								<option key={g.id} value={g.id}>
									{g.name}
								</option>
							))}
						</SettingSelect>
					)}
					{period === 'custom' && (
						<>
							<input type="date" aria-label="Start date" className={dateInput} value={customStart} max={customEnd || undefined} onChange={(e) => setCustomStart(e.target.value)} />
							<span className="text-muted-foreground">–</span>
							<input type="date" aria-label="End date" className={dateInput} value={customEnd} min={customStart || undefined} onChange={(e) => setCustomEnd(e.target.value)} />
						</>
					)}
					<SettingSelect value={period} onChange={(v) => setPeriod(v as Period)} aria-label="Period">
						{PERIODS.map((p) => (
							<option key={p.value} value={p.value}>
								{p.label}
							</option>
						))}
					</SettingSelect>
				</div>
			</div>

			{loading ? (
				<div className="flex flex-1 items-center justify-center py-10">
					<Spinner />
				</div>
			) : (
				<>
					<div className="text-muted-foreground mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
						<span>
							<span className="text-foreground text-base font-medium">{summary.total_messages.toLocaleString()}</span> messages
						</span>
						<Tip content="Token counts are estimates and may not reflect actual API usage">
							<span>
								<span className="text-foreground text-base font-medium">{formatNumber(totalTokens)}</span> tokens
							</span>
						</Tip>
						<span>
							<span className="text-foreground text-base font-medium">{summary.total_chats.toLocaleString()}</span> chats
						</span>
						<span>
							<span className="text-foreground text-base font-medium">{summary.total_users}</span> users
						</span>
					</div>

					{daily.length > 1 && (
						<div className="mb-4">
							<div className="mb-1 text-xs font-medium">{period === '24h' ? 'Hourly Messages' : 'Daily Messages'}</div>
							<ChartLine data={daily} models={chartSeries} colors={CHART_COLORS} height={200} period={chartPeriod(period)} />
						</div>
					)}

					<div className="grid gap-4 xl:grid-cols-2">
						<Panel title="Model Usage">
							<table className="text-muted-foreground w-full text-left text-xs">
								<thead className="text-foreground bg-background sticky top-0 uppercase">
									<tr className="border-b">
										<th scope="col" className="px-2.5 py-1.5 font-normal">
											#
										</th>
										<Head label="Model" active={modelSort.by === 'name'} direction={modelSort.dir} onClick={() => toggleModel('name')} />
										<Head label="Messages" active={modelSort.by === 'count'} direction={modelSort.dir} onClick={() => toggleModel('count')} className="text-right" />
										<Head label="Users" active={modelSort.by === 'users'} direction={modelSort.dir} onClick={() => toggleModel('users')} className="text-right" />
										<Head label="Chats" active={modelSort.by === 'chats'} direction={modelSort.dir} onClick={() => toggleModel('chats')} className="text-right" />
										<Head label="Tokens" active={modelSort.by === 'tokens'} direction={modelSort.dir} onClick={() => toggleModel('tokens')} className="text-right" />
										<Head label="%" active={modelSort.by === 'percentage'} direction={modelSort.dir} onClick={() => toggleModel('percentage')} className="text-right" />
									</tr>
								</thead>
								<tbody>
									{sortedModels.map((model, idx) => (
										<tr
											key={model.model_id}
											className="hover:bg-muted/50 cursor-pointer transition"
											onClick={() => {
												setSelectedModel({ id: model.model_id, name: model.name });
												setShowModel(true);
											}}
										>
											<td className="px-2.5 py-1.5">{idx + 1}</td>
											<td className="px-2.5 py-1.5">
												<div className="flex items-center gap-2">
													<img
														src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${encodeURIComponent(model.model_id)}`}
														alt={model.name}
														className="size-5 shrink-0 rounded-full object-cover"
														onError={(e) => {
															// LICENSE covers this Open WebUI fallback logo.
															// Do not alter, remove, obscure, or replace it except as LICENSE permits:
															// https://docs.openwebui.com/license.
															e.currentTarget.src = '/favicon.png';
														}}
													/>
													<span className="text-foreground line-clamp-1">{model.name}</span>
												</div>
											</td>
											<td className="px-2.5 py-1.5 text-right">{model.count.toLocaleString()}</td>
											<td className="px-2.5 py-1.5 text-right">{(model.unique_users ?? 0).toLocaleString()}</td>
											<td className="px-2.5 py-1.5 text-right">{(model.unique_chats ?? 0).toLocaleString()}</td>
											<td className="px-2.5 py-1.5 text-right">{formatNumber(tokenStats[model.model_id]?.total_tokens ?? 0)}</td>
											<td className="px-2.5 py-1.5 text-right">{sharePercent(model.count, totalModelMessages)}%</td>
										</tr>
									))}
									{sortedModels.length === 0 && (
										<tr>
											<td colSpan={7} className="px-2.5 py-3 text-center">
												No data
											</td>
										</tr>
									)}
								</tbody>
							</table>
						</Panel>

						<Panel title="User Activity">
							<table className="text-muted-foreground w-full text-left text-xs">
								<thead className="text-foreground bg-background sticky top-0 uppercase">
									<tr className="border-b">
										<th scope="col" className="px-2.5 py-1.5 font-normal">
											#
										</th>
										<Head label="User" active={userSort.by === 'name'} direction={userSort.dir} onClick={() => toggleUser('name')} />
										<Head label="Messages" active={userSort.by === 'count'} direction={userSort.dir} onClick={() => toggleUser('count')} className="text-right" />
										<Head label="Tokens" active={userSort.by === 'tokens'} direction={userSort.dir} onClick={() => toggleUser('tokens')} className="text-right" />
									</tr>
								</thead>
								<tbody>
									{sortedUsers.map((user, idx) => (
										<tr key={user.user_id}>
											<td className="px-2.5 py-1.5">{idx + 1}</td>
											<td className="px-2.5 py-1.5">
												<div className="flex items-center gap-2">
													<img
														src={`${WEBUI_API_BASE_URL}/users/${user.user_id}/profile/image`}
														alt={user.name || 'User'}
														className="size-5 shrink-0 rounded-full object-cover"
														onError={(e) => {
															e.currentTarget.src = '/user.png';
														}}
													/>
													<span className="text-foreground line-clamp-1">{user.name || user.email || user.user_id.substring(0, 8)}</span>
												</div>
											</td>
											<td className="px-2.5 py-1.5 text-right">{user.count.toLocaleString()}</td>
											<td className="px-2.5 py-1.5 text-right">{formatNumber(user.total_tokens ?? 0)}</td>
										</tr>
									))}
									{sortedUsers.length === 0 && (
										<tr>
											<td colSpan={4} className="px-2.5 py-3 text-center">
												No data
											</td>
										</tr>
									)}
								</tbody>
							</table>
						</Panel>
					</div>

					<div className="text-muted-foreground mt-2 text-right text-xs">ⓘ Message counts are based on assistant responses.</div>
				</>
			)}
		</div>
	);
}
