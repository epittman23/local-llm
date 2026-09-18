import { Button } from '@/components/ui/button';

/**
 * The persistent React root Astro mounts once (see src/pages/index.astro).
 * Placeholder for Phase 3: proves the Astro + React + shadcn/ui + Tailwind
 * wiring end to end. Routing (react-router), auth, and the real app shell
 * are Phase 4.
 */
export default function App() {
	return (
		<main className="flex min-h-svh flex-col items-center justify-center gap-4">
			<h1 className="text-2xl font-semibold">local-llm</h1>
			<Button>Astro + React + shadcn/ui</Button>
		</main>
	);
}
