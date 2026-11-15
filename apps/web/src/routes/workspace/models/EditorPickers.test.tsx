import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BaseModelSelect, CheckboxGrid, ItemPicker } from './EditorPickers';

describe('CheckboxGrid', () => {
	const items = [
		{ id: 'vision', label: 'Vision', description: 'Accepts images in a message.' },
		{ id: 'image_generation', label: 'Image generation', description: 'Makes images.', off: 'Image generation is off.' }
	];

	it('ties each label to its box, so the label toggles it, and shows the description under it (A11Y-4)', () => {
		const onToggle = vi.fn();
		render(<CheckboxGrid title="Capabilities" items={items} isChecked={() => false} onToggle={onToggle} />);
		expect(screen.getByRole('group', { name: 'Capabilities' })).toBeInTheDocument();
		const vision = screen.getByRole('checkbox', { name: 'Vision' });
		expect(vision).toHaveAccessibleDescription('Accepts images in a message.');
		fireEvent.click(screen.getByText('Vision'));
		expect(onToggle).toHaveBeenCalledWith('vision', true);
	});

	it('disables a switched-off feature’s row and says why in place of its description (ACT-5)', () => {
		render(
			<CheckboxGrid
				title="Capabilities"
				items={items}
				isChecked={(id) => id === 'image_generation'}
				onToggle={vi.fn()}
			/>
		);
		const box = screen.getByRole('checkbox', { name: 'Image generation' });
		expect(box).toBeDisabled();
		expect(box).toBeChecked();
		expect(box).toHaveAccessibleDescription('Image generation is off.');
	});

	it('keeps two grids’ boxes apart when they share an id', () => {
		const first = vi.fn();
		render(
			<>
				<CheckboxGrid title="A" items={[items[0]]} isChecked={() => false} onToggle={first} />
				<CheckboxGrid title="B" items={[items[0]]} isChecked={() => false} onToggle={vi.fn()} />
			</>
		);
		const [a, b] = screen.getAllByRole('checkbox', { name: 'Vision' });
		expect(a.id).not.toBe(b.id);
		fireEvent.click(screen.getAllByText('Vision')[0]);
		expect(first).toHaveBeenCalledTimes(1);
	});
});

describe('ItemPicker', () => {
	const labels = { search: 'Search tools', trigger: 'Choose tools', noMatch: 'No tool matches that search.' };
	const items = [
		{ id: 't1', name: 'Calculator' },
		{ id: 't2', name: 'Weather' }
	];

	it('adds the tool that is picked from the list', () => {
		const onChange = vi.fn();
		render(<ItemPicker title="Tools" items={items} selectedIds={[]} onChange={onChange} labels={labels} />);
		fireEvent.click(screen.getByRole('button', { name: 'Choose tools' }));
		expect(screen.getByRole('dialog', { name: 'Choose tools' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('option', { name: 'Weather' }));
		expect(onChange).toHaveBeenCalledWith(['t2']);
	});

	it('removes a picked tool when it is picked again', () => {
		const onChange = vi.fn();
		render(<ItemPicker title="Tools" items={items} selectedIds={['t1']} onChange={onChange} labels={labels} />);
		fireEvent.click(screen.getByRole('button', { name: 'Choose tools' }));
		fireEvent.click(screen.getByRole('option', { name: /Calculator/ }));
		expect(onChange).toHaveBeenCalledWith([]);
	});

	it('adds every tool from Add all', () => {
		const onChange = vi.fn();
		render(<ItemPicker title="Tools" items={items} selectedIds={['t1']} onChange={onChange} labels={labels} />);
		fireEvent.click(screen.getByRole('button', { name: 'Choose tools' }));
		fireEvent.click(screen.getByRole('button', { name: 'Add all (2)' }));
		expect(onChange).toHaveBeenCalledWith(['t1', 't2']);
	});

	it('says so when the search matches nothing', () => {
		render(<ItemPicker title="Tools" items={items} selectedIds={[]} onChange={vi.fn()} labels={labels} />);
		fireEvent.click(screen.getByRole('button', { name: 'Choose tools' }));
		fireEvent.change(screen.getByPlaceholderText('Search tools'), { target: { value: 'zzz' } });
		expect(screen.getByText('No tool matches that search.')).toBeInTheDocument();
	});

	it('unticks one picked tool from its box, and clears all from Remove all', () => {
		const onChange = vi.fn();
		render(<ItemPicker title="Tools" items={items} selectedIds={['t1', 't2']} onChange={onChange} labels={labels} />);
		fireEvent.click(screen.getByRole('checkbox', { name: 'Calculator' }));
		expect(onChange).toHaveBeenCalledWith(['t2']);
		fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
		expect(onChange).toHaveBeenLastCalledWith([]);
	});

	it('says where to make one only when there is nothing to pick (#956)', () => {
		const { rerender } = render(
			<ItemPicker title="Tools" items={[]} selectedIds={[]} onChange={vi.fn()} labels={labels} empty="No tools yet." />
		);
		expect(screen.getByText('No tools yet.')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Choose tools' })).toBeNull();
		rerender(
			<ItemPicker
				title="Tools"
				items={items}
				selectedIds={['t1']}
				onChange={vi.fn()}
				labels={labels}
				empty="No tools yet."
			/>
		);
		expect(screen.queryByText('No tools yet.')).toBeNull();
	});

	it('offers no Remove all when only locked global items are shown', () => {
		render(
			<ItemPicker
				title="Filters"
				items={[{ id: 'g', name: 'Global', is_global: true }]}
				selectedIds={[]}
				onChange={vi.fn()}
				labels={labels}
				lockGlobal
			/>
		);
		expect(screen.getByRole('checkbox', { name: 'Global' })).toBeDisabled();
		expect(screen.queryByRole('button', { name: 'Remove all' })).toBeNull();
	});
});

describe('BaseModelSelect', () => {
	const models = [
		{ value: 'm1', label: 'Model One' },
		{ value: 'm2', label: 'Model Two' }
	];
	const renderSelect = (value: string | null, onChange = vi.fn(), invalid = false) =>
		render(
			<>
				<span id="base-label">Base model</span>
				<BaseModelSelect
					labelId="base-label"
					items={models}
					value={value}
					onChange={onChange}
					placeholder="Choose a model"
					invalid={invalid}
					describedBy="base-note"
				/>
				<p id="base-note">Choose the model this one is built on.</p>
			</>
		);

	it('is named by its label and the value it shows (#987), and chooses the model that is picked', () => {
		const onChange = vi.fn();
		renderSelect('m1', onChange);
		fireEvent.click(screen.getByRole('button', { name: 'Base model Model One' }));
		fireEvent.click(screen.getByRole('option', { name: 'Model Two' }));
		expect(onChange).toHaveBeenCalledWith('m2');
	});

	it('shows the placeholder when empty, and its error when invalid', () => {
		renderSelect(null, vi.fn(), true);
		const trigger = screen.getByRole('button', { name: 'Base model Choose a model' });
		expect(trigger).toHaveAttribute('aria-invalid', 'true');
		expect(trigger).toHaveAccessibleDescription('Choose the model this one is built on.');
	});

	it('says so when the search matches no model', () => {
		renderSelect(null);
		fireEvent.click(screen.getByRole('button', { name: /Base model/ }));
		fireEvent.change(screen.getByPlaceholderText('Search models'), { target: { value: 'zzz' } });
		expect(screen.getByText('No model matches that search.')).toBeInTheDocument();
	});
});
