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

## AI employees and MCP

Nothing here has a UI-free API in the docs; all of it was read out of
`@nocobase/plugin-ai` and `@nocobase/ai` on the box. Both are configured over
the ordinary REST API with the root token — there is no `nb` env for this host.

- The two collections are `aiMcpClients` (one row per MCP server, primary key
  `name`) and `aiEmployees` (primary key `username`). `aiMcpClients:update`
  then `:rebuildClient` is what makes a changed URL take effect;
  `:testConnection` takes the whole record as its body and reports the tool
  list without saving anything.
- `transport` is `stdio`, `sse` or `http`. **`http` means streamable HTTP** —
  it is the one to use for a `/mcp` endpoint, `sse` is the older protocol.
- An employee's prompt lives in `about`, not `defaultPrompt`. Without
  `modelSettings` naming an `llmServices` row it cannot answer at all — the
  employee looks configured and simply fails.
- Tools reach an employee as **`mcp-<serverName>-<toolName>`**; that is the
  name to put in `skillSettings.tools`, and `aiMcpClients:listTools` prints it.
- **MCP tool permissions are in-memory only.** They default to `ASK` unless the
  raw tool name starts with `get`, `updateToolPermission` does not persist
  them, and every restart of `nocobase.service` resets whatever was set — so an
  employee that auto-called its tools yesterday will start asking again after a
  deploy. `skillSettings.tools[].autoCall` does not override this: MCP tools
  register with `scope: GENERAL`, and `autoCall` is only consulted for
  `scope: CUSTOM`.
- **`aiMcpClients:listTools` ignores `filterByTk`.** It returns `data` as an
  object keyed by server name, each value an array of tools, so pick your own
  server out of the mapping. Each tool carries the `permission` NocoBase gave
  it — measured on this box: `get_*` tools come back `ALLOW`, everything else
  `ASK`. That is the cheapest way to confirm the naming rule above is doing
  what you think.
- **`modelSettings` holds a list**, not one model:
  `{"enabled": true, "models": [{"llmService": "<row name>", "model": "<id>"}]}`.
  The `llmServices` row name is a generated id like `v_8u1ls8vtrsz` and differs
  per installation — look it up, never hardcode it. `ai:listModels?llmService=<name>`
  lists the models a service actually exposes; there is no `aiModels:list`.
- `aiConversations:create` wants `aiEmployee` as an **object** —
  `{"aiEmployee": {"username": "dora"}}`. A bare string fails with
  `WHERE parameter "username" has invalid "undefined" value`.
- `aiConversations:sendMessages` takes `{sessionId, aiEmployee: "<username>",
  messages: [...], stream}` — note `aiEmployee` is a plain string here and an
  object in `create`. **A message's `content` must be an object**,
  `{"role": "user", "content": {"type": "text", "content": "..."}}`; passing a
  plain string stores it character-indexed as `{"0": "W", "1": "h", ...}` and
  the employee never sees the question. `stream: false` is supported and avoids
  parsing SSE.
- `aiConversations:sendMessages` **needs an `X-Timezone` header**. Without one,
  resolving the date variables in the system prompt dies with a bare
  `m.startOf is not a function` before the model is ever called — for every
  employee, which makes it look like the employee is broken.

## nginx

- Reverse proxy only. TLS is terminated by Cloudflare before the tunnel, so
  pass `X-Forwarded-Proto` from `$http_x_forwarded_proto` — inventing `https`
  or `$scheme` gives NocoBase the wrong origin for generated links.
- `proxy_buffering off` and long read timeouts: the async task manager streams
  progress, and imports and backups run for minutes.

## The supervised browser

Facts about the Chrome the `browser` role runs and the two MCP servers in front
of it. All measured on this box.

- **Ubuntu's `/etc/apparmor.d/chrome` takes Chrome's network away in this
  container.** The profile is `flags=(unconfined)` and its own comment says it
  exists only to give the binary a name, so it reads like a no-op. It is not:
  with it loaded, Chrome's browser process gets `EACCES` from
  `socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)`. Everything follows from that one
  denial — `Cannot start http server for devtools` (so no CDP port, so
  playwright-mcp exposes no tools) and every page rendering as the offline error
  page. The same user running python creates the identical socket fine, and
  Chrome installs no seccomp filter of its own, which is what rules out the
  obvious suspects. `--no-sandbox` makes no difference. The `browser` role
  disables the profile and unloads it; the sysctl the profile exists to serve
  (`apparmor_restrict_unprivileged_userns`) is 0 here, so it buys nothing.
- **`JoinsNamespaceOf` is a `[Unit]` directive.** Under `[Service]` systemd logs
  `Unknown key name ... ignoring` and silently gives the unit its own
  `PrivateTmp`. The X socket lives in `/tmp/.X11-unix`, so getting this wrong
  should break the display — it appears to work anyway because Xlib falls back
  to an abstract socket, which makes it a bug that hides.
- Chrome is headed on an Xvfb display on purpose. Headless is what Cloudflare
  challenges hardest, and a headless browser has nothing for a person to take
  over.
- **noVNC resolves its websocket `path` against the origin root, not against the
  page it was served from.** Served at `/browser/vnc.html` it still asks for
  `/websockify`, which falls through this vhost to `location /`, gets proxied to
  NocoBase, and shows in the viewer as a bare "Failed to connect to server".
  The `/browser/` redirect therefore passes `path=browser/websockify`
  explicitly — noVNC prepends the slash, so that value must not have one.
  Testing `/browser/websockify` by hand proves nothing about this: it returns
  101 either way, because it is not the path the viewer asks for.
- Chrome *does* attach cached basic-auth credentials to a same-origin WebSocket
  handshake, so one `auth_basic` on the location covers the viewer and its
  stream both. Measured: `"GET /browser/websockify" 101` logged with the
  remote user filled in.
- nginx builds `Location` from `$scheme`, and Cloudflare terminates TLS before
  the tunnel — so a redirect written the obvious way sends someone reading an
  https:// page to an http:// URL. `absolute_redirect off` inside the redirect
  locations fixes it; setting it at snippet level would change how NocoBase's
  own redirects are written, because the snippet is included in server context.
- The viewer requesting `/browser/package.json` and getting a 404 is noVNC
  probing for its own metadata. Harmless, and not worth a location block.
- **Playwright MCP answers 403 to every request unless `--allowed-hosts` carries
  the port.** Given `--host 127.0.0.1` it normalises the bound address to
  `localhost` and then rejects `Host: 127.0.0.1:8813`, which is exactly what
  NocoBase sends. Pass `127.0.0.1:8813,localhost:8813`.
- `browser_navigate` does **not** return the page text — it writes the snapshot
  to the output directory and returns a link to a path on the box, which is
  worth nothing to a remote client. Only `browser_snapshot` returns it inline.
  `lex-mcp` therefore reads pages with a fixed script instead.
- `browser_click` and `browser_type` take **`target`**, not `ref` — and a CSS
  selector works there as well as a snapshot ref, which is worth preferring
  because refs are renumbered whenever the page changes.
- **lex.bg serves failure pages with HTTP 200.** Three seen: a PHP/MySQL error
  (it runs PHP 5.6), a bare `Please, try later` throttle, and a near-empty body.
  None means the law is absent, and an employee that reads one as "not found"
  gives a wrong legal answer rather than no answer — `lex-mcp` detects all three
  and says so.
- **lex.bg's own search is unreliable**: it answers `Няма резултати от
  търсенето!` for `Конституция`. The structured trees
  (`/laws/tree/laws`, `/laws/tree/code`) are the real way in, and documents live
  at `/laws/ldoc/<id>` — the Constitution is `/laws/ldoc/521957377`.
- The Cloudflare clearance is an HttpOnly cookie in the profile's `Cookies`
  database. It survives a restart of both Chrome and the MCP servers, which is
  what makes "a person clicks the checkbox once" worth building.
