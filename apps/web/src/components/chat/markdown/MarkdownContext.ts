import { createContext, useContext } from 'react';
import type { CodeRunResult } from '@/lib/apis/utils';
import type { CanvasDocument } from '@/lib/chat/documents';

/** What every token in one message needs, passed down once instead of through each level. */
export type MarkdownEnv = {
	id: string;
	done: boolean;
	chatId?: string;
	messageId?: string;
	/** Whether tool calls in this message can be approved from here (a saved chat's own message). */
	resolvable: boolean;
	sourceIds: string[];
	onSourceClick?: (id: string | number) => void;
	/** The message's canvas documents (lib/chat/documents.ts): a fenced block that is one renders as a card, not a code block. */
	documents?: CanvasDocument[];
	/** How many fenced blocks the message's earlier texts hold: the ordinal this text's first block takes in `block:<messageId>:<n>`. */
	blockBase?: number;
	/** A python code block's Run button: the code's output, shown under the block. */
	onRun?: (code: string) => Promise<CodeRunResult>;
	onToolCallResolved?: (res: unknown) => void;
	expandDetails: boolean;
	collapseCodeBlocks: boolean;
	fadeStreamingText: boolean;
};

export const MarkdownEnvContext = createContext<MarkdownEnv>({
	id: '',
	done: true,
	resolvable: false,
	sourceIds: [],
	expandDetails: false,
	collapseCodeBlocks: false,
	fadeStreamingText: true
});
export const useMarkdownEnv = () => useContext(MarkdownEnvContext);
