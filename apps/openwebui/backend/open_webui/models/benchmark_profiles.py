import logging
import time
from typing import Optional

from open_webui.benchmarks.serving.profiles import (
    ProfileError,
    ServingProfile,
    validate_definition,
)
from open_webui.internal.db import Base, get_async_db_context
from pydantic import BaseModel, ConfigDict
from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    func,
    select,
    text,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)


####################
# Benchmark Serving Profile DB Schema
#
# The serving profiles used to live in local-llm's scripts/shell/main.sh
# (`_lllm_profile`), and this app shelled out to read them. They are rows
# now, in two tables:
#
#   benchmark_profile          a stable identity: the immutable `name` the
#                              tuning search spaces are keyed by, plus how the
#                              profile is presented (display name, default,
#                              archived).
#   benchmark_profile_version  an append-only history of what the profile
#                              serves. Editing a profile inserts a version;
#                              nothing here is ever updated or deleted.
#
# Why versioned rather than updated in place: benchmark_config.config_text
# already records the six fingerprinted lines of every configuration that
# was actually served, but a profile carries more than those lines -- the
# weights path, the Hugging Face repo and download pattern, the rationale
# notes -- and none of that is fingerprinted. Updating in place would lose it
# on every edit. benchmark_run.profile_version_id records which version a run
# served, so the complete definition behind any measurement stays
# recoverable.
#
# A profile version and a config_id are orthogonal on purpose. Editing only
# the weights path or the notes produces a new version with the *same*
# config_id, correctly: nothing about the served configuration changed.
####################


class BenchmarkProfile(Base):
    __tablename__ = 'benchmark_profile'
    profile_id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(Text, nullable=False, unique=True)
    display_name = Column(Text, nullable=False)
    is_default = Column(Boolean, nullable=False, default=False)
    created_at = Column(BigInteger, nullable=False)
    archived_at = Column(BigInteger, nullable=True)

    __table_args__ = (
        # At most one default, enforced by the database rather than by every
        # caller remembering to clear the old one first.
        Index(
            'ux_benchmark_profile_default',
            'is_default',
            unique=True,
            postgresql_where=text('is_default'),
            sqlite_where=text('is_default'),
        ),
    )


class BenchmarkProfileVersion(Base):
    __tablename__ = 'benchmark_profile_version'
    version_id = Column(Integer, primary_key=True, autoincrement=True)
    profile_id = Column(Integer, ForeignKey('benchmark_profile.profile_id'), nullable=False)
    version = Column(Integer, nullable=False)
    created_at = Column(BigInteger, nullable=False)
    created_by = Column(Text, nullable=True)
    note = Column(Text, nullable=True)

    arch = Column(Text, nullable=False)
    alias = Column(Text, nullable=False)
    # May contain the literal `{LLAMA_MODELS}`, resolved against the serving
    # host's LLAMA_MODELS at launch, so a row does not bake in one machine's
    # home directory. The path is not fingerprinted either way.
    model_path = Column(Text, nullable=False)
    hf_repo = Column(Text, nullable=False, server_default='')
    hf_pattern = Column(Text, nullable=False, server_default='')
    ctx = Column(Integer, nullable=False)
    threads = Column(Integer, nullable=False)
    ngl = Column(Integer, nullable=False)
    moe = Column(Integer, nullable=True)
    override_tensors = Column(Text, nullable=True)
    parallel = Column(Integer, nullable=False, server_default='1')
    cache_k = Column(Text, nullable=False, server_default='q8_0')
    cache_v = Column(Text, nullable=False, server_default='q8_0')
    batch = Column(Integer, nullable=False, server_default='512')
    ubatch = Column(Integer, nullable=False, server_default='512')
    spec = Column(JSON, nullable=False)
    samplers = Column(JSON, nullable=False)
    # llama-server arguments beyond the modelled fields. The thinking budget
    # is NOT one of them: it is `reasoning_effort_default`, and the launcher
    # builds --chat-template-kwargs from the *resolved* effort. A literal
    # reasoning_effort here would fingerprint as the override but launch as
    # the literal -- exactly the served-flags/recorded-flags disagreement the
    # fingerprint exists to rule out.
    extra = Column(JSON, nullable=False)
    reasoning_effort_default = Column(Text, nullable=True)
    notes = Column(Text, nullable=False, server_default='')

    __table_args__ = (
        UniqueConstraint('profile_id', 'version', name='uq_benchmark_profile_version'),
        CheckConstraint("arch IN ('dense','moe')", name='ck_benchmark_profile_version_arch'),
        # The shell's --n-cpu-moe guard rail, at the schema level: a dense
        # model has no experts, so a dense definition carrying one is invalid.
        CheckConstraint("arch <> 'dense' OR moe IS NULL", name='ck_benchmark_profile_version_dense_moe'),
    )


class BenchmarkProfileModel(BaseModel):
    profile_id: int
    name: str
    display_name: str
    is_default: bool
    created_at: int
    archived_at: Optional[int] = None

    model_config = ConfigDict(from_attributes=True)


class BenchmarkProfileVersionModel(BaseModel):
    version_id: int
    profile_id: int
    version: int
    created_at: int
    created_by: Optional[str] = None
    note: Optional[str] = None
    arch: str
    alias: str
    model_path: str
    hf_repo: str = ''
    hf_pattern: str = ''
    ctx: int
    threads: int
    ngl: int
    moe: Optional[int] = None
    override_tensors: Optional[str] = None
    parallel: int = 1
    cache_k: str = 'q8_0'
    cache_v: str = 'q8_0'
    batch: int = 512
    ubatch: int = 512
    spec: list[str]
    samplers: list[str]
    extra: list[str]
    reasoning_effort_default: Optional[str] = None
    notes: str = ''

    model_config = ConfigDict(from_attributes=True)


class BenchmarkProfileEntry(BaseModel):
    """A profile's identity together with its current (latest) version."""

    profile: BenchmarkProfileModel
    version: BenchmarkProfileVersionModel

    def to_serving_profile(self) -> ServingProfile:
        return to_serving_profile(self.profile.name, self.version)


def to_serving_profile(name: str, version: BenchmarkProfileVersionModel) -> ServingProfile:
    return ServingProfile.from_definition(name, version.model_dump())


class BenchmarkProfileTable:
    @staticmethod
    async def _latest_versions(db: AsyncSession, profile_ids: list[int]) -> dict[int, BenchmarkProfileVersion]:
        """Each profile's highest version. A Python group-by over one query,
        per this schema's convention of keeping derived views out of the
        database (see BenchmarkRunTable.get_latest_run_per_config)."""
        if not profile_ids:
            return {}
        result = await db.execute(
            select(BenchmarkProfileVersion)
            .filter(BenchmarkProfileVersion.profile_id.in_(profile_ids))
            .order_by(BenchmarkProfileVersion.profile_id, BenchmarkProfileVersion.version.desc())
        )
        latest: dict[int, BenchmarkProfileVersion] = {}
        for row in result.scalars().all():
            latest.setdefault(row.profile_id, row)
        return latest

    @classmethod
    async def _entries(cls, db: AsyncSession, profiles: list[BenchmarkProfile]) -> list[BenchmarkProfileEntry]:
        latest = await cls._latest_versions(db, [p.profile_id for p in profiles])
        entries = []
        for profile in profiles:
            version = latest.get(profile.profile_id)
            if version is None:  # a profile is always created with version 1
                log.warning('benchmark profile %r has no versions; skipping', profile.name)
                continue
            entries.append(
                BenchmarkProfileEntry(
                    profile=BenchmarkProfileModel.model_validate(profile),
                    version=BenchmarkProfileVersionModel.model_validate(version),
                )
            )
        return entries

    async def list_profiles(
        self, *, include_archived: bool = False, db: Optional[AsyncSession] = None
    ) -> list[BenchmarkProfileEntry]:
        async with get_async_db_context(db) as db:
            query = select(BenchmarkProfile).order_by(BenchmarkProfile.profile_id)
            if not include_archived:
                query = query.filter(BenchmarkProfile.archived_at.is_(None))
            result = await db.execute(query)
            return await self._entries(db, list(result.scalars().all()))

    async def get_by_name(self, name: str, db: Optional[AsyncSession] = None) -> Optional[BenchmarkProfileEntry]:
        async with get_async_db_context(db) as db:
            result = await db.execute(select(BenchmarkProfile).filter_by(name=name))
            profile = result.scalars().first()
            entries = await self._entries(db, [profile]) if profile else []
            return entries[0] if entries else None

    async def get_default(self, db: Optional[AsyncSession] = None) -> Optional[BenchmarkProfileEntry]:
        async with get_async_db_context(db) as db:
            result = await db.execute(
                select(BenchmarkProfile).filter(
                    BenchmarkProfile.is_default.is_(True), BenchmarkProfile.archived_at.is_(None)
                )
            )
            profile = result.scalars().first()
            entries = await self._entries(db, [profile]) if profile else []
            return entries[0] if entries else None

    async def get_version(
        self, version_id: int, db: Optional[AsyncSession] = None
    ) -> Optional[BenchmarkProfileVersionModel]:
        async with get_async_db_context(db) as db:
            result = await db.execute(select(BenchmarkProfileVersion).filter_by(version_id=version_id))
            row = result.scalars().first()
            return BenchmarkProfileVersionModel.model_validate(row) if row else None

    async def list_versions(
        self, profile_id: int, db: Optional[AsyncSession] = None
    ) -> list[BenchmarkProfileVersionModel]:
        async with get_async_db_context(db) as db:
            result = await db.execute(
                select(BenchmarkProfileVersion)
                .filter_by(profile_id=profile_id)
                .order_by(BenchmarkProfileVersion.version.desc())
            )
            return [BenchmarkProfileVersionModel.model_validate(row) for row in result.scalars().all()]

    async def create(
        self,
        *,
        name: str,
        display_name: str,
        definition: dict,
        created_by: Optional[str] = None,
        note: Optional[str] = None,
        db: Optional[AsyncSession] = None,
    ) -> BenchmarkProfileEntry:
        definition = validate_definition(definition)
        now = int(time.time())
        async with get_async_db_context(db) as db:
            profile = BenchmarkProfile(name=name, display_name=display_name, is_default=False, created_at=now)
            db.add(profile)
            await db.flush()
            db.add(
                BenchmarkProfileVersion(
                    profile_id=profile.profile_id,
                    version=1,
                    created_at=now,
                    created_by=created_by,
                    note=note,
                    **definition,
                )
            )
            await db.commit()
            return (await self._entries(db, [profile]))[0]

    async def add_version(
        self,
        profile_id: int,
        *,
        definition: dict,
        created_by: Optional[str] = None,
        note: Optional[str] = None,
        db: Optional[AsyncSession] = None,
    ) -> BenchmarkProfileVersionModel:
        """Record a new definition. The only way a profile's settings change.

        Two concurrent edits both computing the same next version number are
        stopped by uq_benchmark_profile_version rather than by a lock: one
        commits, the other fails loudly instead of silently overwriting.
        """
        definition = validate_definition(definition)
        async with get_async_db_context(db) as db:
            result = await db.execute(
                select(func.max(BenchmarkProfileVersion.version)).filter_by(profile_id=profile_id)
            )
            current = result.scalar()
            if current is None:
                raise ProfileError(f'no benchmark profile with id {profile_id}')
            row = BenchmarkProfileVersion(
                profile_id=profile_id,
                version=current + 1,
                created_at=int(time.time()),
                created_by=created_by,
                note=note,
                **definition,
            )
            db.add(row)
            await db.commit()
            await db.refresh(row)
            return BenchmarkProfileVersionModel.model_validate(row)

    async def set_display_name(self, profile_id: int, display_name: str, db: Optional[AsyncSession] = None) -> None:
        async with get_async_db_context(db) as db:
            await db.execute(
                update(BenchmarkProfile).filter_by(profile_id=profile_id).values(display_name=display_name)
            )
            await db.commit()

    async def set_default(self, profile_id: int, db: Optional[AsyncSession] = None) -> None:
        async with get_async_db_context(db) as db:
            result = await db.execute(select(BenchmarkProfile).filter_by(profile_id=profile_id))
            profile = result.scalars().first()
            if profile is None:
                raise ProfileError(f'no benchmark profile with id {profile_id}')
            if profile.archived_at is not None:
                raise ProfileError('an archived profile cannot be the default')
            # Clear, then set, in one transaction: the partial unique index is
            # checked per statement, so this order never has two defaults.
            await db.execute(
                update(BenchmarkProfile).filter(BenchmarkProfile.is_default.is_(True)).values(is_default=False)
            )
            await db.execute(update(BenchmarkProfile).filter_by(profile_id=profile_id).values(is_default=True))
            await db.commit()

    async def archive(self, profile_id: int, db: Optional[AsyncSession] = None) -> None:
        """Hide a profile from pickers. Never a delete: runs reference its versions."""
        async with get_async_db_context(db) as db:
            result = await db.execute(select(BenchmarkProfile).filter_by(profile_id=profile_id))
            profile = result.scalars().first()
            if profile is None:
                raise ProfileError(f'no benchmark profile with id {profile_id}')
            if profile.is_default:
                raise ProfileError('the default profile cannot be archived; set another default first')
            profile.archived_at = int(time.time())
            await db.commit()

    async def unarchive(self, profile_id: int, db: Optional[AsyncSession] = None) -> None:
        async with get_async_db_context(db) as db:
            await db.execute(update(BenchmarkProfile).filter_by(profile_id=profile_id).values(archived_at=None))
            await db.commit()


BenchmarkProfiles = BenchmarkProfileTable()
