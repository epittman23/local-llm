import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Plus, Settings } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { AccessControl } from '@/components/common/AccessControl';
import { ExperimentalBadge } from '@/components/common/ExperimentalBadge';
import { toastFailure } from '@/components/common/failureToast';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { FieldLabel, FormField, SecretInput, SelectField } from '@/components/settings/formFields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { AccessGrant } from '@/lib/access/accessGrants';
import {
	createExternalKnowledgeSource,
	getExternalKnowledgeConnections,
	searchKnowledgeBases,
	testExternalKnowledgeSource,
	updateExternalKnowledgeConnection,
	updateExternalKnowledgeSource
} from '@/lib/apis/knowledge';
import { useAuthStore } from '@/lib/stores/authStore';
import {
	blankSourceForm,
	connectionForItem,
	connectionPayload,
	type ExternalConnection,
	type ExternalKnowledgeItem,
	endpointPlaceholder,
	formFromItem,
	missingFields,
	type Provider,
	type SourceForm,
	schemaDefaults,
	sourcePayload,
	togglePayload
} from './externalKnowledge';

const QUERY_KEY = ['admin-settings', 'external-knowledge'];
const PROVIDERS: readonly (readonly [Provider, string])[] = [
	['qdrant', 'Qdrant'],
	['milvus', 'Milvus'],
	['pgvector', 'pgvector']
];

type TestResult = { documents?: string[]; metadatas?: Record<string, unknown>[]; distances?: number[] };

/**
 * Ports admin/Settings/ExternalKnowledge.svelte, the Integrations tab's
 * Knowledge section: the knowledge bases backed by an external vector store,
 * each with a configure button and an enable switch, and a dialog to add or
 * edit one. Saving is refused until a test query has returned documents, and
 * any edit to a field the test depends on asks for a new test. Rules in
 * externalKnowledge.ts.
 *
 * #933: the dialog speaks the connection dialogs' form language; a source
 * that is off says "Off" rather than fading (DAT-3, COL-2).
 */
export function ExternalKnowledge() {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<{ item: ExternalKnowledgeItem; connection: ExternalConnection } | null>(null);

	const list = useQuery({
		queryKey: QUERY_KEY,
		queryFn: async () => {
			const [c, k] = await Promise.all([
				getExternalKnowledgeConnections(token),
				searchKnowledgeBases(token, null, null, 1, 'external')
			]);
			return {
				connections: (c?.items ?? []) as ExternalConnection[],
				items: (k?.items ?? []) as ExternalKnowledgeItem[]
			};
		},
		retry: false,
		gcTime: 0
	});
	const connections = list.data?.connections ?? [];
	const items = list.data?.items ?? [];
	const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

	const toggle = async (item: ExternalKnowledgeItem, connection: ExternalConnection) => {
		const turningOn = connection.enabled === false;
		try {
			await updateExternalKnowledgeConnection(token, connection.id, togglePayload(connection));
			toast.success(`“${item.name}” is ${turningOn ? 'on' : 'off'}`);
			await refresh();
		} catch (error) {
			toastFailure(`Couldn't turn ${turningOn ? 'on' : 'off'} “${item.name}”.`, error);
		}
	};

	return (
		<div className="flex w-full flex-col">
			<SourceDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				editing={editing}
				onSaved={async () => {
					setDialogOpen(false);
					await refresh();
				}}
			/>

			<div className="mb-2 flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<h4 className="text-body font-strong">External knowledge sources</h4>
					<ExperimentalBadge />
				</div>
				<Button
					variant="outline"
					size="sm"
					type="button"
					onClick={() => {
						setEditing(null);
						setDialogOpen(true);
					}}
				>
					<Plus aria-hidden />
					Add source
				</Button>
			</div>

			{list.isError ? (
				<LoadFailed
					what="the knowledge sources"
					error={list.error}
					retrying={list.isFetching}
					onRetry={() => void list.refetch()}
				/>
			) : list.isLoading ? (
				<div className="py-2">
					<Spinner />
				</div>
			) : items.length === 0 ? (
				<p className="text-foreground-muted text-dense">
					None yet. Add one to search a vector store you run; it is added once a test query finds documents.
				</p>
			) : (
				<ul className="flex flex-col gap-1">
					{items.map((item) => {
						const connection = connectionForItem(connections, item);
						const enabled = connection?.enabled !== false;
						const source = item.meta?.external?.source?.name;
						return (
							<li key={item.id} className="flex w-full min-w-0 items-center gap-2 text-body">
								<Database className="text-foreground-muted size-4 shrink-0" aria-hidden />
								<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
									<span className="min-w-0 truncate">{item.name}</span>
									<span className="text-foreground-muted text-dense">
										{item.meta?.external?.provider ?? connection?.provider}
										{source ? ` · ${source}` : ''}
									</span>
									{!enabled && (
										<Badge variant="secondary">
											<span className="sr-only">, </span>Off
										</Badge>
									)}
									{!connection && <Badge variant="warning">Connection missing</Badge>}
								</span>
								<Tip content={connection ? 'Configure' : 'Its connection is missing, so it cannot be configured'}>
									<span>
										<Button
											variant="ghost"
											size="icon-sm"
											type="button"
											aria-label={`Configure ${item.name}`}
											disabled={!connection}
											onClick={() => {
												if (!connection) return;
												setEditing({ item, connection });
												setDialogOpen(true);
											}}
										>
											<Settings aria-hidden />
										</Button>
									</span>
								</Tip>
								<Switch
									aria-label={`Enable ${item.name}`}
									checked={enabled}
									disabled={!connection}
									onCheckedChange={() => connection && void toggle(item, connection)}
								/>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

/** Add or edit one source. Every open starts from the item being edited, or blank. */
function SourceDialog({
	open,
	onOpenChange,
	editing,
	onSaved
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	editing: { item: ExternalKnowledgeItem; connection: ExternalConnection } | null;
	onSaved: () => void | Promise<void>;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const ids = useId();
	const id = (name: string) => `${ids}-${name}`;
	const [f, setF] = useState<SourceForm>(blankSourceForm());
	const [accessGrants, setAccessGrants] = useState<AccessGrant[]>([]);
	const [testResult, setTestResult] = useState<TestResult | null>(null);
	const [testProblem, setTestProblem] = useState<string | null>(null);
	const [missing, setMissing] = useState<ReadonlySet<keyof SourceForm>>(new Set());
	const [testing, setTesting] = useState(false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open) return;
		setF(editing ? formFromItem(editing.item, editing.connection) : blankSourceForm());
		setAccessGrants(editing?.item.access_grants ?? []);
		setTestResult(null);
		setTestProblem(null);
		setMissing(new Set());
		setTesting(false);
		setSaving(false);
		// Seeded when the dialog opens; edits inside it are local.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	/** Change a field the test depends on: the last test no longer counts. */
	const change = (patch: Partial<SourceForm>) => {
		setF((prev) => ({ ...prev, ...patch }));
		setTestResult(null);
		setTestProblem(null);
		setMissing((prev) => new Set([...prev].filter((key) => !(key in patch))));
	};
	const editingConnection = editing?.connection ?? null;
	const tested = Boolean(testResult?.documents?.length);

	/** Says under each empty field that it is needed, focusing the first; true when none is. */
	const complete = (saving: boolean) => {
		const empty = missingFields(f, saving);
		setMissing(new Set(empty));
		if (empty.length > 0) setTimeout(() => document.getElementById(id(empty[0]))?.focus());
		return empty.length === 0;
	};

	const test = async () => {
		if (!complete(false)) return;
		setTesting(true);
		setTestResult(null);
		setTestProblem(null);
		try {
			const res = await testExternalKnowledgeSource(token, {
				...(editingConnection?.id ? { connection_id: editingConnection.id } : {}),
				connection: connectionPayload(f, editingConnection),
				source: sourcePayload(f),
				query: f.testQuery,
				count: 5
			});
			if (res?.documents?.length) setTestResult(res);
			else setTestProblem('The test found no documents. Check the collection and the field names.');
		} catch (error) {
			setTestProblem(`${error}`);
		} finally {
			setTesting(false);
		}
	};

	const save = async () => {
		if (!complete(true)) return;
		if (!tested) {
			setTestProblem(`Run the test first: a source is ${editing ? 'saved' : 'added'} only once it finds documents.`);
			setTimeout(() => document.getElementById(id('test'))?.focus());
			return;
		}
		setSaving(true);
		const body = {
			name: f.name,
			description: f.description,
			connection: connectionPayload(f, editingConnection),
			source: sourcePayload(f),
			access_grants: accessGrants,
			test_query: f.testQuery,
			test_count: 5
		};
		try {
			await (editing
				? updateExternalKnowledgeSource(token, editing.item.id, body)
				: createExternalKnowledgeSource(token, body));
			toast.success(editing ? `“${f.name}” saved` : `“${f.name}” added`);
			await onSaved();
		} catch (error) {
			toastFailure(editing ? `Couldn't save “${f.name}”.` : `Couldn't add “${f.name}”.`, error);
		} finally {
			setSaving(false);
		}
	};

	const found = testResult?.documents?.length ?? 0;
	const testHelp = tested ? (
		<span role="status" className="text-success">
			Found {found} document{found === 1 ? '' : 's'}.
		</span>
	) : (
		'A source is saved only once this finds documents.'
	);
	const needed = (key: keyof SourceForm) => (missing.has(key) ? 'Needed.' : undefined);
	const text = (
		key: keyof SourceForm,
		label: string,
		extra: { placeholder?: string; mono?: boolean; optional?: boolean } = {}
	) => (
		<FormField id={id(key)} label={label} optional={extra.optional} error={needed(key)}>
			{(props) => (
				<Input
					{...props}
					className={extra.mono ? 'font-mono' : undefined}
					value={String(f[key])}
					onChange={(e) => change({ [key]: e.target.value } as Partial<SourceForm>)}
					placeholder={extra.placeholder}
					autoComplete="off"
				/>
			)}
		</FormField>
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{editing ? 'Edit knowledge source' : 'Add knowledge source'}</DialogTitle>
					<DialogDescription>
						A knowledge base whose documents live in your own vector store. Its vectors must come from the embedding
						model local-llm uses.
					</DialogDescription>
				</DialogHeader>
				<form
					noValidate
					className="flex flex-col gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<div className="grid gap-4 sm:grid-cols-2">
						{text('name', 'Name', { placeholder: 'Research knowledge' })}
						<FormField id={id('provider')} label="Vector store">
							{(props) => (
								<SelectField
									{...props}
									value={f.provider}
									onChange={(provider) => change({ provider, ...schemaDefaults(provider) })}
									options={PROVIDERS}
								/>
							)}
						</FormField>
					</div>

					<FormField id={id('description')} label="Description" optional>
						{(props) => (
							<Textarea
								{...props}
								value={f.description}
								onChange={(e) => setF((prev) => ({ ...prev, description: e.target.value }))}
							/>
						)}
					</FormField>

					{text('endpoint', 'Endpoint', { placeholder: endpointPlaceholder(f.provider) })}

					<div className="grid gap-4 sm:grid-cols-2">
						<FormField id={id('timeout')} label="Timeout, seconds">
							{(props) => (
								<Input
									{...props}
									type="number"
									min={0}
									value={f.timeout}
									onChange={(e) => change({ timeout: e.target.value === '' ? 0 : Number(e.target.value) })}
								/>
							)}
						</FormField>
						{f.provider !== 'pgvector' && (
							<FormField
								id={id('apiKey')}
								label="API key or token"
								optional
								help={editingConnection?.auth_configured ? 'Empty keeps the saved one.' : undefined}
							>
								{(props) => <SecretInput {...props} value={f.apiKey} onChange={(apiKey) => change({ apiKey })} />}
							</FormField>
						)}
					</div>

					{f.provider === 'milvus' && text('dbName', 'Database', { optional: true, placeholder: 'default' })}

					<div className="flex flex-col gap-4 border-t pt-4">
						{text('sourceName', 'Collection', { placeholder: 'research-docs', mono: true })}
						{f.provider === 'pgvector' && (
							<div className="grid gap-4 sm:grid-cols-2">
								{text('tableName', 'Table', { placeholder: 'document_chunk', mono: true })}
								{text('collectionField', 'Collection field', { placeholder: 'collection_name', mono: true })}
							</div>
						)}
						<div className="grid gap-4 sm:grid-cols-2">
							{text('contentField', 'Content field', { mono: true })}
							{text('vectorField', 'Vector field', {
								mono: true,
								optional: f.provider === 'qdrant',
								placeholder: f.provider === 'qdrant' ? 'Default' : undefined
							})}
							{text('metadataField', 'Metadata field', { mono: true, optional: true })}
							{text('documentIdField', 'Document ID field', { mono: true, optional: true })}
						</div>
					</div>

					<div className="flex flex-col">
						<FieldLabel htmlFor={id('testQuery')}>Test query</FieldLabel>
						<div className="flex flex-wrap items-start gap-2">
							<Input
								id={id('testQuery')}
								className="min-w-48 flex-1"
								value={f.testQuery}
								onChange={(e) => change({ testQuery: e.target.value })}
								placeholder="A question its documents answer"
								autoComplete="off"
								{...fieldProps(id('test-message'), { error: needed('testQuery') ?? testProblem, help: testHelp })}
							/>
							<Button
								id={id('test')}
								type="button"
								variant="outline"
								disabled={testing}
								aria-busy={testing || undefined}
								onClick={test}
							>
								{testing && <Spinner className="size-3.5" />}
								{testing ? 'Testing…' : 'Run test'}
							</Button>
						</div>
						<FieldMessage
							id={id('test-message')}
							className="mt-1.5"
							error={needed('testQuery') ?? testProblem}
							help={testHelp}
						/>
					</div>

					<div className="border-t pt-4">
						<AccessControl
							accessGrants={accessGrants}
							onChange={setAccessGrants}
							accessRoles={['read']}
							share
							sharePublic
							shareUsers
						/>
					</div>

					<div className="flex justify-end border-t pt-3">
						<Button type="submit" disabled={saving} aria-busy={saving || undefined}>
							{saving && <Spinner className="size-3.5" />}
							{saving ? 'Saving…' : editing ? 'Save' : 'Add source'}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
