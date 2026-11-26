import { createContext } from 'react';

/**
 * What a card in a reply needs of the canvas: which document is open, and a
 * way to open one. `ChatPage` provides it; a card outside it opens nothing.
 */
export type CanvasContextValue = { openId: string | null; open: (id: string) => void };

export const CanvasContext = createContext<CanvasContextValue | null>(null);
