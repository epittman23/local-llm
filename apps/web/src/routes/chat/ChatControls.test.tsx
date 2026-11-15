import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatControls } from './ChatControls';

vi.mock('@/components/common/AdvancedParams', () => ({
	AdvancedParams: ({
		params,
		onChange
	}: {
		params: Record<string, unknown>;
		onChange: (p: Record<string, unknown>) => void;
	}) => (
		<button type="button" onClick={() => onChange({ ...params, temperature: 0.2 })}>
			Set temperature
		</button>
	)
}));

afterEach(cleanup);

describe('ChatControls', () => {
	it('is the side panel’s body: no region or Close of its own, labels in sentence case (TYP-7)', () => {
		render(<ChatControls params={{}} onParams={vi.fn()} files={[]} admin={false} />);
		expect(screen.queryByRole('complementary')).toBeNull();
		expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
		expect(screen.getByLabelText('System prompt')).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Model parameters' })).toBeInTheDocument();
		expect(screen.queryByRole('list', { name: 'Chat files' })).toBeNull();
	});

	it('edits the system prompt and the parameters, keeping each other', () => {
		const onParams = vi.fn();
		render(
			<ChatControls
				params={{ system: 'Be brief.' }}
				onParams={onParams}
				files={[
					{ id: 'f1', name: 'data.csv' },
					{ id: 'f2', file: { filename: 'notes.md' } }
				]}
				admin
			/>
		);
		expect(screen.getByRole('list', { name: 'Chat files' }).textContent).toBe('data.csvnotes.md');
		fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: '' } });
		expect(onParams).toHaveBeenLastCalledWith({ system: undefined });
		fireEvent.click(screen.getByRole('button', { name: 'Set temperature' }));
		expect(onParams).toHaveBeenLastCalledWith({ system: 'Be brief.', temperature: 0.2 });
	});
});
