import { Info } from 'lucide-react';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';

type Usage = Record<string, unknown>;

const numberIn = (v: unknown): number | null => {
	const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** The first of `keys` that holds a number: providers name the same count differently. */
const first = (usage: Usage | undefined, ...keys: string[]) => {
	for (const k of keys) {
		const n = numberIn(usage?.[k]);
		if (n !== null) return n;
	}
	return null;
};

const figure = (n: number, digits = 0) =>
	n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/**
 * A reply's usage in words (WRD-2, WRD-5): one count per alias, since the
 * server adds `input_tokens`/`output_tokens` beside the provider's own names.
 * Speed and time come only from llama-server's `timings`, which the server
 * merges into `usage`; other providers report none (S3-D7: shown as is).
 */
export function generationInfo(usage: Usage) {
	const prompt = first(usage, 'prompt_tokens', 'input_tokens', 'prompt_eval_count');
	const completion = first(usage, 'completion_tokens', 'output_tokens', 'eval_count', 'predicted_n');
	const details = (usage.completion_tokens_details ?? usage.output_tokens_details) as Usage | undefined;
	const reasoning = first(details, 'reasoning_tokens');
	const parts = [
		prompt !== null ? `${figure(prompt)} prompt` : null,
		completion !== null ? `${figure(completion)} completion` : null
	].filter(Boolean);
	const generated = first(usage, 'predicted_per_second');
	const read = first(usage, 'prompt_per_second');
	const promptMs = first(usage, 'prompt_ms');
	const predictedMs = first(usage, 'predicted_ms');
	const totalMs = promptMs !== null || predictedMs !== null ? (promptMs ?? 0) + (predictedMs ?? 0) : null;
	return {
		tokens: parts.length ? `${parts.join(' + ')} tokens` : null,
		reasoning: reasoning !== null ? `${figure(reasoning)} tokens` : null,
		speed: generated !== null ? `${figure(generated, 1)} tokens/s` : null,
		promptSpeed: read !== null ? `${figure(read, 1)} tokens/s` : null,
		total: totalMs !== null ? `${figure(totalMs / 1000, 1)} s` : null
	};
}

/** The reply's "Generation info": a popover opened by click or tap, so touch reaches it too (OVL-4, A11Y-4). */
export function GenerationInfo({ usage }: { usage: Usage }) {
	const info = generationInfo(usage);
	const rows: [string, string | null][] = [
		['Tokens', info.tokens],
		['Reasoning', info.reasoning],
		['Speed', info.speed],
		['Prompt', info.promptSpeed],
		['Total time', info.total]
	];
	const timed = info.speed || info.promptSpeed || info.total;
	return (
		<Popover>
			<Tip content="Generation info">
				<PopoverTrigger asChild>
					<Button type="button" aria-label="Generation info" variant="ghost" size="icon-sm">
						<Info className="size-3.5" aria-hidden />
					</Button>
				</PopoverTrigger>
			</Tip>
			<PopoverContent align="start" className="w-auto max-w-80 gap-2">
				<PopoverTitle className="text-body font-strong">Generation info</PopoverTitle>
				<dl className="text-body grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
					{rows
						.filter(([, value]) => value)
						.map(([label, value]) => (
							<div key={label} className="contents">
								<dt className="text-foreground-muted">{label}</dt>
								<dd className="tabular-nums">{value}</dd>
							</div>
						))}
				</dl>
				{!timed && <p className="text-dense text-foreground-muted">Speed not reported by this provider</p>}
			</PopoverContent>
		</Popover>
	);
}
