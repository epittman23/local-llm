// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { describe, expect, it } from 'vitest';
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

describe('Markdown', () => {
	it('renders headings, lists, tables and highlighted code', () => {
		const { container } = renderMd('# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```python\nprint("hi")\n```\n');
		expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
		expect(screen.getAllByRole('listitem')).toHaveLength(2);
		expect(screen.getByRole('table')).toBeTruthy();
		expect(screen.getByTestId('code-block').textContent).toContain('print("hi")');
		expect(container.querySelector('.hljs-built_in, .hljs-string')).toBeTruthy();
	});
	it('renders math with KaTeX', () => {
		const { container } = renderMd('Euler: $e^{i\\pi}+1=0$');
		expect(container.querySelector('.katex')).toBeTruthy();
	});
	it('never injects raw HTML from a response', () => {
		const { container } = renderMd('<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>\n\nhi <b onclick="x()">bold</b>');
		expect(container.querySelector('img[onerror], script, b[onclick]')).toBeNull();
		expect(container.textContent).toContain('<script>alert(1)</script>');
	});
	it('titles reasoning and shows sources for citations', () => {
		renderMd('<details type="reasoning" done="true" duration="4">\n<summary>Thinking</summary>\nhmm\n</details>\n\nAnswer [1]', { sourceIds: ['https://www.example.com/page'] });
		expect(screen.getByRole('button', { name: 'Thought for 4 seconds' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'View source: example.com' })).toBeTruthy();
	});
	it('shows citations as text when there are no sources', () => {
		renderMd('Answer [1]');
		expect(screen.getByText('Answer [1]')).toBeTruthy();
	});
	it("shows a message's styles, forms and overlays as text (channels and shared chats render here)", () => {
		const { container } = renderMd('hi <style>body{display:none}</style> <form action="https://evil.example"><input type="password"></form> <div style="position:fixed;inset:0">x</div>');
		expect(container.querySelector('style, form, input, [style]')).toBeNull();
		expect(container.textContent).toContain('<style>body{display:none}</style>');
	});
	it('draws user, model and channel mentions as chips, a label-less one by its id', () => {
		const { container } = renderMd('hi <@U:u1|Ann>, <@M:gpt-4o> and <#C:c1|general>');
		expect([...container.querySelectorAll('[data-type="mention"]')].map((e) => e.textContent)).toEqual(['@Ann', '@gpt-4o', '#general']);
	});
});
