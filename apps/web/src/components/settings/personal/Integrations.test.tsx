import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import Integrations from './Integrations';

// #263: a personal tool server saved without a name has `info.name === ''`,
// which `??` kept, so its row in the list was blank. The original showed the URL.

const settings = vi.hoisted(() => ({
	toolServers: [
		{ url: 'https://unnamed.example', info: { name: '' } },
		{ url: 'https://spaces.example', info: { name: '   ' } },
		{ url: 'https://named.example', info: { name: 'Weather' } },
		{ url: 'https://no-info.example' },
		// A name that is not text, as an imported JSON file can hold.
		{ url: 'https://number.example', info: { name: 42 } }
	]
}));
vi.mock('@/lib/settings/userSettings', () => ({
	useUserSettings: () => ({ settings, update: vi.fn() })
}));

describe('personal tool servers (#263)', () => {
	it('lists a server without a name by its URL', () => {
		render(
			<TooltipProvider>
				<Integrations />
			</TooltipProvider>
		);
		const rows = within(screen.getByRole('list', { name: 'Tool servers' })).getAllByRole('listitem');
		expect(rows.map((row) => row.querySelector('span')?.textContent)).toEqual([
			'https://unnamed.example',
			'https://spaces.example',
			'Weather',
			'https://no-info.example',
			'42'
		]);
	});
});
