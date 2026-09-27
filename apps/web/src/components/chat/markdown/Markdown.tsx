import { useDeferredValue, useMemo } from 'react';
import { lexMessage } from '@/lib/markdown/lexer';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { type MarkdownEnv, MarkdownEnvContext } from './MarkdownContext';
import { Blocks } from './Tokens';

type Props = Partial<Omit<MarkdownEnv, 'expandDetails' | 'collapseCodeBlocks' | 'fadeStreamingText'>> & {
	id: string;
	content: string;
	modelName?: string;
	paragraphSpan?: boolean;
	className?: string;
};

/**
 * Ports chat/Messages/Markdown.svelte: a message's Markdown through the chat
 * lexer and the token renderer. While a reply streams, the text is taken as a
 * deferred value, so re-tokenizing never blocks typing or scrolling (the
 * Svelte version throttled to one parse per animation frame for the same
 * reason).
 */
export function Markdown({ id, content, modelName, paragraphSpan, className, done = true, resolvable = false, sourceIds = [], ...rest }: Props) {
	const userName = useAuthStore((s) => s.user?.name);
	const { settings } = useUserSettings();
	const deferred = useDeferredValue(content);
	const tokens = useMemo(() => lexMessage(deferred, modelName, userName), [deferred, modelName, userName]);
	const s = (settings ?? {}) as Record<string, unknown>;
	const env: MarkdownEnv = {
		id,
		done,
		resolvable,
		sourceIds,
		...rest,
		expandDetails: Boolean(s.expandDetails),
		collapseCodeBlocks: Boolean(s.collapseCodeBlocks),
		fadeStreamingText: (s.chatFadeStreamingText as boolean | undefined) ?? true
	};
	return (
		<MarkdownEnvContext.Provider value={env}>
			<div className={cn('markdown-prose w-full min-w-0 text-[0.9375rem] break-words', className)} data-testid="markdown">
				<Blocks tokens={tokens} paragraphSpan={paragraphSpan} />
			</div>
		</MarkdownEnvContext.Provider>
	);
}
