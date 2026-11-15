import { create } from 'zustand';

type ModelPickerState = {
	/** The latest request to open a picker: the model slot it is for, and a counter so a repeat opens it again. */
	request: { index: number; n: number } | null;
	open: (index: number) => void;
};

/**
 * Asks the chat's model picker to open, from outside it: the Ctrl+Shift+M
 * shortcut, "Try another model" under a failed reply, or a send refused
 * because a model slot is empty (FRM-2). Only a picker that is on screen
 * answers (the desktop header and the phone composer may both be mounted).
 */
export const useModelPickerStore = create<ModelPickerState>((set) => ({
	request: null,
	open: (index) => set((s) => ({ request: { index, n: (s.request?.n ?? 0) + 1 } }))
}));

/** Opens the model picker for slot `index` (the first model by default). */
export const openModelPicker = (index = 0) => useModelPickerStore.getState().open(index);
