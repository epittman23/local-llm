import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Bm25Weight, DEFAULT_BM25_WEIGHT } from './Bm25Weight';

// #233: "Default" sent null, which the server reads as "keep the stored weight",
// so it could never be saved. The weight is always shown, with a reset to the default.

describe('Bm25Weight', () => {
	it('shows the default weight when none is set, with nothing to reset', () => {
		render(<Bm25Weight value={null} onChange={vi.fn()} />);

		expect(screen.getByLabelText('BM25 Weight')).toHaveValue(DEFAULT_BM25_WEIGHT);
		expect(screen.getByLabelText('BM25 Weight slider')).toHaveValue(String(DEFAULT_BM25_WEIGHT));
		expect(screen.getByRole('button', { name: `Reset to ${DEFAULT_BM25_WEIGHT}` })).toBeDisabled();
	});

	it('resets a custom weight to the default as a number the server saves', () => {
		const onChange = vi.fn();
		render(<Bm25Weight value={0.3} onChange={onChange} />);

		fireEvent.click(screen.getByRole('button', { name: `Reset to ${DEFAULT_BM25_WEIGHT}` }));

		expect(onChange).toHaveBeenCalledWith(DEFAULT_BM25_WEIGHT);
	});

	it('sends the weight typed or slid, and ignores an emptied box', () => {
		const onChange = vi.fn();
		render(<Bm25Weight value={0.5} onChange={onChange} />);

		fireEvent.change(screen.getByLabelText('BM25 Weight'), { target: { value: '0.2' } });
		fireEvent.change(screen.getByLabelText('BM25 Weight slider'), { target: { value: '0.75' } });
		fireEvent.change(screen.getByLabelText('BM25 Weight'), { target: { value: '' } });

		expect(onChange.mock.calls).toEqual([[0.2], [0.75]]);
	});
});
