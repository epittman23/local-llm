---
name: new-migration
description: Add an Alembic revision to this repo's append-only schema, including a benchmark_schema_note row when a change makes config_ids incomparable. Use whenever a SQLAlchemy model in apps/server/local_llm/models changes, a table or column is added, or the database needs to record a discontinuity.
---

# new-migration

The rule is in `AGENTS.md`, "Maintenance policy": the schema is
append-only. Add a revision; **never edit one already in
`apps/server/local_llm/migrations/versions/`**. The PR gate trips on any
edit there. A fix to a bad migration is a new revision.

Migrations run on their own when the backend starts
(`config.py`, `run_migrations()`, `upgrade head`), so a broken revision
stops `make backend`.

## Steps

1. Find the current head, which is the new revision's `down_revision`.
   It is the revision no other file names as its `down_revision`. This
   needs no environment. `alembic heads` does: three revisions import
   `local_llm`, which loads the app's config and requires `LLLM_SECRET_KEY`.

   ```sh
   cd apps/server/local_llm/migrations/versions
   comm -23 <(grep -h '^revision' *.py | grep -o "'[0-9a-f]\{12\}'" | sort) \
            <(grep -h '^down_revision' *.py | grep -o "'[0-9a-f]\{12\}'" | sort -u)
   ```

   It must print exactly one id.
2. Write the file by hand in `migrations/versions/`, named
   `<12 hex chars>_<what_it_does>.py`, with the docstring, `revision`,
   `down_revision`, `upgrade()` and `downgrade()` the existing files use.
   Make `upgrade()` safe to re-run where the existing files are (they check
   before they insert or create).
3. Change the model in `local_llm/models/` to match. `tests/test_schema_drift.py`
   migrates a fresh database and compares every model against it. Any new
   difference fails.
4. **If the change alters what `config_id` covers** (see the
   `serving-change` skill), the revision also inserts a
   `benchmark_schema_note` row saying what changed and that ids either side
   are not comparable. Copy the shape of `f4b6d2e8a913_note_fingerprint_model_extra_fit.py`:
   - a `SCHEMA_NOTE` constant;
   - an insert of `noted_on` (absolute date) and `note`, guarded by a count;
   - a `downgrade()` that deletes exactly that row.
5. Run the tests that need a database. `make test-backend` starts the
   throwaway pgvector Postgres those tests need, and without it they skip
   locally while CI fails. For a quicker loop, see `docs/guides/testing.md`,
   which covers `TEST_DATABASE_URL` and `test_schema_drift.py`.
6. If the change fixes an inherited drift entry, shrink
   `tests/fixtures/schema_drift.json` with `SCHEMA_DRIFT_RECORD=1`. The
   gate lets that file shrink without approval and trips when it grows
   (`SHRINK_ONLY` in `pr_gate.py`).
7. Update the docs (use the `docs-sync` skill).
