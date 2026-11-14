import { create } from 'zustand';

type ConnectionState = {
	/** The live connection dropped and has not come back for longer than a brief blip. */
	lost: boolean;
	setLost: (lost: boolean) => void;
};

/**
 * Whether the app's live connection to the server is down (FBK-1: a
 * condition that lasts is an inline message, not a toast that expires).
 * SocketProvider writes it; ConnectionBanner shows it, and the toaster moves
 * its toasts below the banner on a phone.
 */
export const useConnectionStore = create<ConnectionState>((set) => ({
	lost: false,
	setLost: (lost) => set({ lost })
}));
