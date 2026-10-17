"""Characterization tests for Loader._get_loader (retrieval/loaders/main.py).

It was refactored for ruff's complexity limit with no tests of its own, so
these pin what it did before the refactor: for each engine configuration
and file, which loader it builds and with what arguments, or what it
raises. Every loader class is replaced by a recorder, so nothing is parsed
and no service is called; the archive size check runs for real on zip
files built in a temp directory. Each case's result was recorded from the
untouched method into fixtures/document_loader_selection.json and must not
change.

The golden file is only ever written by hand, never by this test. To record
it again (only for an intended behaviour change, reviewed as such), run
`LOADER_GOLDEN_RECORD=1 pytest tests/test_document_loader_selection.py`.
"""

import json
import os
import zipfile
from pathlib import Path

import langchain_community.document_loaders as community_loaders
import pytest

from local_llm.retrieval.loaders import main as loaders

GOLDEN = Path(__file__).parent / 'fixtures' / 'document_loader_selection.json'
RECORD = os.environ.get('LOADER_GOLDEN_RECORD') == '1'

# Loader classes imported into loaders/main.py's namespace.
MODULE_LOADERS = [
    'AzureAIDocumentIntelligenceLoader',
    'BSHTMLLoader',
    'Docx2txtLoader',
    'PyPDFLoader',
    'TextLoader',
    'DatalabMarkerLoader',
    'ExternalDocumentLoader',
    'MinerULoader',
    'MistralLoader',
    'PaddleOCRVLLoader',
    'TikaLoader',
    'DoclingLoader',
    'CSVLoaderWithSummary',
    'ExcelLoader',
    'PptxLoader',
]
# Optional loaders it imports from langchain_community inside the method.
UNSTRUCTURED_LOADERS = [
    'UnstructuredRSTLoader',
    'UnstructuredXMLLoader',
    'UnstructuredEPubLoader',
    'UnstructuredWordDocumentLoader',
    'UnstructuredExcelLoader',
    'UnstructuredPowerPointLoader',
    'UnstructuredEmailLoader',
    'UnstructuredODTLoader',
]

DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

EXTERNAL = {'EXTERNAL_DOCUMENT_LOADER_URL': 'https://ext', 'EXTERNAL_DOCUMENT_LOADER_API_KEY': 'k'}
DOC_INTEL = {
    'DOCUMENT_INTELLIGENCE_ENDPOINT': 'https://di',
    'DOCUMENT_INTELLIGENCE_KEY': 'k',
    'DOCUMENT_INTELLIGENCE_MODEL': 'prebuilt',
}
PADDLE = {'PADDLEOCR_VL_BASE_URL': 'https://paddle', 'PADDLEOCR_VL_TOKEN': 't'}


def _case(case_id, filename, content_type='', engine='', file=None, unstructured=True, **kwargs):
    """file: None (a path that doesn't exist), 'small_zip', 'big_zip' or 'not_zip'."""
    return (
        case_id,
        {
            'filename': filename,
            'content_type': content_type,
            'engine': engine,
            'file': file,
            'unstructured': unstructured,
            'kwargs': kwargs,
        },
    )


CASES = [
    # --- archive size check (runs before any engine) ---
    _case('archive_missing_file_is_not_checked', 'a.docx'),
    _case('archive_not_a_zip_is_not_checked', 'a.docx', file='not_zip'),
    _case('archive_small_zip_passes', 'a.docx', file='small_zip'),
    _case('archive_bomb_rejected', 'a.xlsx', file='big_zip'),
    _case('archive_bomb_by_content_type', 'upload.bin', XLSX, file='big_zip'),
    _case('archive_bomb_within_raised_limit_still_capped', 'a.pptx', file='big_zip', FILE_MAX_SIZE=500),
    _case('archive_bomb_limit_below_ratio', 'a.odt', file='big_zip', FILE_MAX_SIZE=1),
    _case('archive_limit_unparseable', 'a.epub', file='big_zip', FILE_MAX_SIZE='lots'),
    _case('archive_limit_zero_means_default', 'a.docx', file='big_zip', FILE_MAX_SIZE=0),
    _case('archive_limit_negative_disables_check', 'a.docx', file='big_zip', FILE_MAX_SIZE=-1),
    _case('archive_check_runs_before_engine', 'a.docx', engine='external', file='big_zip', **EXTERNAL),
    # --- external ---
    _case('external', 'a.pdf', 'application/pdf', engine='external', metadata_extra=True, **EXTERNAL),
    _case(
        'external_without_api_key',
        'a.pdf',
        'application/pdf',
        engine='external',
        EXTERNAL_DOCUMENT_LOADER_URL='https://ext',
    ),
    # --- tika ---
    _case('tika_text_file', 'a.py', engine='tika', TIKA_SERVER_URL='https://tika'),
    _case('tika_text_content_type', 'notes', 'text/plain', engine='tika', TIKA_SERVER_URL='https://tika'),
    _case(
        'tika_document',
        'a.pdf',
        'application/pdf',
        engine='tika',
        TIKA_SERVER_URL='https://tika',
        TIKA_SERVER_VERSION='3',
        PDF_EXTRACT_IMAGES=True,
    ),
    _case('tika_html_is_not_text', 'a.html', 'text/html', engine='tika', TIKA_SERVER_URL='https://tika'),
    _case('tika_without_url', 'a.pdf', engine='tika'),
    # --- datalab marker ---
    _case('datalab_marker_defaults', 'a.pdf', engine='datalab_marker', DATALAB_MARKER_API_KEY='k'),
    _case(
        'datalab_marker_all_options',
        'a.PNG',
        engine='datalab_marker',
        DATALAB_MARKER_API_KEY='k',
        DATALAB_MARKER_API_BASE_URL='https://marker',
        DATALAB_MARKER_ADDITIONAL_CONFIG='{"x": 1}',
        DATALAB_MARKER_USE_LLM=True,
        DATALAB_MARKER_SKIP_CACHE=True,
        DATALAB_MARKER_FORCE_OCR=True,
        DATALAB_MARKER_PAGINATE=True,
        DATALAB_MARKER_STRIP_EXISTING_OCR=True,
        DATALAB_MARKER_DISABLE_IMAGE_EXTRACTION=True,
        DATALAB_MARKER_FORMAT_LINES=True,
        DATALAB_MARKER_OUTPUT_FORMAT='json',
    ),
    _case(
        'datalab_marker_blank_base_url',
        'a.docx',
        engine='datalab_marker',
        DATALAB_MARKER_API_KEY='k',
        DATALAB_MARKER_API_BASE_URL='   ',
    ),
    _case('datalab_marker_unsupported_ext', 'a.txt', engine='datalab_marker', DATALAB_MARKER_API_KEY='k'),
    _case('datalab_marker_without_key', 'a.pdf', engine='datalab_marker'),
    # --- docling ---
    _case('docling_text_file', 'a.md', 'text/markdown', engine='docling', DOCLING_SERVER_URL='https://docling'),
    _case('docling_default_params', 'a.pdf', 'application/pdf', engine='docling', DOCLING_SERVER_URL='https://docling'),
    _case(
        'docling_dict_params',
        'a.pdf',
        'application/pdf',
        engine='docling',
        DOCLING_SERVER_URL='https://docling',
        DOCLING_API_KEY='k',
        DOCLING_PARAMS={'do_ocr': True},
    ),
    _case(
        'docling_json_params',
        'a.pdf',
        engine='docling',
        DOCLING_SERVER_URL='https://docling',
        DOCLING_PARAMS='{"ocr_lang": ["en"]}',
    ),
    _case(
        'docling_invalid_params', 'a.pdf', engine='docling', DOCLING_SERVER_URL='https://docling', DOCLING_PARAMS='{'
    ),
    _case('docling_without_url', 'a.pdf', engine='docling'),
    # --- Azure document intelligence ---
    _case('document_intelligence_key', 'a.pdf', engine='document_intelligence', **DOC_INTEL),
    _case(
        'document_intelligence_credential',
        'a.pptx',
        engine='document_intelligence',
        **{**DOC_INTEL, 'DOCUMENT_INTELLIGENCE_KEY': ''},
    ),
    _case('document_intelligence_content_type', 'upload', DOCX, engine='document_intelligence', **DOC_INTEL),
    _case(
        'document_intelligence_ppt_content_type',
        'upload',
        'application/vnd.ms-powerpoint',
        engine='document_intelligence',
        **DOC_INTEL,
    ),
    _case('document_intelligence_unsupported', 'a.xlsx', XLSX, engine='document_intelligence', **DOC_INTEL),
    _case(
        'document_intelligence_empty_endpoint',
        'a.pdf',
        engine='document_intelligence',
        **{**DOC_INTEL, 'DOCUMENT_INTELLIGENCE_ENDPOINT': ''},
    ),
    _case('document_intelligence_unset_endpoint', 'a.pdf', engine='document_intelligence'),
    # --- MinerU ---
    _case('mineru_defaults', 'a.pdf', engine='mineru'),
    _case(
        'mineru_all_options',
        'a.png',
        engine='mineru',
        MINERU_FILE_EXTENSIONS=['pdf', 'png'],
        MINERU_API_MODE='cloud',
        MINERU_API_URL='https://mineru',
        MINERU_API_KEY='k',
        MINERU_PARAMS={'lang': 'en'},
        MINERU_API_TIMEOUT='120',
    ),
    _case('mineru_bad_timeout', 'a.pdf', engine='mineru', MINERU_API_TIMEOUT='soon'),
    _case('mineru_zero_timeout', 'a.pdf', engine='mineru', MINERU_API_TIMEOUT=0),
    _case('mineru_unsupported_ext', 'a.docx', engine='mineru'),
    # --- Mistral OCR ---
    _case('mistral_ocr', 'a.pdf', engine='mistral_ocr', MISTRAL_OCR_API_KEY='k', MISTRAL_OCR_API_BASE_URL='https://m'),
    _case('mistral_ocr_base64', 'a.pdf', engine='mistral_ocr', MISTRAL_OCR_API_KEY='k', MISTRAL_OCR_USE_BASE64=True),
    _case('mistral_ocr_unset_key', 'a.pdf', engine='mistral_ocr'),
    _case('mistral_ocr_empty_key', 'a.pdf', engine='mistral_ocr', MISTRAL_OCR_API_KEY=''),
    _case('mistral_ocr_not_pdf', 'a.png', engine='mistral_ocr', MISTRAL_OCR_API_KEY='k'),
    # --- PaddleOCR-VL ---
    _case('paddleocr_vl', 'a.pdf', engine='paddleocr_vl', **PADDLE),
    _case('paddleocr_vl_without_token', 'a.pdf', engine='paddleocr_vl', PADDLEOCR_VL_BASE_URL='https://paddle'),
    _case('paddleocr_vl_unsupported_ext', 'a.docx', engine='paddleocr_vl', **PADDLE),
    # --- default loaders by file type ---
    _case('pdf', 'a.PDF'),
    _case('pdf_options', 'a.pdf', PDF_EXTRACT_IMAGES=True, PDF_LOADER_MODE='single'),
    _case('csv', 'a.csv', 'text/csv'),
    _case('rst', 'a.rst'),
    _case('rst_without_unstructured', 'a.rst', unstructured=False),
    _case('xml', 'a.xml'),
    _case('xml_without_unstructured', 'a.xml', unstructured=False),
    _case('htm', 'a.htm'),
    _case('html', 'a.html', 'text/html'),
    _case('md', 'a.md'),
    _case('epub_by_content_type', 'book', 'application/epub+zip'),
    _case('epub_extension_alone_is_text', 'a.epub'),
    _case('epub_without_unstructured', 'book', 'application/epub+zip', unstructured=False),
    _case('docx', 'a.docx'),
    _case('docx_by_content_type', 'upload', DOCX),
    _case('doc', 'a.doc'),
    _case('doc_by_content_type', 'upload', 'application/msword'),
    _case('doc_without_unstructured', 'a.doc', unstructured=False),
    _case('xls', 'a.xls'),
    _case('xlsx_by_content_type', 'upload', XLSX),
    _case('excel_without_unstructured', 'a.xlsx', unstructured=False),
    _case('ppt', 'a.ppt'),
    _case('pptx_by_content_type', 'upload', PPTX),
    _case('ppt_by_content_type', 'upload', 'application/vnd.ms-powerpoint'),
    _case('powerpoint_without_unstructured', 'a.pptx', unstructured=False),
    _case('msg', 'a.msg'),
    _case('msg_without_unstructured', 'a.msg', unstructured=False),
    _case('odt', 'a.odt'),
    _case('odt_without_unstructured', 'a.odt', unstructured=False),
    _case('source_file', 'main.rs'),
    _case('text_content_type', 'README', 'text/plain'),
    _case('unknown_file', 'blob.xyz', 'application/octet-stream'),
    _case('no_extension', 'Makefile'),
    _case('unknown_engine_uses_default', 'a.pdf', engine='something_else'),
]


def _write_file(kind: str, path: Path) -> None:
    if kind == 'not_zip':
        path.write_bytes(b'not a zip archive')
    elif kind in ('small_zip', 'big_zip'):
        size = 1024 if kind == 'small_zip' else 11 * 1024 * 1024  # 11 MiB of zeros compresses to ~11 KiB
        with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('word/document.xml', b'\0' * size)


def _run(spec: dict, monkeypatch, tmp_path: Path) -> dict:
    calls = []

    def recorder(name):
        def build(*args, **kwargs):
            calls.append(name)
            return {'loader': name, 'args': list(args), 'kwargs': kwargs}

        return build

    def missing(name):
        def build(*args, **kwargs):
            raise ImportError(f'{name} needs unstructured')

        return build

    for name in MODULE_LOADERS:
        monkeypatch.setattr(loaders, name, recorder(name))
    for name in UNSTRUCTURED_LOADERS:
        monkeypatch.setattr(community_loaders, name, recorder(name) if spec['unstructured'] else missing(name))
    monkeypatch.setattr(loaders, 'DefaultAzureCredential', lambda: '<DefaultAzureCredential>')
    monkeypatch.setattr(loaders, 'MINERU_MAX_MARKDOWN_BYTES', 12345)
    monkeypatch.setattr(loaders.Loader, '_detect_text_encoding', lambda self, path: f'<encoding of {Path(path).name}>')

    file_path = tmp_path / spec['filename']
    if spec['file']:
        _write_file(spec['file'], file_path)

    kwargs = dict(spec['kwargs'])
    metadata = {'chat_id': 'c1'} if kwargs.pop('metadata_extra', False) else {}
    loader = loaders.Loader(spec['engine'], user='<user>', user_groups=['g1'], metadata=metadata, **kwargs)
    try:
        result = loader._get_loader(spec['filename'], spec['content_type'], str(file_path))
    except Exception as e:
        result = {'raised': type(e).__name__, 'message': str(e)}
    # Paths differ per run; keep only the file name.
    return json.loads(json.dumps(result).replace(str(tmp_path) + '/', '<tmp>/'))


def _golden() -> dict:
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_case_ids_are_unique():
    ids = [case[0] for case in CASES]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize(('case_id', 'spec'), CASES, ids=[c[0] for c in CASES])
def test_loader_selection_matches_golden(monkeypatch, tmp_path, case_id, spec):
    result = _run(spec, monkeypatch, tmp_path)
    if RECORD:
        pytest.skip('recording')
    assert result == _golden()[case_id]


def test_record_golden(monkeypatch, tmp_path):
    """Writes the golden file, only when LOADER_GOLDEN_RECORD=1."""
    if not RECORD:
        pytest.skip('set LOADER_GOLDEN_RECORD=1 to record the golden file')
    golden = {}
    for i, (case_id, spec) in enumerate(CASES):
        case_dir = tmp_path / str(i)
        case_dir.mkdir()
        with monkeypatch.context() as m:
            golden[case_id] = _run(spec, m, case_dir)
    golden = json.loads(json.dumps(golden).replace(str(tmp_path) + '/', '<tmp>/'))
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')


def test_a_missing_community_loader_is_an_import_error():
    """New with the refactor: the lookup helper mirrors `from ... import`, so callers' fallbacks still apply."""
    with pytest.raises(ImportError):
        loaders._community_loader('NoSuchLoaderAnywhere')
    with pytest.raises(ValueError, match=r"Processing \.x files requires the 'unstructured' package"):
        loaders._unstructured_required('NoSuchLoaderAnywhere', 'f.x', '.x')
    assert loaders._unstructured_or_fallback('NoSuchLoaderAnywhere', 'f.x', lambda: 'fell back', 'note') == 'fell back'
