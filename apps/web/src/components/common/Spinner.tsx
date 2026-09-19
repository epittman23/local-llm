import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// Ports common/Spinner.svelte (an SVG with SMIL animation) as lucide's
// Loader2 + Tailwind's animate-spin. `role="status"` so a test or screen
// reader can find it.
export function Spinner({ className }: { className?: string }) {
	return <Loader2 role="status" aria-label="Loading" className={cn('size-5 animate-spin', className)} />;
}
