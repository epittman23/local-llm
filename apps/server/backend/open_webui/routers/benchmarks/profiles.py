"""routers/benchmarks/profiles.py - CRUD for stored serving profiles.

Backs decision 11 in docs/migration-plan.md: full profile CRUD (list,
create, clone, edit, archive, set default) from the Serve page. Thin over
models/benchmark_profiles.py.BenchmarkProfileTable, which already carries
the actual rules (versioning, the default-profile guard rails); this file's
only job is turning those into HTTP.

A profile's `name` is immutable after creation (tuning search spaces are
files named after it -- see the plan's "Assumptions requiring
confirmation"). `DefinitionForm` has no `name` field at all, and every form
here is `extra='forbid'`, so a client that tries to smuggle a rename through
an edit gets a loud 422 rather than a silently ignored field.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from open_webui.benchmarks.serving.profiles import ProfileError
from open_webui.constants import ERROR_MESSAGES
from open_webui.models.benchmark_profiles import BenchmarkProfileEntry, BenchmarkProfiles
from open_webui.utils.auth import get_admin_user
from pydantic import BaseModel, ConfigDict

router = APIRouter()


class DefinitionForm(BaseModel):
    """Everything a profile *version* carries.

    Deliberately excludes `name`, `display_name` and `is_default`: those
    belong to the profile's identity (`BenchmarkProfile`), not its
    definition, and are never accepted here -- see this module's docstring.
    """

    arch: str
    alias: str
    model_path: str
    hf_repo: str = ''
    hf_pattern: str = ''
    ctx: int
    threads: int
    ngl: int
    moe: int | None = None
    override_tensors: str | None = None
    parallel: int = 1
    cache_k: str = 'q8_0'
    cache_v: str = 'q8_0'
    batch: int = 512
    ubatch: int = 512
    spec: list[str] = []
    samplers: list[str] = []
    extra: list[str] = []
    reasoning_effort_default: str | None = None
    notes: str = ''

    model_config = ConfigDict(extra='forbid')


class CreateProfileForm(BaseModel):
    name: str
    display_name: str
    definition: DefinitionForm
    note: str | None = None

    model_config = ConfigDict(extra='forbid')


class CloneProfileForm(BaseModel):
    """A new identity for an existing profile's *current* definition.

    The clone's definition is read from the source profile's latest version
    server-side, not accepted from the client -- a clone is meant to start
    identical, with `name`/`display_name` the only things that differ.
    """

    name: str
    display_name: str
    note: str | None = None

    model_config = ConfigDict(extra='forbid')


class AddVersionForm(BaseModel):
    definition: DefinitionForm
    note: str | None = None

    model_config = ConfigDict(extra='forbid')


class DisplayNameForm(BaseModel):
    display_name: str

    model_config = ConfigDict(extra='forbid')


#: Fields BenchmarkProfileVersionModel carries beyond DEFINITION_FIELDS --
#: dropped when cloning a version into a new profile's own first version.
_VERSION_IDENTITY_FIELDS = {'version_id', 'profile_id', 'version', 'created_at', 'created_by', 'note'}


async def _get_or_404(name: str) -> BenchmarkProfileEntry:
    entry = await BenchmarkProfiles.get_by_name(name)
    if entry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)
    return entry


@router.get('/')
async def list_profiles(include_archived: bool = False, user=Depends(get_admin_user)):
    return await BenchmarkProfiles.list_profiles(include_archived=include_archived)


@router.get('/default')
async def get_default_profile(user=Depends(get_admin_user)):
    entry = await BenchmarkProfiles.get_default()
    if entry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=ERROR_MESSAGES.NOT_FOUND)
    return entry


@router.get('/{name}')
async def get_profile(name: str, user=Depends(get_admin_user)):
    return await _get_or_404(name)


@router.get('/{name}/versions')
async def list_versions(name: str, user=Depends(get_admin_user)):
    entry = await _get_or_404(name)
    return await BenchmarkProfiles.list_versions(entry.profile.profile_id)


@router.post('/', status_code=status.HTTP_201_CREATED)
async def create_profile(form_data: CreateProfileForm, user=Depends(get_admin_user)):
    if await BenchmarkProfiles.get_by_name(form_data.name) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=ERROR_MESSAGES.DEFAULT(f"a profile named '{form_data.name}' already exists"),
        )
    try:
        return await BenchmarkProfiles.create(
            name=form_data.name,
            display_name=form_data.display_name,
            definition=form_data.definition.model_dump(),
            created_by=user.id,
            note=form_data.note,
        )
    except ProfileError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e


@router.post('/{name}/clone', status_code=status.HTTP_201_CREATED)
async def clone_profile(name: str, form_data: CloneProfileForm, user=Depends(get_admin_user)):
    source = await _get_or_404(name)
    if await BenchmarkProfiles.get_by_name(form_data.name) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=ERROR_MESSAGES.DEFAULT(f"a profile named '{form_data.name}' already exists"),
        )
    definition = source.version.model_dump(exclude=_VERSION_IDENTITY_FIELDS)
    try:
        return await BenchmarkProfiles.create(
            name=form_data.name,
            display_name=form_data.display_name,
            definition=definition,
            created_by=user.id,
            note=form_data.note or f"cloned from '{name}' (version {source.version.version})",
        )
    except ProfileError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e


@router.post('/{name}/versions', status_code=status.HTTP_201_CREATED)
async def add_version(name: str, form_data: AddVersionForm, user=Depends(get_admin_user)):
    entry = await _get_or_404(name)
    try:
        return await BenchmarkProfiles.add_version(
            entry.profile.profile_id,
            definition=form_data.definition.model_dump(),
            created_by=user.id,
            note=form_data.note,
        )
    except ProfileError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e


@router.post('/{name}/display-name')
async def set_display_name(name: str, form_data: DisplayNameForm, user=Depends(get_admin_user)):
    entry = await _get_or_404(name)
    await BenchmarkProfiles.set_display_name(entry.profile.profile_id, form_data.display_name)
    return await _get_or_404(name)


@router.post('/{name}/default')
async def set_default(name: str, user=Depends(get_admin_user)):
    entry = await _get_or_404(name)
    try:
        await BenchmarkProfiles.set_default(entry.profile.profile_id)
    except ProfileError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    return await _get_or_404(name)


@router.post('/{name}/archive')
async def archive_profile(name: str, user=Depends(get_admin_user)):
    entry = await _get_or_404(name)
    try:
        await BenchmarkProfiles.archive(entry.profile.profile_id)
    except ProfileError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    return await _get_or_404(name)


@router.post('/{name}/unarchive')
async def unarchive_profile(name: str, user=Depends(get_admin_user)):
    entry = await _get_or_404(name)
    await BenchmarkProfiles.unarchive(entry.profile.profile_id)
    return await _get_or_404(name)
