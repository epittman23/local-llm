import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TagSelector, ViewSelector } from './FilterSelects';

describe('TagSelector', () => {
	it('is named by what it filters, then its value (A11Y-2)', () => {
		render(<TagSelector value="" tags={['local']} name="Source" placeholder="All sources" onChange={vi.fn()} />);
		expect(screen.getByRole('button', { name: 'Source: All sources' })).toBeVisible();
	});

	it('reads "Tag: All tags" with nothing chosen, never "Tag: Tag"', () => {
		render(<TagSelector value="" tags={['stats']} onChange={vi.fn()} />);
		expect(screen.getByRole('button', { name: 'Tag: All tags' })).toBeVisible();
	});

	it('defaults its name to Tag and capitalises a chosen tag, with a clear button', () => {
		render(<TagSelector value="stats" tags={['stats']} onChange={vi.fn()} />);
		expect(screen.getByRole('button', { name: 'Tag: stats' })).toBeVisible();
		expect(screen.getByText('stats')).toHaveClass('capitalize');
		expect(screen.getByRole('button', { name: 'Clear tag filter' })).toBeVisible();
	});

	it('names its clear button by what it filters, and clears it', () => {
		const onChange = vi.fn();
		render(
			<TagSelector value="qwen/qwen3.6-27b" tags={['qwen/qwen3.6-27b']} name="Model" asWritten onChange={onChange} />
		);
		fireEvent.click(screen.getByRole('button', { name: 'Clear model filter' }));
		expect(onChange).toHaveBeenCalledWith('');
	});

	it('lets a long chosen value shrink, so the clear button keeps its place (#1027)', () => {
		render(<TagSelector value="a-long-value" tags={['a-long-value']} onChange={vi.fn()} />);
		const trigger = screen.getByRole('button', { name: 'Tag: a-long-value' });
		// A flex child cannot shrink below its content without min-w-0, on itself and on the row it sits in.
		expect(trigger).toHaveClass('min-w-0', 'shrink');
		expect(trigger.parentElement).toHaveClass('min-w-0');
	});
});

describe('TagSelector of identifiers (asWritten, #1027)', () => {
	const ID = 'qwen/qwen-2.5-coder-32b-instruct-long-name';
	it('shows a chosen id exactly as written, never capitalised', () => {
		render(<TagSelector value={ID} tags={[ID]} name="Model" placeholder="All models" asWritten onChange={vi.fn()} />);
		const value = screen.getByText(ID);
		expect(value).not.toHaveClass('capitalize');
		expect(screen.getByRole('button', { name: `Model: ${ID}` })).toHaveAttribute('title', ID);
	});

	it('lists every id whole in its menu, not cut at 32 characters', async () => {
		const onChange = vi.fn();
		render(<TagSelector value="" tags={[ID]} name="Model" placeholder="All models" asWritten onChange={onChange} />);
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Model: All models' }), {
			button: 0,
			pointerType: 'mouse'
		});
		const item = await screen.findByRole('menuitemradio', { name: ID });
		expect(item).not.toHaveClass('capitalize');
		// Sized to the ids up to a cap; one past it ends in an ellipsis, whole in its title (TYP-7).
		expect(item).toHaveAttribute('title', ID);
		expect(item.querySelector('.truncate')).toHaveTextContent(ID);
		expect(screen.getByRole('menu')).toHaveClass('w-max');
		expect(screen.getByRole('menu')).not.toHaveClass('w-(--radix-dropdown-menu-trigger-width)');
		fireEvent.click(item);
		expect(onChange).toHaveBeenCalledWith(ID);
	});

	it('still cuts and capitalises ordinary tags', async () => {
		const tag = 'a tag that is much longer than thirty-two letters';
		render(<TagSelector value="" tags={[tag]} onChange={vi.fn()} />);
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Tag: All tags' }), { button: 0, pointerType: 'mouse' });
		const item = await screen.findByRole('menuitemradio', { name: `${tag.slice(0, 32)}...` });
		expect(item).toHaveClass('capitalize');
	});
});

describe('ViewSelector', () => {
	it('says what it filters in its visible text too, not a bare "All"', () => {
		render(<ViewSelector value="" onChange={vi.fn()} />);
		const button = screen.getByRole('button', { name: /^View: / });
		expect(button.textContent).toMatch(/^View: /);
	});
});
