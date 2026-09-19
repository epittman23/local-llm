import saveAs from 'file-saver';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export type PromptSuggestion = { content: string; title: [string, string] };

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * A suggestion's title is a `[title, subtitle]` pair; older saves stored a bare
 * string. Anything else is treated as blank. Unknown fields are dropped: the
 * import path takes a file, and only these two fields are ever read from it.
 */
export function normalizeSuggestion(raw: unknown): PromptSuggestion {
	const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const title: [string, string] = typeof s.title === 'string' ? [str(s.title, 200), ''] : Array.isArray(s.title) ? [str(s.title[0], 200), str(s.title[1], 200)] : ['', ''];
	return { content: str(s.content), title };
}

/** Parses an imported suggestions file (a JSON array); throws on anything that is not one. */
export function parseSuggestionsImport(text: string): PromptSuggestion[] {
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) throw new Error('Expected a JSON array.');
	return parsed.map(normalizeSuggestion);
}

/** Ports Models/PromptSuggestions.svelte: the starter prompts shown on a model's new-chat screen. */
export function PromptSuggestionsEditor({
	value,
	onChange
}: {
	value: PromptSuggestion[];
	onChange: (next: PromptSuggestion[]) => void;
}) {
	const suggestions = value.map(normalizeSuggestion);
	const update = (i: number, patch: Partial<PromptSuggestion>) => onChange(suggestions.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
	const field = 'w-full bg-transparent text-[0.8125rem] leading-5 outline-hidden placeholder:text-muted-foreground/50';

	return (
		<div className="space-y-2">
			<div className="mb-1 flex h-6 w-full items-center justify-between">
				<div className="text-muted-foreground min-w-0 flex-1 self-center text-xs">Default Prompt Suggestions</div>
				<div className="flex shrink-0 items-center justify-end gap-1.5">
					<input
						id="prompt-suggestions-import-input"
						type="file"
						accept=".json"
						hidden
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (!file) return;
							const reader = new FileReader();
							reader.onload = (event) => {
								try {
									onChange([...suggestions, ...parseSuggestionsImport(String(event.target?.result))]);
								} catch {
									toast.error('Invalid JSON file');
								}
							};
							reader.readAsText(file);
							e.target.value = '';
						}}
					/>
					<Button type="button" variant="ghost" size="xs" onClick={() => document.getElementById('prompt-suggestions-import-input')?.click()}>
						Import
					</Button>
					{suggestions.length > 0 && (
						<Button
							type="button"
							variant="ghost"
							size="xs"
							onClick={() => saveAs(new Blob([JSON.stringify(suggestions)], { type: 'application/json' }), `prompt-suggestions-export-${Date.now()}.json`)}
						>
							Export
						</Button>
					)}
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label="Add prompt suggestion"
						onClick={() => {
							// One blank row at a time: don't stack empties.
							if (suggestions.length === 0 || suggestions[suggestions.length - 1].content !== '') {
								onChange([...suggestions, { content: '', title: ['', ''] }]);
							}
						}}
					>
						<Plus />
					</Button>
				</div>
			</div>

			{suggestions.length > 0 ? (
				<div className="flex flex-col gap-2">
					{suggestions.map((s, i) => (
						<div key={i} className="flex items-start gap-2">
							<div className="min-w-0 flex-1">
								<div className="flex gap-2">
									<input className={field} placeholder="Title" aria-label="Title" value={s.title[0]} onChange={(e) => update(i, { title: [e.target.value, s.title[1]] })} />
									<input className={`${field} text-muted-foreground`} placeholder="Subtitle" aria-label="Subtitle" value={s.title[1]} onChange={(e) => update(i, { title: [s.title[0], e.target.value] })} />
								</div>
								<textarea
									className={`${field} min-h-5 resize-none`}
									placeholder="Content"
									aria-label="Content"
									rows={1}
									value={s.content}
									onChange={(e) => update(i, { content: e.target.value })}
								/>
							</div>
							<button
								type="button"
								className="text-muted-foreground hover:text-foreground shrink-0 pt-1"
								aria-label="Remove prompt suggestion"
								onClick={() => onChange(suggestions.filter((_, idx) => idx !== i))}
							>
								<X className="size-3.5" />
							</button>
						</div>
					))}
				</div>
			) : (
				<div className="text-muted-foreground text-center text-xs">No suggestion prompts</div>
			)}
		</div>
	);
}
