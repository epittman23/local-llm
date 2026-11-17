import { useMutation, useQuery } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { CheckIcon, CopyIcon, DownloadIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { Markdown } from '@/components/chat/markdown/Markdown';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
	generateReport,
	getAnswerRuns,
	getReportFileText,
	getTestOptions,
	listReports,
	type ReportAnswer
} from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { useCopy } from '@/lib/ui/useCopy';
import { recordTime } from './AnswersPage';
import { orderTiers } from './testsFormat';

const ALL = '__all__';

// `markdown_url` looks like `/api/v1/benchmarks/report/files/<run_dir>/report.md`;
// getReportFileText needs the run dir and filename split back out of it.
const splitMarkdownUrl = (markdownUrl: string): { runDir: string; filename: string } | null => {
	const parts = markdownUrl.split('/').filter(Boolean);
	if (parts.length < 2) return null;
	const filename = decodeURIComponent(parts[parts.length - 1]);
	const runDir = decodeURIComponent(parts[parts.length - 2]);
	return { runDir, filename };
};

/** Why a report has no figures, as a sentence (B-D4); '' when it has some. */
export const figuresNote = (skipped: string | undefined, count: number): string => {
	if (count > 0 || !skipped) return '';
	if (skipped.startsWith('figures disabled')) return 'No figures: Generate figures was off for this report.';
	if (skipped.startsWith('matplotlib'))
		return "No figure files: matplotlib isn't installed on the server, so the figures are text plots in the report.";
	if (skipped.startsWith('nothing to plot:')) return `No figures: ${skipped.slice('nothing to plot:'.length).trim()}.`;
	return `No figures: ${skipped}.`;
};

/** `at` is where the part starts in the document, a key that stays put. */
export type ReportPart =
	| { kind: 'text'; at: number; text: string }
	| { kind: 'figure'; at: number; src: string; alt: string; caption: string };

/**
 * The report as the page shows it: its title line taken out (the page shows
 * it above the document, so the document's sections are the page's next
 * headings, A11Y-3), and each figure placed where the report references it,
 * as a picture fetched with the token (`figures` maps a file name to its
 * object URL). A reference to a figure that could not be fetched stays in
 * the text as its description.
 */
export const reportParts = (
	markdown: string,
	figures: Record<string, string>
): { title: string; parts: ReportPart[] } => {
	let text = markdown;
	let title = '';
	const head = /^# (.+)\n/.exec(text);
	if (head) {
		title = head[1].trim();
		text = text.slice(head[0].length);
	}
	const parts: ReportPart[] = [];
	const figure = /^!\[([^\]]*)\]\(([^)\s]+)\)[ \t]*\n(?:[ \t]*\n)?(?:\*([^*\n]+)\*[ \t]*\n)?/gm;
	let last = 0;
	for (let m = figure.exec(text); m; m = figure.exec(text)) {
		const src = figures[m[2]];
		if (!src) continue;
		if (m.index > last) parts.push({ kind: 'text', at: last, text: text.slice(last, m.index) });
		parts.push({ kind: 'figure', at: m.index, src, alt: m[1], caption: m[3] ?? '' });
		last = m.index + m[0].length;
	}
	if (last < text.length) parts.push({ kind: 'text', at: last, text: text.slice(last) });
	return { title, parts };
};

/** A saved report in the picker: when, what it covers, and how many figures. */
export const reportLabel = (r: ReportAnswer): string => {
	const f = r.filters ?? {};
	const scope = [f.tier ?? 'all tiers', f.benchmark ?? 'all benchmarks', f.model ?? 'all models'].join(', ');
	const when = r.created_at ? recordTime(r.created_at) : r.date;
	return `${when} · ${r.filters ? scope : 'filters not recorded'} · ${r.figures.length} ${r.figures.length === 1 ? 'figure' : 'figures'}`;
};

const pageTheme = (): 'light' | 'dark' =>
	typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light';

/**
 * Ports Report.svelte: the tier/model/benchmark filters, Generate, and the
 * resulting markdown and figures. The document is rendered by the chat's
 * own Markdown (CNT-1): its tables are the shared Table, named and scrolling
 * in their own frames, with Copy table (DAT-6). Figures are drawn by the
 * server in the page's theme (B-D3), fetched with the Bearer token (an
 * `<img>` cannot send one) and shown where the report references them.
 * Saved reports can be reopened (B-D4). The filters and the open report are
 * in the address: `?tier=&benchmark=&model=&report=` (NAV-1).
 */
export function ReportPage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const [params, setParams] = useSearchParams();
	const { copied, copy } = useCopy();

	const setParam = (changes: Record<string, string | null>, push = false) =>
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

	const optionsQuery = useQuery({ queryKey: ['test-options'], queryFn: () => getTestOptions(token), enabled: !!token });
	const runsQuery = useQuery({
		queryKey: ['answer-runs', 200],
		queryFn: () => getAnswerRuns(token, 200),
		enabled: !!token
	});
	const savedQuery = useQuery({ queryKey: ['reports'], queryFn: () => listReports(token), enabled: !!token });
	const tiers = orderTiers(optionsQuery.data?.tiers ?? []);
	const benchmarks: string[] = optionsQuery.data?.benchmarks ?? [];
	const models = [...new Set((runsQuery.data?.runs ?? []).map((r) => r.model))].sort();
	const saved = savedQuery.data?.reports ?? [];

	const tier = params.get('tier') ?? ALL;
	const benchmark = params.get('benchmark') ?? ALL;
	const model = params.get('model') ?? ALL;
	const reportId = params.get('report');
	const figuresParam = params.get('figures') !== 'off';

	const generateMutation = useMutation({
		mutationFn: async (): Promise<ReportAnswer> => {
			const res = await generateReport(token, {
				...(tier !== ALL ? { tier } : {}),
				...(model !== ALL ? { model } : {}),
				...(benchmark !== ALL ? { benchmark } : {}),
				figures: figuresParam,
				theme: pageTheme()
			});
			if (res.error) throw new Error(res.error);
			return res;
		},
		onSuccess: (res) => {
			setParam({ report: res.date }, true);
			void savedQuery.refetch();
		}
	});
	const fresh = generateMutation.data;
	const answer: ReportAnswer | undefined =
		reportId && fresh?.date === reportId ? fresh : saved.find((r) => r.date === reportId);

	const objectUrls = useRef<string[]>([]);
	useEffect(
		() => () => {
			for (const url of objectUrls.current) URL.revokeObjectURL(url);
		},
		[]
	);

	const docQuery = useQuery({
		queryKey: ['report-doc', answer?.markdown_url],
		enabled: !!token && !!answer,
		staleTime: Number.POSITIVE_INFINITY,
		queryFn: async () => {
			const r = answer as ReportAnswer;
			const parsed = splitMarkdownUrl(r.markdown_url);
			if (!parsed) throw new Error('Unexpected report response');
			const text = (await getReportFileText(token, parsed.runDir, parsed.filename)) ?? '';
			const figures: Record<string, string> = {};
			await Promise.all(
				r.figures.map(async (url) => {
					try {
						const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
						if (!res.ok) return;
						const objectUrl = URL.createObjectURL(await res.blob());
						objectUrls.current.push(objectUrl);
						figures[decodeURIComponent(url.split('/').pop() ?? '')] = objectUrl;
					} catch (err) {
						console.error('Failed to load report figure:', url, err);
					}
				})
			);
			return { text, ...reportParts(text, figures) };
		}
	});

	const generateError =
		generateMutation.error instanceof Error ? generateMutation.error.message : generateMutation.error;
	const note = answer ? figuresNote(answer.figures_skipped, answer.figures.length) : '';

	return (
		<div className="flex min-w-0 flex-col gap-4">
			<div>
				<h2 className="text-lg font-medium">Report</h2>
				<p className="text-foreground-muted text-dense">
					Build a statistical report, with figures, from the recorded benchmark runs, or reopen a saved one.
				</p>
			</div>

			<form
				className="flex flex-wrap items-end gap-3"
				onSubmit={(e) => {
					e.preventDefault();
					generateMutation.mutate();
				}}
			>
				<div className="flex flex-col gap-1">
					<Label htmlFor="report-tier">Tier</Label>
					<Select value={tier} onValueChange={(v) => setParam({ tier: v === ALL ? null : v })}>
						<SelectTrigger id="report-tier" className="w-40">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All tiers</SelectItem>
							{tiers.map((t) => (
								<SelectItem key={t} value={t}>
									{t}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="flex flex-col gap-1">
					<Label htmlFor="report-model">Model</Label>
					<Select value={model} onValueChange={(v) => setParam({ model: v === ALL ? null : v })}>
						<SelectTrigger id="report-model" className="w-48">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All models</SelectItem>
							{[...new Set([...models, ...(model !== ALL ? [model] : [])])].map((m) => (
								<SelectItem key={m} value={m}>
									{m}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="flex flex-col gap-1">
					<Label htmlFor="report-benchmark">Benchmark</Label>
					<Select value={benchmark} onValueChange={(v) => setParam({ benchmark: v === ALL ? null : v })}>
						<SelectTrigger id="report-benchmark" className="w-48">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All benchmarks</SelectItem>
							{benchmarks.map((b) => (
								<SelectItem key={b} value={b}>
									{b}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="flex items-center gap-2 pb-1.5">
					<Checkbox
						id="report-figures"
						checked={figuresParam}
						onCheckedChange={(c) => setParam({ figures: c === true ? null : 'off' })}
					/>
					<Label htmlFor="report-figures" className="font-normal">
						Generate figures
					</Label>
				</div>

				<Button type="submit" disabled={generateMutation.isPending} aria-busy={generateMutation.isPending || undefined}>
					{generateMutation.isPending ? 'Generating…' : 'Generate report'}
				</Button>
			</form>
			{generateMutation.isError && (
				<div role="alert" className="text-danger text-dense">
					<p>
						Couldn't generate the report
						{generateError === 'no results match those filters'
							? ': no recorded results match these filters.'
							: ': the server answered with an error.'}
					</p>
					{generateError !== 'no results match those filters' && (
						<details className="text-foreground-muted mt-1">
							<summary className="cursor-pointer">Details</summary>
							<p className="mt-1 break-words">{String(generateError)}</p>
						</details>
					)}
				</div>
			)}

			{saved.length > 0 && (
				<div className="flex min-w-0 flex-col gap-1">
					<Label htmlFor="report-saved">Saved report</Label>
					<Select value={answer ? answer.date : ''} onValueChange={(v) => setParam({ report: v }, true)}>
						<SelectTrigger id="report-saved" className="w-full max-w-full sm:w-fit">
							<SelectValue placeholder={`Open one of ${saved.length} saved reports`} />
						</SelectTrigger>
						<SelectContent>
							{saved.map((r) => (
								<SelectItem key={r.date} value={r.date}>
									{reportLabel(r)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}

			{generateMutation.isPending ? (
				<p className="text-foreground-muted my-6" role="status">
					Generating the report… this can take a while for large runs.
				</p>
			) : reportId && !answer ? (
				savedQuery.isLoading ? (
					<p className="text-foreground-muted my-6">Loading the saved report…</p>
				) : savedQuery.isError ? (
					<LoadFailed what="saved reports" error={savedQuery.error} onRetry={() => void savedQuery.refetch()} />
				) : (
					<div className="my-6 flex flex-col items-start gap-2">
						<p className="text-title font-title">This report no longer exists</p>
						<p className="text-foreground-muted">
							No saved report is called <span className="font-mono">{reportId}</span>. Generate a new one, or open a
							saved one.
						</p>
					</div>
				)
			) : answer ? (
				docQuery.isError ? (
					<LoadFailed what="the report" error={docQuery.error} onRetry={() => void docQuery.refetch()} />
				) : docQuery.isLoading || !docQuery.data ? (
					<p className="text-foreground-muted my-6">Loading the report…</p>
				) : (
					<article aria-labelledby="report-title" className="flex min-w-0 flex-col gap-3">
						<div className="flex flex-wrap items-center gap-2 border-b pb-2">
							<h3 id="report-title" className="text-title font-title mr-auto">
								{docQuery.data.title || 'Measurement report'}
							</h3>
							<Button variant="outline" size="sm" onClick={() => void copy(docQuery.data.text, 'the report markdown')}>
								{copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
								{copied ? 'Copied' : 'Copy markdown'}
							</Button>
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									saveAs(
										new Blob([docQuery.data.text], { type: 'text/markdown;charset=utf-8' }),
										`report-${answer.date}.md`
									)
								}
							>
								<DownloadIcon aria-hidden />
								Download .md
							</Button>
						</div>
						{answer.windows.length > 0 && (
							<div className="flex flex-wrap items-center gap-1.5">
								{answer.windows.map((w) => (
									<Badge key={w} variant="secondary">
										Release-date window: {w}
									</Badge>
								))}
							</div>
						)}
						{note && <p className="text-foreground-muted text-dense">{note}</p>}
						{docQuery.data.parts.map((part) =>
							part.kind === 'text' ? (
								<Markdown key={part.at} id={`report-${answer.date}-${part.at}`} content={part.text} />
							) : (
								// CNT-4: a generated figure sits in a frame that belongs to the theme.
								<figure key={part.at} className="bg-surface-1 my-2 w-fit max-w-full rounded-lg border p-2">
									<img src={part.src} alt={part.alt} className="block h-auto max-w-full rounded" />
									{part.caption && (
										<figcaption className="text-foreground-muted mt-1.5 text-dense">{part.caption}</figcaption>
									)}
								</figure>
							)
						)}
					</article>
				)
			) : (
				<p className="text-foreground-muted my-6">
					Choose the filters and press Generate report{saved.length ? ', or open a saved report' : ''}.
				</p>
			)}
		</div>
	);
}
