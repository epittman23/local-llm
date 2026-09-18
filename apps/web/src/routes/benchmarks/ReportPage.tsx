import { useMutation, useQuery } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from '@/components/ui/select';
import { generateReport, getReportFileText, getTestOptions } from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';

const DEFAULT_OPTION = '__default__';

// `markdown_url` looks like `/api/v1/benchmarks/report/files/<run_dir>/report.md`;
// getReportFileText needs the run dir and filename split back out of it.
const splitMarkdownUrl = (markdownUrl: string): { runDir: string; filename: string } | null => {
	const parts = markdownUrl.split('/').filter(Boolean);
	if (parts.length < 2) return null;
	const filename = decodeURIComponent(parts[parts.length - 1]);
	const runDir = decodeURIComponent(parts[parts.length - 2]);
	return { runDir, filename };
};

/**
 * Ports Report.svelte: the tier/model/benchmark filter form, Generate, and
 * rendering the resulting markdown + figures. Markdown is parsed with the
 * same `marked` library (not pinned to the fork's old 9.x -- no custom
 * extension here for a version bump to break) and injected via
 * dangerouslySetInnerHTML, same trust boundary as Svelte's own `{@html}`:
 * this is a backend-generated statistical report on an admin-gated page,
 * not user-submitted content.
 *
 * Figures are fetched with the Bearer token and rendered as object URLs
 * rather than plain `<img src>`, exactly per the ported API's own comment
 * on why (an `<img>` tag can't attach an Authorization header, and these
 * endpoints are admin-only).
 */
export function ReportPage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const [tier, setTier] = useState(DEFAULT_OPTION);
	const [model, setModel] = useState('');
	const [benchmark, setBenchmark] = useState(DEFAULT_OPTION);
	const [figures, setFigures] = useState(true);
	const [markdownHtml, setMarkdownHtml] = useState<string | null>(null);
	const [figureUrls, setFigureUrls] = useState<{ url: string; objectUrl: string }[]>([]);
	const [error, setError] = useState<string | null>(null);
	const figureUrlsRef = useRef(figureUrls);
	figureUrlsRef.current = figureUrls;

	const optionsQuery = useQuery({
		queryKey: ['test-options'],
		queryFn: () => getTestOptions(token),
		enabled: !!token
	});
	const tiers: string[] = optionsQuery.data?.tiers ?? [];
	const benchmarks: string[] = optionsQuery.data?.benchmarks ?? [];

	useEffect(() => {
		// Revokes any blob URLs this component created, on unmount only --
		// revoking on every regenerate would break the previous report if a
		// user navigated back before this ran again, so this intentionally
		// isn't in the mutation's own onSuccess/onSettled.
		return () => {
			for (const entry of figureUrlsRef.current) URL.revokeObjectURL(entry.objectUrl);
		};
	}, []);

	const generateMutation = useMutation({
		mutationFn: async () => {
			const form = {
				...(tier !== DEFAULT_OPTION ? { tier } : {}),
				...(model.trim() ? { model: model.trim() } : {}),
				...(benchmark !== DEFAULT_OPTION ? { benchmark } : {}),
				figures
			};

			const res = await generateReport(token, form);
			if (res.error) throw new Error(res.error);

			const parsed = splitMarkdownUrl(res.markdown_url);
			if (!parsed) throw new Error('Unexpected report response');

			const text = await getReportFileText(token, parsed.runDir, parsed.filename);
			// DOMPurify as defense in depth, not because this content is expected
			// to be adversarial: report.py generates purely statistical markdown
			// (tables, figures, prose) from recorded benchmark data on an
			// admin-only page, the same trust boundary Report.svelte's own
			// unsanitized {@html} relies on. Sanitizing costs nothing here and
			// protects against a future report.py change that interpolates a
			// less-trusted string (a model name, a note field) without escaping.
			const html = DOMPurify.sanitize(marked.parse(text ?? '') as string);

			let entries: { url: string; objectUrl: string }[] = [];
			if (Array.isArray(res.figures) && res.figures.length > 0) {
				const fetched = await Promise.all(
					res.figures.map(async (url: string) => {
						try {
							const figRes = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
							if (!figRes.ok) return null;
							const blob = await figRes.blob();
							return { url, objectUrl: URL.createObjectURL(blob) };
						} catch (err) {
							console.error('Failed to load report figure:', url, err);
							return null;
						}
					})
				);
				entries = fetched.filter((e): e is { url: string; objectUrl: string } => e !== null);
			}

			return { html, entries };
		},
		onMutate: () => {
			setError(null);
			setMarkdownHtml(null);
			for (const entry of figureUrlsRef.current) URL.revokeObjectURL(entry.objectUrl);
			setFigureUrls([]);
		},
		onSuccess: ({ html, entries }) => {
			setMarkdownHtml(html);
			setFigureUrls(entries);
		},
		onError: (err: unknown) =>
			setError(err instanceof Error ? err.message : String(err))
	});

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h2 className="text-lg font-medium">Report</h2>
				<p className="text-muted-foreground text-xs">
					Generate a statistical report and figures from recorded benchmark runs.
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
					<Label>Tier</Label>
					<Select value={tier} onValueChange={setTier}>
						<SelectTrigger className="w-40">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={DEFAULT_OPTION}>Default</SelectItem>
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
					<Input
						id="report-model"
						className="w-48"
						placeholder="Optional model filter"
						value={model}
						onChange={(e) => setModel(e.target.value)}
					/>
				</div>

				<div className="flex flex-col gap-1">
					<Label>Benchmark</Label>
					<Select value={benchmark} onValueChange={setBenchmark}>
						<SelectTrigger className="w-48">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={DEFAULT_OPTION}>Default</SelectItem>
							{benchmarks.map((b) => (
								<SelectItem key={b} value={b}>
									{b}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="flex items-center gap-2 pb-1.5 text-sm">
					<Checkbox
						id="report-figures"
						checked={figures}
						onCheckedChange={(c) => setFigures(c === true)}
					/>
					<Label htmlFor="report-figures">Generate figures</Label>
				</div>

				<Button type="submit" disabled={generateMutation.isPending}>
					{generateMutation.isPending ? 'Generating…' : 'Generate'}
				</Button>
			</form>

			{generateMutation.isPending ? (
				<p className="text-muted-foreground my-6 text-sm">
					Generating report… this can take a while for large runs.
				</p>
			) : error ? (
				<div className="border-destructive/20 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap">
					{error}
				</div>
			) : markdownHtml ? (
				<>
					{figureUrls.length > 0 && (
						<div className="grid gap-3 sm:grid-cols-2">
							{figureUrls.map((entry) => (
								<img
									key={entry.url}
									src={entry.objectUrl}
									alt={entry.url}
									className="w-full rounded-lg border"
								/>
							))}
						</div>
					)}
					<div
						className="prose dark:prose-invert max-w-none text-sm"
						// See this file's own docstring for the trust boundary this relies on.
						dangerouslySetInnerHTML={{ __html: markdownHtml }}
					/>
				</>
			) : (
				<p className="text-muted-foreground my-6 text-sm">
					Set optional filters and click Generate to build a report.
				</p>
			)}
		</div>
	);
}
