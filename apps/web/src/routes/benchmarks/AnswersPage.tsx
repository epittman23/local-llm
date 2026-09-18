import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getAnswerOne, getAnswerRuns, getAnswers } from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';

type AnswerRow = {
	benchmark: string;
	item_id: string;
	outcome: string;
	reason?: string;
};

const filterOptions = [
	{ value: 'failures', label: 'Failures' },
	{ value: 'all', label: 'All' },
	{ value: 'pass', label: 'Pass' }
];

const outcomeBadgeVariant = (outcome: string): 'default' | 'destructive' | 'secondary' => {
	const o = (outcome ?? '').toLowerCase();
	if (o.includes('pass')) return 'default';
	if (o.includes('fail')) return 'destructive';
	return 'secondary';
};

const formatRunLabel = (run: {
	started_at: number;
	model: string;
	tier: string;
	passed: number;
	attempted: number;
}): string => {
	const date = run.started_at ? new Date(run.started_at * 1000).toLocaleString() : '—';
	return `${date} · ${run.model} · ${run.tier} · ${run.passed}/${run.attempted}`;
};

/**
 * Ports Answers.svelte's run picker, filterable results table, and answer
 * detail -- except the detail view. The checklist is explicit here (Phase 5,
 * docs/migration-plan.md): "build a minimal transcript renderer; do not port
 * chat/Messages.svelte for it." Svelte's own version reused the live chat's
 * Messages component purely for its markdown/code-block rendering, at the
 * cost of a documented layout bug ("does not size correctly outside the
 * live chat's own layout") worked around by escaping markdown headings.
 * This renders the prompt/response as plain preformatted text instead --
 * benchmark answers are graded as code, so preserving whitespace exactly
 * matters more here than markdown rendering does.
 */
export function AnswersPage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const [selectedRun, setSelectedRun] = useState<string | null>(null);
	const [filter, setFilter] = useState<'failures' | 'all' | 'pass'>('failures');
	const [selectedItem, setSelectedItem] = useState<{ benchmark: string; item_id: string } | null>(
		null
	);
	const [thinking, setThinking] = useState(false);

	const runsQuery = useQuery({
		queryKey: ['answer-runs'],
		queryFn: () => getAnswerRuns(token, 20),
		enabled: !!token
	});
	const runs = runsQuery.data?.runs ?? [];
	const effectiveRun = selectedRun ?? runs[0]?.suite_run_id ?? null;

	const rowsQuery = useQuery({
		queryKey: ['answers', effectiveRun, filter],
		queryFn: () => getAnswers(token, effectiveRun as string, filter),
		enabled: !!token && !!effectiveRun
	});
	const rows: AnswerRow[] = rowsQuery.data?.rows ?? [];

	const answerQuery = useQuery({
		queryKey: ['answer', effectiveRun, selectedItem, thinking],
		queryFn: () =>
			getAnswerOne(token, {
				run: effectiveRun as string,
				benchmark: (selectedItem as { benchmark: string }).benchmark,
				item_id: (selectedItem as { item_id: string }).item_id,
				thinking
			}),
		enabled: !!token && !!effectiveRun && !!selectedItem
	});
	const answer = answerQuery.data;

	return (
		<div className="flex flex-col gap-2">
			<div className="mb-2 flex flex-wrap items-center justify-between gap-2">
				<h2 className="shrink-0 text-lg font-medium">Answers</h2>

				<div className="flex flex-wrap items-center justify-end gap-2">
					{runsQuery.isLoading ? (
						<p className="text-muted-foreground text-xs">Loading…</p>
					) : runs.length > 0 ? (
						<Select
							value={effectiveRun ?? undefined}
							onValueChange={(v) => {
								setSelectedRun(v);
								setSelectedItem(null);
							}}
						>
							<SelectTrigger className="w-fit max-w-md">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{runs.map((run: any) => (
									<SelectItem key={run.suite_run_id} value={run.suite_run_id}>
										{formatRunLabel(run)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : (
						<span className="text-muted-foreground text-xs">No runs found</span>
					)}

					<Select
						value={filter}
						onValueChange={(v) => {
							setFilter(v as typeof filter);
							setSelectedItem(null);
						}}
					>
						<SelectTrigger className="w-32">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{filterOptions.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>

					<label className="flex items-center gap-1.5 text-xs select-none">
						<Checkbox checked={thinking} onCheckedChange={(c) => setThinking(c === true)} />
						Show thinking
					</label>
				</div>
			</div>

			{rowsQuery.isLoading ? (
				<div className="my-10 flex justify-center">
					<p className="text-muted-foreground text-sm">Loading…</p>
				</div>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Benchmark</TableHead>
							<TableHead>Item</TableHead>
							<TableHead>Outcome</TableHead>
							<TableHead>Reason</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<TableRow
								key={`${row.benchmark}::${row.item_id}`}
								className="cursor-pointer"
								data-state={
									selectedItem?.benchmark === row.benchmark && selectedItem?.item_id === row.item_id
										? 'selected'
										: undefined
								}
								onClick={() => setSelectedItem({ benchmark: row.benchmark, item_id: row.item_id })}
							>
								<TableCell>{row.benchmark}</TableCell>
								<TableCell>{row.item_id}</TableCell>
								<TableCell>
									<Badge variant={outcomeBadgeVariant(row.outcome)}>{row.outcome}</Badge>
								</TableCell>
								<TableCell className="max-w-96 truncate" title={row.reason ?? ''}>
									{row.reason ?? '—'}
								</TableCell>
							</TableRow>
						))}
						{rows.length === 0 && (
							<TableRow>
								<TableCell colSpan={4} className="text-muted-foreground text-center">
									No data
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			)}

			<div className="mt-6 flex flex-col gap-1.5 border-t pt-4">
				<div className="text-sm">Answer</div>

				{!selectedItem ? (
					<p className="text-muted-foreground px-0.5 text-xs">Select a row above to view its answer.</p>
				) : answerQuery.isLoading ? (
					<div className="my-6 flex justify-center">
						<p className="text-muted-foreground text-sm">Loading…</p>
					</div>
				) : answerQuery.isError ? (
					<p className="text-destructive px-0.5 text-xs">Failed to load answer</p>
				) : answer ? (
					<div className="flex flex-col gap-2">
						<div className="text-muted-foreground flex flex-wrap items-center gap-2 px-0.5 text-xs">
							<span className="text-foreground font-medium">{answer.model}</span>
							{answer.config_id && <span>· {answer.config_id}</span>}
							{answer.system_name && <span>· {answer.system_name}</span>}
							<Badge variant={outcomeBadgeVariant(answer.outcome)}>{answer.outcome}</Badge>
							{answer.reason && <span>— {answer.reason}</span>}
						</div>
						<div className="flex flex-col gap-3 rounded-lg border p-3">
							<div>
								<div className="text-muted-foreground mb-1 text-xs font-medium">Prompt</div>
								<pre className="bg-muted overflow-x-auto rounded-md p-2.5 text-xs whitespace-pre-wrap">
									{answer.prompt}
								</pre>
							</div>
							{thinking && answer.reasoning && (
								<div>
									<div className="text-muted-foreground mb-1 text-xs font-medium">
										Reasoning ({answer.reasoning_chars} chars)
									</div>
									<pre className="bg-muted overflow-x-auto rounded-md p-2.5 text-xs whitespace-pre-wrap">
										{answer.reasoning}
									</pre>
								</div>
							)}
							<div>
								<div className="text-muted-foreground mb-1 text-xs font-medium">Response</div>
								<pre className="bg-muted overflow-x-auto rounded-md p-2.5 text-xs whitespace-pre-wrap">
									{answer.content}
								</pre>
							</div>
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}
