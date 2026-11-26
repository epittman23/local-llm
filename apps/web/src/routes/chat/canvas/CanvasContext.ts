import { createContext } from 'react';
import type { ChatFile } from '@/lib/chat/history';

/**
 * What a card in a reply needs of the canvas: which document is open, and a
 * way to open one. `ChatPage` provides it; a card outside it opens nothing.
 * `attach` puts a file on the next message; it is false, after saying why,
 * when the chat cannot take it (a temporary chat, the file limit). `generating`
 * is true while a reply is being written, when the sandbox's workspace is busy
 * and Save to workspace is not offered. `ownChat` is true for a chat the
 * signed-in user owns: only its owner may write into its workspace, so Save to
 * workspace is offered to no one else (an admin reading another's chat).
 */
export type CanvasContextValue = {
	openId: string | null;
	open: (id: string) => void;
	attach?: (file: ChatFile) => boolean;
	generating?: boolean;
	ownChat?: boolean;
};

export const CanvasContext = createContext<CanvasContextValue | null>(null);
