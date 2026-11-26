import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createContext, type ReactElement, type ReactNode, useContext } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { type CanvasDocument, messageDocuments } from '@/lib/chat/documents';
import type { ChatFile, Message } from '@/lib/chat/history';

/** A file id as the server makes them (a UUID), from a short hex key. */
export const id = (key: string) => `00000000-0000-4000-8000-${key.padStart(12, '0')}`;
export const content = (key: string, attachment = false) =>
	`/api/v1/files/${id(key)}/content${attachment ? '?attachment=true' : ''}`;

/** A sandbox output file, as a reply's `files` holds it. */
export const output = (
	key: string,
	name: string,
	meta: Record<string, unknown> = {},
	extra: Partial<ChatFile> = {}
): ChatFile => ({
	type: 'file',
	id: id(key),
	name,
	url: content(key),
	size: 10,
	meta: { source: 'sandbox_output', sandbox_path: `/workspace/outputs/${name}`, ...meta },
	...extra
});

/** A file a person attached. */
export const upload = (key: string, name: string, extra: Partial<ChatFile> = {}): ChatFile => ({
	type: 'file',
	id: id(key),
	name,
	url: content(key),
	size: 10,
	...extra
});

const message = (role: Message['role'], files: ChatFile[]): Message => ({
	id: 'm1',
	parentId: null,
	childrenIds: [],
	role,
	content: '',
	done: true,
	files
});

/** The documents the canvas model makes of a reply's files (or, with `role` 'user', a person's attachments). */
export const docsOf = (files: ChatFile[], role: Message['role'] = 'assistant'): CanvasDocument[] =>
	messageDocuments(message(role, files));

export const docOf = (file: ChatFile, role: Message['role'] = 'assistant'): CanvasDocument => docsOf([file], role)[0];

/** A fenced block as a document. */
export const blockDoc = (text: string, language = 'html', closed = true, name = 'HTML page'): CanvasDocument => ({
	id: 'block:m1:0',
	name,
	kind: language === 'html' || language === 'svg' ? 'html' : 'code',
	language,
	bytes: text.length,
	messageId: 'm1',
	source: { type: 'block', text, language, closed }
});

/** Renders with a query client and tooltips around it, which `rerender` keeps. */
export const renderWithClient = (ui: ReactElement) => {
	const client = new QueryClient();
	return render(ui, {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				<TooltipProvider>{children}</TooltipProvider>
			</QueryClientProvider>
		)
	});
};

const Slot = createContext<ReactNode>(null);
const SlotOutlet = () => useContext(Slot);

/**
 * `renderWithClient` inside a data router (the unsaved-changes guard's `useBlocker` needs one), which
 * `rerender` keeps. Returns the router, to read the address and to navigate.
 */
export const renderWithRouter = (ui: ReactElement, initialEntries = ['/']) => {
	const client = new QueryClient();
	const router = createMemoryRouter([{ path: '*', element: <SlotOutlet /> }], { initialEntries });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<Slot.Provider value={children}>
					<RouterProvider router={router} />
				</Slot.Provider>
			</TooltipProvider>
		</QueryClientProvider>
	);
	return { ...render(ui, { wrapper }), router, client };
};
