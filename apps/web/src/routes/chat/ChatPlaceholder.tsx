import { Zap } from 'lucide-react';
import { Fragment, useMemo } from 'react';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import { ProfileAvatar } from '@/components/ui/avatar';
import { RowButton } from '@/components/ui/row-button';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { modelImage } from './ModelSelector';
import type { ChatModel } from './useModels';

type Suggestion = { content: string; title?: string[] };

/** An identifier with a line-break opportunity after each `/` and `-`, so it wraps rather than clips (TYP-7). */
function Breakable({ text }: { text: string }) {
	// Each piece is keyed by where it starts in the text.
	let at = 0;
	const parts = text.split(/(?<=[/-])/).map((part) => {
		const piece = { part, at };
		at += part.length;
		return piece;
	});
	return (
		<>
			{parts.map(({ part, at }) => (
				<Fragment key={at}>
					{part}
					{at + part.length < text.length && <wbr />}
				</Fragment>
			))}
		</>
	);
}

/**
 * Ports chat/Placeholder.svelte and Suggestions.svelte: the empty chat's
 * greeting and its suggested prompts, from the model or the server defaults,
 * the first six in their own order (#927). The greeting is the model entry's
 * name, with its id beneath (DAT-4); an entry with no name of its own (the
 * name is the id) shows the id itself, monospaced and wrapping (#1065).
 * Without a model it greets the user.
 */
export function ChatPlaceholder({
	model,
	temporary,
	onSelect
}: {
	model: ChatModel | undefined;
	temporary: boolean;
	onSelect: (prompt: string) => void;
}) {
	const name = useAuthStore((s) => s.user?.name);
	const defaults = useConfigStore(
		(s) => (s.config as { default_prompt_suggestions?: Suggestion[] } | null)?.default_prompt_suggestions
	);
	const source = model?.info?.meta?.suggestion_prompts ?? defaults ?? [];
	const suggestions = useMemo(() => source.slice(0, 6), [source]);
	const description = model?.info?.meta?.description;

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-6 py-8">
			{temporary && (
				<div className="text-muted-foreground mb-4 text-sm">
					Temporary chat: this chat won't appear in history and your messages will not be saved.
				</div>
			)}
			<div className="flex items-center gap-3">
				{model && <ProfileAvatar src={modelImage(model.id)} name={model.name} size="lg" />}
				{!model ? (
					<h1 className="text-heading">{`Hello, ${name ?? ''}`}</h1>
				) : model.name === model.id ? (
					<h1 className="min-w-0 font-mono text-title break-words">
						<Breakable text={model.id} />
					</h1>
				) : (
					<div className="flex min-w-0 flex-col">
						<h1 className="truncate text-heading" title={model.name}>
							{model.name}
						</h1>
						<span className="font-mono text-caption text-foreground-muted break-words">
							<Breakable text={model.id} />
						</span>
					</div>
				)}
			</div>
			{description && (
				<SafeMarkdown text={description} className="text-muted-foreground mt-1 line-clamp-2 max-w-xl text-sm" />
			)}
			{suggestions.length > 0 && (
				<div className="mt-6">
					<div className="text-muted-foreground mb-2 flex items-center gap-1 text-xs">
						<Zap className="size-3" /> Suggested
					</div>
					<div className="grid gap-1 sm:grid-cols-2">
						{suggestions.map((s, i) => (
							<RowButton key={i} className="flex flex-col items-start px-3 py-2" onClick={() => onSelect(s.content)}>
								<div className="line-clamp-1 text-sm font-medium">{s.title?.[0] ?? s.content}</div>
								{s.title?.[1] && <div className="text-muted-foreground line-clamp-1 text-xs">{s.title[1]}</div>}
							</RowButton>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
