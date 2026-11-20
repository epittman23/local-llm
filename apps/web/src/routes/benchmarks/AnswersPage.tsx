import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Markdown } from '@/components/chat/markdown/Markdown';
import { LoadFailed } from '@/components/common/LoadFailed';
import { TableSkeleton } from '@/components/common/TableSkeleton';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getAnswerOne, getAnswerRuns, getAnswers, type SuiteRun } from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { OutcomeBadge } from './OutcomeBadge';

type AnswerRow = {
	benchmark: string;
	item_id: string;
	outcome: string;
	reason?: string;
};

type Filter = 'failures' | 'all' | 'pass';
const FILTERS: { value: Filter; label: string }[] = [
	{ value: 'failures', label: 'Failures' },
	{ value: 'all', label: 'All outcomes' },
	{ value: 'pass', label: 'Passed' }
];

/** A record's time, absolute (DAT-5): `2026-11-14 22:46`, in local time. */
export const recordTime = (epochSeconds: number): string => {
	if (!epochSeconds) return '–';
	const d = new Date(epochSeconds * 1000);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** A run in the picker: when, the model at its configuration, the tier, and its score (B-D7). */
export const formatRunLabel = (run: SuiteRun): string =>
	`${recordTime(run.started_at)} · ${run.model}${run.config_id ? ` @ ${run.config_id}` : ''} · ${run.tier} · ${run.passed}/${run.attempted}`;

/** What llama-server's timings say about one answer, in words with units (WRD-5); '' when it sent none. */
export const timingText = (t: Record<string, number> | null | undefined): string => {
	if (!t) return '';
	const parts: string[] = [];
	if (t.predicted_n) {
		const rate = t.predicted_per_second ?? (t.predicted_ms ? (t.predicted_n / t.predicted_ms) * 1000 : null);
		parts.push(
			`${t.predicted_n.toLocaleString('en')} tokens generated${rate ? ` at ${rate.toFixed(1)} tokens/s` : ''}`
		);
	}
	if (t.prompt_n) {
		parts.push(
			`${t.prompt_n.toLocaleString('en')} prompt tokens${t.prompt_ms ? ` in ${(t.prompt_ms / 1000).toFixed(1)} s` : ''}`
		);
	}
	return parts.join(' · ');
};

const sameItem = (a: { benchmark: string; item_id: string } | null, b: AnswerRow) =>
	!!a && a.benchmark === b.benchmark && a.item_id === b.item_id;

/**
 * Ports Answers.svelte's run picker, filterable results and answer detail,
 * as a list and the answer beside it (#1046): on a wide screen the answer
 * stays in view while the list scrolls; on a phone the answer replaces the
 * list, with a way back. Every choice is in the address (NAV-1):
 * `?run=&filter=&benchmark=&item=`; opening an answer adds a history entry,
 * the rest replace it. The answer is rendered with the chat's own Markdown
 * (CNT-1, CNT-2), with the raw text a click away, since graded code is
 * whitespace-exact.
 */
export function AnswersPage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const [params, setParams] = useSearchParams();
	const [thinking, setThinking] = useState(false);
	const [view, setView] = useState<'rendered' | 'raw'>('rendered');

	const filterParam = params.get('filter');
	const filter: Filter = filterParam === 'all' || filterParam === 'pass' ? filterParam : 'failures';
	const benchmarkParam = params.get('benchmark');
	const itemParam = params.get('item');
	const selected = benchmarkParam && itemParam ? { benchmark: benchmarkParam, item_id: itemParam } : null;

	const update = (changes: Record<string, string | null>, push = false) =>
		setParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				for (const [k, v] of Object.entries(changes)) {
					if (v) next.set(k, v);
					else next.delete(k);
				}
				return next;
			},
			{ replace: !push }
		);

	const runsQuery = useQuery({
		queryKey: ['answer-runs'],
		queryFn: () => getAnswerRuns(token, 50),
		enabled: !!token
	});
	const runs = runsQuery.data?.runs ?? [];
	const effectiveRun = params.get('run') ?? runs[0]?.suite_run_id ?? null;
	// The newest run is a default, not a place: once shown, its id goes in the
	// address, so a reload or a shared link stays on it after a newer run (NAV-1).
	const runParam = params.get('run');
	useEffect(() => {
		if (!runParam && effectiveRun) update({ run: effectiveRun });
	});

	const rowsQuery = useQuery({
		queryKey: ['answers', effectiveRun, filter],
		queryFn: () => getAnswers(token, effectiveRun as string, filter),
		enabled: !!token && !!effectiveRun
	});
	const rows: AnswerRow[] = rowsQuery.data?.rows ?? [];
	const index = rows.findIndex((row) => sameItem(selected, row));

	const answerQuery = useQuery({
		queryKey: ['answer', effectiveRun, selected?.benchmark, selected?.item_id, thinking],
		queryFn: () =>
			getAnswerOne(token, {
				run: effectiveRun as string,
				benchmark: (selected as AnswerRow).benchmark,
				item_id: (selected as AnswerRow).item_id,
				thinking
			}),
		enabled: !!token && !!effectiveRun && !!selected
	});
	const answer = answerQuery.data;

	const listRef = useRef<HTMLDivElement>(null);
	const detailRef = useRef<HTMLElement>(null);

	const open = (row: AnswerRow, push = true) => update({ benchmark: row.benchmark, item: row.item_id }, push);
	const step = (by: number, focusRow = false) => {
		const next = rows[index === -1 ? 0 : index + by];
		if (!next) return;
		open(next, false);
		if (focusRow) {
			const target = index === -1 ? 0 : index + by;
			requestAnimationFrame(() =>
				listRef.current?.querySelectorAll<HTMLButtonElement>('[data-row-open]')[target]?.focus()
			);
		}
	};

	// On a phone the answer replaces the list: bring its heading to the top when one opens,
	// and when it closes, give focus back to the row it came from (NAV-4).
	const selectedKey = selected ? `${selected.benchmark}::${selected.item_id}` : '';
	const returnTo = useRef('');
	useEffect(() => {
		if (!selectedKey) {
			const key = returnTo.current;
			returnTo.current = '';
			if (key) listRef.current?.querySelector<HTMLButtonElement>(`[data-row-open="${CSS.escape(key)}"]`)?.focus();
			return;
		}
		const el = detailRef.current;
		if (el && typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1023px)').matches) {
			el.scrollIntoView({ block: 'start' });
			// The list (and the row that had focus) is hidden now: focus moves to the answer (NAV-4).
			el.querySelector<HTMLElement>('#answers-detail-title')?.focus({ preventScroll: true });
		}
	}, [selectedKey]);

	// Up and Down (or k and j) move between answers, from the list or the answer (NAV-5).
	const onKeys = (event: KeyboardEvent, fromList: boolean) => {
		const target = event.target as HTMLElement;
		if (target.closest('input, textarea, select, [role="combobox"], [role="radiogroup"]')) return;
		if (fromList && !target.hasAttribute('data-row-open')) return;
		const by =
			event.key === 'ArrowDown' || event.key === 'j' ? 1 : event.key === 'ArrowUp' || event.key === 'k' ? -1 : 0;
		if (!by || !rows.length) return;
		event.preventDefault();
		step(by, fromList);
	};

	const filterLabel = FILTERS.find((f) => f.value === filter)?.label ?? '';

	return (
		// min-w-0: a long answer or row scrolls in its own box instead of widening the page.
		<div className="flex min-w-0 flex-col gap-4">
			<div>
				<h2 className="text-lg font-medium">Answers</h2>
				<p className="text-foreground-muted text-dense">
					Read what the model answered for each graded item of a run, failures first.
				</p>
			</div>

			<div className="flex flex-wrap items-end gap-3">
				<div className="flex min-w-0 flex-col gap-1">
					<Label htmlFor="answers-run">Run</Label>
					{runsQuery.isLoading ? (
						<p className="text-foreground-muted text-dense py-1.5">Loading runs…</p>
					) : (
						<Select
							value={effectiveRun ?? undefined}
							disabled={!runs.length}
							onValueChange={(v) => update({ run: v, benchmark: null, item: null })}
						>
							<SelectTrigger id="answers-run" className="w-full max-w-full sm:w-fit">
								<SelectValue placeholder="No runs" />
							</SelectTrigger>
							<SelectContent>
								{runs.map((run) => (
									<SelectItem key={run.suite_run_id} value={run.suite_run_id}>
										{formatRunLabel(run)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="answers-outcome">Outcome</Label>
					<Select
						value={filter}
						onValueChange={(v) => update({ filter: v === 'failures' ? null : v, benchmark: null, item: null })}
					>
						<SelectTrigger id="answers-outcome" className="w-36">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{FILTERS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex items-center gap-2 pb-1.5">
					<Checkbox id="answers-thinking" checked={thinking} onCheckedChange={(c) => setThinking(c === true)} />
					<Label htmlFor="answers-thinking" className="font-normal">
						Show thinking
					</Label>
				</div>
			</div>

			{runsQuery.isError ? (
				<LoadFailed
					what="runs"
					error={runsQuery.error}
					onRetry={() => void runsQuery.refetch()}
					retrying={runsQuery.isFetching}
				/>
			) : !runsQuery.isLoading && runs.length === 0 ? (
				<div className="mx-auto flex max-w-sm flex-col items-center gap-2 py-16 text-center">
					<p className="text-title font-title">No runs yet</p>
					<p className="text-foreground-muted">A run on Tests records every answer, and they can be read here.</p>
					<Button asChild variant="outline">
						<Link to="/benchmarks/tests">Open Tests</Link>
					</Button>
				</div>
			) : (
				<div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-start">
					<div ref={listRef} className={selected ? 'max-lg:hidden' : undefined}>
						{rowsQuery.isLoading || runsQuery.isLoading ? (
							<TableSkeleton label="Loading answers" rows={6} />
						) : rowsQuery.isError ? (
							<LoadFailed
								what="answers"
								error={rowsQuery.error}
								onRetry={() => void rowsQuery.refetch()}
								retrying={rowsQuery.isFetching}
							/>
						) : rows.length === 0 ? (
							<p className="text-foreground-muted py-8 text-center">
								{filter === 'failures'
									? 'No failures in this run.'
									: filter === 'pass'
										? 'Nothing passed in this run.'
										: 'This run has no answers.'}
							</p>
						) : (
							<>
								<p className="text-foreground-muted text-dense mb-1 tabular-nums">
									{rows.length} {filterLabel.toLowerCase()}
								</p>
								<Table aria-label="Answers">
									<TableHeader>
										<TableRow>
											<TableHead scope="col">Item</TableHead>
											<TableHead scope="col">Outcome</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{rows.map((row) => (
											<TableRow
												key={`${row.benchmark}::${row.item_id}`}
												data-state={sameItem(selected, row) ? 'selected' : undefined}
												onOpen={() => open(row)}
											>
												<TableCell className="min-w-0 whitespace-normal">
													<Button
														type="button"
														variant="ghost"
														size="sm"
														data-row-open={`${row.benchmark}::${row.item_id}`}
														aria-current={sameItem(selected, row) ? 'true' : undefined}
														className="-mx-2.5 h-auto max-w-full shrink flex-col items-start gap-0 py-1 text-left whitespace-normal"
														onClick={() => open(row)}
														onKeyDown={(e) => onKeys(e, true)}
													>
														<span className="text-foreground font-mono break-all">{row.item_id}</span>
														<span className="text-foreground-muted text-dense font-normal">{row.benchmark}</span>
													</Button>
												</TableCell>
												<TableCell>
													<OutcomeBadge outcome={row.outcome} />
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</>
						)}
					</div>

					<section
						ref={detailRef}
						aria-labelledby="answers-detail-title"
						onKeyDown={(e) => onKeys(e, false)}
						className={
							selected
								? 'min-w-0 scroll-mt-4 lg:sticky lg:top-4 lg:rounded-lg lg:border lg:p-4'
								: 'max-lg:hidden lg:rounded-lg lg:border lg:p-4'
						}
					>
						{!selected ? (
							<>
								<h3 id="answers-detail-title" className="text-body font-strong">
									Answer
								</h3>
								<p className="text-foreground-muted text-dense mt-1">
									Open an item in the list to read its answer here.
								</p>
							</>
						) : (
							<div className="flex min-w-0 flex-col gap-3">
								<div className="flex flex-wrap items-center gap-2">
									<Button
										variant="ghost"
										size="sm"
										className="lg:hidden"
										onClick={() => {
											returnTo.current = selectedKey;
											update({ benchmark: null, item: null });
										}}
									>
										<ArrowLeftIcon aria-hidden />
										Back to the list
									</Button>
									{index !== -1 && (
										<div className="ml-auto flex items-center gap-1">
											<span className="text-foreground-muted text-dense tabular-nums">
												{index + 1} of {rows.length}
											</span>
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label="Previous answer"
												title="Previous answer (Up or k)"
												disabled={index <= 0}
												onClick={() => step(-1)}
											>
												<ChevronUpIcon aria-hidden />
											</Button>
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label="Next answer"
												title="Next answer (Down or j)"
												disabled={index >= rows.length - 1}
												onClick={() => step(1)}
											>
												<ChevronDownIcon aria-hidden />
											</Button>
										</div>
									)}
								</div>
								<div className="flex flex-wrap items-center gap-2">
									<h3 id="answers-detail-title" tabIndex={-1} className="text-title font-title font-mono break-all">
										{selected.item_id}
									</h3>
									{answer && <OutcomeBadge outcome={answer.outcome} />}
								</div>

								{answerQuery.isLoading ? (
									<p className="text-foreground-muted text-dense">Loading the answer…</p>
								) : answerQuery.isError ? (
									<LoadFailed
										what="this answer"
										error={answerQuery.error}
										onRetry={() => void answerQuery.refetch()}
										retrying={answerQuery.isFetching}
									/>
								) : answer ? (
									<>
										<dl className="text-dense grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
											<dt className="text-foreground-muted">Benchmark</dt>
											<dd>{answer.benchmark}</dd>
											<dt className="text-foreground-muted">Model</dt>
											<dd>
												{answer.model}
												{answer.config_id && (
													<>
														{' @ '}
														<span className="font-mono">{answer.config_id}</span>
													</>
												)}
											</dd>
											<dt className="text-foreground-muted">System prompt</dt>
											<dd>{answer.system_name ?? 'None'}</dd>
											{answer.reason && (
												<>
													<dt className="text-foreground-muted">Reason</dt>
													<dd className="break-words">{answer.reason}</dd>
												</>
											)}
											{timingText(answer.timings) && (
												<>
													<dt className="text-foreground-muted">Timing</dt>
													<dd className="tabular-nums">{timingText(answer.timings)}</dd>
												</>
											)}
										</dl>

										<SegmentedControl
											aria-label="Show the answer as"
											value={view}
											onValueChange={setView}
											options={[
												{ value: 'rendered', label: 'Rendered' },
												{ value: 'raw', label: 'Raw text' }
											]}
											className="w-fit"
										/>

										<div>
											<h4 className="text-foreground-muted mb-1 text-dense font-strong">Prompt</h4>
											{/* The prompt is what was sent, often a code stub: always its exact text. */}
											<pre className="bg-surface-1 overflow-x-auto rounded-lg border p-2.5 text-dense whitespace-pre-wrap">
												{answer.prompt}
											</pre>
										</div>
										{thinking && answer.reasoning && (
											<div>
												<h4 className="text-foreground-muted mb-1 text-dense font-strong">
													Thinking ({answer.reasoning_chars.toLocaleString('en')} characters)
												</h4>
												<pre className="bg-surface-1 max-h-96 overflow-auto rounded-lg border p-2.5 text-dense whitespace-pre-wrap">
													{answer.reasoning}
												</pre>
											</div>
										)}
										<div>
											<h4 className="text-foreground-muted mb-1 text-dense font-strong">Response</h4>
											{view === 'raw' ? (
												<pre className="bg-surface-1 overflow-x-auto rounded-lg border p-2.5 text-dense whitespace-pre-wrap">
													{answer.content}
												</pre>
											) : (
												<Markdown
													id={`answer-response-${selectedKey}`}
													content={answer.content ?? ''}
													modelName={answer.model}
												/>
											)}
										</div>
									</>
								) : null}
							</div>
						)}
					</section>
				</div>
			)}
		</div>
	);
}
