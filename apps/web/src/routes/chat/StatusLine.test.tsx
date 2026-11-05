import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Message } from '@/lib/chat/history';
import { StatusLine } from './StatusLine';

const reply = (statusHistory: Message['statusHistory']) =>
	({ id: 'r', parentId: 'q', childrenIds: [], role: 'assistant', content: '', statusHistory }) as Message;

describe('StatusLine', () => {
	it('shows the retrieval statuses in words, not as an empty button (#529)', () => {
		render(
			<StatusLine
				message={reply([
					{ action: 'queries_generated', queries: ['tax'], done: false },
					{ action: 'sources_retrieved', count: 3, done: true }
				])}
			/>
		);
		const button = screen.getByRole('button', { name: 'Retrieved 3 sources' });
		fireEvent.click(button);
		expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
			'Querying "tax"',
			'Retrieved 3 sources'
		]);
	});

	it('leaves out a status with nothing to say, and hidden ones', () => {
		render(
			<StatusLine
				message={reply([
					{ action: 'web_search', description: 'Searching the web', done: true },
					{ action: 'queries_generated', done: true },
					{ description: 'secret', hidden: true }
				])}
			/>
		);
		expect(screen.getByRole('button').textContent).toBe('Searching the web');
	});

	it('shows nothing when no status has anything to say', () => {
		const { container } = render(<StatusLine message={reply([{ action: 'queries_generated' }])} />);
		expect(container).toBeEmptyDOMElement();
	});

	it('stops pulsing once the latest status is done, even when that status is hidden', () => {
		render(
			<StatusLine
				message={reply([
					{ action: 'knowledge_search', query: 'q', done: false },
					{ action: 'knowledge_search', query: 'q', done: true, hidden: true }
				])}
			/>
		);
		expect(screen.getByRole('button', { name: 'Searching Knowledge for "q"' })).not.toHaveClass('animate-pulse');
	});

	it('pulses while the latest status is not done', () => {
		render(<StatusLine message={reply([{ action: 'knowledge_search', query: 'q', done: false }])} />);
		expect(screen.getByRole('button', { name: 'Searching Knowledge for "q"' })).toHaveClass('animate-pulse');
	});
});
