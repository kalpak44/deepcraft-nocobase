# deepcraft-nocobase

Runs [NocoBase](https://www.nocobase.com/) 2.2.6 with the
[CRM 2.0](https://docs.nocobase.com/solution/crm) template on `nocobase-lxc`,
hardened by [homelab-infra](https://github.com/kalpak44/homelab-infra).

No Docker — NocoBase is installed from npm and supervised by systemd, with
nginx in front of it and Postgres on a separate box.

## What's here

| | |
|---|---|
| `ansible/playbook.yml` | setup: node, nocobase, nginx. Never touches data |
| `ansible/backup.yml` | take a backup and fetch it |
| `ansible/restore.yml` | restore a backup, or the published CRM template |
| `ansible/upgrade.yml` | move to a new release and run its migrations |
| `.github/workflows/deploy.yml` | github pipeline, runs the setup playbook on push to main |
| `Justfile` | every command below — CI runs the same ones |
| `.env.example` | copy to `.env` and fill in |

## Access

| | |
|---|---|
| Internet | <https://ownai.deepcraftstudio.com> — routed in through Cloudflare for SaaS, see [Point your own domain at it](#point-your-own-domain-at-it) |
| LAN | <http://192.168.1.5/> |

Sign in with the `NOCOBASE_ROOT_*` credentials from `.env`.

## How it is put together

| | |
|---|---|
| App | `/data/nocobase/app`, installed with `create-nocobase-app`, run by `nocobase.service` as the `nocobase` user |
| Disk | **`/` is only 20G** — everything lives on the 49G `/data` volume |
| Database | external Postgres 18 at `192.168.1.4:5432` |
| nginx | reverse proxy on `:80`; TLS is terminated by Cloudflare before the tunnel |
| Node | current LTS, installed by the `nodejs` role from the nodejs.org tarball |

---

## Getting set up

The box lives on a private network and is **not reachable from the internet by
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

### 3. Connect via WARP

`192.168.1.5` is a private address — it does not exist on the public internet.
Cloudflare WARP puts your machine on that private network, after which the box is
reachable from anywhere. Skip this step if you are on the home LAN.

```bash
just connect-warp
```

On the home LAN it will say *"already reachable"* and do nothing. To enrol anyway
so you can test the developer path:

```bash
just connect-warp --force
```

**macOS** — a browser opens for the Cloudflare sign-in. If the device is already
on the consumer "Free" account, `just connect-warp` drops that registration first,
because a device cannot join an organisation while it holds one. By hand:

```bash
warp-cli registration delete                      # only if on the "Free" account
warp-cli registration new proud-block-d46f
warp-cli connect
```

Or through the app: **Preferences → Account → Login with Cloudflare Zero Trust**,
team name **`proud-block-d46f`**.

**Ubuntu** — fully automatic, no browser. `just connect-warp` enrols headlessly
with the `CF_WARP_*` service token from `.env`. This is also how CI does it.

**Confirm it worked:**

```bash
warp-cli status     # Status update: Connected
just check          # tcp 192.168.1.5:22022 open (via WARP)
```

`just check` reports `(via WARP)` or `(via LAN)`, so you can always tell which path
you are on. Disconnect again with `warp-cli disconnect`.

Only `192.168.1.5` is routed over WARP. The rest of your traffic and the rest of
the home network are untouched.

**If it does not work:**

| Symptom | Cause |
|---|---|
| `unrecognized subcommand 'teams-enroll'` | old command — use `registration new` |
| `warp-cli status` says `Connected` but `just check` says `(via LAN)` | on the consumer account, not the org — check `warp-cli registration show` says anything but `Account type: Free` |
| `Registration Missing` | the service token is not accepted by the device-enrolment policy |
| still unreachable while connected | the split tunnel is missing the `192.168.1.5/32` route |

### 4. Check it works

```bash
just check
```

Verifies your tools, your key, WARP and the SSH connection, and tells you which
one is broken — including whether you are reaching the box **via LAN** or **via
WARP**. **Run this first whenever something misbehaves.**

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
  [ok]   on the home LAN as 192.168.1.217 — WARP optional
  [warn] WARP not connected (fine, you are on the LAN)
  [ok]   tcp 192.168.1.5:22022 open (via LAN)
  [ok]   ssh auth as root

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
| `just deploy-ansible` | run the setup playbook; connects WARP first |
| `just logs` | tail the nocobase journal |
| `just connect-warp` | join the Zero Trust network on its own |
| `just write-ssh-key` | write the deploy key to disk |

These touch the database, and are deliberately not part of a deploy:

| Command | Does |
|---|---|
| `just backup` | take a backup and fetch it into `./backups` |
| `just restore backups/<file>` | **replaces the whole database** with that archive |
| `just restore-crm-template` | **replaces the whole database** with the published CRM 2.0 template |
| `just upgrade <version>` | backs up, moves the pin, migrates, restarts |

Both restore commands ask you to type the database name before they do anything.
A restore also replaces the users table, so the play puts your configured
`NOCOBASE_ROOT_*` account back afterwards — otherwise the CRM template would
leave the box on NocoBase's published `admin@nocobase.com` / `admin123`.

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

The setup playbook installs the current Node.js LTS, resolved from `nodejs.org`
at run time and checksum-verified, then NocoBase, then nginx. Node 26 becomes
LTS in October 2026, so set `nodejs_lts_line: "24"` in
`ansible/roles/nodejs/defaults/main.yml` if you would rather not cross that
boundary automatically.

It never migrates or overwrites data: the NocoBase version is pinned by
`nocobase_version` in `ansible/roles/nocobase/defaults/main.yml`, and the play
fails if the box is running something else rather than upgrading it behind your
back. Use `just upgrade <version>` and commit the new pin.

## Point your own domain at it

Your domain stays with your current DNS provider. Subdomains only, not the apex.
The box has no public hostname of its own — every public URL is a customer domain
routed in through Cloudflare for SaaS.

**We go first**, because steps 2 and 3 below need values that do not exist until
the custom hostname has been created. All of this is in
[homelab-infra](https://github.com/kalpak44/homelab-infra):

- **a.** Add your hostname to `local.saas_customers` in
  `terraform/cloudflare/shared/zero-trust/saas.tf`:

  ```hcl
  "app.yourdomain.com" = "http://192.168.1.5:80"
  ```

  That one line is the whole entry — it creates the Cloudflare custom hostname
  *and* the tunnel ingress rule, which are folded into `ingress_overrides` and
  `all_hostnames` from the same map. Both are required: the tunnel matches on the
  `Host` header, so a custom hostname without an ingress rule negotiates TLS
  perfectly and then returns 404.
- **b.** Apply it — `just deploy cloudflare shared/zero-trust`, or the
  **Cloudflare - Deploy** workflow.
- **c.** Send you the validation values from
  `just output cloudflare shared/zero-trust saas_customer_onboarding`.

**You then add**, on your DNS provider:

| | Type | Name | Value |
|---|---|---|---|
| **1** | CNAME | `app` | `saas.pavel-usanli.online` — **DNS-only, do not proxy** |
| **2** | TXT | `_acme-challenge.app.yourdomain.com` | from step **c** |
| **3** | TXT | `_cf-custom-hostname.app.yourdomain.com` | from step **c** — omit if the value comes back empty |

Cloudflare then issues and renews the HTTPS certificate for your hostname
automatically. It usually takes a couple of minutes after record 2 is visible.

Notes on the three records:

- **1 must not be proxied.** If your domain also sits behind Cloudflare, an
  orange-clouded record is served by your own zone's proxy and never reaches the
  custom-hostname path at all. Grey cloud, or a plain CNAME at any other provider.
- **2 is the certificate challenge.** Point it at `saas.pavel-usanli.online` only
  after this record is live, otherwise the hostname is unreachable in the gap
  between cutting traffic over and the certificate issuing.
- **3 proves you own the domain.** Cloudflare skips it when the domain already
  belongs to the same Cloudflare account, in which case step **c** returns nothing
  for it — that is expected, not a missing value.
