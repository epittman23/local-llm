import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Params } from '@/components/common/advancedParamDefs';
import type { PlaygroundMessage, PlaygroundStats } from './playgroundModel';

/** The Chat tab: the conversation being built, and how the last run ended. */
export type ChatTab = {
	modelId: string;
	system: string;
	messages: PlaygroundMessage[];
	draft: string;
	role: 'user' | 'assistant';
	params: Params;
	/** Why the last run failed, shown under the transcript with Retry (#968). */
	failure: string | null;
};

/** The Completions tab: your text, the model's continuation of it, and how the last run ended. */
export type CompletionsTab = {
	modelId: string;
	prompt: string;
	output: string;
	params: Params;
	stats: PlaygroundStats | null;
	failure: string | null;
};

type Patch<T> = Partial<T> | ((current: T) => Partial<T>);

type PlaygroundState = {
	chat: ChatTab;
	completions: CompletionsTab;
	/** The Images tab's prompt. Its results are data URLs, too big to keep, so they stay with the page. */
	imagePrompt: string;
	setChat: (patch: Patch<ChatTab>) => void;
	setCompletions: (patch: Patch<CompletionsTab>) => void;
	setImagePrompt: (prompt: string) => void;
	/** Clears the conversation and the system instructions; the model and parameters stay. */
	clearChat: () => void;
};

export const emptyChat: ChatTab = {
	modelId: '',
	system: '',
	messages: [],
	draft: '',
	role: 'user',
	params: {},
	failure: null
};

export const emptyCompletions: CompletionsTab = {
	modelId: '',
	prompt: '',
	output: '',
	params: {},
	stats: null,
	failure: null
};

const apply = <T>(current: T, patch: Patch<T>): T => ({
	...current,
	...(typeof patch === 'function' ? patch(current) : patch)
});

/**
 * Each Playground tab's work, kept while the browser tab is open (#969): a
 * tab switch, a reload or a visit elsewhere no longer loses a hand-built
 * conversation. sessionStorage, so it goes with the browser tab and is
 * never shared between two of them.
 */
export const usePlaygroundStore = create<PlaygroundState>()(
	persist(
		(set) => ({
			chat: emptyChat,
			completions: emptyCompletions,
			imagePrompt: '',
			setChat: (patch) => set((s) => ({ chat: apply(s.chat, patch) })),
			setCompletions: (patch) => set((s) => ({ completions: apply(s.completions, patch) })),
			setImagePrompt: (imagePrompt) => set({ imagePrompt }),
			clearChat: () =>
				set((s) => ({ chat: { ...emptyChat, modelId: s.chat.modelId, params: s.chat.params, role: 'user' } }))
		}),
		{
			name: 'lllm-playground',
			storage: createJSONStorage(() => sessionStorage),
			partialize: (s) => ({ chat: s.chat, completions: s.completions, imagePrompt: s.imagePrompt })
		}
	)
);
