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

Install `just` itself (`brew install just` on macOS, `sudo apt install just` on
Ubuntu), then let it do the rest:

```bash
just install-cli-tools
```

That installs ansible, the Cloudflare WARP client and the small CLI bits, on both
macOS and Ubuntu. On macOS the WARP step asks for your admin password; if you skip
it, everything else still works on the home LAN.

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

**Ubuntu** — `just connect-warp` does it for you, using the two `CF_WARP_*` values
in `.env`.

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
| `just help` | show all of this |
| `just install-cli-tools` | install ansible + WARP (once per machine) |
| `just check` | verify tools, key and connectivity — start here |
| `just connect-ssh` | shell on the box; connects WARP first |
| `just deploy-ansible` | run the playbook; connects WARP first |
| `just connect-warp` | join the Zero Trust network on its own |
| `just write-ssh-key` | write the deploy key to disk |

Add `--lan` to `connect-ssh` or `deploy-ansible` when you're on the home network
and want to skip WARP entirely:

```bash
just connect-ssh --lan
just deploy-ansible --lan
```

`just connect-ssh` handles the key, port and user for you. The raw equivalent on
the LAN is `ssh -p 22022 root@192.168.1.5`.

---

## Deploying

Push to `main` touching `ansible/**`, or run the **Deploy** workflow manually from
the Actions tab.

```
GitHub runner → WARP → Cloudflare → tunnel → 192.168.1.5:22022
```

CI runs `just install-cli-tools` then `just deploy-ansible` — the same commands
you run locally.

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
