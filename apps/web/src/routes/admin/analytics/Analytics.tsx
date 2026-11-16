import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { FilterMenu } from '@/components/common/FilterSelects';
import { SortHeaderButton } from '@/components/common/ListChrome';
import { LoadFailed } from '@/components/common/LoadFailed';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table } from '@/components/ui/table';
import { getModels } from '@/lib/apis';
import { getDailyStats, getModelAnalytics, getSummary, getTokenUsage, getUserAnalytics } from '@/lib/apis/analytics';
import { getGroups } from '@/lib/apis/groups';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn, formatNumber } from '@/lib/utils';
import { useAdminSingleUser } from '../adminVisibility';
import { openRow } from '../rowOpen';
import { TableSkeleton } from '../TableSkeleton';
import { AnalyticsModelModal } from './AnalyticsModelModal';
import {
	CHART_COLORS,
	chartModels,
	chartPeriod,
	type DailyPoint,
	dateRange,
	isCustomIncomplete,
	type ModelSort,
	type ModelStat,
	PERIODS,
	type Period,
	parsePeriod,
	sharedPrefix,
	sharePercent,
	sortModels,
	sortUsers,
	type TokenStats,
	type UserSort,
	type UserStat
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

const ariaSort = (active: boolean, dir: 'asc' | 'desc') =>
	active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined;

/** A sortable column heading: `aria-sort` on the cell, the shared header button inside it. */
function Head<K extends string>({
	label,
	by,
	sort,
	onSort,
	className
}: {
	label: string;
	by: K;
	sort: { by: K; dir: 'asc' | 'desc' };
	onSort: (by: K) => void;
	className?: string;
}) {
	const numeric = by !== 'name';
	return (
		<th
			scope="col"
			aria-sort={ariaSort(sort.by === by, sort.dir)}
			className={cn('py-1 font-normal', numeric && 'text-right', className)}
		>
			<SortHeaderButton
				label={label}
				active={sort.by === by}
				direction={sort.dir}
				className={cn('text-foreground-muted', numeric && 'ms-auto')}
				onClick={() => onSort(by)}
			/>
		</th>
	);
}

const toggle = <K extends string>(s: { by: K; dir: 'asc' | 'desc' }, by: K) =>
	s.by === by
		? { by, dir: s.dir === 'asc' ? ('desc' as const) : ('asc' as const) }
		: { by, dir: by === 'name' ? ('asc' as const) : ('desc' as const) };

/**
 * Ports admin/Analytics.svelte + Analytics/Dashboard.svelte: usage over a chosen
 * period (and optionally one group) -- totals, a messages-over-time line chart,
 * a model table (a row opens its dialog) and a user table.
 *
 * The period, and a custom range, are remembered in localStorage. In custom mode
 * nothing is fetched until both dates are set. Token counts are estimates;
 * message counts are assistant responses.
 *
 * #1028: it fills a page; the tables are the shared `Table`, named and
 * scrollable from the keyboard, the Model column takes the room the figures
 * leave (a shared provider prefix is dropped in the cell, kept in its title),
 * and a row opens from its name button too. While there is one account
 * (S4-D1) the Users column, User activity and the group filter are hidden.
 */
export default function Analytics() {
	const token = useAuthStore((s) => s.token) ?? '';
	const singleUser = useAdminSingleUser();
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

	const groups = useQuery({
		queryKey: ['admin', 'groups'],
		queryFn: async () => ((await getGroups(token)) ?? []) as { id: string; name: string }[],
		enabled: !singleUser
	});
	const models = useQuery({
		queryKey: ['models-all'],
		queryFn: async () => ((await getModels(token)) ?? []) as { id: string; name?: string }[]
	});

	// A group chosen before the install went down to one account no longer applies.
	const group = singleUser ? null : groupId;
	const incomplete = isCustomIncomplete(period, customStart, customEnd);
	const data = useQuery({
		queryKey: ['admin', 'analytics', period, customStart, customEnd, group],
		enabled: !incomplete,
		queryFn: async () => {
			const { start, end } = dateRange(period, customStart, customEnd);
			const granularity = period === '24h' ? 'hourly' : 'daily';
			const [summary, byModel, byUser, daily, tokens] = await Promise.all([
				getSummary(token, start, end, group),
				getModelAnalytics(token, start, end, group),
				getUserAnalytics(token, start, end, 50, group),
				getDailyStats(token, start, end, granularity, group),
				getTokenUsage(token, start, end, group)
			]);
			return { summary, byModel, byUser, daily, tokens };
		}
	});

	const names = useMemo(() => new Map((models.data ?? []).map((m) => [m.id, m.name || m.id])), [models.data]);
	const summary = data.data?.summary ?? { total_messages: 0, total_chats: 0, total_users: 0 };
	const modelStats: ModelStat[] = useMemo(
		() =>
			((data.data?.byModel?.models ?? []) as Omit<ModelStat, 'name'>[]).map((m) => ({
				...m,
				name: names.get(m.model_id) || m.model_id
			})),
		[data.data, names]
	);
	const userStats: UserStat[] = data.data?.byUser?.users ?? [];
	const daily: DailyPoint[] = data.data?.daily?.data ?? [];
	const tokenStats: TokenStats = useMemo(
		() =>
			Object.fromEntries(
				(
					(data.data?.tokens?.models ?? []) as {
						model_id: string;
						input_tokens: number;
						output_tokens: number;
						total_tokens: number;
					}[]
				).map((m) => [m.model_id, m])
			),
		[data.data]
	);
	const totalTokens = data.data?.tokens?.total_tokens ?? 0;

	const sortedModels = useMemo(
		() => sortModels(modelStats, tokenStats, modelSort.by, modelSort.dir),
		[modelStats, tokenStats, modelSort]
	);
	const sortedUsers = useMemo(() => sortUsers(userStats, userSort.by, userSort.dir), [userStats, userSort]);
	const totalModelMessages = modelStats.reduce((sum, m) => sum + m.count, 0);
	const prefix = sharedPrefix(modelStats.map((m) => m.name));

	const chartSeries = chartModels(daily);
	const range = dateRange(period, customStart, customEnd);
	const periodLabel = PERIODS.find((p) => p.value === period)?.label ?? '';
	const groupLabel = groups.data?.find((g) => g.id === groupId)?.name ?? 'All users';

	const openModel = (model: ModelStat) => {
		setSelectedModel({ id: model.model_id, name: model.name });
		setShowModel(true);
	};
	const sortModel = (by: ModelSort) => setModelSort((s) => toggle(s, by));
	const sortUser = (by: UserSort) => setUserSort((s) => toggle(s, by));

	const stats = [
		{ value: summary.total_messages.toLocaleString(), noun: summary.total_messages === 1 ? 'message' : 'messages' },
		{ value: formatNumber(totalTokens), noun: 'tokens (estimated)' },
		{ value: summary.total_chats.toLocaleString(), noun: summary.total_chats === 1 ? 'chat' : 'chats' },
		...(singleUser
			? []
			: [{ value: summary.total_users.toLocaleString(), noun: summary.total_users === 1 ? 'user' : 'users' }])
	];

	return (
		<div className="flex h-full w-full flex-col gap-4 overflow-y-auto pb-4">
			<AnalyticsModelModal
				open={showModel}
				onOpenChange={setShowModel}
				model={selectedModel}
				startDate={range.start}
				endDate={range.end}
			/>

			<h2 className="sr-only">Analytics</h2>
			<div className="flex flex-wrap items-center gap-2">
				{!singleUser && (groups.data?.length ?? 0) > 0 && (
					<FilterMenu
						value={groupId ?? ''}
						onChange={(v) => setGroupId(v || null)}
						items={[
							{ value: '', label: 'All users' },
							...(groups.data ?? []).map((g) => ({ value: g.id, label: g.name }))
						]}
						trigger={
							<Button variant="outline" type="button" className="shrink">
								<span className="truncate">Group: {groupLabel}</span>
								<ChevronDown aria-hidden data-icon="inline-end" />
							</Button>
						}
					/>
				)}
				<FilterMenu
					value={period}
					onChange={(v) => setPeriod(v as Period)}
					items={PERIODS}
					trigger={
						<Button variant="outline" type="button">
							Period: {periodLabel}
							<ChevronDown aria-hidden data-icon="inline-end" />
						</Button>
					}
				/>
				{period === 'custom' && (
					<div className="flex flex-wrap items-center gap-2">
						<Input
							type="date"
							aria-label="Start date"
							className="w-auto"
							value={customStart}
							max={customEnd || undefined}
							onChange={(e) => setCustomStart(e.target.value)}
						/>
						<span aria-hidden className="text-foreground-muted">
							to
						</span>
						<Input
							type="date"
							aria-label="End date"
							className="w-auto"
							value={customEnd}
							min={customStart || undefined}
							onChange={(e) => setCustomEnd(e.target.value)}
						/>
					</div>
				)}
			</div>

			{incomplete ? (
				<p className="text-foreground-muted py-10 text-center">Choose a start and an end date.</p>
			) : data.isError ? (
				<LoadFailed what="analytics" error={data.error} onRetry={() => data.refetch()} retrying={data.isFetching} />
			) : data.isFetching || !data.data ? (
				<TableSkeleton label="analytics" />
			) : (
				<>
					<dl className="flex flex-wrap gap-x-6 gap-y-2">
						{stats.map((s) => (
							<div key={s.noun} className="flex items-baseline gap-1.5">
								<dt className="text-foreground-muted order-2">{s.noun}</dt>
								<dd className="text-foreground-strong font-strong text-title order-1 tabular-nums">{s.value}</dd>
							</div>
						))}
					</dl>

					{daily.length > 1 && (
						<div className="flex flex-col gap-2">
							<h3 className="text-foreground-strong font-strong">Messages over time</h3>
							<ChartLine
								data={daily}
								models={chartSeries}
								colors={CHART_COLORS}
								height={200}
								period={chartPeriod(period)}
								labelOf={(id) => names.get(id) || id}
							/>
						</div>
					)}

					<div className={cn('grid gap-6', !singleUser && 'xl:grid-cols-2')}>
						<div className="flex min-w-0 flex-col gap-2">
							<h3 className="text-foreground-strong font-strong">Model usage</h3>
							{sortedModels.length === 0 ? (
								<p className="text-foreground-muted py-6 text-center">No messages in this period.</p>
							) : (
								<Table aria-label="Model usage" className="text-dense table-fixed text-left">
									<thead>
										<tr className="border-b">
											<Head label="Model" by="name" sort={modelSort} onSort={sortModel} />
											<Head label="Messages" by="count" sort={modelSort} onSort={sortModel} className="w-24" />
											{!singleUser && (
												<Head
													label="Users"
													by="users"
													sort={modelSort}
													onSort={sortModel}
													className="w-20 max-sm:hidden"
												/>
											)}
											<Head
												label="Chats"
												by="chats"
												sort={modelSort}
												onSort={sortModel}
												className="w-20 max-sm:hidden"
											/>
											<Head
												label="Tokens"
												by="tokens"
												sort={modelSort}
												onSort={sortModel}
												className="w-20 max-sm:hidden"
											/>
											<Head label="Share" by="percentage" sort={modelSort} onSort={sortModel} className="w-20" />
										</tr>
									</thead>
									<tbody>
										{sortedModels.map((model) => {
											const title = model.name === model.model_id ? model.name : `${model.name} (${model.model_id})`;
											const shown = prefix ? model.name.slice(prefix.length) : model.name;
											return (
												<tr
													key={model.model_id}
													className="hover:bg-muted/50 cursor-pointer border-b last:border-0"
													onClick={openRow(() => openModel(model))}
												>
													<td className="py-1">
														<div className="flex min-w-0 items-center gap-2 ps-2">
															<ProfileAvatar
																src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${encodeURIComponent(model.model_id)}`}
																name={model.name}
																size="sm"
															/>
															<Button
																variant="ghost"
																size="sm"
																type="button"
																title={title}
																className="text-foreground -mx-2.5 max-w-full shrink justify-start"
																onClick={() => openModel(model)}
															>
																<span className="truncate">{shown}</span>
															</Button>
														</div>
													</td>
													<td className="px-2 py-1 text-right tabular-nums">{model.count.toLocaleString()}</td>
													{!singleUser && (
														<td className="px-2 py-1 text-right tabular-nums max-sm:hidden">
															{(model.unique_users ?? 0).toLocaleString()}
														</td>
													)}
													<td className="px-2 py-1 text-right tabular-nums max-sm:hidden">
														{(model.unique_chats ?? 0).toLocaleString()}
													</td>
													<td className="px-2 py-1 text-right tabular-nums max-sm:hidden">
														{formatNumber(tokenStats[model.model_id]?.total_tokens ?? 0)}
													</td>
													<td className="px-2 py-1 text-right tabular-nums">
														{sharePercent(model.count, totalModelMessages)}%
													</td>
												</tr>
											);
										})}
									</tbody>
								</Table>
							)}
						</div>

						{!singleUser && (
							<div className="flex min-w-0 flex-col gap-2">
								<h3 className="text-foreground-strong font-strong">User activity</h3>
								{sortedUsers.length === 0 ? (
									<p className="text-foreground-muted py-6 text-center">No messages in this period.</p>
								) : (
									<Table aria-label="User activity" className="text-dense table-fixed text-left">
										<thead>
											<tr className="border-b">
												<Head label="User" by="name" sort={userSort} onSort={sortUser} />
												<Head label="Messages" by="count" sort={userSort} onSort={sortUser} className="w-24" />
												<Head label="Tokens" by="tokens" sort={userSort} onSort={sortUser} className="w-20" />
											</tr>
										</thead>
										<tbody>
											{sortedUsers.map((user) => {
												const name = user.name || user.email || user.user_id.substring(0, 8);
												return (
													<tr key={user.user_id} className="border-b last:border-0">
														<td className="px-2 py-1.5">
															<div className="flex min-w-0 items-center gap-2">
																<ProfileAvatar
																	src={`${WEBUI_API_BASE_URL}/users/${user.user_id}/profile/image`}
																	name={user.name || user.email}
																	size="sm"
																/>
																<span className="text-foreground truncate" title={name}>
																	{name}
																</span>
															</div>
														</td>
														<td className="px-2 py-1.5 text-right tabular-nums">{user.count.toLocaleString()}</td>
														<td className="px-2 py-1.5 text-right tabular-nums">
															{formatNumber(user.total_tokens ?? 0)}
														</td>
													</tr>
												);
											})}
										</tbody>
									</Table>
								)}
							</div>
						)}
					</div>

					<p className="text-foreground-muted text-caption">
						Messages count model replies. Token counts are estimates and can differ from what a provider bills.
					</p>
				</>
			)}
		</div>
	);
}
