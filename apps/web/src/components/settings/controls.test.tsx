import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));

import {
	SavedNote,
	SettingField,
	SettingInput,
	SettingNumber,
	SettingRow,
	SettingSelect,
	SettingsDialogHost,
	SettingsForm,
	SettingsPageHost,
	SettingsSection,
	SettingTextarea,
	settingSlug,
	useSavedFlash,
	useSettingErrors,
	useSettingsHost
} from './controls';

afterEach(() => {
	cleanup();
	act(() => useSettingsModalStore.getState().closeSettings());
	vi.useRealTimers();
});

/** An at-once tab whose Toggle starts a save and whose Saved (outside it) ends one. */
function AtOnce({ startSaving = false }: { startSaving?: boolean }) {
	const [saving, setSaving] = useState(startSaving);
	return (
		<>
			<SettingsForm title="Connections" savesAtOnce saving={saving}>
				<button type="button" onClick={() => setSaving(true)}>
					Toggle
				</button>
			</SettingsForm>
			<button type="button" onClick={() => setSaving(false)}>
				Saved
			</button>
		</>
	);
}

describe('SettingsForm (#951, FRM-3)', () => {
	it('on request: the SaveBar, the dirty flag for the modal, and Discard changes', () => {
		const onDiscard = vi.fn();
		const onSubmit = vi.fn();
		const { rerender, unmount } = render(
			<SettingsForm title="General" dirty={false} onDiscard={onDiscard} onSubmit={onSubmit}>
				<p>body</p>
			</SettingsForm>
		);
		expect(screen.getByRole('heading', { name: 'General', level: 2 })).toHaveClass('text-heading');
		expect(screen.getByRole('status')).toHaveTextContent('All changes saved');
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
		expect(useSettingsModalStore.getState().dirty).toBe(false);

		rerender(
			<SettingsForm title="General" dirty onDiscard={onDiscard} onSubmit={onSubmit}>
				<p>body</p>
			</SettingsForm>
		);
		expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
		expect(useSettingsModalStore.getState().dirty).toBe(true);
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(onDiscard).toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSubmit).toHaveBeenCalled();
		unmount();
		expect(useSettingsModalStore.getState().dirty).toBe(false);
	});

	it('busy: Save says so and cannot be pressed twice', () => {
		render(
			<SettingsForm title="Audio" dirty saving onDiscard={() => {}}>
				<p>body</p>
			</SettingsForm>
		);
		const save = screen.getByRole('button', { name: /Saving…/ });
		expect(save).toBeDisabled();
		expect(save).toHaveAttribute('aria-busy', 'true');
	});

	it('at once: no footer, and a line saying changes save as they are made', () => {
		render(
			<SettingsForm title="Interface" savesAtOnce>
				<p>body</p>
			</SettingsForm>
		);
		expect(screen.getByText('Changes are saved as you make them.')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
	});

	it('at once, while saving: says so and holds every control, then gives focus back (ACT-5)', () => {
		render(<AtOnce />);
		const toggle = screen.getByRole('button', { name: 'Toggle' });
		toggle.focus();
		fireEvent.click(toggle);
		expect(screen.getByText('Saving…')).toBeInTheDocument();
		expect(toggle).toBeDisabled();
		expect(toggle.closest('fieldset')).toHaveAttribute('aria-busy', 'true');
		// A browser moves focus off a control that becomes disabled.
		toggle.blur();
		fireEvent.click(screen.getByRole('button', { name: 'Saved' }));
		expect(screen.getByText('Changes are saved as you make them.')).toBeInTheDocument();
		expect(toggle).toBeEnabled();
		expect(document.activeElement).toBe(toggle);
	});

	it('at once: gives focus back even when it was lost before the save rendered (Chromium blurs at once)', () => {
		render(<AtOnce />);
		const toggle = screen.getByRole('button', { name: 'Toggle' });
		toggle.focus();
		toggle.blur();
		fireEvent.click(toggle);
		fireEvent.click(screen.getByRole('button', { name: 'Saved' }));
		expect(document.activeElement).toBe(toggle);
	});

	it('at once: leaves focus alone after a save if it has moved on', () => {
		render(<AtOnce startSaving />);
		const saved = screen.getByRole('button', { name: 'Saved' });
		saved.focus();
		fireEvent.click(saved);
		expect(document.activeElement).toBe(saved);
	});

	it('neither (the admin tabs): a plain Save, as before', () => {
		const onSubmit = vi.fn();
		render(
			<SettingsForm title="Documents" onSubmit={onSubmit}>
				<p>body</p>
			</SettingsForm>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSubmit).toHaveBeenCalled();
		expect(screen.queryByText('All changes saved')).toBeNull();
	});
});

describe('rows and fields (#999, #1001)', () => {
	it('slugs a label for search', () => {
		expect(settingSlug('Speech Playback Speed')).toBe('speech-playback-speed');
		expect(settingSlug('  Auto-Playback Response!')).toBe('auto-playback-response');
	});

	it('puts the description under the label, names the row and section for search, and labels the control', () => {
		render(
			<SettingsSection title="Read aloud">
				<SettingRow label="Speech Playback Speed" description="How fast responses are read.">
					{(id) => <input aria-labelledby={id} />}
				</SettingRow>
				<SettingField label="Language" htmlFor="lang" description="A code such as en.">
					<SettingInput id="lang" />
				</SettingField>
			</SettingsSection>
		);
		expect(screen.getByRole('region', { name: 'Read aloud' })).toHaveAttribute('data-setting', 'read-aloud');
		expect(screen.getByRole('textbox', { name: 'Speech Playback Speed' })).toBeInTheDocument();
		const row = screen.getByText('Speech Playback Speed').closest('[data-setting]');
		expect(row).toHaveAttribute('data-setting', 'speech-playback-speed');
		expect(row).toHaveTextContent('How fast responses are read.');
		const lang = screen.getByRole('textbox', { name: 'Language' });
		expect(lang).toHaveAttribute('data-slot', 'input');
		expect(lang.closest('[data-setting]')).toHaveAttribute('data-setting', 'language');
	});

	it('uses the shared Input and Textarea, and keeps a native select for <option> children', () => {
		const onNumber = vi.fn();
		const onSelect = vi.fn();
		render(
			<>
				<SettingNumber aria-label="Top K" value={5} onChange={onNumber} />
				<SettingTextarea aria-label="Prompt" />
				<SettingSelect aria-label="Speed" value="1" onChange={onSelect}>
					<option value="">Default</option>
					<option value="1">1x</option>
				</SettingSelect>
			</>
		);
		fireEvent.change(screen.getByRole('spinbutton', { name: 'Top K' }), { target: { value: '40' } });
		expect(onNumber).toHaveBeenCalledWith(40);
		fireEvent.change(screen.getByRole('spinbutton', { name: 'Top K' }), { target: { value: '' } });
		expect(onNumber).toHaveBeenLastCalledWith('');
		expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveAttribute('data-slot', 'textarea');
		fireEvent.change(screen.getByRole('combobox', { name: 'Speed' }), { target: { value: '' } });
		expect(onSelect).toHaveBeenCalledWith('');
	});
});

function Flasher() {
	const { isSaved, flash } = useSavedFlash(1000);
	return (
		<>
			<button type="button" onClick={() => flash(['memory'])}>
				save
			</button>
			{isSaved('memory') && <SavedNote />}
		</>
	);
}

describe('SavedNote and useSavedFlash (FRM-3 at once)', () => {
	it('shows Saved beside the setting that saved, then lets it go', () => {
		vi.useFakeTimers();
		render(<Flasher />);
		expect(screen.queryByText('Saved')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'save' }));
		expect(screen.getByRole('status')).toHaveTextContent('Saved');
		act(() => vi.advanceTimersByTime(1001));
		expect(screen.queryByText('Saved')).toBeNull();
	});
});

/** A tab with one field, saved on request: dirty while the field differs from what was saved. */
function DraftTab() {
	const [value, setValue] = useState('');
	const host = useSettingsHost();
	return (
		<SettingsForm title="General" dirty={value !== ''} onDiscard={() => setValue('')}>
			<p>host: {String(host.kind)}</p>
			<label>
				Name
				<input value={value} onChange={(e) => setValue(e.target.value)} />
			</label>
		</SettingsForm>
	);
}

describe('settings hosts (#951, FRM-3)', () => {
	it('outside any host the tab reports to the dialog store, with no kind', () => {
		render(<DraftTab />);
		expect(screen.getByText('host: null')).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
		expect(useSettingsModalStore.getState().dirty).toBe(true);
	});

	it('in the dialog host the tab reports to the dialog store', () => {
		const { unmount } = render(
			<SettingsDialogHost>
				<DraftTab />
			</SettingsDialogHost>
		);
		expect(screen.getByText('host: dialog')).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
		expect(useSettingsModalStore.getState().dirty).toBe(true);
		unmount();
		expect(useSettingsModalStore.getState().dirty).toBe(false);
	});

	it('on a page the one page guard asks once before another tab, and never touches the dialog store', async () => {
		const router = createMemoryRouter(
			[
				{
					path: '/admin/settings/:tab',
					element: (
						<SettingsPageHost>
							<Link to="/admin/settings/audio">Audio</Link>
							<DraftTab />
						</SettingsPageHost>
					)
				},
				{ path: '/elsewhere', element: <p>Elsewhere</p> }
			],
			{ initialEntries: ['/admin/settings/general'] }
		);
		render(<RouterProvider router={router} />);
		expect(screen.getByText('host: page')).toBeInTheDocument();
		// Clean: a tab change goes straight through.
		fireEvent.click(screen.getByRole('link', { name: 'Audio' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/admin/settings/audio'));
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
		expect(useSettingsModalStore.getState().dirty).toBe(false);
		await act(() => router.navigate('/admin/settings/general'));
		expect(await screen.findAllByRole('alertdialog')).toHaveLength(1);
		expect(screen.getByText('This tab has changes that are not saved. They are lost if you leave it.')).toBeVisible();
		expect(router.state.location.pathname).toBe('/admin/settings/audio');
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/admin/settings/general'));
	});

	it('on a page, saving clears the guard: a clean tab leaves without asking', async () => {
		const router = createMemoryRouter(
			[
				{
					path: '/a',
					element: (
						<SettingsPageHost>
							<DraftTab />
						</SettingsPageHost>
					)
				},
				{ path: '/b', element: <p>Page B</p> }
			],
			{ initialEntries: ['/a'] }
		);
		render(<RouterProvider router={router} />);
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
		fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } });
		await act(() => router.navigate('/b'));
		expect(await screen.findByText('Page B')).toBeInTheDocument();
		expect(screen.queryByRole('alertdialog')).toBeNull();
	});
});

/**
 * A tab checked on Save (FRM-2): Name must not be blank; Size is a number in a
 * row; Extra's field is shown only while `Show extra` is ticked.
 */
function Checked({ onSave }: { onSave: () => void }) {
	const [name, setName] = useState('');
	const [size, setSize] = useState<number | ''>(1);
	const [extra, setExtra] = useState(false);
	const problems: Record<string, string> = {};
	if (!name.trim()) problems.name = 'Enter a name.';
	if (size !== '' && size < 1) problems.size = 'Size must be at least 1.';
	if (!extra) problems.extra = 'Extra is wrong.';
	const { errors, check, reset } = useSettingErrors(problems);
	return (
		<SettingsForm
			title="Checked"
			dirty
			errors={errors}
			onDiscard={reset}
			onSubmit={() => {
				if (check()) onSave();
			}}
		>
			<SettingField label="Name" description="What to call it." descriptionId="name-help" htmlFor="name">
				<SettingInput id="name" aria-describedby="name-help" value={name} onChange={(e) => setName(e.target.value)} />
			</SettingField>
			<SettingRow label="Size" fieldId="size">
				<SettingNumber id="size" aria-label="Size" value={size} onChange={setSize} />
			</SettingRow>
			<label>
				<input type="checkbox" checked={extra} onChange={(e) => setExtra(e.target.checked)} />
				Show extra
			</label>
			<button type="button" onClick={() => check({ extra: 'Extra is wrong.' })}>
				Check extra
			</button>
		</SettingsForm>
	);
}

describe('field errors on Save (FRM-2)', () => {
	it('shows nothing before Save, then each error under its field, and focuses the first', async () => {
		vi.useFakeTimers();
		const onSave = vi.fn();
		render(<Checked onSave={onSave} />);
		const name = screen.getByLabelText('Name');
		expect(name).not.toHaveAttribute('aria-invalid');
		expect(name).toHaveAttribute('aria-describedby', 'name-help');
		expect(screen.getByText('What to call it.')).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText('Size'), { target: { value: '0' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSave).not.toHaveBeenCalled();
		// The error replaces the help, and the field names it.
		expect(name).toHaveAttribute('aria-invalid', 'true');
		expect(name).toHaveAccessibleDescription('Enter a name.');
		expect(screen.queryByText('What to call it.')).toBeNull();
		const size = screen.getByLabelText('Size');
		expect(size).toHaveAttribute('aria-invalid', 'true');
		expect(size).toHaveAccessibleDescription('Size must be at least 1.');
		act(() => vi.runAllTimers());
		expect(name).toHaveFocus();
		expect(toastError).not.toHaveBeenCalled();

		// Put right, an error goes at once; the rest stay.
		fireEvent.change(name, { target: { value: 'Ada' } });
		expect(name).not.toHaveAttribute('aria-invalid');
		expect(name).toHaveAttribute('aria-describedby', 'name-help');
		expect(size).toHaveAttribute('aria-invalid', 'true');
	});

	it('says a wrong field that is not on the page in a toast, and saves once all is right', () => {
		vi.useFakeTimers();
		toastError.mockReset();
		const onSave = vi.fn();
		render(<Checked onSave={onSave} />);
		fireEvent.click(screen.getByRole('button', { name: 'Check extra' }));
		act(() => vi.runAllTimers());
		expect(toastError).toHaveBeenCalledWith('Extra is wrong.');

		fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } });
		fireEvent.click(screen.getByLabelText('Show extra'));
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSave).toHaveBeenCalledOnce();
	});

	it('Discard changes stops showing them', () => {
		render(<Checked onSave={() => {}} />);
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
	});
});
