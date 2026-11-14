import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmojiPicker } from './EmojiPicker';

vi.mock('@/lib/emoji/emoji', () => ({
	useEmojiIndex: () => ({ all: [{ group: 'Smileys', name: 'smile', char: '😄', names: ['smile'] }] }),
	searchEmojis: (index: { all: unknown[] }) => index.all
}));

describe('EmojiPicker', () => {
	it('draws each emoji on the standard’s title step (TYP-2) and submits its name', () => {
		const onSubmit = vi.fn();
		render(
			<QueryClientProvider client={new QueryClient()}>
				<EmojiPicker onSubmit={onSubmit}>
					<button type="button">Pick</button>
				</EmojiPicker>
			</QueryClientProvider>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Pick' }));
		const option = screen.getByRole('option', { name: 'smile' });
		expect(option.className).toContain('text-title');
		fireEvent.click(option);
		expect(onSubmit).toHaveBeenCalledWith('smile');
	});
});
