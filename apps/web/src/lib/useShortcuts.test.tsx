import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shortcut } from '@/lib/shortcuts';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { KEYBINDINGS_KEY, useShortcuts } from './useShortcuts';

function Host() {
	useShortcuts();
	return null;
}

function mount(keybindings: Record<string, string> | null = null) {
	const client = new QueryClient();
	client.setQueryData(KEYBINDINGS_KEY, keybindings);
	const wrap = (children: ReactNode) => (
		<QueryClientProvider client={client}>
			<MemoryRouter>{children}</MemoryRouter>
		</QueryClientProvider>
	);
	return render(wrap(<Host />));
}

afterEach(() => {
	act(() => useSettingsModalStore.getState().closeSettings());
});

describe('the Close shortcut (#950, NAV-4)', () => {
	it('leaves Escape to the top layer: Settings stays open under it', () => {
		mount();
		act(() => useSettingsModalStore.getState().openSettings('general'));
		act(() => {
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		});
		expect(useSettingsModalStore.getState().open).toBe(true);
	});

	it('bound to another key, presses Escape for the focused layer', () => {
		mount({ [Shortcut.CLOSE_MODAL]: 'Alt+Q' });
		const escapes = vi.fn();
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && escapes();
		document.addEventListener('keydown', onKey);
		act(() => {
			document.body.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', altKey: true, bubbles: true })
			);
		});
		document.removeEventListener('keydown', onKey);
		expect(escapes).toHaveBeenCalledTimes(1);
	});
});
