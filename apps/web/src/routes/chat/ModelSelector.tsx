import { Check, ChevronDown, Minus, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import type { ChatModel } from './useModels';

export const modelImage = (id: string) => `${WEBUI_API_BASE_URL}/models/model/profile/image?id=${encodeURIComponent(id)}`;

/**
 * Ports chat/ModelSelector.svelte and ModelSelector/Selector.svelte: one
 * searchable picker per selected model, "+" to chat with another model side
 * by side (when the user may), "-" to drop one, and "Set as default", which
 * saves the selection to the user's settings. Hidden models are not offered.
 */
export function ModelSelector({ models, selected, onChange, disabled }: { models: ChatModel[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
	const user = useAuthStore((s) => s.user);
	const { update } = useUserSettings();
	const multiple = user?.role === 'admin' || ((user?.permissions as { chat?: { multiple_models?: boolean } } | undefined)?.chat?.multiple_models ?? true);
	const visible = useMemo(() => models.filter((m) => !m.info?.meta?.hidden), [models]);

	return (
		<div className="flex min-w-0 flex-col items-start gap-0.5">
			{selected.map((id, idx) => (
				<div key={idx} className="flex max-w-full items-center gap-1">
					<Picker id={idx === 0 ? 'model-selector-model-button' : undefined} models={visible} value={id} disabled={disabled} onPick={(pick) => onChange(selected.map((s, i) => (i === idx ? pick : s)))} />
					{idx === 0 && multiple && (
						<button type="button" aria-label="Add Model" className="text-muted-foreground hover:text-foreground p-1" disabled={disabled} onClick={() => onChange([...selected, ''])}>
							<Plus className="size-3.5" />
						</button>
					)}
					{idx > 0 && (
						<button type="button" aria-label="Remove Model" className="text-muted-foreground hover:text-foreground p-1" disabled={disabled} onClick={() => onChange(selected.filter((_, i) => i !== idx))}>
							<Minus className="size-3.5" />
						</button>
					)}
				</div>
			))}
			<button
				type="button"
				className="text-muted-foreground hover:text-foreground px-1 text-xs"
				onClick={async () => {
					await update({ models: selected });
					toast.success('Default model updated');
				}}
			>
				Set as default
			</button>
		</div>
	);
}

function Picker({ id, models, value, onPick, disabled }: { id?: string; models: ChatModel[]; value: string; onPick: (id: string) => void; disabled?: boolean }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const current = models.find((m) => m.id === value);
	const q = query.trim().toLowerCase();
	const shown = q ? models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || (m.info?.meta?.tags ?? []).some((t) => t.name.toLowerCase().includes(q))) : models;
	return (
		<Popover
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				if (!o) setQuery('');
			}}
		>
			<PopoverTrigger asChild>
				<button type="button" id={id} disabled={disabled} className="flex min-w-0 items-center gap-1 text-lg font-medium" aria-label="Select a model">
					<span className="truncate">{current?.name ?? (value ? value : 'Select a model')}</span>
					<ChevronDown className="size-4 shrink-0" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 p-1.5">
				<Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a model" aria-label="Search a model" className="mb-1 h-8" />
				<div role="listbox" aria-label="Models" className="max-h-80 overflow-y-auto">
					{shown.length === 0 && <p className="text-muted-foreground px-2 py-3 text-sm">No results found</p>}
					{shown.map((m) => (
						<button
							key={m.id}
							type="button"
							role="option"
							aria-selected={m.id === value}
							className={cn('hover:bg-muted flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm', m.id === value && 'bg-muted')}
							onClick={() => {
								onPick(m.id);
								setOpen(false);
							}}
						>
							<img src={modelImage(m.id)} alt="" className="size-5 rounded-full object-cover" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
							<span className="min-w-0 flex-1 truncate">{m.name}</span>
							{m.id === value && <Check className="size-3.5" />}
						</button>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}
