import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import App from './App';

describe('App', () => {
	it('renders the placeholder root', () => {
		render(<App />);
		expect(screen.getByRole('heading', { name: 'local-llm' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /shadcn\/ui/ })).toBeInTheDocument();
	});
});
