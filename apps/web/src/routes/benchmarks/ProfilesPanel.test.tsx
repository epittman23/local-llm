import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/apis/benchmarks/profiles';
import { useAuthStore } from '@/lib/stores/authStore';
import { fieldOfServerError } from './ProfileDefinitionForm';
import { ProfilesPanel } from './ProfilesPanel';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/apis/benchmarks/profiles', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks/profiles')>();
	return {
		...real,
		listProfiles: vi.fn(),
		getProfile: vi.fn(),
		listProfileVersions: vi.fn(),
		createProfile: vi.fn(),
		cloneProfile: vi.fn(),
		addProfileVersion: vi.fn(),
		setDefaultProfile: vi.fn(),
		archiveProfile: vi.fn(),
		unarchiveProfile: vi.fn()
	};
});

const definition = {
	arch: 'dense',
	alias: 'qwen3.8-27b',
	model_path: '{LLAMA_MODELS}/qwen38/Qwen3.8-27B-UD-Q3_K_XL.gguf',
	hf_repo: '',
	hf_pattern: '',
	ctx: 16384,
	threads: 12,
	ngl: 20,
	moe: null,
	override_tensors: null,
	parallel: 1,
	cache_k: 'q8_0',
	cache_v: 'q8_0',
	batch: 512,
	ubatch: 512,
	spec: [],
	samplers: [],
	extra: [],
	reasoning_effort_default: 'medium',
	notes: 'The dense baseline.'
};
const version = (n: number, over: Record<string, unknown> = {}) => ({
	version_id: n,
	profile_id: 1,
	version: n,
	created_at: 1794700000 + n * 3600,
	created_by: null,
	note: `note for v${n}`,
	...definition,
	...over
});
const entry = (name: string, over: Record<string, unknown> = {}, profile: Record<string, unknown> = {}) => ({
	profile: { profile_id: name.length, name, display_name: `${name} display`, is_default: false, created_at: 1, archived_at: null, ...profile },
	version: version(2, over)
});

function Host({ initial = true }: { initial?: boolean }) {
	const [open, setOpen] = useState(initial);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open panel
			</button>
			<ProfilesPanel open={open} onOpenChange={setOpen} />
		</>
	);
}

const renderPanel = (url = '/benchmarks/serve') => {
	const router = createMemoryRouter([{ path: '/benchmarks/serve', element: <Host /> }], { initialEntries: [url] });
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
};

describe('ProfilesPanel', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
		vi.mocked(api.listProfiles).mockResolvedValue([
			entry('qwen38', {}, { is_default: true }),
			entry('qwen36', { arch: 'moe', moe: 34 }),
			entry('old', {}, { archived_at: 5 })
		] as never);
		vi.mocked(api.getProfile).mockResolvedValue(entry('qwen38', {}, { is_default: true }) as never);
		vi.mocked(api.listProfileVersions).mockResolvedValue([version(2, { ngl: 22 }), version(1)] as never);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	it('lists each profile with its state, version and model file, and the rest in its menu (#977)', async () => {
		renderPanel();
		const table = await screen.findByRole('region', { name: 'Profiles' });
		expect(within(table).getByText('qwen38')).toBeInTheDocument();
		expect(within(table).getByText('Default')).toBeInTheDocument();
		expect(within(table).getByText('Archived')).toBeInTheDocument();
		expect(within(table).getAllByText('Qwen3.8-27B-UD-Q3_K_XL.gguf')).toHaveLength(3);
		expect(screen.getByRole('button', { name: 'Edit old' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'More actions for qwen36' })).toBeInTheDocument();
	});

	it('archives at once with Undo, and makes a profile the default (ACT-3)', async () => {
		vi.mocked(api.archiveProfile).mockResolvedValue({} as never);
		vi.mocked(api.setDefaultProfile).mockResolvedValue({} as never);
		renderPanel();
		fireEvent.pointerDown(await screen.findByRole('button', { name: 'More actions for qwen36' }), { button: 0 });
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
		await waitFor(() => expect(api.archiveProfile).toHaveBeenCalledWith('test-token', 'qwen36'));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith('qwen36 archived', expect.anything()));
		fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions for qwen36' }), { button: 0 });
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Make default' }));
		await waitFor(() => expect(api.setDefaultProfile).toHaveBeenCalledWith('test-token', 'qwen36'));
	});

	it('shows each version note, record date and what changed (#978)', async () => {
		renderPanel();
		fireEvent.click(await screen.findByRole('button', { name: 'History of qwen38' }));
		expect(await screen.findByText('note for v2')).toBeInTheDocument();
		expect(screen.getByText('note for v1')).toBeInTheDocument();
		expect(screen.getByText('Current')).toBeInTheDocument();
		expect(screen.getByText('Changes from version 1')).toBeInTheDocument();
		expect(screen.getByText('GPU layers:')).toBeInTheDocument();
		expect(screen.getByText('22')).toBeInTheDocument();
		expect(screen.getByText('The first version.')).toBeInTheDocument();
		expect(screen.queryByText('The dense baseline.')).toBeNull();
		fireEvent.click(screen.getAllByRole('button', { name: /Definition/ })[0]);
		expect(await screen.findByText('The dense baseline.')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Back to profiles' }));
		expect(await screen.findByRole('heading', { name: 'Manage profiles' })).toBeInTheDocument();
	});

	it('reopens on the list after closing on another view', async () => {
		renderPanel();
		fireEvent.click(await screen.findByRole('button', { name: 'History of qwen38' }));
		await screen.findByText('note for v2');
		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		fireEvent.click(screen.getByRole('button', { name: 'Open panel' }));
		expect(await screen.findByRole('heading', { name: 'Manage profiles' })).toBeInTheDocument();
	});

	it('edits as a new version, listing the changes before saving (#1052)', async () => {
		vi.mocked(api.addProfileVersion).mockResolvedValue({ version: { version: 3 } } as never);
		renderPanel();
		fireEvent.click(await screen.findByRole('button', { name: 'Edit qwen38' }));
		const dialog = await screen.findByRole('dialog');
		expect(within(dialog).getByRole('heading', { name: 'New version of qwen38' })).toBeInTheDocument();
		expect(within(dialog).getByText('No changes yet. Saving now would repeat the current version.')).toBeInTheDocument();
		const ngl = within(dialog).getByRole('textbox', { name: 'GPU layers' });
		expect((ngl as HTMLInputElement).value).toBe('20');
		fireEvent.change(ngl, { target: { value: '22' } });
		expect(within(dialog).getByText('Changes from v2')).toBeInTheDocument();
		expect(within(dialog).getByText('GPU layers:')).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole('button', { name: 'Save as new version' }));
		await waitFor(() =>
			expect(api.addProfileVersion).toHaveBeenCalledWith('test-token', 'qwen38', {
				definition: expect.objectContaining({ ngl: 22, override_tensors: null, reasoning_effort_default: 'medium' }),
				note: ''
			})
		);
		expect(toast.success).toHaveBeenCalledWith('Version 3 of qwen38 saved');
	});

	it('opens a prefilled new version from a link (B-D8)', async () => {
		renderPanel('/benchmarks/serve?edit=qwen38&def.ngl=22&def.batch=1024&note=From%20pre-screen');
		const ngl = await screen.findByRole('textbox', { name: 'GPU layers' });
		expect((ngl as HTMLInputElement).value).toBe('22');
		expect((screen.getByRole('textbox', { name: 'Batch size' }) as HTMLInputElement).value).toBe('1024');
		expect((screen.getByRole('textbox', { name: /Version note/ }) as HTMLTextAreaElement).value).toBe('From pre-screen');
		expect(screen.getByText('Batch size:')).toBeInTheDocument();
	});

	it('asks before closing an edit with unsaved changes (FRM-3)', async () => {
		renderPanel();
		fireEvent.click(await screen.findByRole('button', { name: 'Edit qwen38' }));
		fireEvent.change(await screen.findByRole('textbox', { name: 'GPU layers' }), { target: { value: '24' } });
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(await screen.findByText('Discard changes?')).toBeInTheDocument();
	});

	it('checks the name when it is left, and puts a refusal under its field (FRM-2, FBK-1)', async () => {
		vi.mocked(api.createProfile).mockRejectedValue("[ERROR: a profile named 'qwen40' already exists]");
		renderPanel();
		fireEvent.click(await screen.findByRole('button', { name: 'Create profile' }));
		const name = await screen.findByRole('textbox', { name: 'Name' });
		fireEvent.change(name, { target: { value: 'Bad Name!' } });
		fireEvent.blur(name);
		expect(
			await screen.findByText('Use 1 to 64 characters: a-z, 0-9, - and _, starting with a letter or digit.')
		).toBeInTheDocument();
		fireEvent.change(name, { target: { value: 'qwen40' } });
		fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Qwen 4' } });
		fireEvent.change(screen.getByRole('textbox', { name: 'Model file' }), { target: { value: '/m/x.gguf' } });
		fireEvent.change(screen.getByRole('textbox', { name: 'Alias' }), { target: { value: 'q4' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));
		await waitFor(() => expect(api.createProfile).toHaveBeenCalled());
		expect(await screen.findByText(/already exists/)).toBeInTheDocument();
		expect(screen.getByRole('textbox', { name: 'Name' }).getAttribute('aria-invalid')).toBe('true');
	});

	it('refuses what the server would: experts on a dense model, -fit, --parallel in the arguments', async () => {
		renderPanel();
		fireEvent.click(await screen.findByRole('button', { name: 'Edit qwen38' }));
		const moe = await screen.findByRole('textbox', { name: /Expert layers on the CPU/ });
		fireEvent.change(moe, { target: { value: '4' } });
		fireEvent.change(screen.getByRole('textbox', { name: /Extra arguments/ }), { target: { value: '-fit on' } });
		fireEvent.change(screen.getByRole('textbox', { name: /Speculative decoding arguments/ }), {
			target: { value: '--parallel 2' }
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
		expect(await screen.findByText('A dense model has no experts to keep on the CPU. Leave this empty.')).toBeInTheDocument();
		expect(screen.getByText('Remove -fit: the launcher always passes -fit off.')).toBeInTheDocument();
		expect(screen.getByText('Set the slot count with Parallel slots, not here.')).toBeInTheDocument();
		expect(api.addProfileVersion).not.toHaveBeenCalled();
	});

	it('clones under a checked name', async () => {
		vi.mocked(api.cloneProfile).mockResolvedValue({} as never);
		renderPanel();
		fireEvent.pointerDown(await screen.findByRole('button', { name: 'More actions for qwen38' }), { button: 0 });
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Clone' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Clone qwen38' }));
		expect(await screen.findByText('Enter a display name for the copy.')).toBeInTheDocument();
		fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'qwen38-b' } });
		fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Copy' } });
		fireEvent.click(screen.getByRole('button', { name: 'Clone qwen38' }));
		await waitFor(() =>
			expect(api.cloneProfile).toHaveBeenCalledWith('test-token', 'qwen38', {
				name: 'qwen38-b',
				display_name: 'Copy',
				note: ''
			})
		);
	});

	it('says when the profiles could not load', async () => {
		vi.mocked(api.listProfiles).mockRejectedValue('database unavailable');
		renderPanel();
		expect(await screen.findByText("Couldn't load profiles")).toBeInTheDocument();
	});
});

describe('fieldOfServerError', () => {
	it('names the field a refusal is about', () => {
		expect(fieldOfServerError("a profile named 'x' already exists")).toBe('name');
		expect(fieldOfServerError("arch must be 'dense' or 'moe'")).toBe('arch');
		expect(fieldOfServerError('--n-cpu-moe is not applicable to a dense model')).toBe('moe');
		expect(fieldOfServerError('another edit of this profile was saved first')).toBeNull();
	});
});
