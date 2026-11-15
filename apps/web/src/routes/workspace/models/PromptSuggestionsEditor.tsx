import saveAs from 'file-saver';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export type PromptSuggestion = { content: string; title: [string, string] };

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * A suggestion's title is a `[title, subtitle]` pair; older saves stored a bare
 * string. Anything else is treated as blank. Unknown fields are dropped: the
 * import path takes a file, and only these two fields are ever read from it.
 */
export function normalizeSuggestion(raw: unknown): PromptSuggestion {
	const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const title: [string, string] =
		typeof s.title === 'string'
			? [str(s.title, 200), '']
			: Array.isArray(s.title)
				? [str(s.title[0], 200), str(s.title[1], 200)]
				: ['', ''];
	return { content: str(s.content), title };
}

/**
 * Repairs a stored suggestion's title for editing, as the original's render
 * did: a bare-string title becomes `[title, '']`, anything else that is not a
 * pair is blank. Nothing is cut and every other field is kept, so editing one
 * suggestion never rewrites the others (#226); the limits above are for imports.
 */
export function shapeSuggestion(raw: unknown): PromptSuggestion {
	const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const text = (v: unknown) => (typeof v === 'string' ? v : '');
	const title: [string, string] =
		typeof s.title === 'string'
			? [s.title, '']
			: Array.isArray(s.title)
				? [text(s.title[0]), text(s.title[1])]
				: ['', ''];
	return { ...s, content: text(s.content), title };
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
	const suggestions = value.map(shapeSuggestion);
	const update = (i: number, patch: Partial<PromptSuggestion>) =>
		onChange(suggestions.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

	return (
		<div className="space-y-2">
			<div className="flex w-full items-center justify-end">
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
									toast.error("That file isn't a suggestions export: it isn't a JSON list.");
								}
							};
							reader.readAsText(file);
							e.target.value = '';
						}}
					/>
					<Button
						type="button"
						variant="ghost"
						size="xs"
						onClick={() => document.getElementById('prompt-suggestions-import-input')?.click()}
					>
						Import
					</Button>
					{suggestions.length > 0 && (
						<Button
							type="button"
							variant="ghost"
							size="xs"
							onClick={() =>
								saveAs(
									new Blob([JSON.stringify(suggestions)], { type: 'application/json' }),
									`prompt-suggestions-export-${Date.now()}.json`
								)
							}
						>
							Export
						</Button>
					)}
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							// One blank row at a time: don't stack empties.
							if (suggestions.length === 0 || suggestions[suggestions.length - 1].content !== '') {
								onChange([...suggestions, { content: '', title: ['', ''] }]);
							}
						}}
					>
						<Plus aria-hidden />
						Add suggestion
					</Button>
				</div>
			</div>

			{suggestions.length > 0 ? (
				<div className="flex flex-col gap-3">
					{suggestions.map((s, i) => (
						<div key={i} className="flex items-start gap-2">
							<div className="flex min-w-0 flex-1 flex-col gap-2">
								<div className="flex gap-2 max-sm:flex-col">
									<Input
										placeholder="Title"
										aria-label="Title"
										value={s.title[0]}
										onChange={(e) => update(i, { title: [e.target.value, s.title[1]] })}
									/>
									<Input
										placeholder="Subtitle"
										aria-label="Subtitle"
										value={s.title[1]}
										onChange={(e) => update(i, { title: [s.title[0], e.target.value] })}
									/>
								</div>
								<Textarea
									placeholder="The prompt sent when it is chosen"
									aria-label="Content"
									rows={2}
									value={s.content}
									onChange={(e) => update(i, { content: e.target.value })}
								/>
							</div>
							<Button
								variant="ghost"
								size="icon-sm"
								className="shrink-0"
								type="button"
								aria-label={`Remove suggestion ${i + 1}`}
								onClick={() => onChange(suggestions.filter((_, idx) => idx !== i))}
							>
								<X aria-hidden />
							</Button>
						</div>
					))}
				</div>
			) : (
				<p className="text-foreground-muted text-dense">No suggestions yet. Add one, or import a file.</p>
			)}
		</div>
	);
}
