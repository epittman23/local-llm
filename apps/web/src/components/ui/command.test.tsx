import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandLoading,
	CommandSeparator
} from './command';

function Palette({ onSelect = vi.fn() }: { onSelect?: (value: string) => void }) {
	return (
		<Command label="Pick a fruit">
			<CommandInput placeholder="Search fruit" />
			<CommandList label="Fruit">
				<CommandEmpty>No fruit matches.</CommandEmpty>
				<CommandGroup heading="Fruit">
					<CommandItem value="apple" onSelect={onSelect}>
						Apple
					</CommandItem>
					<CommandItem value="banana" onSelect={onSelect}>
						Banana
					</CommandItem>
				</CommandGroup>
				<CommandSeparator />
			</CommandList>
		</Command>
	);
}

describe('Command (NAV-5)', () => {
	it('keeps focus in the field while the arrow keys move the highlight, and Enter chooses', () => {
		const onSelect = vi.fn();
		render(<Palette onSelect={onSelect} />);
		const field = screen.getByRole('combobox', { name: 'Pick a fruit' });
		field.focus();
		const [apple, banana] = screen.getAllByRole('option');
		expect(apple).toHaveAttribute('aria-selected', 'true');

		fireEvent.keyDown(field, { key: 'ArrowDown' });
		expect(banana).toHaveAttribute('aria-selected', 'true');
		expect(field).toHaveFocus();
		expect(field).toHaveAttribute('aria-activedescendant', banana.id);

		fireEvent.keyDown(field, { key: 'Enter' });
		expect(onSelect).toHaveBeenCalledWith('banana');
	});

	it('names the list and its groups, and says so when nothing matches', () => {
		render(<Palette />);
		expect(screen.getByRole('listbox', { name: 'Fruit' })).toBeInTheDocument();
		expect(screen.getByRole('group', { name: 'Fruit' })).toBeInTheDocument();
		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'kiwi' } });
		expect(screen.getByText('No fruit matches.')).toBeInTheDocument();
	});

	it('draws the field with the standard edge and the rows at the touch height on a coarse pointer (LAY-3)', () => {
		render(<Palette />);
		const wrapper = screen.getByRole('combobox').parentElement as HTMLElement;
		expect(wrapper).toHaveAttribute('data-composite-field');
		expect(wrapper.className).toContain('border-border-control');
		expect(wrapper.className).toContain('pointer-coarse:h-(--control-touch)');
		expect(screen.getAllByRole('option')[0].className).toContain('pointer-coarse:min-h-11');
		expect(screen.getAllByRole('option')[0].className).toContain('data-[selected=true]:bg-surface-3');
	});

	it('shows a loading row in place of the items', () => {
		render(
			<Command label="Search">
				<CommandList>
					<CommandLoading label="Searching">Searching…</CommandLoading>
				</CommandList>
			</Command>
		);
		expect(screen.getByRole('progressbar', { name: 'Searching' })).toHaveTextContent('Searching…');
	});
});
