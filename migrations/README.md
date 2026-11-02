# Migrations

Numbered SQL files, applied in order by `npm run migrate` (`scripts/migrate.ts`). Each file wraps
its statements in `BEGIN` / `COMMIT`; applied versions are recorded in `schema_migrations`.

## Every migration must work with the previous release's code

A failed deploy rolls back the code, not the schema (`scripts/deploy.sh`): if the health check
fails after a migration ran, the previous release runs against the migrated database.

- Add first, remove later. Add the new column or table in one release; stop reading the old one in
  that release; drop or rename it in a later release (as `028_export_url_clear` and
  `029_export_url_column_drop` did).
- A new `NOT NULL` column needs a default, so the previous code's inserts still work.
- Don't change the meaning of an existing column in place.
