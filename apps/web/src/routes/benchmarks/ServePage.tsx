import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, CircleAlertIcon, CircleCheckIcon, CircleIcon, CopyIcon, LoaderCircleIcon } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { Disclosure, FormField } from '@/components/settings/formFields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusNotice } from '@/components/ui/status-notice';
import {
	checkServe,
	getLive,
	getServeProfile,
	parseBenchmarksEventStream,
	previewServe,
	type ServePreview,
	type ServeStartForm,
	startServe,
	stopServe,
	streamServe
} from '@/lib/apis/benchmarks';
import { listProfiles, type ProfileEntry } from '@/lib/apis/benchmarks/profiles';
import { errorMessage } from '@/lib/apis/errors';
import { useAuthStore } from '@/lib/stores/authStore';
import { useCopy } from '@/lib/ui/useCopy';
import { useFieldErrors } from '@/lib/ui/useFieldErrors';
import { routePaths } from '@/routes/routePaths';
import { ChoiceSelect, FlagLabel } from './fields';
import { ProfilesPanel } from './ProfilesPanel';
import { argvToText, type DefinitionKey, FIELD_META, isEditParam, showValue } from './profileForm';
import { type LogLine, ServeLog } from './ServeLog';

const CHECK_POLL_MS = 5000;
const PREVIEW_DEBOUNCE_MS = 300;

/** The number overrides, in page order; each is kept in the address under its own name (NAV-1). */
const NUMBER_FIELDS = ['ngl', 'ctx', 'threads', 'parallel'] as const;
type NumberField = (typeof NUMBER_FIELDS)[number];

/** A number override's words (WRD-2), its flag, the profile field it overrides, and its least value. */
const NUMBER_META: Record<NumberField, { label: string; flag: string; key: DefinitionKey; min: number; unit: string }> =
	{
		ngl: { label: 'GPU layers', flag: '-ngl', key: 'ngl', min: 0, unit: 'layers' },
		ctx: { label: 'Context', flag: '-c', key: 'ctx', min: 1, unit: 'tokens' },
		threads: { label: 'Threads', flag: '-t', key: 'threads', min: 1, unit: 'threads' },
		parallel: { label: 'Parallel slots', flag: '--parallel', key: 'parallel', min: 1, unit: 'slots' }
	};

/** What is wrong with a number override, or nothing (FRM-2: what is wrong and how to put it right). */
export function overrideProblem(field: NumberField, raw: string): string | undefined {
	const value = raw.trim();
	if (!value) return undefined;
	const { min, unit } = NUMBER_META[field];
	if (!/^\d+$/.test(value) || Number(value) < min) return `Enter a whole number of ${unit}, ${min} or more.`;
	return undefined;
}

/** llama-server prints one of these once the model is loaded and it takes requests. */
const READY_LINE = /starting the main loop|all slots are idle/;

/** How long a server has been up, in words with units (WRD-5): "1 h 06 min", "4 min", "35 s". */
export function uptime(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	if (s < 60) return `${s} s`;
	const minutes = Math.floor(s / 60);
	if (minutes < 60) return `${minutes} min`;
	return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

function useDebounced<T>(value: T, ms: number): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), ms);
		return () => clearTimeout(timer);
	}, [value, ms]);
	return debounced;
}

/** A profile in the picker: its name, "(default)", and its display name (#976). */
const profileLabel = (entry: ProfileEntry) =>
	`${entry.profile.name}${entry.profile.is_default ? ' (default)' : ''} · ${entry.profile.display_name}`;

/**
 * Ports d863707:apps/openwebui/src/lib/components/benchmarks/Serve.svelte: the
 * profile picker, the overrides form, start/stop/check, and the live log
 * stream (SSE via parseBenchmarksEventStream, unchanged). The health check
 * is a TanStack Query poll (`refetchInterval`).
 *
 * #972/#976/#1051: the server's state is a status badge with what is served,
 * its config_id, uptime and endpoint; the picker opens on what is served (or
 * the default profile) and locks while it runs; each override is named in
 * words with its flag, shows the profile's value, and is checked before
 * Start; and while stopped a launch preview shows the command and the
 * config_id the run would be recorded under (GET /serve/preview, B-D5). The
 * profile and overrides live in the address (`?profile=&ngl=&ctx=&threads=
 * &parallel=&ot=&reasoning=&spec=`, NAV-1): a link prefills the form and
 * never starts anything. `?edit=<profile>&def.<field>=` opens Manage
 * profiles on a prefilled new version (B-D8; ProfilesPanel).
 *
 * "download weights" is not here: there is no backend endpoint for it.
 * docs/guides/model-downloads.md remains the documented path.
 */
export function ServePage() {
	const token = useAuthStore((state) => state.token) ?? '';
	const queryClient = useQueryClient();
	const [params, setParams] = useSearchParams();

	// The form starts from the address once; after that the address follows the form.
	const [selectedProfile, setSelectedProfile] = useState(() => params.get('profile') ?? '');
	const [numbers, setNumbers] = useState<Record<NumberField, string>>(() => ({
		ngl: params.get('ngl') ?? '',
		ctx: params.get('ctx') ?? '',
		threads: params.get('threads') ?? '',
		parallel: params.get('parallel') ?? ''
	}));
	const [ot, setOt] = useState(() => params.get('ot') ?? '');
	const [reasoning, setReasoning] = useState(() => params.get('reasoning') ?? '');
	const [spec, setSpec] = useState(() => (params.get('spec') === 'off' ? 'off' : ''));
	const [actionError, setActionError] = useState<{ title: string; reason: string } | null>(null);
	const [profilesPanelOpen, setProfilesPanelOpen] = useState(() => params.has('edit'));

	const profilesQuery = useQuery({
		queryKey: ['profiles', 'active'],
		queryFn: () => listProfiles(token, false),
		enabled: !!token
	});
	const entries = profilesQuery.data ?? [];

	const checkQuery = useQuery({
		queryKey: ['serve-check'],
		queryFn: () => checkServe(token),
		enabled: !!token,
		refetchInterval: CHECK_POLL_MS
	});
	const running = checkQuery.data?.running === true;

	// #976: the picker opens on what is served, else the default profile, unless the address named one.
	const seeded = useRef(!!selectedProfile);
	useEffect(() => {
		if (seeded.current || !checkQuery.data || !profilesQuery.data) return;
		seeded.current = true;
		const list = profilesQuery.data;
		const fromCheck = checkQuery.data.profile as string | null;
		const fallback = list.find((e) => e.profile.is_default)?.profile.name ?? list[0]?.profile.name;
		const name = fromCheck && list.some((e) => e.profile.name === fromCheck) ? fromCheck : fallback;
		if (name) setSelectedProfile(name);
	}, [checkQuery.data, profilesQuery.data]);

	// While a server runs, the form shows its profile and is locked (#976).
	const shownProfile = running ? ((checkQuery.data?.profile as string | null) ?? selectedProfile) : selectedProfile;
	const definition = entries.find((e) => e.profile.name === shownProfile)?.version;

	const weightsQuery = useQuery({
		queryKey: ['serve-profile', shownProfile],
		queryFn: () => getServeProfile(token, shownProfile),
		enabled: !!token && !!shownProfile
	});
	const weightsMissing = weightsQuery.data?.weights_present === false ? String(weightsQuery.data.model ?? '') : null;

	const liveQuery = useQuery({
		queryKey: ['live'],
		queryFn: () => getLive(token),
		enabled: !!token && running,
		refetchInterval: CHECK_POLL_MS
	});
	const run = running ? (liveQuery.data?.run ?? null) : null;

	// The address follows the form (NAV-1), replacing the entry: changing a field is not a destination.
	useEffect(() => {
		setParams(
			(current) => {
				const next = new URLSearchParams(current);
				const values: Record<string, string> = { profile: selectedProfile, ...numbers, ot, reasoning, spec };
				for (const [key, value] of Object.entries(values)) {
					if (value.trim()) next.set(key, value.trim());
					else next.delete(key);
				}
				return next.toString() === current.toString() ? current : next;
			},
			{ replace: true }
		);
	}, [selectedProfile, numbers, ot, reasoning, spec, setParams]);

	const problems: Partial<Record<NumberField, string>> = {};
	for (const field of NUMBER_FIELDS) {
		const problem = overrideProblem(field, numbers[field]);
		if (problem) problems[field] = problem;
	}
	const { errors, field: fieldEvents, submit } = useFieldErrors(problems, NUMBER_FIELDS);
	const valid = Object.keys(problems).length === 0;

	const noThinking = !!definition && !definition.reasoning_effort_default;
	const noSpec = !!definition && !(definition.spec ?? []).length;

	const form = useMemo<ServeStartForm>(() => {
		const out: ServeStartForm = {};
		if (selectedProfile) out.profile = selectedProfile;
		for (const field of NUMBER_FIELDS) if (numbers[field].trim()) out[field] = Number(numbers[field]);
		if (ot.trim()) out.ot = ot.trim();
		if (reasoning && !noThinking) out.reasoning = reasoning;
		if (spec && !noSpec) out.spec = spec;
		return out;
	}, [selectedProfile, numbers, ot, reasoning, spec, noThinking, noSpec]);

	// B-D5: what Start would launch, while stopped and the form is valid.
	const previewForm = useDebounced(form, PREVIEW_DEBOUNCE_MS);
	const previewQuery = useQuery({
		queryKey: ['serve-preview', previewForm],
		queryFn: () => previewServe(token, previewForm),
		enabled: !!token && !running && valid && !!previewForm.profile,
		placeholderData: keepPreviousData,
		retry: false
	});

	// -------------------------------------------------------------------
	// Log stream (SSE): a long-lived connection, not a request/response the cache can model.
	// -------------------------------------------------------------------
	const [logLines, setLogLines] = useState<LogLine[]>([]);
	const [streaming, setStreaming] = useState(false);
	const abortControllerRef = useRef<AbortController | null>(null);

	const stopLogStream = () => {
		abortControllerRef.current?.abort();
		abortControllerRef.current = null;
		setStreaming(false);
	};

	const startLogStream = async () => {
		stopLogStream();
		setLogLines([]);
		setStreaming(true);

		// Stored before the fetch, so unmounting or stopping mid-request aborts it.
		const controller = new AbortController();
		abortControllerRef.current = controller;
		const [res] = await streamServe(token, controller).catch(() => [null] as const);

		// A newer stream (or unmount) replaced this one: leave its state alone.
		if (controller.signal.aborted) return;
		if (!res?.body) {
			setStreaming(false);
			return;
		}

		try {
			for await (const { event, data } of parseBenchmarksEventStream<{ line: string }>(res.body)) {
				if (event === 'done') break;
				if (data?.line !== undefined) {
					const text = data.line;
					setLogLines((lines) => [...lines, { n: lines.length, text }]);
				}
			}
		} catch (err) {
			// Aborted or connection closed -- not necessarily an error worth surfacing.
			console.error(err);
		}
		if (abortControllerRef.current === controller) setStreaming(false);
	};

	// Reconnects the log stream whenever a server turns out to be running but
	// nothing here is tailing it -- the common case being this page having
	// just (re)mounted; the backend replays its buffered history.
	useEffect(() => {
		if (running && !streaming) {
			void startLogStream();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [running]);

	useEffect(() => stopLogStream, []);

	const ready = running && logLines.some((line) => READY_LINE.test(line.text));

	const startMutation = useMutation({
		mutationFn: () => startServe(token, form),
		onMutate: () => setActionError(null),
		// Not awaited: the stream lives as long as the server, and TanStack
		// Query keeps the mutation pending until onSuccess settles.
		onSuccess: () => {
			void startLogStream();
			return queryClient.invalidateQueries({ queryKey: ['serve-check'] });
		},
		onError: (err: unknown) => setActionError({ title: "Couldn't start the server", reason: errorMessage(err) })
	});

	const stopMutation = useMutation({
		mutationFn: () => stopServe(token),
		onMutate: () => setActionError(null),
		onSuccess: async () => {
			stopLogStream();
			await queryClient.invalidateQueries({ queryKey: ['serve-check'] });
		},
		onError: (err: unknown) => setActionError({ title: "Couldn't stop the server", reason: errorMessage(err) })
	});

	// FRM-2: Start shows every wrong override and focuses the first, instead of sending it.
	const start = () => {
		if (!submit()) return;
		startMutation.mutate();
	};

	const closeProfiles = (open: boolean) => {
		setProfilesPanelOpen(open);
		if (open) return;
		// A prefilled edit link has done its job once the dialog closes.
		setParams(
			(current) => {
				const next = new URLSearchParams(current);
				for (const key of [...next.keys()]) if (isEditParam(key)) next.delete(key);
				return next;
			},
			{ replace: true }
		);
	};

	const port = (checkQuery.data?.port as number | undefined) ?? 8090;
	const locked = running;
	const lockHelp = 'Stop the server to change the profile or overrides.';
	const reasoningDefault = definition?.reasoning_effort_default;

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 className="text-title font-title tracking-tight">Serve</h2>
				<Button variant="outline" onClick={() => setProfilesPanelOpen(true)}>
					Manage profiles
				</Button>
			</div>

			<ServerStatus
				loading={checkQuery.isLoading}
				failed={checkQuery.isError ? checkQuery.error : null}
				onRetry={() => checkQuery.refetch()}
				retrying={checkQuery.isFetching}
				running={running}
				ready={ready}
				profile={shownProfile}
				configId={run?.config_id ?? null}
				startedAt={run?.started_at ?? null}
				port={port}
			/>

			{profilesQuery.isError ? (
				<LoadFailed
					what="profiles"
					error={profilesQuery.error}
					onRetry={() => profilesQuery.refetch()}
					retrying={profilesQuery.isFetching}
				/>
			) : (
				<div className="grid gap-6 lg:grid-cols-2">
					<section aria-label="Profile" className="flex min-w-0 flex-col gap-3">
						<FormField
							id="serve-profile"
							label="Profile"
							help={
								locked
									? lockHelp
									: !profilesQuery.isLoading && entries.length === 0
										? 'No profiles yet. Create one under Manage profiles.'
										: undefined
							}
						>
							{(props) => (
								<ChoiceSelect
									{...props}
									value={shownProfile}
									onChange={setSelectedProfile}
									disabled={locked || entries.length === 0}
									placeholder={profilesQuery.isLoading ? 'Loading profiles…' : 'Choose a profile'}
									options={entries.map((e) => [e.profile.name, profileLabel(e)] as const)}
								/>
							)}
						</FormField>
						{weightsMissing && (
							<StatusNotice tone="warning" title="Weights file not found">
								<p>
									Start fails until the model file exists at{' '}
									<span className="font-mono break-all">{weightsMissing}</span>. docs/guides/model-downloads.md says how
									to download it.
								</p>
							</StatusNotice>
						)}
						{definition && <ProfileSummary definition={definition} />}
					</section>

					<section aria-labelledby="serve-overrides-heading" className="flex min-w-0 flex-col gap-3">
						<div>
							<h3 id="serve-overrides-heading" className="font-strong">
								Overrides
							</h3>
							<p className="text-foreground-muted text-dense mt-1">
								{locked ? lockHelp : 'One-off changes for this start. Leave a field empty to use the profile’s value.'}
							</p>
						</div>
						<fieldset disabled={locked} className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
							{NUMBER_FIELDS.map((field) => {
								const meta = NUMBER_META[field];
								const profileValue = definition ? showValue(meta.key, definition[meta.key]) : '';
								return (
									<FormField
										key={field}
										id={`serve-${field}`}
										label={<FlagLabel label={meta.label} flag={meta.flag} />}
										optional
										error={errors[field]}
										help={definition ? `The profile uses ${profileValue}.` : undefined}
									>
										{(props) => (
											<Input
												{...props}
												{...fieldEvents(field)}
												inputMode="numeric"
												autoComplete="off"
												placeholder={profileValue === '–' ? '' : profileValue}
												value={numbers[field]}
												onChange={(e) => setNumbers((n) => ({ ...n, [field]: e.target.value }))}
											/>
										)}
									</FormField>
								);
							})}
							<FormField
								id="serve-ot"
								className="sm:col-span-2"
								label={<FlagLabel label="Override tensors" flag="-ot" />}
								optional
								help={
									definition?.override_tensors
										? 'Replaces the profile’s pattern, shown as the example.'
										: 'A tensor pattern and where its tensors go, such as blk\\.1[0-9]\\.ffn_.*=CPU.'
								}
							>
								{(props) => (
									<Input
										{...props}
										autoComplete="off"
										className="font-mono"
										placeholder={definition?.override_tensors ?? ''}
										value={ot}
										onChange={(e) => setOt(e.target.value)}
									/>
								)}
							</FormField>
							<FormField
								id="serve-reasoning"
								label="Reasoning effort"
								help={noThinking ? 'This model has no thinking budget to set.' : undefined}
							>
								{(props) => (
									<ChoiceSelect
										{...props}
										value={noThinking ? '' : reasoning}
										onChange={setReasoning}
										disabled={locked || noThinking}
										options={[
											['', reasoningDefault ? `Default (${reasoningDefault})` : 'Default'],
											['low', 'Low'],
											['medium', 'Medium'],
											['high', 'High']
										]}
									/>
								)}
							</FormField>
							<FormField
								id="serve-spec"
								label="Speculative decoding"
								help={noSpec ? 'This profile has no speculative decoding to turn off.' : undefined}
							>
								{(props) => (
									<ChoiceSelect
										{...props}
										value={noSpec ? '' : spec}
										onChange={setSpec}
										disabled={locked || noSpec}
										options={[
											['', noSpec ? 'Default (off)' : 'Default (the profile’s flags)'],
											['off', 'Off']
										]}
									/>
								)}
							</FormField>
						</fieldset>
					</section>
				</div>
			)}

			{!running && (
				<LaunchPreview
					loading={previewQuery.fetchStatus === 'fetching'}
					invalid={!valid}
					preview={previewQuery.data ?? null}
					error={previewQuery.isError ? previewQuery.error : null}
				/>
			)}

			<div className="flex flex-col gap-2">
				<div className="flex flex-wrap items-center gap-2">
					{running ? (
						<Button
							variant="outline"
							onClick={() => stopMutation.mutate()}
							disabled={stopMutation.isPending}
							aria-busy={stopMutation.isPending || undefined}
						>
							{stopMutation.isPending && <Spinner className="size-3.5" />}
							{stopMutation.isPending ? 'Stopping…' : 'Stop server'}
						</Button>
					) : (
						<Button
							onClick={start}
							disabled={startMutation.isPending || !selectedProfile}
							aria-busy={startMutation.isPending || undefined}
						>
							{startMutation.isPending && <Spinner className="size-3.5" />}
							{startMutation.isPending ? 'Starting…' : 'Start'}
						</Button>
					)}
					<Button variant="ghost" onClick={() => checkQuery.refetch()} disabled={checkQuery.isFetching}>
						{checkQuery.isFetching ? 'Checking…' : 'Check status'}
					</Button>
				</div>
				{actionError && (
					<div role="alert" className="text-danger text-dense flex items-start gap-1.5">
						<CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
						<p>
							{actionError.title}: {actionError.reason}
						</p>
					</div>
				)}
			</div>

			<ServeLog lines={logLines} streaming={streaming} />

			<ProfilesPanel open={profilesPanelOpen} onOpenChange={closeProfiles} />
		</div>
	);
}

/**
 * #972: the server's state at a glance. A status badge (Stopped, Loading,
 * Ready; COL-3) with what is served, the config_id the run is recorded under
 * and its uptime (from Live's record of the run), the endpoint to copy
 * (DAT-4), and the pages that use a ready server.
 */
function ServerStatus({
	loading,
	failed,
	onRetry,
	retrying,
	running,
	ready,
	profile,
	configId,
	startedAt,
	port
}: {
	loading: boolean;
	failed: unknown;
	onRetry: () => void;
	retrying: boolean;
	running: boolean;
	ready: boolean;
	profile: string;
	configId: string | null;
	startedAt: number | null;
	port: number;
}) {
	const { copied, copy } = useCopy();
	const endpoint = `http://127.0.0.1:${port}/v1`;
	if (failed) {
		return (
			<StatusNotice
				tone="danger"
				title="Couldn't check the server"
				details={errorMessage(failed)}
				action={
					<Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
						{retrying ? 'Checking…' : 'Check again'}
					</Button>
				}
			>
				<p>Whether a model is being served is not known. The backend may be restarting.</p>
			</StatusNotice>
		);
	}
	const badge = loading ? (
		<Badge variant="secondary">
			<LoaderCircleIcon data-icon="inline-start" aria-hidden className="animate-spin" />
			Checking
		</Badge>
	) : !running ? (
		<Badge variant="secondary">
			<CircleIcon data-icon="inline-start" aria-hidden />
			Stopped
		</Badge>
	) : ready ? (
		<Badge variant="success">
			<CircleCheckIcon data-icon="inline-start" aria-hidden />
			Ready
		</Badge>
	) : (
		<Badge variant="secondary">
			<LoaderCircleIcon data-icon="inline-start" aria-hidden className="animate-spin" />
			Loading
		</Badge>
	);
	return (
		<section aria-label="Server status" className="bg-surface-1 flex flex-col gap-3 rounded-panel border p-4">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				{badge}
				<p className="font-strong">
					{loading ? 'Checking the server…' : running ? `Serving ${profile}` : 'Nothing served'}
				</p>
				{!loading && !running && (
					<p className="text-foreground-muted text-dense">Start a profile below to serve it on port {port}.</p>
				)}
				{running && !ready && (
					<p className="text-foreground-muted text-dense">Loading the model; the log below shows how far it is.</p>
				)}
			</div>
			{running && (
				<dl className="grid gap-x-6 gap-y-2 text-dense sm:grid-cols-[auto_1fr]">
					<StatusRow label="Configuration">
						{configId ? <span className="font-mono">{configId}</span> : 'Not recorded yet'}
					</StatusRow>
					<StatusRow label="Up for">{startedAt ? uptime(Date.now() / 1000 - startedAt) : '–'}</StatusRow>
					<StatusRow label="Endpoint">
						<span className="flex flex-wrap items-center gap-2">
							<span className="font-mono break-all">{endpoint}</span>
							<Button size="sm" variant="ghost" onClick={() => copy(endpoint, 'endpoint')}>
								{copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
								{copied ? 'Copied' : 'Copy endpoint'}
							</Button>
						</span>
					</StatusRow>
				</dl>
			)}
			{running && (
				<div className="flex flex-wrap gap-2">
					<Button asChild variant="outline" size="sm">
						<Link to={routePaths.benchmarksLive}>Open Live</Link>
					</Button>
					<Button asChild variant="outline" size="sm">
						<Link to={routePaths.benchmarksTests}>Run tests</Link>
					</Button>
				</div>
			)}
		</section>
	);
}

function StatusRow({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-foreground-muted">{label}</dt>
			<dd className="min-w-0">{children}</dd>
		</>
	);
}

/** Every field of the selected profile's current version in words, then its notes (#1051: nothing below a fold). */
function ProfileSummary({ definition }: { definition: ProfileEntry['version'] }) {
	const keys = (Object.keys(FIELD_META) as DefinitionKey[]).filter((key) => key !== 'notes');
	return (
		<div className="flex flex-col gap-3 rounded-lg border p-3">
			<p className="text-foreground-muted text-dense">Version {definition.version}</p>
			<dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-dense">
				{keys.map((key) => (
					<div key={key} className="contents">
						<dt className="text-foreground-muted">{FIELD_META[key].label}</dt>
						<dd className="min-w-0 font-mono break-words">{showValue(key, definition[key])}</dd>
					</div>
				))}
			</dl>
			{definition.notes && (
				<Disclosure title="Notes" description="Why the profile is set up this way">
					<p className="text-dense max-w-[72ch] whitespace-pre-wrap">{definition.notes}</p>
				</Disclosure>
			)}
		</div>
	);
}

/**
 * B-D5: what Start would launch, as the server resolves it (GET
 * /serve/preview): the config_id the run would be recorded under and the
 * llama-server command, each argument shell-quoted.
 */
function LaunchPreview({
	loading,
	invalid,
	preview,
	error
}: {
	loading: boolean;
	invalid: boolean;
	preview: ServePreview | null;
	error: unknown;
}) {
	const { copied, copy } = useCopy();
	const command = preview ? argvToText(preview.argv) : '';
	const shown = preview && !invalid && !error;
	return (
		<section aria-labelledby="serve-preview-heading" className="flex min-w-0 flex-col gap-2">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<h3 id="serve-preview-heading" className="font-strong">
					Launch preview
				</h3>
				{shown && (
					<p className="text-dense">
						<span className="text-foreground-muted">Recorded as </span>
						<span className="font-mono">{preview.config_id}</span>
					</p>
				)}
				{shown && (
					<Button size="sm" variant="ghost" className="ms-auto" onClick={() => copy(command, 'command')}>
						{copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
						{copied ? 'Copied' : 'Copy command'}
					</Button>
				)}
			</div>
			{invalid ? (
				<p className="text-foreground-muted text-dense">Correct the overrides to see what Start would run.</p>
			) : error ? (
				<p role="alert" className="text-danger text-dense flex items-start gap-1.5">
					<CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
					<span>Start would be refused with these settings: {errorMessage(error)}</span>
				</p>
			) : preview ? (
				<>
					<pre
						aria-busy={loading || undefined}
						className="bg-surface-1 rounded-lg border p-3 font-mono text-dense break-words whitespace-pre-wrap"
					>
						{command}
					</pre>
					{preview.warning && <p className="text-warning text-dense">{preview.warning}</p>}
				</>
			) : (
				<p className="text-foreground-muted text-dense">
					{loading ? 'Working out the command…' : 'Choose a profile to see what Start would run.'}
				</p>
			)}
		</section>
	);
}
