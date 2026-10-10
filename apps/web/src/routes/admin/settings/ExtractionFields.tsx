import { useState } from 'react';
import { Tip } from '@/components/common/Tip';
import { BoundSecret, BoundSelect, BoundText, BoundToggle } from '@/components/settings/boundFields';
import {
	SettingField,
	SettingNumber,
	SettingRow,
	SettingSelect,
	SettingTextarea
} from '@/components/settings/controls';
import { mineruUrlForMode } from './documents';

type Rec = Record<string, any>;

const twoUp = 'grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2';
const codeClass = 'text-foreground';

const MARKER_CONFIG_HINT =
	'Additional configuration options for marker. This should be a JSON string with key-value pairs. For example, \'{"key": "value"}\'. Supported keys include: disable_links, keep_pageheader_in_output, keep_pagefooter_in_output, filter_blank_pages, drop_repeated_text, layout_coverage_threshold, merge_threshold, height_tolerance, gap_threshold, image_threshold, min_line_length, level_count, default_level';

/** The "Header variables" disclosure under the external loader's headers box. */
function HeaderVariablesHint() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				aria-expanded={open}
				className="text-muted-foreground/70 hover:text-foreground mt-1 text-[0.6875rem] transition-colors"
				onClick={() => setOpen((o) => !o)}
			>
				Header variables
			</button>
			{open && (
				<div className="text-muted-foreground mt-1 text-[0.6875rem] leading-5">
					<div>No additional headers are sent unless configured.</div>
					<div>
						Example: <code className={codeClass}>{'{"X-LLLM-File-Id": "{{FILE_ID}}"}'}</code>
					</div>
					<div>
						Available variables: <code className={codeClass}>{'{{FILE_ID}}'}</code>,{' '}
						<code className={codeClass}>{'{{FILE_NAME}}'}</code>,{' '}
						<code className={codeClass}>{'{{FILE_CONTENT_TYPE}}'}</code>
					</div>
				</div>
			)}
		</>
	);
}

/** The settings that belong to whichever content extraction engine is chosen. */
export function ExtractionFields({ c, set }: { c: Rec; set: (changes: Rec) => void }) {
	const bound = { config: c, set };

	switch (c.CONTENT_EXTRACTION_ENGINE) {
		case '':
			return (
				<>
					<BoundToggle
						{...bound}
						name="PDF_EXTRACT_IMAGES"
						label="PDF Extract Images (OCR)"
						description="Extract images from PDFs so OCR can process image-only pages."
					/>
					<BoundSelect
						{...bound}
						name="PDF_LOADER_MODE"
						label="PDF Loader Mode"
						description="Page mode creates one document per page. Single mode keeps pages together for chunking across boundaries."
						options={[
							['page', 'Page'],
							['single', 'Single']
						]}
					/>
				</>
			);

		case 'datalab_marker':
			return (
				<>
					<BoundText
						{...bound}
						name="DATALAB_MARKER_API_BASE_URL"
						label="API Base URL"
						description="Datalab Marker service endpoint used for document parsing."
						placeholder="Enter Datalab Marker API Base URL"
					/>
					<BoundSecret
						{...bound}
						name="DATALAB_MARKER_API_KEY"
						label="API Key"
						description="API key used to authenticate with Datalab Marker."
						placeholder="Enter Datalab Marker API Key"
					/>
					<SettingField
						label="Additional Config"
						description="JSON options passed to Marker for advanced parsing behavior."
						htmlFor="field-DATALAB_MARKER_ADDITIONAL_CONFIG"
					>
						<Tip content={MARKER_CONFIG_HINT}>
							<SettingTextarea
								id="field-DATALAB_MARKER_ADDITIONAL_CONFIG"
								placeholder={'Enter JSON config (e.g., {"disable_links": true})'}
								value={c.DATALAB_MARKER_ADDITIONAL_CONFIG ?? ''}
								onChange={(e) => set({ DATALAB_MARKER_ADDITIONAL_CONFIG: e.target.value })}
							/>
						</Tip>
					</SettingField>
					<BoundToggle
						{...bound}
						name="DATALAB_MARKER_USE_LLM"
						label="Use LLM"
						description="Use an LLM to improve tables, forms, math, and layout detection."
					/>
					<BoundToggle
						{...bound}
						name="DATALAB_MARKER_SKIP_CACHE"
						label="Skip Cache"
						description="Skip cached Marker results and rerun inference."
					/>
					<BoundToggle
						{...bound}
						name="DATALAB_MARKER_FORCE_OCR"
						label="Force OCR"
						description="Run OCR on all PDF pages, even pages with embedded text."
					/>
					<BoundToggle
						{...bound}
						name="DATALAB_MARKER_PAGINATE"
						label="Paginate"
						description="Separate output by page with page markers."
					/>
					<BoundToggle
						{...bound}
						name="DATALAB_MARKER_STRIP_EXISTING_OCR"
						label="Strip Existing OCR"
						description="Remove existing OCR text and rerun OCR when Force OCR is off."
					/>
					<BoundToggle
						{...bound}
						name="DATALAB_MARKER_DISABLE_IMAGE_EXTRACTION"
						label="Disable Image Extraction"
						description="Do not extract images from PDFs during Marker processing."
					/>
					<BoundToggle
						{...bound}
						name="DATALAB_MARKER_FORMAT_LINES"
						label="Format Lines"
						description="Format lines to detect inline math and styles."
					/>
					<BoundSelect
						{...bound}
						name="DATALAB_MARKER_OUTPUT_FORMAT"
						label="Output Format"
						description="Text output format returned by Marker."
						options={[
							['markdown', 'Markdown'],
							['json', 'JSON'],
							['html', 'HTML']
						]}
					/>
				</>
			);

		case 'external':
			return (
				<>
					<div className={twoUp}>
						<BoundText
							{...bound}
							name="EXTERNAL_DOCUMENT_LOADER_URL"
							label="Document Loader URL"
							description="External service endpoint used to load document content."
							placeholder="Enter External Document Loader URL"
						/>
						<BoundSecret
							{...bound}
							name="EXTERNAL_DOCUMENT_LOADER_API_KEY"
							label="API Key"
							description="API key sent to the external document loader."
							placeholder="Enter External Document Loader API Key"
						/>
					</div>
					<SettingField
						label="Headers"
						description="Additional JSON headers sent to the external document loader."
						htmlFor="field-EXTERNAL_DOCUMENT_LOADER_HEADERS"
					>
						<Tip content={'Enter additional headers in JSON format (e.g. {"X-Custom-Header": "value"}'}>
							<SettingTextarea
								id="field-EXTERNAL_DOCUMENT_LOADER_HEADERS"
								placeholder="Enter additional headers in JSON format"
								value={c.EXTERNAL_DOCUMENT_LOADER_HEADERS ?? ''}
								onChange={(e) => set({ EXTERNAL_DOCUMENT_LOADER_HEADERS: e.target.value })}
							/>
						</Tip>
						<HeaderVariablesHint />
					</SettingField>
				</>
			);

		case 'tika':
			return (
				<div className={twoUp}>
					<BoundText
						{...bound}
						name="TIKA_SERVER_URL"
						label="Tika Server URL"
						description="Tika server endpoint used for content extraction."
						placeholder="Enter Tika Server URL"
					/>
					<SettingField
						label="Tika Server Version"
						description="Select the Tika server API version."
						htmlFor="field-TIKA_SERVER_VERSION"
					>
						<SettingSelect
							id="field-TIKA_SERVER_VERSION"
							value={c.TIKA_SERVER_VERSION}
							onChange={(v) => set({ TIKA_SERVER_VERSION: v })}
						>
							<option value="3">Tika 3.x</option>
							<option value="4">Tika 4.x</option>
						</SettingSelect>
					</SettingField>
				</div>
			);

		case 'docling':
			return (
				<>
					<div className={twoUp}>
						<BoundText
							{...bound}
							name="DOCLING_SERVER_URL"
							label="Docling Server URL"
							description="Docling service endpoint used for parsing."
							placeholder="Enter Docling Server URL"
						/>
						<BoundSecret
							{...bound}
							name="DOCLING_API_KEY"
							label="API Key"
							description="API key sent to Docling."
							placeholder="Enter Docling API Key"
						/>
					</div>
					<SettingField
						label="Parameters"
						description="Additional Docling parameters in JSON format."
						htmlFor="field-DOCLING_PARAMS"
					>
						<SettingTextarea
							id="field-DOCLING_PARAMS"
							rows={5}
							placeholder="Enter additional parameters in JSON format"
							value={c.DOCLING_PARAMS ?? ''}
							onChange={(e) => set({ DOCLING_PARAMS: e.target.value })}
						/>
					</SettingField>
				</>
			);

		case 'document_intelligence':
			return (
				<>
					<div className={twoUp}>
						<BoundText
							{...bound}
							name="DOCUMENT_INTELLIGENCE_ENDPOINT"
							label="Endpoint"
							description="Document Intelligence endpoint used for parsing."
							placeholder="Enter Document Intelligence Endpoint"
						/>
						<BoundSecret
							{...bound}
							name="DOCUMENT_INTELLIGENCE_KEY"
							label="Key"
							description="Credential used for Document Intelligence."
							placeholder="Enter Document Intelligence Key"
						/>
					</div>
					<BoundText
						{...bound}
						name="DOCUMENT_INTELLIGENCE_MODEL"
						label="Document Intelligence Model"
						description="Model name used by Document Intelligence."
						placeholder="Enter Document Intelligence Model"
					/>
				</>
			);

		case 'mistral_ocr':
			return (
				<>
					<div className={twoUp}>
						<BoundText
							{...bound}
							name="MISTRAL_OCR_API_BASE_URL"
							label="API Base URL"
							description="Mistral OCR service endpoint."
							placeholder="Enter Mistral API Base URL"
						/>
						<BoundSecret
							{...bound}
							name="MISTRAL_OCR_API_KEY"
							label="API Key"
							description="API key sent to Mistral OCR."
							placeholder="Enter Mistral API Key"
						/>
					</div>
					<BoundToggle
						{...bound}
						name="MISTRAL_OCR_USE_BASE64"
						label="Use Base64"
						description="Send PDFs as base64 data URLs instead of uploading first."
					/>
				</>
			);

		case 'paddleocr_vl':
			return (
				<div className={twoUp}>
					<BoundText
						{...bound}
						name="PADDLEOCR_VL_BASE_URL"
						label="API Base URL"
						description="PaddleOCR-vl service endpoint."
						placeholder="Enter PaddleOCR-vl API Base URL"
					/>
					<BoundSecret
						{...bound}
						name="PADDLEOCR_VL_TOKEN"
						label="API Token"
						description="API token sent to PaddleOCR-vl."
						placeholder="Enter PaddleOCR-vl API Token"
					/>
				</div>
			);

		case 'mineru':
			return (
				<>
					<BoundSelect
						{...bound}
						name="MINERU_API_MODE"
						label="API Mode"
						description="Choose the local or cloud MinerU API mode."
						options={[
							['local', 'local'],
							['cloud', 'cloud']
						]}
						onPick={(mode) => set({ MINERU_API_URL: mineruUrlForMode(mode, c.MINERU_API_URL) })}
					/>
					<BoundText
						{...bound}
						name="MINERU_API_URL"
						label="API URL"
						description="MinerU API endpoint for the selected mode."
						placeholder={c.MINERU_API_MODE === 'cloud' ? 'https://mineru.net/api/v4' : 'http://localhost:8000'}
					/>
					<BoundSecret
						{...bound}
						name="MINERU_API_KEY"
						label="API Key"
						description="API key used for MinerU cloud mode."
						placeholder="Enter MinerU API Key"
					/>
					<SettingRow label="API Timeout" description="Maximum time in seconds to wait for MinerU API responses.">
						<div className="w-16">
							<SettingNumber
								aria-label="API Timeout"
								placeholder="60"
								min={1}
								value={c.MINERU_API_TIMEOUT}
								onChange={(v) => set({ MINERU_API_TIMEOUT: v === '' ? null : v })}
							/>
						</div>
					</SettingRow>
					<SettingField
						label="Parameters"
						description="Advanced MinerU parsing parameters in JSON format."
						htmlFor="field-MINERU_PARAMS"
					>
						<SettingTextarea
							id="field-MINERU_PARAMS"
							rows={7}
							placeholder={`{\n  "enable_ocr": false,\n  "enable_formula": true,\n  "enable_table": true,\n  "language": "en",\n  "model_version": "pipeline",\n  "page_ranges": ""\n}`}
							value={c.MINERU_PARAMS ?? ''}
							onChange={(e) => set({ MINERU_PARAMS: e.target.value })}
						/>
					</SettingField>
					<BoundText
						{...bound}
						name="MINERU_FILE_EXTENSIONS"
						label="File Extensions"
						description="Comma-separated extensions MinerU should handle."
						placeholder="pdf, docx, pptx, xlsx"
					/>
				</>
			);

		default:
			return null;
	}
}
