# deepcraft-nocobase

Ansible automation for a single VM — `nocobase-lxc`, an unprivileged LXC
container at `192.168.1.5:22022`, hardened by `homelab-infra`. It runs
**NocoBase 2.2.6** with the **CRM 2.0** template, served at
<https://ownai.deepcraftstudio.com>.

Everything is driven through `just`; CI runs the same recipes.

## The box

| | |
|---|---|
| OS | Ubuntu 24.04, LXC, x86_64, 4G RAM |
| **`/` is 20G — do not install into it** | `/data` is a separate 49G volume, and NocoBase lives at `/data/nocobase` |
| Node | installed by the `nodejs` role from the nodejs.org tarball, current LTS |
| Database | **external** Postgres 18 at `192.168.1.4:5432`, not on this box |
| Docker | not installed and not wanted — everything runs natively under systemd |
| Process | `nocobase.service`, running `yarn start` as the `nocobase` user |
| WebDAV | `/data/webdav` served by the same nginx at `/webdav/`, basic auth from `/etc/nginx/webdav.htpasswd`. Accounts are runtime state — `just webdav-user-*`, never the playbook. Uploads cap at 100 MB (Cloudflare), not at nginx |
| Documents | `docs-mcp` on `127.0.0.1:8812` indexes the share and serves it to the **Dora** AI employee over MCP — reads pdf/docx/xlsx/pptx and the legacy binary formats, writes docx/xlsx/text. Hybrid search: SQLite FTS5 plus a local `multilingual-e5-small` model, so no document text leaves the box. Wiring is runtime state — `just docs-employee`. No OCR, so a scanned PDF is reported unreadable, not silently indexed empty |
| Browser | real Google Chrome, headed, on an Xvfb display, profile at `/data/chrome/profile`. Long-lived on purpose: lex.bg is behind Cloudflare, and a challenge can only be answered by a person. `x11vnc` → `websockify` → nginx `/browser/` publishes the live window, basic auth from `/etc/nginx/browser.htpasswd`. Also accepts `?token=<base64 user:pass>`, exchanged once for a `HttpOnly` cookie so the token reaches no later URL — that is what lets Lexy hand out a one-click link. Accounts and tokens are runtime state — `just browser-user-*` and `just browser-link`, never the playbook |
| Law | `playwright-mcp` on `127.0.0.1:8813` attaches to that Chrome over CDP; `lex-mcp` on `:8814` proxies it and is what the **Lexy** AI employee actually sees. The proxy exists to rename tools to `get_*` — see the permission note in [nocobase.md](.claude/rules/nocobase.md) — and to turn a Cloudflare challenge into instructions a person can act on. Wiring is runtime state — `just lexy-employee` |
| TLS | terminated by Cloudflare for SaaS; nginx sees plain HTTP on `:80` |

## Layout

| path | what |
|---|---|
| `Justfile` | every command — setup, checks, deploy, data operations. CI calls these, not raw ansible |
| `ansible/playbook.yml` | **setup only**: `nodejs` → `nocobase` → `ciela_mcp` → `whisper` → `nginx` → `webdav` → `docs_mcp` → `browser` → `playwright_mcp` → `lex_mcp` |
| `ansible/backup.yml` | take a backup and fetch it to `./backups` |
| `ansible/restore.yml` | restore a `.nbdata`, including the CRM template |
| `ansible/upgrade.yml` | move to a new release and run its migrations |
| `ansible/roles/*` | one role per concern (`browser`, `ciela_mcp`, `docs_mcp`, `lex_mcp`, `nginx`, `nodejs`, `nocobase`, `playwright_mcp`, `webdav`, `whisper`) |
| `mcp_servers/*` | MCP servers the AI employees call; the `ciela_mcp`, `docs_mcp` and `lex_mcp` roles ship `ciela-mcp`, `docs-mcp` and `lex-mcp` to the box. `playwright-mcp` is upstream's server, pinned by a lockfile and nothing else |
| `ansible/inventory.yml` | host details come from env vars, nothing committed |
| `.github/workflows/deploy.yml` | runs `playbook.yml` on push to `main` touching `ansible/`, `Justfile`, or itself |
| `.env.example` | copy to `.env`; `.env` and `./backups/` are gitignored |

## Commands

```bash
just check                      # tools, key, connectivity — run this first when something breaks
just deploy-ansible [--lan]     # setup playbook; never touches data
just logs [--lan]               # tail the nocobase journal
just smoke                      # load every admin page in a browser; no SSH needed
```

Data operations are deliberately separate from deploy — a routine deploy can
never move or overwrite the database:

The document employee's wiring lives in the database, so it is runtime state
too — and re-running the recipe is how a changed prompt gets applied:

```bash
just docs-employee              # register docs-mcp and create/refresh Dora
just docs-status                # what is indexed; whether the model is loaded
just logs-docs                  # tail the docs-mcp journal
```

Share accounts are managed outside the playbook, because CI applies it on every
push and would delete anything it declared:

```bash
just webdav-users               # who can mount the share
just webdav-user-add NAME       # create an account, or reset its password
just webdav-user-remove NAME    # revoke access; uploaded files are kept
```

```bash
just backup                     # fetches a .nbdata into ./backups
just restore backups/<file>     # replaces the whole database
just restore-crm-template       # installs the published CRM 2.0 template
just upgrade 2.3.0              # backs up, migrates, restarts
```

Add `--lan` on the home network to skip WARP. Never invoke `ansible-playbook`
directly — the recipes write the SSH key, join WARP and export the inventory
and database variables from `.env`.

## Rules

@.claude/rules/commits.md
@.claude/rules/ansible.md
@.claude/rules/nocobase.md
@.claude/rules/secrets.md
