"""routers/benchmarks/report.py - generate and serve the statistical audit report.

benchmarks.report.build_report() returns markdown + in-memory figure bytes
by design (it never touches a filesystem, keeping its read-only-database
discipline) -- this router is the one place that decides where those bytes
land (DATA_DIR/benchmarks/reports/<run>/) and how they're served back.
"""

from __future__ import annotations

import asyncio
import json
import math
import time
import uuid
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict

from local_llm.benchmarks.analysis import report as report_logic
from local_llm.constants import ERROR_MESSAGES
from local_llm.env import DATA_DIR
from local_llm.utils.auth import get_admin_user

router = APIRouter()

REPORTS_DIR = DATA_DIR / 'benchmarks' / 'reports'


class ReportForm(BaseModel):
    tier: str | None = None
    model: str | None = None
    benchmark: str | None = None
    figures: bool = True
    #: The page's theme, so the figures are drawn in its colours. Old reports keep their light PNGs.
    theme: Literal['light', 'dark'] = 'light'

    model_config = ConfigDict(extra='forbid')


#: What a saved report says about itself, next to its report.md, so the list
#: of saved reports can show and reopen it. Reports written before this have none.
META = 'report.json'


def _write_report(out_dir: Path, result, meta: dict) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'report.md').write_text(result.markdown)
    for fig in result.figures:
        (out_dir / fig.name).write_bytes(fig.data)
    (out_dir / META).write_text(json.dumps(meta))


def _answer(run_dir: str, figure_names: list[str], meta: dict) -> dict:
    """How a report is described to the page, freshly generated or reopened."""
    base = f'/api/v1/benchmarks/report/files/{run_dir}'
    return {
        'markdown_url': f'{base}/report.md',
        'figures': [f'{base}/{name}' for name in figure_names],
        'date': run_dir,
        'windows': meta.get('windows', []),
        'figures_skipped': meta.get('figures_skipped', ''),
        'filters': meta.get('filters', {}),
        'theme': meta.get('theme'),
    }


@router.post('/')
async def generate_report(form_data: ReportForm, user=Depends(get_admin_user)):
    try:
        result = await report_logic.build_report(
            tier=form_data.tier,
            model=form_data.model,
            benchmark=form_data.benchmark,
            generate_figures=form_data.figures,
            theme=form_data.theme,
        )
    except report_logic.SciPyUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    except report_logic.NoBenchmarkResults as exc:
        return {'error': str(exc)}

    run_dir = f'{time.strftime("%Y-%m-%d", time.gmtime())}-{uuid.uuid4().hex[:6]}'
    meta = {
        'filters': {'tier': form_data.tier, 'model': form_data.model, 'benchmark': form_data.benchmark},
        'theme': form_data.theme,
        'windows': result.windows,
        'figures': [fig.name for fig in result.figures],
        'figures_skipped': result.figures_skipped,
        'created_at': int(time.time()),
    }
    await asyncio.to_thread(_write_report, REPORTS_DIR / run_dir, result, meta)
    return _answer(run_dir, meta['figures'], meta)


def _saved_reports(limit: int, report_id: str | None = None) -> list[dict]:
    """The saved reports, newest first by when they were written (a directory's name only orders by day).

    `report_id` keeps only the report of that name, however old: it is matched
    against the directory listing, never joined into a path.
    """
    if not REPORTS_DIR.is_dir():
        return []
    found = []
    for path in REPORTS_DIR.iterdir():
        if report_id is not None and path.name != report_id:
            continue
        md = path / 'report.md'
        if not path.is_dir() or not md.is_file():
            continue
        meta: dict = {}
        try:
            meta = json.loads((path / META).read_text())
        except (OSError, ValueError):
            meta = {}
        if not isinstance(meta, dict):
            meta = {}
        figures = meta.get('figures')
        if not isinstance(figures, list):
            figures = sorted(p.name for p in path.glob('*.png'))
        # A hand-edited report.json can hold anything; only a finite number sorts (bool is an int, and is not a
        # time; json reads NaN, Infinity and 1e400 as floats that int() refuses).
        recorded = meta.get('created_at')
        valid_time = isinstance(recorded, (int, float)) and not isinstance(recorded, bool) and math.isfinite(recorded)
        created = int(recorded) if valid_time and recorded else int(md.stat().st_mtime)
        found.append({**_answer(path.name, figures, meta), 'created_at': created})
    found.sort(key=lambda r: r['created_at'], reverse=True)
    return found[:limit]


@router.get('/')
async def list_reports(
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    report_id: Annotated[str | None, Query(alias='id')] = None,
    user=Depends(get_admin_user),
):
    """Saved reports to reopen: each one's files, filters and when it was written.

    `?id=` answers only that report (an empty list if there is none), so a
    link reopens a report older than the newest `limit`.
    """
    return {'reports': await asyncio.to_thread(_saved_reports, limit, report_id)}


@router.get('/files/{run_dir}/{filename}')
async def get_report_file(run_dir: str, filename: str, user=Depends(get_admin_user)):
    path = (REPORTS_DIR / run_dir / filename).resolve()
    if REPORTS_DIR.resolve() not in path.parents or not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)
    return FileResponse(path)
