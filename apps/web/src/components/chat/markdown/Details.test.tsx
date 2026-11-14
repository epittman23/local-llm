// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CodeBlock } from './CodeBlock';
import { Markdown } from './Markdown';

const renderMd = (content: string, props: Partial<Parameters<typeof Markdown>[0]> = {}) =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<MemoryRouter>
					<Markdown id="m1" content={content} {...props} />
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);

const toolCall = (result: string) =>
	`<details type="tool_calls" done="true" name="search" arguments="{&quot;q&quot;:&quot;cats&quot;}" result="${result}">\n<summary>Tool Executed</summary>\n</details>`;

afterEach(cleanup);

describe('a details block in a response', () => {
	const reasoning =
		'<details type="reasoning" done="true" duration="4">\n<summary>Thinking</summary>\nhidden thoughts\n</details>';

	it('starts collapsed and opens its body when its title button is pressed', () => {
		renderMd(reasoning);
		const title = screen.getByRole('button', { name: 'Thought for 4 seconds' });
		expect(title.getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByText('hidden thoughts')).toBeNull();
		fireEvent.click(title);
		expect(title.getAttribute('aria-expanded')).toBe('true');
		expect(screen.getByText('hidden thoughts')).toBeTruthy();
		fireEvent.click(title);
		expect(screen.queryByText('hidden thoughts')).toBeNull();
	});

	it('pulses a reasoning title and shows no result while the response is still streaming', () => {
		renderMd('<details type="reasoning" done="false">\n<summary>Thinking</summary>\nhmm\n</details>', { done: false });
		const title = screen.getByRole('button', { name: /Thinking/ });
		expect(title.className).toContain('animate-pulse');
	});

	it('groups consecutive blocks under one button that counts the steps once the response is done', () => {
		renderMd(`${reasoning}\n${reasoning}`);
		const group = screen.getByRole('button', { name: '2 steps' });
		expect(group.getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryAllByTestId('details')).toHaveLength(0);
		fireEvent.click(group);
		expect(group.getAttribute('aria-expanded')).toBe('true');
		expect(screen.getAllByTestId('details')).toHaveLength(2);
	});

	it('labels the group "Working..." while the response is still streaming', () => {
		renderMd(`${reasoning}\n${reasoning}`, { done: false });
		expect(screen.getByRole('button', { name: 'Working...' })).toBeTruthy();
	});
});

describe('a tool call in a response', () => {
	it('shows its result title, and its input and output when expanded', () => {
		renderMd(toolCall('&quot;three cats&quot;'));
		const title = screen.getByRole('button', { name: 'View Result from search' });
		expect(title.getAttribute('aria-expanded')).toBe('false');
		fireEvent.click(title);
		expect(title.getAttribute('aria-expanded')).toBe('true');
		expect(screen.getByText('Input')).toBeTruthy();
		expect(screen.getByText('Output')).toBeTruthy();
	});

	it('cuts a long result and shows all of it when "Show all" is pressed', () => {
		renderMd(toolCall('x'.repeat(2500)), { sourceIds: [] });
		fireEvent.click(screen.getByRole('button', { name: 'View Result from search' }));
		const showAll = screen.getByRole('button', { name: 'Show all (2500 characters)' });
		const pre = () => screen.getAllByText(/^x+$/)[0];
		expect(pre().textContent).toHaveLength(2000);
		fireEvent.click(showAll);
		expect(pre().textContent).toHaveLength(2500);
		expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
	});
});

describe('CodeBlock Preview', () => {
	it('offers Preview for html and svg blocks, handing the code to the callback', () => {
		const onPreview = vi.fn();
		render(<CodeBlock id="b1" lang="html" code="<p>hi</p>" complete onPreview={onPreview} />);
		fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
		expect(onPreview).toHaveBeenCalledWith('<p>hi</p>');
	});

	it('does not offer Preview for other languages', () => {
		render(<CodeBlock id="b1" lang="python" code="1" complete onPreview={vi.fn()} />);
		expect(screen.queryByRole('button', { name: /Preview/ })).toBeNull();
	});
});
