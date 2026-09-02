# NocoBase

Facts that were expensive to establish. Check them before changing the
`nocobase` role or the data playbooks.

## Install

- Installed with `create-nocobase-app`, not Docker. The container has no Docker
  and nesting is off; do not reintroduce it.
- **`create-nocobase-app@X` writes its own version into the generated
  `package.json` as the `@nocobase/app` dependency.** Pinning
  `nocobase_version` therefore pins the NocoBase release. There is no separate
  version to set.
- Requires Node >= 22 and **Yarn 1.22.x** — not berry.
- `npm install -g` puts binaries in the *versioned* node prefix, not on `PATH`.
  The role symlinks `yarn` into `/usr/local/bin` itself.
- Install into `/data`, never `/` — see the disk note in [CLAUDE.md](../../CLAUDE.md).

## What is and is not idempotent

- `yarn nocobase install` and `pm enable` converge, but log the same `success`
  whether or not they did anything. There is nothing in the output to base
  `changed_when` on, so both are `changed_when: false`.
- `yarn install` reruns the postinstall build every time and never prints
  "Already up-to-date". Use the checksum of `node_modules/.yarn-integrity`
  before and after as the change signal.

## Backup and restore

- `@nocobase/plugin-backups` (v2 format) and the older
  `@nocobase/plugin-backup-restore` both ship in the preset and **both register
  a `restore` command**. Only the former reads a v2 `.nbdata`, so it is the one
  the role enables.
- **`restore` is the only CLI command.** There is no `nocobase backup` — taking
  one goes through the `backup` resource over the API (`backup:create`, then
  poll `backup:status`).
- A `.nbdata` is a zip: `_metadata.json`, a `pg_dump` custom archive, and
  `uploads/`. `unzip -p <file> _metadata.json` reads the metadata without
  restoring, which is how the play checks compatibility up front.
- **pg_restore must not be older than the archive.** The published CRM template
  is a v1.16 archive written by pg_dump 17, which `postgresql-client-16` cannot
  read at all. Ubuntu 24.04 ships 16 only, so the client comes from PGDG.
- Backup Manager rejects a backup taken on a **higher** major Postgres than the
  target and allows the reverse. The installation docs say the versions "must
  match"; the code does not. Restoring the template's 16 into the box's 18 is
  fine.
- Restoring an archive from an older NocoBase leaves the schema behind the
  code — **run `yarn nocobase upgrade` afterwards**, or the app comes back in
  maintenance mode with a bare `column "invalid" does not exist`.
- **A restore replaces the users table.** After the CRM template the superuser
  is the published default `admin@nocobase.com` / `admin123`. `restore.yml`
  puts the configured account back as part of the restore; keep it that way.
- The template references ~119 plugins, many of them commercial. On this
  installation those log `Cannot find plugin` during migration and their menu
  entries are absent. Expected, and documented by NocoBase.

## nginx

- Reverse proxy only. TLS is terminated by Cloudflare before the tunnel, so
  pass `X-Forwarded-Proto` from `$http_x_forwarded_proto` — inventing `https`
  or `$scheme` gives NocoBase the wrong origin for generated links.
- `proxy_buffering off` and long read timeouts: the async task manager streams
  progress, and imports and backups run for minutes.
