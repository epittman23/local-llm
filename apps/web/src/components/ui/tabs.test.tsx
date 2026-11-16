import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tabs, TabsList, TabsTrigger } from './tabs';

describe('TabsTrigger', () => {
	it('sets an inactive tab in the muted text colour, never the text colour at an opacity (COL-2)', () => {
		render(
			<Tabs defaultValue="general">
				<TabsList variant="line">
					<TabsTrigger value="general">General</TabsTrigger>
					<TabsTrigger value="permissions">Permissions</TabsTrigger>
				</TabsList>
			</Tabs>
		);
		const inactive = screen.getByRole('tab', { name: 'Permissions' });
		expect(inactive).toHaveAttribute('data-state', 'inactive');
		// --foreground-muted meets 4.5:1 on the page and on --surface-3 in every theme; text-foreground/60 was 4.34:1 in light.
		expect(inactive).toHaveClass('text-muted-foreground');
		expect(inactive.className).not.toMatch(/text-(?:muted-)?foreground\/\d+/);
		// The active tab still reads in the strong text colour.
		expect(screen.getByRole('tab', { name: 'General' })).toHaveClass('data-active:text-foreground');
	});
});
