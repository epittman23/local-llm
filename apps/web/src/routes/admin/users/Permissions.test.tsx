import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Permissions as PermissionsShape, withDefaults } from '@/lib/access/permissions';
import { useConfigStore } from '@/lib/stores/configStore';
import { Permissions } from './Permissions';

beforeEach(() => {
	useConfigStore.setState({ config: { features: { enable_plugins: true } } } as never);
});

function Harness({
	start,
	baseline = withDefaults(null),
	defaults
}: {
	start: PermissionsShape;
	baseline?: PermissionsShape;
	defaults?: Partial<PermissionsShape>;
}) {
	const [permissions, setPermissions] = useState(start);
	return (
		<Permissions
			permissions={permissions}
			onChange={setPermissions}
			baseline={baseline}
			defaultPermissions={defaults}
		/>
	);
}

const heading = (name: RegExp) => screen.getByRole('button', { name });

describe('Permissions (#1099)', () => {
	it('folds every group, naming it without "Permissions" and counting its permissions', () => {
		render(<Harness start={withDefaults(null)} />);
		const chat = heading(/^Chat/);
		expect(chat.getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByRole('checkbox')).toBeNull();
		expect(screen.queryByText(/Permissions$/)).toBeNull();
		fireEvent.click(chat);
		expect(chat.getAttribute('aria-expanded')).toBe('true');
		expect(screen.getByRole('checkbox', { name: 'Upload files' })).toBeTruthy();
		expect(screen.getByText('Attach files to a message.')).toBeTruthy();
		fireEvent.click(chat);
		expect(screen.queryByRole('checkbox', { name: 'Upload files' })).toBeNull();
	});

	it('counts the permissions that differ from the baseline, live', () => {
		render(<Harness start={withDefaults(null)} />);
		const chat = heading(/^Chat/);
		expect(within(chat).queryByText(/changed/)).toBeNull();
		fireEvent.click(chat);
		const upload = screen.getByRole('checkbox', { name: 'Upload files' });
		fireEvent.click(upload);
		expect(within(heading(/^Chat/)).getByText('1 changed')).toBeTruthy();
	});

	it('filters by label or description and opens the groups that match', () => {
		render(<Harness start={withDefaults(null)} />);
		fireEvent.change(screen.getByLabelText('Filter permissions'), { target: { value: 'read aloud' } });
		expect(screen.getByRole('checkbox', { name: 'Text to speech' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /^Workspace/ })).toBeNull();
		expect(within(heading(/^Chat/)).getByText(/^1 of \d+$/)).toBeTruthy();
		fireEvent.change(screen.getByLabelText('Filter permissions'), { target: { value: '' } });
		expect(screen.queryByRole('checkbox')).toBeNull();
	});

	it('says so when nothing matches the filter, with a way to clear it', () => {
		render(<Harness start={withDefaults(null)} />);
		fireEvent.change(screen.getByLabelText('Filter permissions'), { target: { value: 'zzzz' } });
		expect(screen.getByText('Nothing matches “zzzz”')).toBeTruthy();
		fireEvent.click(screen.getAllByRole('button', { name: 'Clear search' }).at(-1) as HTMLElement);
		expect(heading(/^Chat/)).toBeTruthy();
	});

	it('shows a risk under its checkbox, and the default hint where a default keeps one on', () => {
		render(
			<Harness
				start={withDefaults({ features: { memories: false } })}
				defaults={{ features: { memories: true } } as never}
			/>
		);
		fireEvent.click(heading(/^Workspace/));
		expect(screen.getAllByText('Lets them run any code on the server.').length).toBeGreaterThan(0);
		fireEvent.click(heading(/^Features/));
		expect(screen.getByText("On for every account by default, so this group's members keep it.")).toBeTruthy();
	});

	it('nests Import and Export under their workspace permission once it is on', () => {
		render(<Harness start={withDefaults({ workspace: { models: true } })} />);
		fireEvent.click(heading(/^Workspace/));
		expect(screen.getByRole('checkbox', { name: 'Import models' })).toBeTruthy();
		expect(screen.getByRole('checkbox', { name: 'Export models' })).toBeTruthy();
	});
});
