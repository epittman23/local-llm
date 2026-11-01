import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type PromptSuggestion, PromptSuggestionsEditor, parseSuggestionsImport } from './PromptSuggestionsEditor';

afterEach(() => vi.restoreAllMocks());

const long = 'x'.repeat(3000);
const longTitle = 't'.repeat(300);

const renderEditor = (value: unknown[]) => {
	const onChange = vi.fn<(next: PromptSuggestion[]) => void>();
	render(<PromptSuggestionsEditor value={value as PromptSuggestion[]} onChange={onChange} />);
	return onChange;
};

describe('PromptSuggestionsEditor', () => {
	it('leaves the other suggestions whole, unknown fields included, when one is edited (#226)', () => {
		const untouched = { content: long, title: [longTitle, longTitle], id: 'keep-me' };
		const onChange = renderEditor([untouched, { content: 'short', title: ['Short', ''] }]);

		fireEvent.change(screen.getAllByLabelText('Title')[1], { target: { value: 'Short!' } });

		expect(onChange).toHaveBeenCalledTimes(1);
		const [first, second] = onChange.mock.calls[0][0];
		expect(first).toEqual(untouched);
		expect(second).toEqual({ content: 'short', title: ['Short!', ''] });
	});

	it('keeps the edited suggestion’s own long fields and unknown fields', () => {
		const onChange = renderEditor([{ content: long, title: [longTitle, 'sub'], extra: 1 }]);

		fireEvent.change(screen.getByLabelText('Subtitle'), { target: { value: 'sub2' } });

		expect(onChange.mock.calls[0][0]).toEqual([{ content: long, title: [longTitle, 'sub2'], extra: 1 }]);
	});

	it('still reads an older bare-string title, and a missing one as blank', () => {
		const onChange = renderEditor([{ content: 'a', title: 'Old' }, { content: 'b' }]);

		expect((screen.getAllByLabelText('Title') as HTMLInputElement[]).map((i) => i.value)).toEqual(['Old', '']);
		fireEvent.change(screen.getAllByLabelText('Content')[0], { target: { value: 'a2' } });

		expect(onChange.mock.calls[0][0]).toEqual([
			{ content: 'a2', title: ['Old', ''] },
			{ content: 'b', title: ['', ''] }
		]);
	});

	it('removes only the chosen suggestion and leaves the rest whole', () => {
		const keep = { content: long, title: [longTitle, ''], id: 'k' };
		const onChange = renderEditor([{ content: 'gone', title: ['Gone', ''] }, keep]);

		fireEvent.click(screen.getAllByLabelText('Remove prompt suggestion')[0]);

		expect(onChange.mock.calls[0][0]).toEqual([keep]);
	});

	it('normalizes an imported file but not the suggestions already there', async () => {
		const existing = { content: long, title: [longTitle, ''], id: 'k' };
		const onChange = renderEditor([existing]);
		const file = new File([JSON.stringify([{ content: long, title: longTitle, id: 'dropped' }])], 's.json', {
			type: 'application/json'
		});

		const input = document.getElementById('prompt-suggestions-import-input') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [file] } });

		await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
		expect(onChange.mock.calls[0][0]).toEqual([existing, { content: 'x'.repeat(2000), title: ['t'.repeat(200), ''] }]);
	});
});

describe('parseSuggestionsImport', () => {
	it('rejects anything that is not a JSON array', () => {
		expect(() => parseSuggestionsImport('{}')).toThrow('Expected a JSON array.');
	});
});
