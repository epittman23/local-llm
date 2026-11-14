import { SettingNumber, SettingRow } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';

/**
 * config.py's fallback when `RAG_HYBRID_BM25_WEIGHT` is unset. A deployment
 * that sets the variable starts from its value instead, until the Documents
 * tab is first saved, which stores a weight of its own.
 */
export const DEFAULT_BM25_WEIGHT = 0.5;

/**
 * Hybrid search's BM25 weight. The Svelte page had a Default/Custom toggle
 * whose Default sent null, which the server reads as "keep the stored
 * weight", so Default could never be saved and the row reloaded as Custom
 * (#233). The server always has a weight, so it is always shown, with a
 * Reset to the default.
 */
export function Bm25Weight({ value, onChange }: { value: number | null; onChange: (weight: number) => void }) {
	const weight = value ?? DEFAULT_BM25_WEIGHT;
	return (
		<>
			<SettingRow label="BM25 Weight" description="Balance semantic and lexical weighting for hybrid search.">
				<Button
					variant="ghost"
					size="sm"
					type="button"
					disabled={weight === DEFAULT_BM25_WEIGHT}
					onClick={() => onChange(DEFAULT_BM25_WEIGHT)}
				>
					Reset to {DEFAULT_BM25_WEIGHT}
				</Button>
			</SettingRow>
			<div className="flex items-center gap-2">
				<div className="flex-1">
					<input
						type="range"
						aria-label="BM25 Weight slider"
						min={0}
						max={1}
						step={0.05}
						value={weight}
						onChange={(e) => onChange(Number(e.target.value))}
						className="h-2 w-full cursor-pointer"
					/>
					<div className="text-foreground-muted flex justify-between py-0.5 text-caption">
						<div>semantic</div>
						<div>lexical</div>
					</div>
				</div>
				<div className="w-16">
					<SettingNumber
						aria-label="BM25 Weight"
						min={0}
						max={1}
						step="any"
						value={weight}
						onChange={(v) => {
							if (v !== '') onChange(v);
						}}
					/>
				</div>
			</div>
		</>
	);
}
