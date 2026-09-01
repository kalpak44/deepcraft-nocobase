# deepcraft-nocobase

Deploys to `nocobase-lxc`, hardened by
[homelab-infra](https://github.com/kalpak44/homelab-infra).

## What's here

| | |
|---|---|
| `ansible/` | all ansible scripts |
| `.github/workflows/deploy.yml` | github pipeline, deploys on push to main |
| `Justfile` | every command below — CI runs the same ones |
| `.env.example` | copy to `.env` and fill in |

## Access

| | |
|---|---|
| Internet | <https://deepcraft-nocobase.pavel-usanli.online> |
| Home LAN | <http://192.168.1.5/> |

---

## Getting set up

The box lives on a home network and is **not reachable from the internet by
default**. Cloudflare WARP puts your machine on that network — after step 3 below,
`192.168.1.5` works from anywhere.

### 1. Install the tools

```bash
# macOS
brew install just ansible
brew install --cask cloudflare-warp

# Ubuntu
sudo apt install -y just ansible netcat-openbsd
# WARP is installed for you by `just warp`
```

### 2. Configure

```bash
cp .env.example .env
```

Fill in `NOCOBASE_SSH_PRIVATE_KEY` — ask an admin, or from a `homelab-infra`
checkout run `just output proxmox nocobase-lxc ssh_private_key`. Everything else
is pre-filled. `.env` is gitignored.

### 3. Join the network (skip if you're on the home LAN)

**macOS** — open the Cloudflare WARP app:

1. **Preferences → Account → Login with Cloudflare Zero Trust**
2. Team name: **`proud-block-d46f`**
3. Sign in, then check the menu-bar icon shows **Connected**

**Ubuntu** — `just warp` does it for you, using the two `CF_WARP_*` values in
`.env`.

Only `192.168.1.5` is routed over WARP. The rest of your traffic and the rest of
the home network are untouched.

### 4. Check it works

```bash
just check
```

Verifies your tools, your key, WARP, the SSH connection and the public URL, and
tells you which one is broken. **Run this first whenever something misbehaves.**

```
tools
  [ok]   ssh
  [ok]   ansible-playbook
  [warn] warp-cli not installed - only needed off the home LAN
config
  [ok]   target root@192.168.1.5:22022
key
  [ok]   NOCOBASE_SSH_PRIVATE_KEY parses (SHA256:wjtw...)
network
  [ok]   tcp 192.168.1.5:22022 open
  [ok]   ssh auth as root
  [ok]   public url returns 200

all good
```

---

## Commands

| Command | Does |
|---|---|
| `just check` | verify tools, key and connectivity — start here |
| `just ssh` | shell on the box; connects WARP first |
| `just apply` | deploy the ansible playbook; connects WARP first |
| `just warp` | connect the WARP client on its own |
| `just ssh-key` | write the deploy key to disk |
| `just list` | show all of this |

Add `--lan` to `ssh` or `apply` when you're on the home network and want to skip
WARP entirely:

```bash
just ssh --lan
just apply --lan
```

`just ssh` handles the key, port and user for you. The raw equivalent on the LAN
is `ssh -p 22022 root@192.168.1.5`.

---

## Deploying

Push to `main` touching `ansible/**`, or run the **Deploy** workflow manually from
the Actions tab.

```
GitHub runner → WARP → Cloudflare → tunnel → 192.168.1.5:22022
```

CI runs `just deploy`, which is the same recipe as `just apply` — so what you run
locally is what CI runs.

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

CI reads the same names as `.env`:

| Name | For |
|---|---|
| `NOCOBASE_HOST`, `NOCOBASE_SSH_PORT`, `NOCOBASE_SSH_USER` | where to connect |
| `NOCOBASE_SSH_PRIVATE_KEY` | deploy key |
| `CF_TEAM_NAME`, `CF_WARP_CLIENT_ID`, `CF_WARP_CLIENT_SECRET` | joins the runner to the network |
| `POSTGRES_HOST`, `POSTGRES_PORT` | `192.168.1.4`, `5432` |
| `REDIS_HOST`, `REDIS_PORT` | `192.168.1.6`, `6379` |

Postgres and Redis are host and port only — credentials live in the homelab's
Vault. Both are reachable from the container, not from CI.
