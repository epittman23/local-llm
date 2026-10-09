import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type Variable = {
	type?: string;
	options?: string[];
	placeholder?: string;
	default?: unknown;
	required?: boolean;
	[k: string]: unknown;
};

/**
 * Ports MessageInput/InputVariablesModal.svelte: a form for the `{{name}}`
 * variables in a prompt from the `/` command, one field per variable in the
 * type it declares (select, checkbox, textarea, or a native input type such
 * as date, number or color), prefilled with any default.
 */
export function InputVariablesDialog({
	variables,
	onSubmit,
	onCancel
}: {
	variables: Record<string, Variable> | null;
	onSubmit: (values: Record<string, unknown>) => void;
	onCancel: () => void;
}) {
	const [values, setValues] = useState<Record<string, unknown>>({});
	useEffect(() => {
		if (!variables) return;
		setValues(
			Object.fromEntries(
				Object.entries(variables).map(([k, v]) => [k, v.default ?? (v.type === 'checkbox' ? false : '')])
			)
		);
	}, [variables]);
	if (!variables) return null;
	const set = (k: string, v: unknown) => setValues((cur) => ({ ...cur, [k]: v }));
	return (
		<Dialog open onOpenChange={(o) => !o && onCancel()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Input Variables</DialogTitle>
					<DialogDescription className="sr-only">Fill in the prompt's variables</DialogDescription>
				</DialogHeader>
				<form
					className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto"
					onSubmit={(e) => {
						e.preventDefault();
						onSubmit(values);
					}}
				>
					{Object.entries(variables).map(([name, v]) => {
						const id = `var-${name}`;
						return (
							<div key={name} className="flex flex-col gap-1.5">
								<Label htmlFor={id}>{name}</Label>
								{v.type === 'select' ? (
									<select
										id={id}
										className="border-input h-9 rounded-md border bg-transparent px-2 text-sm"
										value={String(values[name] ?? '')}
										onChange={(e) => set(name, e.target.value)}
									>
										<option value="">{v.placeholder ?? 'Select an option'}</option>
										{(v.options ?? []).map((o) => (
											<option key={o} value={o}>
												{o}
											</option>
										))}
									</select>
								) : v.type === 'checkbox' ? (
									<input
										id={id}
										type="checkbox"
										checked={Boolean(values[name])}
										onChange={(e) => set(name, e.target.checked)}
										className="size-4"
									/>
								) : v.type === 'textarea' ? (
									<Textarea
										id={id}
										placeholder={v.placeholder}
										required={v.required}
										value={String(values[name] ?? '')}
										onChange={(e) => set(name, e.target.value)}
									/>
								) : (
									<Input
										id={id}
										type={v.type && v.type !== 'text' ? v.type : 'text'}
										placeholder={v.placeholder}
										required={v.required}
										value={String(values[name] ?? '')}
										onChange={(e) => set(name, e.target.value)}
									/>
								)}
							</div>
						);
					})}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onCancel}>
							Cancel
						</Button>
						<Button type="submit">Save</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
