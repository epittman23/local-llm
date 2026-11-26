import { type ReactElement, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { toastFailure } from '@/components/common/failureToast';
import { writeBackOutput } from '@/lib/apis/sandbox';
import { useAuthStore } from '@/lib/stores/authStore';

export const SAVED_TO_WORKSPACE = 'Saved to the workspace. The model sees it the next time it reads the file.';
export const WORKSPACE_BUSY = 'The workspace is busy. Try again when the reply has finished.';

/** The words of the dialog the server's `changed` answer opens (WRD-1); `/ui` shows the same ones. */
export const workspaceDialog = (missing: boolean) =>
	missing
		? {
				title: 'Create the workspace file?',
				body: 'The file is no longer in the workspace. Create it with this version?',
				confirm: 'Create'
			}
		: {
				title: 'Replace the workspace file?',
				body: 'The file in the workspace changed after this version. Replace it with this version?',
				confirm: 'Replace'
			};

export type WriteBack = {
	/** Writes the saved version `id` over its file in the workspace; a `changed` answer asks first (the dialog). */
	run: (id: string) => Promise<void>;
	/** A request is in flight: the action is not offered again until it ends. */
	pending: boolean;
	/** Render this once, beside the panel. */
	dialog: ReactElement;
};

/**
 * Saving a version of a sandbox output back to its workspace file
 * (POST /sandbox/outputs/{id}/write-back, CNV-6, docs/guides/sandbox.md
 * "Writing an edit back"). One request at a time: a second press while one is
 * in flight does nothing. The server answers `changed` when the workspace file
 * is not one this document held (or is gone, `missing`); the dialog then asks
 * before it repeats the request with `force`. A busy workspace and any failure
 * are toasts (FBK-4); a failure leaves nothing changed, so it can be tried again.
 */
export function useWriteBack(): WriteBack {
	const token = useAuthStore((s) => s.token) ?? '';
	const [pending, setPending] = useState(false);
	const [asking, setAsking] = useState<{ id: string; missing: boolean } | null>(null);
	const busy = useRef(false);

	const send = async (id: string, force: boolean) => {
		if (busy.current) return;
		busy.current = true;
		setPending(true);
		try {
			const result = await writeBackOutput(token, id, force);
			if (result.status === 'written') toast.success(SAVED_TO_WORKSPACE);
			else if (result.status === 'busy') toast.error(WORKSPACE_BUSY);
			else setAsking({ id, missing: result.missing });
		} catch (error) {
			toastFailure('Could not save to the workspace. Try again.', error);
		} finally {
			busy.current = false;
			setPending(false);
		}
	};

	const words = workspaceDialog(asking?.missing === true);
	const dialog = (
		<ConfirmDialog
			open={asking !== null}
			onOpenChange={(open) => {
				if (!open) setAsking(null);
			}}
			title={words.title}
			confirmLabel={words.confirm}
			onConfirm={() => {
				const id = asking?.id;
				setAsking(null);
				if (id) void send(id, true);
			}}
		>
			<p>{words.body}</p>
		</ConfirmDialog>
	);

	return { run: (id) => send(id, false), pending, dialog };
}
