import { Zap } from 'lucide-react';
import { useMemo } from 'react';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { modelImage } from './ModelSelector';
import type { ChatModel } from './useModels';

type Suggestion = { content: string; title?: string[] };

/**
 * Ports chat/Placeholder.svelte and Suggestions.svelte: the empty chat's
 * greeting (the model's picture, name and description, or "Hello, <name>")
 * and its suggested prompts, from the model or the server defaults, in a
 * random order that stays put while the page is open.
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
	const suggestions = useMemo(() => [...source].sort(() => Math.random() - 0.5).slice(0, 6), [source]);
	const description = model?.info?.meta?.description;

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-6 py-8">
			{temporary && (
				<div className="text-muted-foreground mb-4 text-sm">
					Temporary Chat: this chat won't appear in history and your messages will not be saved.
				</div>
			)}
			<div className="flex items-center gap-3">
				{model && (
					<img
						src={modelImage(model.id)}
						alt=""
						className="size-10 rounded-full object-cover"
						onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
					/>
				)}
				<h1 className="line-clamp-1 text-2xl">{model?.name ?? `Hello, ${name ?? ''}`}</h1>
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
							<button
								key={i}
								type="button"
								className="hover:bg-muted rounded-xl px-3 py-2 text-left"
								onClick={() => onSelect(s.content)}
							>
								<div className="line-clamp-1 text-sm font-medium">{s.title?.[0] ?? s.content}</div>
								{s.title?.[1] && <div className="text-muted-foreground line-clamp-1 text-xs">{s.title[1]}</div>}
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
