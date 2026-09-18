import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
	checkServe,
	getServeProfile,
	getServeProfiles,
	parseBenchmarksEventStream,
	startServe,
	stopServe,
	streamServe,
	type ServeStartForm
} from '@/lib/apis/benchmarks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from '@/components/ui/select';
import { useAuthStore } from '@/lib/stores/authStore';
import { ProfilesPanel } from './ProfilesPanel';

const CHECK_POLL_MS = 5000;

const reasoningOptions = [
	{ value: 'default', label: 'Default' },
	{ value: 'low', label: 'low' },
	{ value: 'medium', label: 'medium' },
	{ value: 'high', label: 'high' }
];

const specOptions = [
	{ value: 'default', label: 'Default' },
	{ value: 'on', label: 'on' },
	{ value: 'off', label: 'off' }
];

/**
 * Ports apps/openwebui/src/lib/components/benchmarks/Serve.svelte: the
 * profile picker, the overrides form, start/stop/check, and the live log
 * stream (SSE via parseBenchmarksEventStream, unchanged). The health check
 * is a TanStack Query poll (`refetchInterval`) instead of Svelte's own
 * `setInterval` -- same 5s cadence, but reusing the query cache means
 * useMutation's own onSuccess can just invalidate it instead of a
 * hand-written refreshRunning().
 *
 * "download weights" (one of Phase 5's checklist items, docs/migration-
 * plan.md) is NOT here: there is no backend endpoint for it yet (grepped
 * routers/benchmarks/*.py directly -- weights.py/FetchProcess exist per
 * Phase 2a but nothing mounts them at an HTTP route). docs/model-
 * downloads.md remains the documented interim path until that exists.
 */
export function ServePage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const queryClient = useQueryClient();

	const [selectedProfile, setSelectedProfile] = useState('');
	const [ngl, setNgl] = useState('');
	const [ctx, setCtx] = useState('');
	const [threads, setThreads] = useState('');
	const [parallel, setParallel] = useState('');
	const [ot, setOt] = useState('');
	const [reasoning, setReasoning] = useState('default');
	const [spec, setSpec] = useState('default');
	const [error, setError] = useState<string | null>(null);
	const [profilesPanelOpen, setProfilesPanelOpen] = useState(false);

	const profilesQuery = useQuery({
		queryKey: ['serve-profiles'],
		queryFn: () => getServeProfiles(token),
		enabled: !!token
	});
	const profiles: string[] = profilesQuery.data?.profiles ?? [];

	const profileDetailsQuery = useQuery({
		queryKey: ['serve-profile', selectedProfile],
		queryFn: () => getServeProfile(token, selectedProfile),
		enabled: !!token && !!selectedProfile
	});

	const checkQuery = useQuery({
		queryKey: ['serve-check'],
		queryFn: () => checkServe(token),
		enabled: !!token,
		refetchInterval: CHECK_POLL_MS
	});
	const running = checkQuery.data?.running ?? null;

	// -------------------------------------------------------------------
	// Log stream (SSE) -- not TanStack Query's concern, it's a long-lived
	// connection rather than a request/response the cache can model.
	// -------------------------------------------------------------------
	const [logLines, setLogLines] = useState<string[]>([]);
	const [streaming, setStreaming] = useState(false);
	const abortControllerRef = useRef<AbortController | null>(null);
	const logContainerRef = useRef<HTMLDivElement | null>(null);

	const stopLogStream = () => {
		abortControllerRef.current?.abort();
		abortControllerRef.current = null;
		setStreaming(false);
	};

	const startLogStream = async () => {
		stopLogStream();
		setLogLines([]);
		setStreaming(true);

		const [res, controller] = await streamServe(token);
		abortControllerRef.current = controller;

		if (!res?.body) {
			setStreaming(false);
			return;
		}

		try {
			for await (const { event, data } of parseBenchmarksEventStream<{ line: string }>(
				res.body
			)) {
				if (event === 'done') break;
				if (data?.line !== undefined) {
					setLogLines((lines) => [...lines, data.line]);
				}
			}
		} catch (err) {
			// Aborted or connection closed -- not necessarily an error worth surfacing.
			console.error(err);
		}
		setStreaming(false);
	};

	useEffect(() => {
		if (logContainerRef.current) {
			logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
		}
	}, [logLines]);

	// Reconnects the log stream whenever a server turns out to be running but
	// nothing here is tailing it -- the common case being this page having
	// just (re)mounted, which resets `streaming`/`logLines` even though the
	// server itself, and the backend's buffered log history, are unaffected.
	// Ports Serve.svelte's own refreshRunning() comment on this exactly.
	useEffect(() => {
		if (running === true && !streaming) {
			void startLogStream();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [running]);

	useEffect(() => stopLogStream, []);

	const startMutation = useMutation({
		mutationFn: async () => {
			const form: ServeStartForm = {};
			if (selectedProfile) form.profile = selectedProfile;
			if (ngl.trim()) form.ngl = Number(ngl);
			if (ctx.trim()) form.ctx = Number(ctx);
			if (threads.trim()) form.threads = Number(threads);
			if (parallel.trim()) form.parallel = Number(parallel);
			if (ot.trim()) form.ot = ot.trim();
			if (reasoning !== 'default') form.reasoning = reasoning;
			if (spec !== 'default') form.spec = spec;
			return startServe(token, form);
		},
		onMutate: () => setError(null),
		onSuccess: async () => {
			await startLogStream();
			await queryClient.invalidateQueries({ queryKey: ['serve-check'] });
		},
		onError: (err: any) => setError(err?.detail ?? String(err))
	});

	const stopMutation = useMutation({
		mutationFn: () => stopServe(token),
		onMutate: () => setError(null),
		onSuccess: async () => {
			stopLogStream();
			await queryClient.invalidateQueries({ queryKey: ['serve-check'] });
		},
		onError: (err: any) => setError(err?.detail ?? String(err))
	});

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<h2 className="text-lg font-medium">Serve</h2>
				<Button variant="outline" size="sm" onClick={() => setProfilesPanelOpen(true)}>
					Manage profiles
				</Button>
			</div>

			{error && (
				<div className="border-destructive/20 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-xs">
					{error}
				</div>
			)}

			<div className="grid gap-4 md:grid-cols-2">
				<div className="flex flex-col gap-2">
					<Label>Profile</Label>
					<Select value={selectedProfile} onValueChange={setSelectedProfile}>
						<SelectTrigger className="w-full">
							<SelectValue placeholder="Select a profile" />
						</SelectTrigger>
						<SelectContent>
							{profiles.map((name) => (
								<SelectItem key={name} value={name}>
									{name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>

					{profileDetailsQuery.data && (
						<div className="max-h-64 overflow-y-auto rounded-lg border p-2.5 text-xs">
							{Object.entries(profileDetailsQuery.data).map(([key, value]) => (
								<div key={key} className="flex justify-between gap-2 py-0.5">
									<span className="text-muted-foreground">{key}</span>
									<span className="text-right break-all">
										{typeof value === 'object' ? JSON.stringify(value) : String(value)}
									</span>
								</div>
							))}
						</div>
					)}
				</div>

				<div className="flex flex-col gap-2">
					<Label>Overrides</Label>
					<div className="grid grid-cols-2 gap-2">
						<div className="flex flex-col gap-1">
							<Label htmlFor="serve-ngl" className="text-muted-foreground text-xs font-normal">
								ngl
							</Label>
							<Input
								id="serve-ngl"
								type="number"
								min={0}
								step={1}
								value={ngl}
								onChange={(e) => setNgl(e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="serve-ctx" className="text-muted-foreground text-xs font-normal">
								ctx
							</Label>
							<Input
								id="serve-ctx"
								type="number"
								min={1}
								step={1}
								value={ctx}
								onChange={(e) => setCtx(e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="serve-threads" className="text-muted-foreground text-xs font-normal">
								threads
							</Label>
							<Input
								id="serve-threads"
								type="number"
								min={1}
								step={1}
								value={threads}
								onChange={(e) => setThreads(e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="serve-parallel" className="text-muted-foreground text-xs font-normal">
								parallel
							</Label>
							<Input
								id="serve-parallel"
								type="number"
								min={1}
								step={1}
								value={parallel}
								onChange={(e) => setParallel(e.target.value)}
							/>
						</div>
						<div className="col-span-2 flex flex-col gap-1">
							<Label htmlFor="serve-ot" className="text-muted-foreground text-xs font-normal">
								ot
							</Label>
							<Input
								id="serve-ot"
								type="text"
								placeholder="--ot"
								value={ot}
								onChange={(e) => setOt(e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label className="text-muted-foreground text-xs font-normal">Reasoning effort</Label>
							<Select value={reasoning} onValueChange={setReasoning}>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{reasoningOptions.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1">
							<Label className="text-muted-foreground text-xs font-normal">
								Speculative decoding
							</Label>
							<Select value={spec} onValueChange={setSpec}>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{specOptions.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
				</div>
			</div>

			<div className="flex items-center gap-2">
				<Button
					onClick={() => startMutation.mutate()}
					disabled={startMutation.isPending || running === true}
				>
					{startMutation.isPending ? 'Starting…' : 'Start'}
				</Button>
				<Button
					variant="secondary"
					onClick={() => stopMutation.mutate()}
					disabled={stopMutation.isPending || running !== true}
				>
					{stopMutation.isPending ? 'Stopping…' : 'Stop'}
				</Button>
				<Button variant="secondary" onClick={() => checkQuery.refetch()} disabled={checkQuery.isFetching}>
					{checkQuery.isFetching ? 'Checking…' : 'Check'}
				</Button>

				{checkQuery.data && (
					<div className="text-muted-foreground ml-2 text-xs">
						{running ? 'Running' : 'Stopped'} · Port: {checkQuery.data.port ?? '-'} · Model:{' '}
						{checkQuery.data.model ?? '-'} · Profile: {checkQuery.data.profile ?? '-'}
					</div>
				)}
			</div>

			<div className="flex flex-col gap-1">
				<div className="text-sm">Log{streaming ? ' (streaming…)' : ''}</div>
				<div
					ref={logContainerRef}
					className="h-72 overflow-y-auto rounded-lg bg-neutral-950 p-2.5 font-mono text-xs break-all whitespace-pre-wrap text-neutral-100"
				>
					{logLines.length === 0 && <div className="text-neutral-500">No log output yet</div>}
					{logLines.map((line, i) => (
						<div key={i}>{line}</div>
					))}
				</div>
			</div>

			<ProfilesPanel open={profilesPanelOpen} onOpenChange={setProfilesPanelOpen} />
		</div>
	);
}
