# supabase/

The only migration directory for the `core` and `studio` schemas
(`docs/data-model.md` § 1). `DATA_SOURCE=fixture` needs none of this; apply
it when a real Supabase project is wired up.

```
supabase/
  migrations/0001_init.sql   schemas, enums, tables, triggers, functions, RLS, storage
  seed.sql                   the pilot producer 星海影视 (matches FIXTURE_PRODUCER_ID)
```

## Apply

Either path applies `0001_init.sql` in one pass (it is one transaction;
under `supabase db push`, which wraps the file itself, the inner `begin;`
only prints "there is already a transaction in progress").

**SQL editor.** Dashboard → SQL Editor → paste the file → Run. Then paste
and run `seed.sql`. Notices (`extension "pgcrypto" already exists`, the
storage block) are fine; an error rolls the whole file back.

**CLI.**

```
supabase link --project-ref <ref>
supabase db push                       # applies supabase/migrations/*
psql "$SUPABASE_DB_URL" -f supabase/seed.sql
```

Then, in **Settings → API → Exposed schemas**, add `core` and `studio`
(keep `public`). A schema that is not exposed returns empty results, not an
error, so do this before wondering why `/titles` is blank. Every client
call names its schema: `supabase.schema("studio").from("versions")`.

If the storage block printed a notice instead of creating the policies
(the migrating role is not the owner of `storage.objects` on some
projects), create the four private buckets — `studio-imports`,
`studio-media`, `studio-exports`, `studio-evidence` — in Dashboard →
Storage, and add the policies from section 11 of `0001_init.sql` through
Storage → Policies. Objects live under `<title_id>/<episode_id>/...`;
reads follow `core.can_read_title` on the first path segment, writes are
staff only, `studio-evidence` is staff only for everything.

## Users

`core.profiles` is the role model (1:1 with `auth.users`); nothing syncs it.
Invite the user (Authentication → Users → Invite, or a magic link), copy
the auth user id, then insert the profile. Two rows are enough for the
pilot — one staff admin, one producer approver for the seeded producer:

```sql
insert into core.profiles (id, kind, staff_role, display_name)
values ('<auth user id of the staff admin>', 'staff', 'admin', 'Ruobin');

insert into core.profiles (id, kind, producer_id, producer_role, display_name, locale)
values ('<auth user id of the partner>', 'producer',
        '00000000-0000-4000-8000-000000000001', 'approver', '陈总', 'zh');
```

`locale` may stay null: the route group decides (`app/(admin)` en,
`app/(producer)` zh, the `pulsar_studio_locale` cookie wins). A user with
no profile row can sign in but sees nothing (the login flow turns that into
a readable error).

## Ingest an episode

Subtitle files are the primary ingest. The CLI parses first, writes only
with `--write`, and writes through the service-role client (bypasses RLS —
the reason it lives in `scripts/` and not in a route):

```
# dry run: format, lines, scenes, warnings
node --import tsx scripts/ingest-episode.ts path/to/ep01.srt

# write: needs DATA_SOURCE=supabase, NEXT_PUBLIC_SUPABASE_URL and
# SUPABASE_SERVICE_ROLE_KEY in .env.local, and an existing title
node --import tsx scripts/ingest-episode.ts path/to/ep01.srt --title <title uuid> --episode 1 --write
```

Create the title first (`/titles/new`, or an insert into `core.titles` plus
one `studio.adaptations` row for it). The script inserts `core.episodes`,
`studio.scenes`, `studio.lines` and upserts `studio.characters` from the
speaker labels.

## What the migration defines

Functions callable through PostgREST (`supabase.schema("studio").rpc(name,
{ p_... })`); each checks the caller itself and writes a `core.audit_events`
row in the same transaction:

| Function | Caller | Returns |
|---|---|---|
| `studio.submit_version(p_version_id)` | staff | version uuid; draft → in_review, writes snapshot + sha256 |
| `studio.decide_scene(p_version_id, p_scene_id, p_decision, p_note?, p_channel?)` | producer approver/reviewer of the title, or staff admin with a note | the decision row as jsonb |
| `studio.approve_version(p_version_id, p_mode?, p_evidence?, p_note?, p_channel?)` | `in_app`: producer approver; `on_behalf`: staff admin + evidence | version uuid; in_review → approved |
| `studio.fork_version(p_version_id)` | staff | the new draft's uuid |
| `studio.choose_alternative(p_alternative_id)` | staff | adapted line uuid |
| `studio.select_variant(p_variant_id)` | staff | variant uuid |
| `studio.set_scene_status(p_scene_id, p_status)` | staff | scene uuid |
| `studio.build_snapshot(p_version_id)` | staff | the snapshot jsonb (also for a draft, so the "current draft" export has the same shape) |

The snapshot hash is `sha256(snapshot::text)` over the stored jsonb's
canonical text; recompute it the same way (`select encode(sha256(convert_to(
snapshot::text, 'UTF8')), 'hex')`) rather than from a JavaScript
serialisation.

Column-level grants for `authenticated` (staff under RLS): `versions` —
insert `(title_id, adaptation_id, episode_id, number, parent_version_id)`,
no direct update; `scenes` — no `status_by` / `status_at`; `line_alternatives`
— no `chosen*`; `variants` — no `selected`; `scene_decisions` and
`audit_events` — read only. Let the defaults mint `id` and `external_id`.

## Deviations from docs/data-model.md

- `core.current_uid()` replaces `auth.uid()` inside the functions (same JWT
  expression) so `studio_owner` needs no grant on the `auth` schema.
- `core.ext_id()` takes its 64 random bits from `gen_random_uuid()` rather
  than `gen_random_bytes()`; pgcrypto is still created but not depended on.
- Four storage buckets (`studio-imports`, `studio-media`, `studio-exports`,
  `studio-evidence`) as the build brief asked, not the doc's one.
- `core.producers.slug` has a random default so `POST /api/producers`
  (which sends no slug) works.
- `studio.versions`: no UPDATE for `authenticated` at all (the doc revokes
  the status/approval/snapshot columns; nothing else is a legitimate direct
  edit). INSERT is column-listed for the same reason.
- `studio.jobs`: staff get INSERT/UPDATE/DELETE, not only SELECT — V1 runs
  jobs inline in route handlers under the staff session.
- `submit_version` does not require `back_translation_zh` on `cut` lines
  (there is no English to translate back); `rationale_zh` is still required.
- A version that has left `draft` cannot be deleted (so a title with a
  submitted version cannot be deleted either); `superseded` is terminal.
- `studio.set_scene_status()` exists as the audited path; a plain UPDATE of
  `scenes.status` under RLS is still allowed as the doc says.
