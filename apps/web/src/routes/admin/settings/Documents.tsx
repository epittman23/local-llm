import { Download } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import {
	BoundNumber,
	BoundSecret,
	BoundSelect,
	BoundText,
	BoundTextarea,
	BoundToggle
} from '@/components/settings/boundFields';
import {
	SettingField,
	SettingNumber,
	SettingRow,
	SettingSwitch,
	SettingsForm,
	SettingsSection
} from '@/components/settings/controls';
import { deleteAllFiles } from '@/lib/apis/files';
import { reindexKnowledgeFiles, reindexKnowledgeMetadata } from '@/lib/apis/knowledge';
import { reindexMemoryVectors } from '@/lib/apis/memories';
import {
	getEmbeddingConfig,
	getRAGConfig,
	resetVectorDB,
	updateEmbeddingConfig,
	updateRAGConfig
} from '@/lib/apis/retrieval';
import { useAdminConfigSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';
import { ExtractionFields } from './ExtractionFields';
import {
	type EmbeddingForm,
	buildEmbeddingPayload,
	buildRagPayload,
	contextPlaceholders,
	embeddingError,
	embeddingModelFor,
	ragFormError,
	rerankingModelFor,
	toEmbeddingForm,
	toRagForm
} from './documents';

type Rec = Record<string, any>;
type Draft = { rag: Rec; embedding: EmbeddingForm };

const twoUp = 'grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2';
const actionButton = 'text-muted-foreground hover:text-foreground shrink-0 text-xs transition-colors';
const hintClass = 'text-muted-foreground/70 mt-1 text-[0.6875rem]';

const EXTRACTION_ENGINES = [
	['', 'Default'],
	['external', 'External'],
	['tika', 'Tika'],
	['docling', 'Docling'],
	['datalab_marker', 'Datalab Marker API'],
	['document_intelligence', 'Document Intelligence'],
	['mistral_ocr', 'Mistral OCR'],
	['paddleocr_vl', 'PaddleOCR-vl'],
	['mineru', 'MinerU']
] as const;

const TEXT_SPLITTERS = [
	['', 'Default (Character)'],
	['token', 'Token (Tiktoken)'],
	['token_transformers', 'Token (Transformers)']
] as const;

/** One of the confirm-then-act buttons at the bottom of the tab. */
function DangerAction({
	label,
	description,
	action,
	title,
	children,
	onConfirm
}: {
	label: string;
	description: string;
	action: string;
	title?: string;
	children?: ReactNode;
	onConfirm: () => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<SettingRow label={label} description={description}>
				<button type="button" className={actionButton} onClick={() => setOpen(true)}>
					{action}
				</button>
			</SettingRow>
			<ConfirmDialog open={open} onOpenChange={setOpen} title={title ?? 'Confirm your action'} onConfirm={onConfirm}>
				{children ?? 'This action cannot be undone. Do you wish to continue?'}
			</ConfirmDialog>
		</>
	);
}

/** Ports admin/Settings/Documents.svelte. */
export default function Documents() {
	const token = useAuthStore((s) => s.token) ?? '';
	const saved = useAdminConfigSaved();
	const { draft, setDraft, isLoading } = useConfigDraft<Draft>(['documents'], async () => {
		const [embedding, rag] = await Promise.all([getEmbeddingConfig(token), getRAGConfig(token)]);
		return embedding && rag ? { embedding: toEmbeddingForm(embedding), rag: toRagForm(rag) } : null;
	});
	const [saving, setSaving] = useState(false);
	const [embeddingLoading, setEmbeddingLoading] = useState(false);

	const setRag = (changes: Rec) => setDraft((d) => d && { ...d, rag: { ...d.rag, ...changes } });
	const setEmbedding = (changes: Partial<EmbeddingForm>) =>
		setDraft((d) => d && { ...d, embedding: { ...d.embedding, ...changes } });
	const setCredentials = (section: 'openai' | 'ollama' | 'azure') => (changes: Rec) =>
		setDraft((d) => d && { ...d, embedding: { ...d.embedding, [section]: { ...d.embedding[section], ...changes } } });

	/** Applies the embedding model; false (after saying why) if it cannot be, in which case the form is put back to what the server has. */
	const applyEmbedding = async (): Promise<boolean> => {
		if (!draft) return false;
		const invalid = embeddingError(draft.embedding);
		if (invalid) {
			toast.error(invalid);
			return false;
		}
		try {
			await updateEmbeddingConfig(token, buildEmbeddingPayload(draft.embedding));
			return true;
		} catch (error) {
			toast.error(`${error}`);
			const fresh = await getEmbeddingConfig(token).catch(() => null);
			if (fresh) setEmbedding(toEmbeddingForm(fresh));
			return false;
		}
	};

	const updateEmbeddingModel = async () => {
		setEmbeddingLoading(true);
		try {
			if (await applyEmbedding()) toast.success('Embedding model updated');
		} finally {
			setEmbeddingLoading(false);
		}
	};

	const save = async () => {
		if (!draft) return;
		const { rag } = draft;
		const invalid = ragFormError(rag);
		if (invalid) {
			toast.error(invalid);
			return;
		}
		setSaving(true);
		try {
			// Bypassing retrieval means there is no embedding model to keep in step.
			if (!rag.BYPASS_EMBEDDING_AND_RETRIEVAL && !(await applyEmbedding())) return;
			await updateRAGConfig(token, buildRagPayload(rag));
			await saved();
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			setSaving(false);
		}
	};

	const reindexAll = async () => {
		try {
			await reindexKnowledgeFiles(token);
			await reindexKnowledgeMetadata(token);
			await reindexMemoryVectors(token);
			toast.success('Success');
		} catch (error) {
			toast.error(`${error}`);
		}
	};
	const run = (request: () => Promise<unknown>) => async () => {
		try {
			await request();
			toast.success('Success');
		} catch (error) {
			toast.error(`${error}`);
		}
	};

	const rag = draft?.rag;
	const emb = draft?.embedding;
	const bound = { config: rag ?? {}, set: setRag };
	const bypass = Boolean(rag?.BYPASS_EMBEDDING_AND_RETRIEVAL);
	const hybrid = rag?.ENABLE_RAG_HYBRID_SEARCH === true;
	const bm25 = rag?.HYBRID_BM25_WEIGHT ?? null;
	const embeddingBound = { config: emb ?? {}, set: setEmbedding as (c: Rec) => void, idPrefix: 'emb' };
	const hosted = emb?.engine === 'ollama' || emb?.engine === 'openai' || emb?.engine === 'azure_openai';

	return (
		<SettingsForm title="Documents" loading={isLoading} onSubmit={save} saving={saving}>
			{draft && rag && emb && (
				<>
					<SettingsSection title="Content Extraction" first>
						<BoundSelect
							{...bound}
							name="CONTENT_EXTRACTION_ENGINE"
							label="Content Extraction Engine"
							description="Choose how uploaded documents are parsed before indexing."
							options={EXTRACTION_ENGINES}
						/>
						<BoundText
							{...bound}
							name="CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES"
							label="Supported Media MIME Types"
							description="Media upload MIME types the content extraction engine may process."
							placeholder="image/*, video/*"
						/>

						<ExtractionFields c={rag} set={setRag} />

						<BoundToggle
							{...bound}
							name="BYPASS_EMBEDDING_AND_RETRIEVAL"
							label="Bypass Embedding and Retrieval"
							description={
								bypass
									? 'Inject the entire content as context for comprehensive processing.'
									: 'Use segmented retrieval for focused and relevant context.'
							}
						/>

						{!bypass && (
							<>
								<BoundSelect
									{...bound}
									name="TEXT_SPLITTER"
									label="Text Splitter"
									description="Choose how extracted text is split before indexing."
									options={TEXT_SPLITTERS}
								/>
								{rag.TEXT_SPLITTER === 'token_transformers' && (
									<BoundText
										{...bound}
										name="RAG_TOKENIZER_MODEL"
										label="Tokenizer Model"
										description="Tokenizer model used for transformer token splitting."
										placeholder="Enter Tokenizer Model"
										required={emb.engine !== ''}
									/>
								)}
								<BoundToggle
									{...bound}
									name="ENABLE_MARKDOWN_HEADER_TEXT_SPLITTER"
									label="Markdown Header Text Splitter"
									description="Split documents by markdown headers before character or token splitting."
								/>
								<div className={twoUp}>
									<BoundNumber
										{...bound}
										name="CHUNK_SIZE"
										label="Chunk Size"
										description="Maximum size for each text chunk."
										placeholder="Enter Chunk Size"
										min={0}
									/>
									<BoundNumber
										{...bound}
										name="CHUNK_OVERLAP"
										label="Chunk Overlap"
										description="Overlap preserved between neighboring chunks."
										placeholder="Enter Chunk Overlap"
										min={0}
									/>
								</div>
								{rag.ENABLE_MARKDOWN_HEADER_TEXT_SPLITTER && (
									<BoundNumber
										{...bound}
										name="CHUNK_MIN_SIZE_TARGET"
										label="Chunk Min Size Target"
										description="Merge chunks smaller than this threshold when possible. Set to 0 to disable merging."
										placeholder="Enter Chunk Min Size Target"
										min={0}
									/>
								)}
							</>
						)}
					</SettingsSection>

					{!bypass && (
						<SettingsSection title="Embedding">
							<BoundSelect
								{...embeddingBound}
								name="engine"
								label="Embedding Model Engine"
								description="Provider used to generate document embeddings."
								options={[
									['', 'Default (SentenceTransformers)'],
									['ollama', 'Ollama'],
									['openai', 'OpenAI'],
									['azure_openai', 'Azure OpenAI']
								]}
								onPick={(engine) => {
									const model = embeddingModelFor(engine);
									if (model !== null) setEmbedding({ model });
								}}
							/>

							{emb.engine === 'openai' && (
								<div className={twoUp}>
									<BoundText
										config={emb.openai}
										set={setCredentials('openai')}
										idPrefix="emb-openai"
										name="url"
										label="API Base URL"
										description="OpenAI-compatible embeddings endpoint."
										placeholder="API Base URL"
										required
									/>
									<BoundSecret
										config={emb.openai}
										set={setCredentials('openai')}
										idPrefix="emb-openai"
										name="key"
										label="API Key"
										description="API key for embedding requests."
										placeholder="API Key"
									/>
								</div>
							)}
							{emb.engine === 'ollama' && (
								<div className={twoUp}>
									<BoundText
										config={emb.ollama}
										set={setCredentials('ollama')}
										idPrefix="emb-ollama"
										name="url"
										label="API Base URL"
										description="Ollama endpoint used for embeddings."
										placeholder="API Base URL"
										required
									/>
									<BoundSecret
										config={emb.ollama}
										set={setCredentials('ollama')}
										idPrefix="emb-ollama"
										name="key"
										label="API Key"
										description="Optional API key for Ollama requests."
										placeholder="API Key"
									/>
								</div>
							)}
							{emb.engine === 'azure_openai' && (
								<div className={twoUp}>
									<BoundText
										config={emb.azure}
										set={setCredentials('azure')}
										idPrefix="emb-azure"
										name="url"
										label="API Base URL"
										description="Azure OpenAI endpoint used for embeddings."
										placeholder="API Base URL"
										required
									/>
									<BoundSecret
										config={emb.azure}
										set={setCredentials('azure')}
										idPrefix="emb-azure"
										name="key"
										label="API Key"
										description="Azure OpenAI API key."
										placeholder="API Key"
										required
									/>
									<BoundText
										config={emb.azure}
										set={setCredentials('azure')}
										idPrefix="emb-azure"
										name="version"
										label="Version"
										description="Azure OpenAI API version."
										placeholder="Version"
										required
									/>
								</div>
							)}

							<SettingField
								label="Embedding Model"
								description="Model used to generate embeddings. Reindex knowledge after changing this."
								htmlFor="emb-model"
							>
								<div className="flex w-full items-center gap-2">
									<input
										id="emb-model"
										className="bg-muted/40 placeholder:text-muted-foreground/50 focus:border-ring h-7 w-full rounded-lg border px-2 text-xs outline-hidden transition-colors"
										placeholder={
											emb.engine === 'ollama'
												? 'Set embedding model'
												: `Set embedding model (e.g. ${emb.model.slice(-40)})`
										}
										required={emb.engine === 'ollama'}
										value={emb.model}
										onChange={(e) => setEmbedding({ model: e.target.value })}
									/>
									{emb.engine === '' && (
										<button
											type="button"
											aria-label="Update embedding model"
											disabled={embeddingLoading}
											className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-50"
											onClick={updateEmbeddingModel}
										>
											{embeddingLoading ? <Spinner /> : <Download className="size-4" />}
										</button>
									)}
								</div>
								<div className={hintClass}>
									After changing the embedding model, reindex knowledge, knowledge search, and memory vectors for
									changes to take effect.
								</div>
							</SettingField>

							<SettingRow label="Embedding Batch Size" description="Number of items processed per embedding batch.">
								<div className="w-16">
									<SettingNumber
										aria-label="Embedding Batch Size"
										min={-2}
										max={16000}
										step={1}
										value={emb.batchSize}
										onChange={(v) => setEmbedding({ batchSize: v === '' ? null : v })}
									/>
								</div>
							</SettingRow>

							{hosted && (
								<>
									<SettingRow
										label="Async Embedding Processing"
										description="Run embedding tasks concurrently to speed up processing."
									>
										{(id) => (
											<SettingSwitch checked={emb.async} onChange={(v) => setEmbedding({ async: v })} labelledBy={id} />
										)}
									</SettingRow>
									<SettingRow
										label="Embedding Concurrent Requests"
										description="Maximum concurrent embedding requests. Set to 0 for unlimited."
									>
										<div className="w-16">
											<SettingNumber
												aria-label="Embedding Concurrent Requests"
												min={0}
												step={1}
												value={emb.concurrent}
												onChange={(v) => setEmbedding({ concurrent: v === '' ? null : v })}
											/>
										</div>
									</SettingRow>
								</>
							)}
						</SettingsSection>
					)}

					<SettingsSection title="Retrieval">
						{!bypass && (
							<>
								<BoundToggle
									{...bound}
									name="RAG_FULL_CONTEXT"
									label="Full Context Mode"
									description={
										rag.RAG_FULL_CONTEXT
											? 'Inject entire documents as context for comprehensive processing.'
											: 'Use segmented retrieval for focused context.'
									}
								/>

								{!rag.RAG_FULL_CONTEXT && (
									<>
										<BoundToggle
											{...bound}
											name="ENABLE_RAG_HYBRID_SEARCH"
											label="Hybrid Search"
											description="Combine semantic and keyword retrieval."
										/>

										{hybrid && (
											<>
												<BoundToggle
													{...bound}
													name="ENABLE_RAG_HYBRID_SEARCH_ENRICHED_TEXTS"
													label="Enrich Hybrid Search Text"
													description="Add filenames, titles, sections, and snippets to improve lexical recall."
												/>
												<BoundSelect
													{...bound}
													name="RAG_RERANKING_ENGINE"
													label="Reranking Engine"
													description="Provider used to rerank hybrid search results."
													options={[
														['', 'Default (SentenceTransformers)'],
														['external', 'External']
													]}
													onPick={(engine) => {
														const model = rerankingModelFor(engine);
														if (model !== null) setRag({ RAG_RERANKING_MODEL: model });
													}}
												/>
												{rag.RAG_RERANKING_ENGINE === 'external' && (
													<div className={twoUp}>
														<BoundText
															{...bound}
															name="RAG_EXTERNAL_RERANKER_URL"
															label="API Base URL"
															description="External reranker endpoint."
															placeholder="API Base URL"
															required
														/>
														<BoundSecret
															{...bound}
															name="RAG_EXTERNAL_RERANKER_API_KEY"
															label="API Key"
															description="API key sent to the external reranker."
															placeholder="API Key"
														/>
													</div>
												)}
												<BoundText
													{...bound}
													name="RAG_RERANKING_MODEL"
													label="Reranking Model"
													description="Model used to rerank retrieved results."
													placeholder="Set reranking model (e.g. BAAI/bge-reranker-v2-m3)"
												/>
											</>
										)}

										<SettingRow
											label="Reranking Batch Size"
											description="Number of results processed per reranking batch."
										>
											<div className="w-16">
												<SettingNumber
													aria-label="Reranking Batch Size"
													min={1}
													max={16000}
													step={1}
													value={rag.RAG_RERANKING_BATCH_SIZE}
													onChange={(v) => setRag({ RAG_RERANKING_BATCH_SIZE: v === '' ? null : v })}
												/>
											</div>
										</SettingRow>

										<BoundNumber
											{...bound}
											name="TOP_K"
											label="Top K"
											description="Maximum number of retrieved chunks returned to the model."
											placeholder="Enter Top K"
											min={0}
										/>

										{hybrid && (
											<>
												<BoundNumber
													{...bound}
													name="TOP_K_RERANKER"
													label="Top K Reranker"
													description="Maximum number of hybrid results sent to the reranker."
													placeholder="Enter Top K Reranker"
													min={0}
												/>
												<BoundNumber
													{...bound}
													name="RELEVANCE_THRESHOLD"
													label="Relevance Threshold"
													description="Only return documents with a score greater than or equal to this value."
													placeholder="Enter Score"
													min={0}
													step="0.01"
													title="The score should be a value between 0.0 (0%) and 1.0 (100%)."
												/>

												<SettingRow
													label="BM25 Weight"
													description="Balance semantic and lexical weighting for hybrid search."
												>
													<button
														type="button"
														className={actionButton}
														onClick={() => setRag({ HYBRID_BM25_WEIGHT: bm25 === null ? 0.5 : null })}
													>
														{bm25 === null ? 'Default' : 'Custom'}
													</button>
												</SettingRow>
												{bm25 !== null && (
													<div className="flex items-center gap-2">
														<div className="flex-1">
															<input
																type="range"
																aria-label="BM25 Weight slider"
																min={0}
																max={1}
																step={0.05}
																value={bm25}
																onChange={(e) => setRag({ HYBRID_BM25_WEIGHT: Number(e.target.value) })}
																className="h-2 w-full cursor-pointer"
															/>
															<div className="text-muted-foreground/70 flex justify-between py-0.5 text-[0.6875rem]">
																<div>semantic</div>
																<div>lexical</div>
															</div>
														</div>
														<div className="w-16">
															<SettingNumber
																aria-label="BM25 Weight"
																min={0}
																max={1}
																step="any"
																value={bm25}
																onChange={(v) => setRag({ HYBRID_BM25_WEIGHT: v === '' ? null : v })}
															/>
														</div>
													</div>
												)}
											</>
										)}
									</>
								)}
							</>
						)}

						<BoundTextarea
							{...bound}
							name="RAG_TEMPLATE"
							label="RAG Template"
							description="Prompt template used when retrieved context is injected."
							placeholder="Leave empty to use the default prompt, or enter a custom prompt"
						>
							{contextPlaceholders(rag.RAG_TEMPLATE) > 1 && (
								<div className={hintClass}>
									This template contains multiple context placeholders ([context] or {'{{CONTEXT}}'}). Context will be
									injected at each occurrence.
								</div>
							)}
						</BoundTextarea>
					</SettingsSection>

					<SettingsSection title="Files">
						<BoundText
							{...bound}
							name="ALLOWED_FILE_EXTENSIONS"
							label="Allowed File Extensions"
							description="Comma-separated upload extensions. Leave empty for all file types."
							placeholder="e.g. pdf, docx, txt"
						/>
						<div className={twoUp}>
							<BoundNumber
								{...bound}
								name="FILE_MAX_SIZE"
								label="Max Upload Size"
								description="Maximum file size in MB. Leave empty for unlimited."
								placeholder="Leave empty for unlimited"
								min={0}
							/>
							<BoundNumber
								{...bound}
								name="FILE_MAX_COUNT"
								label="Max Upload Count"
								description="Maximum number of files that can be used at once in chat."
								placeholder="Leave empty for unlimited"
								min={0}
							/>
						</div>
						<div className={twoUp}>
							<BoundNumber
								{...bound}
								name="FILE_IMAGE_COMPRESSION_WIDTH"
								label="Image Compression Width"
								description="Width in pixels to compress images to. Leave empty for no compression."
								placeholder="Leave empty for no compression"
								min={0}
							/>
							<BoundNumber
								{...bound}
								name="FILE_IMAGE_COMPRESSION_HEIGHT"
								label="Image Compression Height"
								description="Height in pixels to compress images to. Leave empty for no compression."
								placeholder="Leave empty for no compression"
								min={0}
							/>
						</div>
					</SettingsSection>

					<SettingsSection title="Integration">
						<BoundToggle
							{...bound}
							name="ENABLE_GOOGLE_DRIVE_INTEGRATION"
							label="Google Drive"
							description="Allow Google Drive as a document source."
						/>
						<BoundToggle
							{...bound}
							name="ENABLE_ONEDRIVE_INTEGRATION"
							label="OneDrive"
							description="Allow OneDrive as a document source."
						/>
					</SettingsSection>

					<SettingsSection title="Danger Zone">
						<DangerAction
							label="Reset Upload Directory"
							description="Delete uploaded files from the upload directory."
							action="Reset"
							onConfirm={run(() => deleteAllFiles(token))}
						/>
						<DangerAction
							label="Reset Vector Storage/Knowledge"
							description="Clear vector storage and knowledge indexing data."
							action="Reset"
							onConfirm={run(() => resetVectorDB(token))}
						/>
						<DangerAction
							label="Reindex Knowledge and Memory Vectors"
							description="Rebuild vectors for existing knowledge files, knowledge search, and memories."
							action="Reindex"
							title="Reindex Embedding Data"
							onConfirm={reindexAll}
						>
							Rebuild knowledge file, knowledge search, and memory vectors using the current embedding model.
						</DangerAction>
					</SettingsSection>
				</>
			)}
		</SettingsForm>
	);
}
