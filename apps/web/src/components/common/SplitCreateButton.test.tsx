import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { SplitCreateButton } from './SplitCreateButton';

const renderButton = (actions: Parameters<typeof SplitCreateButton>[0]['actions']) =>
	render(
		<MemoryRouter>
			<SplitCreateButton actions={actions} />
		</MemoryRouter>
	);

describe('SplitCreateButton', () => {
	it('draws one action in the same frame as several, so the header does not shift (#1011)', () => {
		const onClick = vi.fn();
		renderButton([{ id: 'knowledge-new', label: 'New knowledge base', onClick }]);
		const button = screen.getByRole('button', { name: 'Create' });
		expect(button.parentElement).toHaveClass('rounded-lg', 'border');
		expect(screen.queryByRole('button', { name: 'Open create menu' })).toBeNull();
		fireEvent.click(button);
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('lists every action in the menu by its own words', async () => {
		renderButton([
			{ id: 'models-new', label: 'New model', onClick: vi.fn() },
			{ id: 'models-import', label: 'Import JSON', onClick: vi.fn() }
		]);
		fireEvent.pointerDown(screen.getByRole('button', { name: 'Open create menu' }), {
			button: 0,
			pointerType: 'mouse'
		});
		const menu = await screen.findByRole('menu');
		expect(
			within(menu)
				.getAllByRole('menuitem')
				.map((item) => item.textContent)
		).toEqual(['New model', 'Import JSON']);
	});
});
