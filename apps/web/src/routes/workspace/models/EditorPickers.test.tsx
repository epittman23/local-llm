import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { BaseModelSelect, CheckboxGrid, ItemPicker } from './EditorPickers';

const withTips = (ui: React.ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);

describe('CheckboxGrid', () => {
	it('toggles an item from its label button', () => {
		const onToggle = vi.fn();
		withTips(
			<CheckboxGrid
				title="Capabilities"
				items={[{ id: 'vision', label: 'Vision', description: 'sees images' }]}
				isChecked={() => false}
				onToggle={onToggle}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Vision' }));
		expect(onToggle).toHaveBeenCalledWith('vision', true);
	});
});

describe('ItemPicker', () => {
	const labels = { search: 'Search tools', trigger: 'Select Tools', empty: 'No tools found' };
	const items = [
		{ id: 't1', name: 'Calculator' },
		{ id: 't2', name: 'Weather' }
	];

	it('adds the tool that is picked from the dropdown', () => {
		const onChange = vi.fn();
		withTips(<ItemPicker title="Tools" items={items} selectedIds={[]} onChange={onChange} labels={labels} />);
		fireEvent.click(screen.getByRole('button', { name: 'Select Tools' }));
		fireEvent.click(screen.getByRole('button', { name: 'Weather' }));
		expect(onChange).toHaveBeenCalledWith(['t2']);
	});

	it('enables every match from Enable all', () => {
		const onChange = vi.fn();
		withTips(<ItemPicker title="Tools" items={items} selectedIds={['t1']} onChange={onChange} labels={labels} />);
		fireEvent.click(screen.getByRole('button', { name: 'Select Tools' }));
		fireEvent.click(screen.getByRole('button', { name: 'Enable all (2)' }));
		expect(onChange).toHaveBeenCalledWith(['t1', 't2']);
	});

	it('says so when the search matches nothing', () => {
		withTips(<ItemPicker title="Tools" items={items} selectedIds={[]} onChange={vi.fn()} labels={labels} />);
		fireEvent.click(screen.getByRole('button', { name: 'Select Tools' }));
		fireEvent.change(screen.getByRole('textbox', { name: 'Search tools' }), { target: { value: 'zzz' } });
		expect(screen.getByText('No tools found')).toBeInTheDocument();
	});

	it('clears the selection from Disable all', () => {
		const onChange = vi.fn();
		withTips(<ItemPicker title="Tools" items={items} selectedIds={['t1']} onChange={onChange} labels={labels} />);
		fireEvent.click(screen.getByRole('button', { name: 'Disable all' }));
		expect(onChange).toHaveBeenCalledWith([]);
	});

	it('offers no Disable all when only locked global items are shown', () => {
		withTips(
			<ItemPicker
				title="Filters"
				items={[{ id: 'g', name: 'Global', is_global: true }]}
				selectedIds={[]}
				onChange={vi.fn()}
				labels={labels}
				lockGlobal
			/>
		);
		expect(screen.queryByRole('button', { name: 'Disable all' })).toBeNull();
	});
});

describe('BaseModelSelect', () => {
	const models = [
		{ value: 'm1', label: 'Model One' },
		{ value: 'm2', label: 'Model Two' }
	];

	it('chooses the model that is clicked', () => {
		const onChange = vi.fn();
		render(<BaseModelSelect items={models} value="m1" onChange={onChange} placeholder="Select" />);
		fireEvent.click(screen.getByRole('button', { name: 'Base model' }));
		fireEvent.click(screen.getByRole('button', { name: 'Model Two' }));
		expect(onChange).toHaveBeenCalledWith('m2');
	});

	it('says so when the search matches no model', () => {
		render(<BaseModelSelect items={models} value={null} onChange={vi.fn()} placeholder="Select" />);
		fireEvent.click(screen.getByRole('button', { name: 'Base model' }));
		fireEvent.change(screen.getByRole('textbox', { name: 'Search a model' }), { target: { value: 'zzz' } });
		expect(screen.getByText('No results found')).toBeInTheDocument();
	});
});
