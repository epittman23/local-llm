import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { ServerDialog } from './useChatSession';

type Question = { id: string; header?: string; question: string; options?: { label: string; description?: string }[]; allow_other?: boolean };
type Answer = { type: 'option'; option_index: number; label: string; description?: string } | { type: 'other'; text: string };

/**
 * What a function or tool on the server can ask of the user mid-reply
 * (Chat.svelte's EventConfirmDialog, the `execute` event, and AskUserCard):
 * a yes/no confirmation, a value (text, password or a choice), or a set of
 * questions. Each answer goes back through the socket event's callback;
 * dismissing sends `false` (or "cancelled" for questions), as before.
 *
 * `execute` runs JavaScript the server sent, as the Svelte app does: it is how
 * an admin-installed function reads something from the browser. It is only
 * ever triggered by the server this app is signed in to.
 */
const dialogKeys = new WeakMap<ServerDialog, number>();
let nextDialogKey = 0;
const dialogKey = (d: ServerDialog) => {
	if (!dialogKeys.has(d)) dialogKeys.set(d, nextDialogKey++);
	return dialogKeys.get(d)!;
};

export function ServerDialogs({ dialog, onClose }: { dialog: ServerDialog | null; onClose: () => void }) {
	const ran = useRef<ServerDialog | null>(null);
	useEffect(() => {
		if (dialog?.type !== 'execute' || ran.current === dialog) return;
		ran.current = dialog;
		(async () => {
			try {
				const fn = new Function(`return (async () => { ${dialog.data?.code ?? ''} })()`);
				dialog.reply(await fn());
			} catch (e) {
				console.error('Error executing code:', e);
			}
			onClose();
		})();
	}, [dialog, onClose]);

	if (!dialog || dialog.type === 'execute') return null;
	// Keyed by the dialog itself: a replacement dialog starts with fresh input state.
	const key = dialogKey(dialog);
	if (dialog.type === 'ask_user') return <AskUserDialog key={key} dialog={dialog} onClose={onClose} />;
	return <ConfirmOrInput key={key} dialog={dialog} onClose={onClose} />;
}

function ConfirmOrInput({ dialog, onClose }: { dialog: ServerDialog; onClose: () => void }) {
	const d = dialog.data ?? {};
	const isInput = dialog.type === 'input';
	const inputType: string = d.input?.type ?? d.type ?? '';
	const options: ({ label?: string; value: string } | string)[] = d.input?.options ?? d.options ?? [];
	const [value, setValue] = useState<string>(d.value ?? '');
	const finish = (v: unknown) => {
		dialog.reply(v);
		onClose();
	};
	return (
		<Dialog open onOpenChange={(o) => !o && finish(false)}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{d.title ?? 'Confirm your action'}</DialogTitle>
					<DialogDescription className="whitespace-pre-wrap">{d.message ?? 'Are you sure?'}</DialogDescription>
				</DialogHeader>
				{isInput &&
					(inputType === 'password' ? (
						<Input type="password" autoFocus aria-label={d.placeholder || 'Enter your message'} placeholder={d.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
					) : inputType === 'select' && options.length ? (
						<select aria-label={d.placeholder || 'Select an option'} className="border-input h-9 rounded-md border bg-transparent px-2 text-sm" value={value} onChange={(e) => setValue(e.target.value)}>
							<option value="">{d.placeholder || 'Select an option'}</option>
							{options.map((o) => {
								const opt = typeof o === 'string' ? { value: o, label: o } : o;
								return (
									<option key={opt.value} value={opt.value}>
										{opt.label ?? opt.value}
									</option>
								);
							})}
						</select>
					) : (
						<Textarea autoFocus aria-label={d.placeholder || 'Enter your message'} placeholder={d.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
					))}
				<DialogFooter>
					<Button variant="outline" onClick={() => finish(false)}>
						Cancel
					</Button>
					<Button onClick={() => finish(isInput ? value : true)}>Confirm</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function AskUserDialog({ dialog, onClose }: { dialog: ServerDialog; onClose: () => void }) {
	const questions: Question[] = dialog.data?.questions ?? [];
	const allowOther: boolean = dialog.data?.allow_other ?? true;
	const timeoutMs: number | null = typeof dialog.data?.timeout_ms === 'number' && dialog.data.timeout_ms > 0 ? dialog.data.timeout_ms : null;
	const [answers, setAnswers] = useState<Record<string, Answer>>({});
	const finish = (v: unknown) => {
		dialog.reply(v);
		onClose();
	};
	useEffect(() => {
		if (!timeoutMs) return;
		const t = setTimeout(() => finish({ status: 'timed_out', answers: {} }), timeoutMs);
		return () => clearTimeout(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [timeoutMs]);
	const complete = questions.length > 0 && questions.every((q) => answers[q.id]?.type === 'option' || (answers[q.id]?.type === 'other' && (answers[q.id] as { text: string }).text.trim() !== ''));
	return (
		<Dialog open onOpenChange={(o) => !o && finish({ status: 'cancelled', answers: {} })}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Input needed</DialogTitle>
					<DialogDescription className="sr-only">Answer the questions to continue</DialogDescription>
				</DialogHeader>
				<div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
					{questions.map((q) => (
						<fieldset key={q.id} className="flex flex-col gap-1.5">
							{q.header && <legend className="text-muted-foreground text-xs">{q.header}</legend>}
							<p className="text-sm font-medium">{q.question}</p>
							{(q.options ?? []).map((o, i) => {
								const picked = answers[q.id]?.type === 'option' && (answers[q.id] as { option_index: number }).option_index === i;
								return (
									<button
										key={i}
										type="button"
										aria-pressed={picked}
										className={cn('hover:bg-muted rounded-xl border px-3 py-2 text-left text-sm', picked && 'border-foreground/50 bg-muted')}
										onClick={() => setAnswers((a) => ({ ...a, [q.id]: { type: 'option', option_index: i, label: o.label, description: o.description ?? '' } }))}
									>
										<div>{o.label}</div>
										{o.description && <div className="text-muted-foreground text-xs">{o.description}</div>}
									</button>
								);
							})}
							{(q.allow_other ?? allowOther) && (
								<Input
									aria-label={`Other answer for ${q.question}`}
									placeholder="Other..."
									value={answers[q.id]?.type === 'other' ? (answers[q.id] as { text: string }).text : ''}
									onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: { type: 'other', text: e.target.value } }))}
								/>
							)}
						</fieldset>
					))}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => finish({ status: 'cancelled', answers: {} })}>
						Skip
					</Button>
					<Button
						disabled={!complete}
						onClick={() => {
							const normalized: Record<string, Answer> = {};
							for (const q of questions) {
								const a = answers[q.id];
								normalized[q.id] = a.type === 'other' ? { type: 'other', text: a.text.trim() } : a;
							}
							finish({ status: 'answered', answers: normalized });
						}}
					>
						Submit answers
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
