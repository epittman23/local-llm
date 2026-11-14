---
name: ui-standard
description: Check a change to the interface against this repo's interface standard (docs/guides/ui-standard.md) before committing - dark first, two widths, keyboard, the four data states, the words - and keep the standard, its tokens and the /ui demo page in step. Use for any change under apps/web/src or apps/desktop that alters what a page looks like or how it behaves, and for any change to the standard itself.
---

# ui-standard

The rules are in `docs/guides/ui-standard.md`. Read it; this skill is only
the procedure for applying it to the change in hand. `/ui` in the running
app shows the rules on the shared components; each of its sections lists
the rules it shows.

## Before writing

1. Find the pattern on `/ui` (`apps/web/src/routes/ui/`) that matches what
   you are building: a form, a table, a confirmation, an empty state. Build
   it the same way, from the shared components in `components/ui` and the
   `Field` and `PageHeader` patterns.
2. Use tokens (`apps/web/src/styles/standard.css`), never values. If the
   standard has no token, size or pattern for what you need, add it to the
   document, to `standard.css` (both themes) and to `/ui` in this change,
   and say so in the pull request.

## Before committing

1. Scan your own diff for what the standard forbids:

   ```
   git diff origin/main... -- apps/web/src | grep -nE '^\+.*(bg-white|bg-black|text-black|text-white|(bg|text|border)-(gray|neutral|zinc|slate|stone)-[0-9]|#[0-9a-fA-F]{3,8}\b|text-\[[0-9.]+(px|rem)\]|outline-none|opacity-(50|60|70)|foreground/[0-9]+|<button)'
   ```

   Each hit is a rule to check (COL-1, COL-2, TYP-2, A11Y-1, ACT-6), not
   automatically a fault: read it.
2. See it rendered. Build (`cd apps/web && bun run build`), run the backend,
   and look at every state you touched **in dark first**, then light, at
   1440 px and 390 px wide. Take screenshots; look at them.
3. Use it from the keyboard only: Tab order, a visible focus indicator on
   every stop, Escape closes one layer, focus returns to the trigger.
4. For anything that shows data, see loading, empty, failed and full.
5. Read every string you added against the Words rules.
6. `cd apps/web && bunx vitest run src/styles src/routes/ui` when the
   tokens or `/ui` changed; `make test-web` before the pull request.

## In the pull request

Name the rules the change was checked against, attach the dark screenshots,
and state any rule you departed from and why. If the change fixes one of
the review issues (#901 to #1115), say which rule it now meets.
