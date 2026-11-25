// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Message } from '@/lib/chat/history';
import { messageDocuments } from '@/lib/chat/documents';
import { CanvasContext } from '@/routes/chat/canvas/CanvasContext';
import { Markdown } from './Markdown';

const { saveAs, copyToClipboard, toastError } = vi.hoisted(() => ({
	saveAs: vi.fn(),
	copyToClipboard: vi.fn(),
	toastError: vi.fn()
}));
vi.mock('file-saver', () => ({ default: saveAs }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));
vi.mock('@/lib/utils', async (original) => ({ ...(await original<typeof import('@/lib/utils')>()), copyToClipboard }));
afterEach(() => vi.clearAllMocks());

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
	it('sizes headings on the standard’s scale (TYP-2)', () => {
		renderMd('# One\n\n## Two\n\n### Three\n\n#### Four\n');
		const size = (name: string) => screen.getByRole('heading', { name }).className;
		expect(size('One')).toContain('text-heading');
		expect(size('Two')).toContain('text-title');
		expect(size('Three')).toContain('text-reading');
		expect(size('Four')).toContain('text-body');
	});

	it('renders headings, lists, tables and highlighted code', () => {
		const { container } = renderMd(
			'# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```python\nprint("hi")\n```\n'
		);
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
		const { container } = renderMd(
			'<img src=x onerror="alert(1)">\n\n<script>alert(1)</script>\n\nhi <b onclick="x()">bold</b>'
		);
		expect(container.querySelector('img[onerror], script, b[onclick]')).toBeNull();
		expect(container.textContent).toContain('<script>alert(1)</script>');
	});
	it('titles reasoning and shows sources for citations', () => {
		renderMd(
			'<details type="reasoning" done="true" duration="4">\n<summary>Thinking</summary>\nhmm\n</details>\n\nAnswer [1]',
			{ sourceIds: ['https://www.example.com/page'] }
		);
		expect(screen.getByRole('button', { name: 'Thought for 4 seconds' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'View source: example.com' })).toBeTruthy();
	});
	it('shows citations as text when there are no sources', () => {
		renderMd('Answer [1]');
		expect(screen.getByText('Answer [1]')).toBeTruthy();
	});
	it("shows a message's styles, forms and overlays as text (channels and shared chats render here)", () => {
		const { container } = renderMd(
			'hi <style>body{display:none}</style> <form action="https://evil.example"><input type="password"></form> <div style="position:fixed;inset:0">x</div>'
		);
		expect(container.querySelector('style, form, input, [style]')).toBeNull();
		expect(container.textContent).toContain('<style>body{display:none}</style>');
	});
	it('draws user, model and channel mentions as chips, a label-less one by its id', () => {
		const { container } = renderMd('hi <@U:u1|Ann>, <@M:gpt-4o> and <#C:c1|general>');
		expect([...container.querySelectorAll('[data-type="mention"]')].map((e) => e.textContent)).toEqual([
			'@Ann',
			'@gpt-4o',
			'#general'
		]);
	});

	it('draws a task item as a box and its text, without the Markdown marker (#940)', () => {
		const { container } = renderMd('- [ ] an open task\n- [x] a done **task**\n\n1. [ ] loose\n\n2. [x] two\n');
		const items = screen.getAllByRole('listitem');
		expect(items.map((li) => li.textContent)).toEqual([
			'Not done: an open task',
			'Done: a done task',
			'Not done: loose',
			'Done: two'
		]);
		expect(container.querySelector('input')).toBeNull();
		const marks = [...container.querySelectorAll('[data-slot="checkbox-mark"]')];
		expect(marks.map((m) => m.getAttribute('data-state'))).toEqual(['unchecked', 'checked', 'unchecked', 'checked']);
	});

	const WIDE =
		'| Model | Coef | Std. err | p-value |\n|---|---:|---:|---:|\n| OLS | 0.4123 | 0.0012 | 1.2e-131 |\n| GLS | =1+1 | 0.0020 | 3.4e-12 |\n';

	it('renders a table in the shared Table: named, cells unwrapped, figures aligned as written (#946)', () => {
		renderMd(WIDE);
		const region = screen.getByRole('region', { name: 'Table: Model, Coef, Std. err, …' });
		const table = within(region).getByRole('table');
		const headings = within(table).getAllByRole('columnheader');
		expect(headings.map((h) => h.getAttribute('scope'))).toEqual(['col', 'col', 'col', 'col']);
		expect(headings[3].style.textAlign).toBe('right');
		const cell = within(table).getByRole('cell', { name: '1.2e-131' });
		expect(cell.className).toContain('whitespace-nowrap');
		expect(cell.style.textAlign).toBe('right');
	});

	it('names a short table by all its headings', () => {
		renderMd('| a | b |\n|---|---|\n| 1 | 2 |\n');
		expect(screen.getByRole('region', { name: 'Table: a, b' })).toBeTruthy();
	});

	it('copies a table as tab-separated cells and says Copied; a refused copy says so (#942)', async () => {
		copyToClipboard.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		renderMd(WIDE);
		fireEvent.click(screen.getByRole('button', { name: 'Copy table' }));
		expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
		expect(copyToClipboard).toHaveBeenCalledWith(
			"Model\tCoef\tStd. err\tp-value\nOLS\t0.4123\t0.0012\t1.2e-131\nGLS\t'=1+1\t0.0020\t3.4e-12"
		);
		fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
		await vi.waitFor(() =>
			expect(toastError).toHaveBeenCalledWith("Couldn't copy the table: the browser blocked clipboard access")
		);
	});

	it('downloads a table as CSV from its always-visible toolbar', () => {
		renderMd(WIDE);
		fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
		expect(saveAs).toHaveBeenCalledWith(expect.any(Blob), 'table-m1-0.csv');
	});

	it('puts display math inside a sentence in a span, which a paragraph may hold, and on its own line in a figure', () => {
		const error = vi.spyOn(console, 'error');
		renderMd('where $$x^2$$ is it\n\n$$\\sum x$$\n');
		expect(error).not.toHaveBeenCalled();
		const [inline, block] = screen.getAllByTestId('display-equation');
		expect(inline.tagName).toBe('SPAN');
		expect(inline.closest('p')).toBeTruthy();
		expect(inline.getAttribute('aria-label')).toBeNull();
		expect(block).toBe(screen.getByRole('figure', { name: 'Equation' }));
		error.mockRestore();
	});
});

describe('a fenced block that is a document', () => {
	const reply = (content: string, done = true): Message => ({
		id: 'm1',
		parentId: null,
		childrenIds: [],
		role: 'assistant',
		content,
		done
	});
	const page = (title: string) => `\`\`\`html\n<!doctype html><title>${title}</title><p>${title}</p>\n\`\`\`\n`;
	/** Renders a reply's text as ChatMessages does: with its documents, and a canvas that `open` stands for. */
	const renderMdIn = (
		message: Message,
		open: (id: string) => void,
		shown: { content?: string; blockBase?: number } = {}
	) =>
		render(
			<CanvasContext.Provider value={{ openId: null, open }}>
				<QueryClientProvider client={new QueryClient()}>
					<TooltipProvider>
						<MemoryRouter>
							<Markdown
								id={message.id}
								messageId={message.id}
								content={shown.content ?? message.content}
								documents={messageDocuments(message)}
								blockBase={shown.blockBase}
								done={message.done !== false}
							/>
						</MemoryRouter>
					</TooltipProvider>
				</QueryClientProvider>
			</CanvasContext.Provider>
		);

	it('renders a complete page as a card, not a code block', () => {
		const message = reply(page('Chart'));
		const open = vi.fn();
		renderMdIn(message, open);
		const card = screen.getByRole('button', { name: /Chart/ });
		expect(card.getAttribute('data-testid')).toBe('document-card');
		expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
		fireEvent.click(card);
		expect(open).toHaveBeenCalledWith('block:m1:0');
	});

	it('keeps a short snippet inline as code, with no Preview button', () => {
		renderMdIn(reply('```html\n<p>hi</p>\n```\n'), vi.fn());
		expect(screen.queryByTestId('document-card')).toBeNull();
		expect(screen.queryByRole('button', { name: /Preview/ })).toBeNull();
		expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
	});

	it('numbers a block as the documents do, in a list, a quote, an alert and a details body', () => {
		const html = (t: string) => page(t).trimEnd();
		const content = [
			'```python\nprint(1)\n```',
			`- item\n\n  ${html('InList').replaceAll('\n', '\n  ')}`,
			`> ${html('InQuote').replaceAll('\n', '\n> ')}`,
			`> [!NOTE]\n> ${html('InAlert').replaceAll('\n', '\n> ')}`,
			`<details type="reasoning" done="true" duration="2">\n<summary>Thinking</summary>\n${html('InDetails')}\n</details>`,
			html('AtTop')
		].join('\n\n');
		const message = reply(content);
		const documents = messageDocuments(message);
		expect(documents.map((d) => d.name)).toEqual(['InList', 'InQuote', 'InAlert', 'InDetails', 'AtTop']);
		const open = vi.fn();
		renderMdIn(message, open);
		fireEvent.click(screen.getByRole('button', { name: 'Thought for 2 seconds' }));
		const cards = screen.getAllByTestId('document-card');
		expect(cards.map((c) => c.textContent)).toEqual(documents.map((d) => expect.stringContaining(d.name)));
		cards.forEach((card, i) => {
			fireEvent.click(card);
			expect(open).toHaveBeenLastCalledWith(documents[i].id);
		});
		// The python block takes ordinal 0 although it is no document.
		expect(documents.map((d) => d.id)).toEqual([1, 2, 3, 4, 5].map((n) => `block:m1:${n}`));
	});

	it('numbers the blocks of a second text after those of the first', () => {
		const message = reply(page('First') + '\n' + page('Second'));
		const documents = messageDocuments(message);
		const open = vi.fn();
		renderMdIn(message, open, { content: page('Second'), blockBase: 1 });
		// As the second text of a reply, its first block is the message's second.
		fireEvent.click(screen.getByTestId('document-card'));
		expect(open).toHaveBeenCalledWith(documents[1].id);
	});

	it('shows a block still being written as a card that says so', () => {
		renderMdIn(reply('```html\n<!doctype html>\n<p>half', false), vi.fn());
		expect(screen.getByTestId('document-card').textContent).toContain('Writing…');
	});

	it('offers Open in canvas on a long block of other code, which stays a code block', () => {
		const code = Array.from({ length: 16 }, (_, i) => `x${i} = ${i}`).join('\n');
		const open = vi.fn();
		renderMdIn(reply(`\`\`\`python\n${code}\n\`\`\`\n`), open);
		expect(screen.queryByTestId('document-card')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Open in canvas' }));
		expect(open).toHaveBeenCalledWith('block:m1:0');
	});

	it('offers no Open in canvas on a short block', () => {
		renderMdIn(reply('```python\nprint(1)\n```\n'), vi.fn());
		expect(screen.queryByRole('button', { name: 'Open in canvas' })).toBeNull();
	});
});
