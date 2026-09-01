# deepcraft-nocobase

Deploys to `nocobase-lxc`, hardened by
[homelab-infra](https://github.com/kalpak44/homelab-infra).

## What's here

| | |
|---|---|
| `ansible/` | all ansible scripts |
| `.github/workflows/deploy.yml` | github pipeline, deploys on push to main |
| `Justfile` | the deploy commands — CI runs the same ones |

## Access

| | |
|---|---|
| Internet | <https://deepcraft-nocobase.pavel-usanli.online> |
| Home LAN | <http://192.168.1.5/> |

## Deploying

Push to `main` touching `ansible/**`, or run the **Deploy** workflow manually from
the Actions tab.

```
GitHub runner → WARP → Cloudflare → tunnel → 192.168.1.5:22022
```

Run it yourself:

```bash
export NOCOBASE_HOST=192.168.1.5 NOCOBASE_SSH_PORT=22022 NOCOBASE_SSH_USER=root
export NOCOBASE_SSH_PRIVATE_KEY="$(cat /path/to/id_ed25519)"

just apply     # on the home LAN
just deploy    # off-LAN: connects WARP first
just doctor    # when something breaks
```

`just list` shows everything. The deploy key comes from `homelab-infra` —
`just output proxmox nocobase-lxc ssh_private_key`.

## SSH access

On the home LAN:

```bash
ssh -p 22022 root@192.168.1.5
```

From anywhere else you need the WARP client, because `192.168.1.5` is not routable
from the internet:

1. Install [Cloudflare WARP](https://one.one.one.one/) — or `brew install --cask cloudflare-warp` on macOS.
2. Open it, go to **Preferences → Account → Login with Cloudflare Zero Trust**.
3. Enter the team name: **`proud-block-d46f`**
4. Sign in, then confirm the menu-bar icon shows **Connected**.
5. `ssh -p 22022 root@192.168.1.5` now works from anywhere.

Only `192.168.1.5` is routed over WARP — the rest of the home network stays on
your normal connection.

## Point your own domain at it

Your domain stays with your current DNS provider. Subdomains only, not the apex.

**You add**, on your DNS provider:

| Type | Name | Value |
|---|---|---|
| CNAME | `app` | `deepcraft-nocobase.pavel-usanli.online` |

**We add**: `app.yourdomain.com` as a Cloudflare custom hostname and a matching
tunnel route. Cloudflare then issues and renews the HTTPS certificate for your
hostname automatically.

> Not enabled yet — the Cloudflare API token in `homelab-infra` needs the
> `SSL and Certificates` permission first.

## Repository secrets

| Name | For |
|---|---|
| `NOCOBASE_HOST`, `NOCOBASE_SSH_PORT`, `NOCOBASE_SSH_USER` | where to connect |
| `NOCOBASE_SSH_PRIVATE_KEY` | deploy key |
| `CF_TEAM_NAME`, `CF_WARP_CLIENT_ID`, `CF_WARP_CLIENT_SECRET` | joins the runner to the network |
| `POSTGRES_HOST`, `POSTGRES_PORT` | `192.168.1.4`, `5432` |
| `REDIS_HOST`, `REDIS_PORT` | `192.168.1.6`, `6379` |

Postgres and Redis are host and port only — credentials live in the homelab's
Vault. Both are reachable from the container, not from CI.
