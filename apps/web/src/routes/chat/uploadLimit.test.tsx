import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadFile } from '@/lib/apis/files';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { type ComposerHandle, MessageComposer } from '../channels/MessageComposer';
import { KnowledgePicker } from '../workspace/models/KnowledgePicker';
import { useAttachments } from './useAttachments';

// #238: an admin's Max Upload Size of 0 means no limit to the server
// (`if max_size and ...`), but the chat and channel composers read it as
// "nothing may be larger than 0 MB" and refused every file; so did the
// model editor's knowledge picker.

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/apis/files', () => ({ uploadFile: vi.fn(() => new Promise(() => {})) }));
vi.mock('@/lib/apis/users', () => ({
	getUserSettings: vi.fn(async () => ({ ui: {} })),
	updateUserSettings: vi.fn(),
	searchUsers: vi.fn(async () => ({ users: [] }))
}));
vi.mock('@/lib/apis', async (orig) => ({ ...(await orig<object>()), getModels: vi.fn(async () => []) }));
vi.mock('@/lib/apis/channels', async (orig) => ({
	...(await orig<object>()),
	getChannelMembersById: vi.fn(async () => ({ users: [] }))
}));
vi.mock('../channels/useChannels', async (orig) => ({
	...(await orig<object>()),
	useChannelList: () => ({ data: [] })
}));

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);
const twoMegabytes = () => new File([new Uint8Array(2 * 1024 * 1024)], 'big.txt', { type: 'text/plain' });
const limit = (max_size: number | null) => useConfigStore.setState({ config: { file: { max_size } } } as never);

beforeEach(() => {
	vi.mocked(toast.error).mockClear();
	vi.mocked(uploadFile).mockClear();
	useAuthStore.setState({
		status: 'authenticated',
		token: 't',
		user: { id: 'u1', email: '', name: 'U', role: 'admin', profile_image_url: '' }
	} as never);
});

describe('chat attachments and the upload size limit', () => {
	const attach = () => {
		const { result } = renderHook(
			() => useAttachments({ temporary: false, selectedModels: ['m'], models: [{ id: 'm' }] as never, chatId: null }),
			{ wrapper }
		);
		act(() => result.current.addFiles([twoMegabytes()]));
		return result.current.files;
	};

	it('a limit of 0 is no limit', () => {
		limit(0);
		expect(attach()).toEqual([expect.objectContaining({ name: 'big.txt', status: 'uploading' })]);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it('a limit of 1 MB still refuses a 2 MB file', () => {
		limit(1);
		expect(attach()).toEqual([]);
		expect(toast.error).toHaveBeenCalledWith('File size should not exceed 1 MB.');
	});
});

describe('channel composer and the upload size limit', () => {
	const attach = () => {
		const ref = createRef<ComposerHandle>();
		render(
			<MessageComposer
				ref={ref}
				channel={{ id: 'c1', name: 'general', type: null } as never}
				placeholder="Message"
				typingUsers={[]}
				replyTo={null}
				onCancelReply={() => {}}
				onTyping={() => {}}
				onSubmit={() => {}}
			/>,
			{ wrapper }
		);
		act(() => ref.current?.addFiles([twoMegabytes()]));
	};

	it('a limit of 0 is no limit', () => {
		limit(0);
		attach();
		expect(uploadFile).toHaveBeenCalledTimes(1);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it('a limit of 1 MB still refuses a 2 MB file', () => {
		limit(1);
		attach();
		expect(uploadFile).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith('File size should not exceed 1 MB.');
	});
});

describe("model editor's knowledge picker and the upload size limit", () => {
	const attach = () => {
		const onChange = vi.fn();
		const { container } = render(<KnowledgePicker items={[]} onChange={onChange} />, { wrapper });
		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, { target: { files: [twoMegabytes()] } });
		return onChange;
	};

	it('a limit of 0 is no limit', () => {
		limit(0);
		const onChange = attach();
		expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ name: 'big.txt', status: 'uploading' })]);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it('a limit of 1 MB still refuses a 2 MB file', () => {
		limit(1);
		const onChange = attach();
		expect(onChange).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith('File size should not exceed 1 MB.');
	});
});
