import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Plus, RefreshCw, Settings } from 'lucide-react';
import { type ComponentProps, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AccessControl } from '@/components/common/AccessControl';
import { ExperimentalBadge } from '@/components/common/ExperimentalBadge';
import { SensitiveInput } from '@/components/common/SensitiveInput';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
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
	type ExternalConnection,
	type ExternalKnowledgeItem,
	type Provider,
	type SourceForm,
	blankSourceForm,
	canSave,
	canTest,
	connectionForItem,
	connectionPayload,
	endpointPlaceholder,
	formFromItem,
	schemaDefaults,
	sourcePayload,
	togglePayload
} from './externalKnowledge';

const bare = 'w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground/50';
const label = 'text-muted-foreground text-xs';
const iconButton = 'text-muted-foreground hover:text-foreground rounded p-1 transition disabled:opacity-50';
const QUERY_KEY = ['admin-settings', 'external-knowledge'];

type TestResult = { documents?: string[]; metadatas?: Record<string, unknown>[]; distances?: number[] };

/**
 * Ports admin/Settings/ExternalKnowledge.svelte, the Integrations tab's
 * Knowledge section: the knowledge bases backed by an external vector store,
 * each with a configure cog and an enable switch, and a dialog to add or edit
 * one. Saving is refused until a test query has returned documents, and any
 * edit to a field the test depends on asks for a new test. Rules in
 * externalKnowledge.ts.
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
				getExternalKnowledgeConnections(token).catch((error) => {
					toast.error(`${error}`);
					return null;
				}),
				searchKnowledgeBases(token, null, null, 1, 'external').catch((error) => {
					toast.error(`${error}`);
					return null;
				})
			]);
			return {
				connections: (c?.items ?? []) as ExternalConnection[],
				items: (k?.items ?? []) as ExternalKnowledgeItem[]
			};
		},
		gcTime: 0
	});
	const connections = list.data?.connections ?? [];
	const items = list.data?.items ?? [];
	const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

	const toggle = async (connection: ExternalConnection) => {
		const res = await updateExternalKnowledgeConnection(token, connection.id, togglePayload(connection)).catch(
			(error) => {
				toast.error(`${error}`);
				return null;
			}
		);
		if (res) await refresh();
	};

	return (
		<div className="flex w-full flex-col text-xs">
			<SourceDialog
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				editing={editing}
				onSaved={async () => {
					setDialogOpen(false);
					await refresh();
				}}
			/>

			<div className="mb-2 flex items-center justify-between">
				<div className="text-muted-foreground flex items-center gap-2 leading-none">
					<div>External Knowledge Sources</div>
					<ExperimentalBadge />
				</div>
				<Tip content="Add Connection">
					<button
						type="button"
						aria-label="Add Knowledge Connection"
						className={iconButton}
						onClick={() => {
							setEditing(null);
							setDialogOpen(true);
						}}
					>
						<Plus className="size-4" />
					</button>
				</Tip>
			</div>

			<ul className="flex flex-col gap-1.5">
				{items.map((item) => {
					const connection = connectionForItem(connections, item);
					const enabled = connection?.enabled !== false;
					const source = item.meta?.external?.source?.name;
					return (
						<li key={item.id} className="flex w-full items-center gap-2">
							<div className={`flex min-w-0 flex-1 items-center gap-1.5 ${enabled ? '' : 'opacity-50'}`}>
								<Database className="size-4 shrink-0" strokeWidth={1.5} aria-hidden />
								<div className="line-clamp-1 min-w-0">
									<span>{item.name}</span>{' '}
									<span className="text-muted-foreground">
										{item.meta?.external?.provider ?? connection?.provider}
										{source ? ` · ${source}` : ''}
									</span>
								</div>
							</div>
							<div className="flex items-center gap-1">
								<Tip content="Configure">
									<button
										type="button"
										aria-label={`Configure ${item.name}`}
										className={iconButton}
										disabled={!connection}
										onClick={() => {
											if (!connection) return void toast.error('External connection not found.');
											setEditing({ item, connection });
											setDialogOpen(true);
										}}
									>
										<Settings className="size-4" />
									</button>
								</Tip>
								<Tip content={enabled ? 'Enabled' : 'Disabled'}>
									<span>
										<Switch
											size="sm"
											aria-label={`${enabled ? 'Disable' : 'Enable'} ${item.name}`}
											checked={enabled}
											disabled={!connection}
											onCheckedChange={() => connection && toggle(connection)}
										/>
									</span>
								</Tip>
							</div>
						</li>
					);
				})}
			</ul>

			{list.isLoading ? (
				<div className="py-2">
					<Spinner />
				</div>
			) : (
				items.length === 0 && (
					<>
						<div className="text-muted-foreground/70 text-[0.6875rem]">No external knowledge sources configured.</div>
						<div className="text-muted-foreground/70 text-[0.6875rem]">Test must pass before a source is created.</div>
					</>
				)
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
	const [f, setF] = useState<SourceForm>(blankSourceForm());
	const [accessGrants, setAccessGrants] = useState<AccessGrant[]>([]);
	const [testResult, setTestResult] = useState<TestResult | null>(null);
	const [testing, setTesting] = useState(false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open) return;
		setF(editing ? formFromItem(editing.item, editing.connection) : blankSourceForm());
		setAccessGrants(editing?.item.access_grants ?? []);
		setTestResult(null);
		setTesting(false);
		setSaving(false);
		// Seeded when the dialog opens; edits inside it are local.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	/** Change a field the test depends on: the last test no longer counts. */
	const change = (patch: Partial<SourceForm>) => {
		setF((prev) => ({ ...prev, ...patch }));
		setTestResult(null);
	};
	const editingConnection = editing?.connection ?? null;
	const tested = Boolean(testResult?.documents?.length);

	const test = async () => {
		if (!canTest(f)) return void toast.error('Fill the source fields and test query first.');
		setTesting(true);
		setTestResult(null);
		const res = await testExternalKnowledgeSource(token, {
			...(editingConnection?.id ? { connection_id: editingConnection.id } : {}),
			connection: connectionPayload(f, editingConnection),
			source: sourcePayload(f),
			query: f.testQuery,
			count: 5
		}).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res?.documents?.length) {
			setTestResult(res);
			toast.success('Test succeeded.');
		} else if (res) toast.error('Test returned no results.');
		setTesting(false);
	};

	const save = async () => {
		if (!canSave(f)) return void toast.error('Fill the required fields first.');
		if (!tested)
			return void toast.error(editing ? 'Test the source before saving it.' : 'Test the source before creating it.');
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
		const res = await (editing
			? updateExternalKnowledgeSource(token, editing.item.id, body)
			: createExternalKnowledgeSource(token, body)
		).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		setSaving(false);
		if (res) {
			toast.success(editing ? 'Knowledge source updated.' : 'Knowledge source created.');
			await onSaved();
		}
	};

	const input = (id: string, text: string, key: keyof SourceForm, extra: Partial<ComponentProps<'input'>> = {}) => (
		<div className="min-w-0 flex-1">
			<label className={label} htmlFor={id}>
				{text}
			</label>
			<input
				id={id}
				className={bare}
				value={String(f[key])}
				onChange={(e) => change({ [key]: e.target.value } as Partial<SourceForm>)}
				autoComplete="off"
				{...extra}
			/>
		</div>
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="text-sm font-medium">
						{editing ? 'Edit Knowledge Connection' : 'Add Knowledge Connection'}
					</DialogTitle>
					<DialogDescription className="sr-only">
						A knowledge base backed by an external vector store.
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-2.5"
					onSubmit={(e) => {
						e.preventDefault();
						save();
					}}
				>
					<div className="flex gap-2">
						{input('external-source-name', 'Name', 'name', { placeholder: 'Research Knowledge', required: true })}
						<div className="min-w-0 flex-1">
							<label className={label} htmlFor="external-source-provider">
								Provider
							</label>
							<select
								id="external-source-provider"
								className="block w-full bg-transparent text-sm outline-hidden [&>option]:bg-popover"
								value={f.provider}
								onChange={(e) => change({ provider: e.target.value as Provider, ...schemaDefaults(e.target.value) })}
							>
								<option value="qdrant">Qdrant</option>
								<option value="milvus">Milvus</option>
								<option value="pgvector">pgvector</option>
							</select>
						</div>
					</div>

					<div>
						<label className={label} htmlFor="external-source-description">
							Description
						</label>
						<textarea
							id="external-source-description"
							className={`${bare} resize-none`}
							rows={2}
							value={f.description}
							onChange={(e) => setF((prev) => ({ ...prev, description: e.target.value }))}
						/>
					</div>

					{input('external-source-endpoint', 'Endpoint', 'endpoint', {
						placeholder: endpointPlaceholder(f.provider),
						required: true
					})}

					<div className="flex gap-2">
						{input('external-source-timeout', 'Timeout', 'timeout', { type: 'number' })}
						{f.provider !== 'pgvector' && (
							<div className="min-w-0 flex-1">
								<div className={label}>API Key / Token</div>
								<SensitiveInput
									value={f.apiKey}
									onChange={(apiKey) => change({ apiKey })}
									placeholder={editingConnection?.auth_configured ? 'Unchanged' : ''}
									required={false}
									autoComplete="off"
								/>
							</div>
						)}
					</div>

					{f.provider === 'milvus' &&
						input('external-source-db-name', 'Database', 'dbName', { placeholder: 'Default' })}

					<hr className="my-1" />

					{input('external-source-collection', 'Collection', 'sourceName', {
						placeholder: 'research-docs',
						required: true
					})}

					{f.provider === 'pgvector' && (
						<div className="flex gap-2">
							{input('external-source-table', 'Table', 'tableName', { placeholder: 'document_chunk', required: true })}
							{input('external-source-collection-field', 'Collection Field', 'collectionField', {
								placeholder: 'collection_name',
								required: true
							})}
						</div>
					)}

					<div className="flex gap-2">
						{input('external-source-content-field', 'Content Field', 'contentField', {
							placeholder: f.provider === 'pgvector' ? 'text' : 'payload.text',
							required: true
						})}
						{input('external-source-vector-field', 'Vector Field', 'vectorField', {
							placeholder: f.provider === 'qdrant' ? 'Default' : 'vector',
							required: f.provider !== 'qdrant'
						})}
					</div>
					<div className="flex gap-2">
						{input('external-source-metadata-field', 'Metadata Field', 'metadataField', {
							placeholder: f.provider === 'pgvector' ? 'vmetadata' : 'payload.metadata'
						})}
						{input('external-source-document-id-field', 'Document ID Field', 'documentIdField', { placeholder: 'id' })}
					</div>

					<div>
						<label className={label} htmlFor="external-source-test-query">
							Test Query
						</label>
						<div className="flex items-center gap-1">
							<input
								id="external-source-test-query"
								className={bare}
								value={f.testQuery}
								onChange={(e) => change({ testQuery: e.target.value })}
								placeholder="Ask a test question"
								autoComplete="off"
								required
							/>
							<Tip content="Test">
								<button
									type="button"
									aria-label="Run test query"
									className={iconButton}
									disabled={testing}
									onClick={test}
								>
									{testing ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
								</button>
							</Tip>
						</div>
						{tested && (
							<div className="mt-1 text-xs text-green-700 dark:text-green-300">
								Test passed: {testResult?.documents?.length} result(s).
							</div>
						)}
						<div className="text-muted-foreground mt-1 text-xs">
							{/* LICENSE covers this Open WebUI wordmark. Do not alter, remove, obscure, or replace it
							    except as LICENSE permits: https://docs.openwebui.com/license. */}
							External vectors must be generated with the same embedding model configured in Open WebUI.
						</div>
					</div>

					<hr className="my-1" />

					<AccessControl
						accessGrants={accessGrants}
						onChange={setAccessGrants}
						accessRoles={['read']}
						share
						sharePublic
						shareUsers
					/>

					<div className="flex justify-end pt-1">
						<Button type="submit" size="sm" disabled={saving || !canSave(f) || !tested}>
							{editing ? 'Save' : 'Create'}
							{saving && <Spinner className="size-3.5" />}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
