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
| TLS | terminated by Cloudflare for SaaS; nginx sees plain HTTP on `:80` |

## Layout

| path | what |
|---|---|
| `Justfile` | every command — setup, checks, deploy, data operations. CI calls these, not raw ansible |
| `ansible/playbook.yml` | **setup only**: `nodejs` → `nocobase` → `nginx` |
| `ansible/backup.yml` | take a backup and fetch it to `./backups` |
| `ansible/restore.yml` | restore a `.nbdata`, including the CRM template |
| `ansible/upgrade.yml` | move to a new release and run its migrations |
| `ansible/roles/*` | one role per concern (`nginx`, `nodejs`, `nocobase`) |
| `ansible/inventory.yml` | host details come from env vars, nothing committed |
| `.github/workflows/deploy.yml` | runs `playbook.yml` on push to `main` touching `ansible/`, `Justfile`, or itself |
| `.env.example` | copy to `.env`; `.env` and `./backups/` are gitignored |

## Commands

```bash
just check                      # tools, key, connectivity — run this first when something breaks
just deploy-ansible [--lan]     # setup playbook; never touches data
just logs [--lan]               # tail the nocobase journal
```

Data operations are deliberately separate from deploy — a routine deploy can
never move or overwrite the database:

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
