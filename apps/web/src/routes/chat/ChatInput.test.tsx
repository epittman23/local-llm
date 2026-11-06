import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChatInput } from './ChatInput';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/apis/knowledge', () => ({
	searchKnowledgeBases: vi.fn(async () => ({ items: [] })),
	searchKnowledgeFiles: vi.fn(async () => ({ items: [] }))
}));
vi.mock('@/lib/apis/prompts', () => ({ getPrompts: vi.fn(async () => []) }));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: {} }) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'u1', name: 'Test User' } })
}));

const nextFrame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

function show(props: Partial<Parameters<typeof ChatInput>[0]> = {}) {
	const onAddWeb = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<ChatInput
					onSubmit={vi.fn(() => true)}
					onStop={vi.fn()}
					generating={false}
					queued={[]}
					onRemoveQueued={vi.fn()}
					onAddWeb={onAddWeb}
					{...props}
				/>
			</TooltipProvider>
		</QueryClientProvider>
	);
	return { box: screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement, onAddWeb };
}

/** Types `value` with the caret at its end, as the browser would. */
function type(box: HTMLTextAreaElement, value: string) {
	fireEvent.change(box, { target: { value, selectionStart: value.length } });
	fireEvent.select(box, { target: { selectionStart: value.length } });
}

describe('ChatInput: placing the caret after a suggestion', () => {
	afterEach(cleanup);

	it('places it at once, so a key typed before the next frame stays where it was typed', async () => {
		// Placed a frame later, a letter typed before that frame went in at the
		// end and the frame then put the caret back in front of it.
		const { box, onAddWeb } = show();
		box.focus();
		type(box, 'hi #https://example.org/b');
		fireEvent.keyDown(box, { key: 'Enter' });
		expect(onAddWeb).toHaveBeenCalledWith(['https://example.org/b']);
		expect(box.value).toBe('hi ');
		expect(box.selectionStart).toBe(3);

		// A letter typed before the next frame.
		fireEvent.change(box, { target: { value: 'hi w', selectionStart: 4 } });
		expect(box.value).toBe('hi w');
		await nextFrame();
		expect(box.selectionStart).toBe(4);
	});

	it('takes focus back a frame later if something else took it (a dialog closing)', async () => {
		const { box } = show();
		box.focus();
		type(box, 'hi #https://example.org/b');
		fireEvent.keyDown(box, { key: 'Enter' });
		const elsewhere = document.createElement('button');
		document.body.append(elsewhere);
		elsewhere.focus();
		await nextFrame();
		expect(document.activeElement).toBe(box);
		expect(box.selectionStart).toBe(3);
		elsewhere.remove();
	});
});
