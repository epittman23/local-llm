import { ChevronDown, FileDown, FileUp, Link2, Pencil } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import type { WorkspaceAction } from '@/lib/stores/workspaceStore';
import { cn } from '@/lib/utils';

// Ports common/SplitCreateButton.svelte. The primary click runs the action
// whose id ends in `-new` (or, failing that, the first visible one); the
// chevron opens the rest. With exactly one action there is no menu at all.
// Icons are picked from the action id's suffix, same convention as the Svelte
// version, so a section only has to name its actions consistently.
function actionIcon(id: string) {
	if (id.endsWith('-new')) return Pencil;
	if (id.includes('-import-link')) return Link2;
	if (id.includes('-import')) return FileUp;
	if (id.includes('-export')) return FileDown;
	return Pencil;
}

/**
 * `filled` draws it as the page's one filled brand button (ACT-1), for a page
 * whose main action it is (Notes); otherwise it is the quiet outlined pair.
 */
export function SplitCreateButton({
	actions,
	label = 'Create',
	filled = false
}: {
	actions: WorkspaceAction[];
	label?: string;
	filled?: boolean;
}) {
	const navigate = useNavigate();
	const visible = actions.filter((action) => action.visible ?? true);
	const primary = visible.find((action) => action.id.endsWith('-new')) ?? visible[0] ?? null;

	const run = async (action: WorkspaceAction | null) => {
		if (!action) return;
		if (action.href) navigate(action.href);
		else await action.onClick?.();
	};

	if (visible.length === 0) return null;
	const variant = filled ? 'default' : 'ghost';
	const frame = cn('flex overflow-hidden rounded-lg', !filled && 'border');

	// LAY-1, #1011: one action is drawn in the same frame as several, so the header keeps its height between sections.
	if (visible.length === 1) {
		return (
			<div className={frame}>
				<Button
					variant={variant}
					size={filled ? 'default' : 'sm'}
					className="rounded-none"
					onClick={() => run(primary)}
				>
					{label}
				</Button>
			</div>
		);
	}

	return (
		<div className={frame}>
			<Button variant={variant} size={filled ? 'default' : 'sm'} className="rounded-none" onClick={() => run(primary)}>
				{label}
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant={variant}
						size={filled ? 'icon' : 'icon-sm'}
						className={cn('rounded-none border-l', filled && 'border-background')}
						aria-label="Open create menu"
					>
						<ChevronDown />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-40">
					{visible.map((action) => {
						const Icon = actionIcon(action.id);
						return (
							<DropdownMenuItem key={action.id} onSelect={() => run(action)}>
								<Icon />
								<span className="truncate">{action.label}</span>
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
