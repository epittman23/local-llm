"""Report figures in the page's theme, why a report has none, and saved reports (#973, #1056, #1111).

The report itself is built from fixture rows (as in test_report.py): no
database, and matplotlib only where it is installed. The router tests call
its functions directly against a temporary reports directory.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import time
import uuid

import pytest
from test_report import Rows

from local_llm.benchmarks.analysis import report
from local_llm.benchmarks.analysis import report_figures as rf
from local_llm.routers.benchmarks import report as report_router


def assemble(rows: Rows, figs: rf.Figures) -> report.ReportResult:
    return report._assemble(rows.rows, {}, {}, [], {'tier': None}, figs)


def paired_rows() -> Rows:
    rows = Rows()
    rows.run([True] * 30)
    rows.run([i < 10 for i in range(30)], system='sha1')
    return rows


# -- figures_skipped --------------------------------------------------------
def test_figures_skipped_says_figures_were_turned_off():
    assert assemble(paired_rows(), rf.Figures(enabled=False)).figures_skipped == 'figures disabled by the caller'


def test_figures_skipped_says_matplotlib_is_missing(monkeypatch):
    monkeypatch.setattr(rf, 'HAVE_MPL', False)
    result = assemble(paired_rows(), rf.Figures(enabled=True))
    assert result.figures == []
    assert result.figures_skipped == 'matplotlib is not installed'


def test_figures_skipped_says_there_is_nothing_to_plot():
    rows = Rows()
    rows.run([True, False] * 10)  # one configuration, no system prompt, no timed run
    result = assemble(rows, rf.Figures(enabled=True))
    assert result.figures == []
    assert result.figures_skipped == report.NOTHING_TO_PLOT


def test_figures_skipped_is_empty_when_figures_were_drawn():
    result = assemble(paired_rows(), rf.Figures(enabled=True))
    assert result.figures
    assert result.figures_skipped == ''


# -- the theme ----------------------------------------------------------------
def test_the_light_palette_is_the_module_constants_and_unknown_themes_fall_back_to_it():
    assert rf.PALETTES['light'].surface == rf.SURFACE
    assert rf.PALETTES['light'].ink == rf.INK
    assert rf.Figures(theme='light').c == rf.PALETTES['light']
    assert rf.Figures(theme='sepia').c == rf.PALETTES['light']
    assert rf.Figures(theme='dark').c == rf.PALETTES['dark']


def _corner(png: bytes) -> str:
    """The figure's background: its top-left pixel, as hex."""
    from matplotlib import image

    r, g, b = (round(float(v) * 255) for v in image.imread(io.BytesIO(png))[0, 0, :3])
    return f'#{r:02x}{g:02x}{b:02x}'


def test_each_theme_draws_its_figures_on_its_own_surface():
    light = assemble(paired_rows(), rf.Figures(enabled=True, theme='light')).figures
    dark = assemble(paired_rows(), rf.Figures(enabled=True, theme='dark')).figures
    assert light
    assert [f.name for f in light] == [f.name for f in dark]
    for lf, df in zip(light, dark, strict=True):
        assert _corner(lf.data) == rf.PALETTES['light'].surface, lf.name
        assert _corner(df.data) == rf.PALETTES['dark'].surface, df.name


def test_the_report_form_takes_a_theme_and_defaults_to_light():
    assert report_router.ReportForm().theme == 'light'
    assert report_router.ReportForm(theme='dark').theme == 'dark'
    with pytest.raises(ValueError):
        report_router.ReportForm(theme='sepia')


# -- saved reports --------------------------------------------------------------
@pytest.fixture
def reports_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(report_router, 'REPORTS_DIR', tmp_path)
    return tmp_path


def test_generate_writes_its_description_and_answers_with_it(reports_dir, monkeypatch):
    seen = {}

    async def fake_build(**kw):
        seen.update(kw)
        return report.ReportResult(
            markdown='# r\n',
            figures=[report.Figure('fig4-mde.png', b'png', 'alt')],
            windows=['2025-01'],
            figures_skipped='',
        )

    monkeypatch.setattr(report_router.report_logic, 'build_report', fake_build)
    form = report_router.ReportForm(tier='smoke', theme='dark')
    answer = asyncio.run(report_router.generate_report(form, user=None))

    assert seen['theme'] == 'dark'
    run_dir = answer['date']
    assert answer['markdown_url'] == f'/api/v1/benchmarks/report/files/{run_dir}/report.md'
    assert answer['figures'] == [f'/api/v1/benchmarks/report/files/{run_dir}/fig4-mde.png']
    assert answer['figures_skipped'] == ''
    assert answer['filters'] == {'tier': 'smoke', 'model': None, 'benchmark': None}
    meta = json.loads((reports_dir / run_dir / 'report.json').read_text())
    assert meta['theme'] == 'dark'
    assert meta['figures'] == ['fig4-mde.png']


def test_generate_answers_why_there_are_no_figures(reports_dir, monkeypatch):
    async def fake_build(**kw):
        return report.ReportResult(markdown='# r\n', figures_skipped=report.NOTHING_TO_PLOT)

    monkeypatch.setattr(report_router.report_logic, 'build_report', fake_build)
    answer = asyncio.run(report_router.generate_report(report_router.ReportForm(), user=None))
    assert answer['figures'] == []
    assert answer['figures_skipped'] == report.NOTHING_TO_PLOT


def _saved(reports_dir, name: str, *, meta: dict | None, mtime: float, pngs=()):
    d = reports_dir / name
    d.mkdir()
    (d / 'report.md').write_text('# r\n')
    for png in pngs:
        (d / png).write_bytes(b'png')
    if meta is not None:
        (d / 'report.json').write_text(json.dumps(meta))
    os.utime(d / 'report.md', (mtime, mtime))


def test_saved_reports_are_listed_newest_first_with_or_without_a_description(reports_dir):
    now = time.time()
    _saved(reports_dir, '2026-11-15-aaaaaa', meta=None, mtime=now - 3600, pngs=['fig2-b.png', 'fig1-a.png'])
    _saved(
        reports_dir,
        '2026-11-15-bbbbbb',
        meta={'filters': {'tier': 'smoke'}, 'figures': [], 'figures_skipped': 'x', 'created_at': int(now)},
        mtime=now - 7200,
    )
    (reports_dir / '2026-11-16-empty').mkdir()  # no report.md: not a report
    (reports_dir / 'stray.txt').write_text('')

    listed = asyncio.run(report_router.list_reports(limit=50, user=None))['reports']

    assert [r['date'] for r in listed] == ['2026-11-15-bbbbbb', '2026-11-15-aaaaaa']
    newer, older = listed
    assert newer['filters'] == {'tier': 'smoke'}
    assert newer['figures'] == []
    assert newer['figures_skipped'] == 'x'
    # Written before descriptions existed: its PNGs are found, its filters unknown.
    assert older['figures'] == [
        '/api/v1/benchmarks/report/files/2026-11-15-aaaaaa/fig1-a.png',
        '/api/v1/benchmarks/report/files/2026-11-15-aaaaaa/fig2-b.png',
    ]
    assert older['filters'] == {}
    assert older['created_at'] == int(now - 3600)


def test_saved_reports_survive_a_broken_description_and_respect_the_limit(reports_dir):
    now = time.time()
    for i in range(3):
        _saved(reports_dir, f'2026-11-1{i}-{uuid.uuid4().hex[:6]}', meta=None, mtime=now - i)
    (next(reports_dir.iterdir()) / 'report.json').write_text('{not json')
    assert len(asyncio.run(report_router.list_reports(limit=2, user=None))['reports']) == 2


def test_no_reports_directory_lists_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(report_router, 'REPORTS_DIR', tmp_path / 'missing')
    assert asyncio.run(report_router.list_reports(limit=50, user=None)) == {'reports': []}
