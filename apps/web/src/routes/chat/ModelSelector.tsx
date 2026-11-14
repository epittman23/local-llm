import { Check, ChevronDown, Minus, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import type { ChatModel } from './useModels';

export const modelImage = (id: string) =>
	`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${encodeURIComponent(id)}`;

/**
 * Ports chat/ModelSelector.svelte and ModelSelector/Selector.svelte: one
 * searchable picker per selected model, "+" to chat with another model side
 * by side (when the user may), "-" to drop one, and "Set as default", which
 * saves the selection to the user's settings. Hidden models are not offered.
 */
export function ModelSelector({
	models,
	selected,
	onChange,
	disabled
}: {
	models: ChatModel[];
	selected: string[];
	onChange: (ids: string[]) => void;
	disabled?: boolean;
}) {
	const user = useAuthStore((s) => s.user);
	const { update } = useUserSettings();
	const multiple =
		user?.role === 'admin' ||
		((user?.permissions as { chat?: { multiple_models?: boolean } } | undefined)?.chat?.multiple_models ?? true);
	const visible = useMemo(() => models.filter((m) => !m.info?.meta?.hidden), [models]);

	return (
		<div className="flex min-w-0 flex-col items-start gap-0.5">
			{selected.map((id, idx) => (
				<div key={idx} className="flex max-w-full items-center gap-1">
					<Picker
						id={idx === 0 ? 'model-selector-model-button' : undefined}
						models={visible}
						value={id}
						disabled={disabled}
						onPick={(pick) => onChange(selected.map((s, i) => (i === idx ? pick : s)))}
					/>
					{idx === 0 && multiple && (
						<Button
							type="button"
							aria-label="Add Model"
							variant="ghost"
							size="icon-xs"
							disabled={disabled}
							onClick={() => onChange([...selected, ''])}
						>
							<Plus className="size-3.5" />
						</Button>
					)}
					{idx > 0 && (
						<Button
							type="button"
							aria-label="Remove Model"
							variant="ghost"
							size="icon-xs"
							disabled={disabled}
							onClick={() => onChange(selected.filter((_, i) => i !== idx))}
						>
							<Minus className="size-3.5" />
						</Button>
					)}
				</div>
			))}
			<Button
				type="button"
				variant="ghost"
				size="xs"
				onClick={() =>
					update({ models: selected }).then(
						() => toast.success('Default model updated'),
						(e) => toast.error(`${e?.message ?? e}`)
					)
				}
			>
				Set as default
			</Button>
		</div>
	);
}

function Picker({
	id,
	models,
	value,
	onPick,
	disabled
}: {
	id?: string;
	models: ChatModel[];
	value: string;
	onPick: (id: string) => void;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const current = models.find((m) => m.id === value);
	const q = query.trim().toLowerCase();
	const shown = q
		? models.filter(
				(m) =>
					m.name.toLowerCase().includes(q) ||
					m.id.toLowerCase().includes(q) ||
					(m.info?.meta?.tags ?? []).some((t) => t.name.toLowerCase().includes(q))
			)
		: models;
	return (
		<Popover
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				if (!o) setQuery('');
			}}
		>
			<PopoverTrigger asChild>
				<Button
					type="button"
					id={id}
					disabled={disabled}
					variant="ghost"
					className="text-title min-w-0"
					aria-label="Select a model"
				>
					<span className="truncate">{current?.name ?? (value ? value : 'Select a model')}</span>
					<ChevronDown className="size-4 shrink-0" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 p-1.5">
				<Input
					autoFocus
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search a model"
					aria-label="Search a model"
					className="mb-1 h-8"
				/>
				<div role="listbox" aria-label="Models" className="max-h-80 overflow-y-auto">
					{shown.length === 0 && <p className="text-muted-foreground px-2 py-3 text-sm">No results found</p>}
					{shown.map((m) => (
						<Button
							key={m.id}
							type="button"
							role="option"
							aria-selected={m.id === value}
							variant="ghost"
							className={cn('w-full justify-start', m.id === value && 'bg-muted')}
							onClick={() => {
								onPick(m.id);
								setOpen(false);
							}}
						>
							<img
								src={modelImage(m.id)}
								alt=""
								className="size-5 rounded-full object-cover"
								onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
							/>
							<span className="min-w-0 flex-1 truncate">{m.name}</span>
							{m.id === value && <Check className="size-3.5" />}
						</Button>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}
