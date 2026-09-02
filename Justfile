# deepcraft-nocobase — deploy to nocobase-lxc
#
# Works on macOS and Ubuntu. Start with:
#
#   just install-cli-tools   once per machine
#   cp .env.example .env     then fill in the deploy key
#   just check               confirms everything works
#
# Config is read from .env automatically — see .env.example.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Loads .env from this directory, so no exports are needed. CI passes the same
# names as job env vars instead.
set dotenv-load := true

key_file := "$HOME/.ssh/nocobase_ed25519"
host     := env_var_or_default("NOCOBASE_HOST", "192.168.1.5")
port     := env_var_or_default("NOCOBASE_SSH_PORT", "22022")
user     := env_var_or_default("NOCOBASE_SSH_USER", "root")

# Show the available commands.
help:
    @echo "setup"
    @echo "  just install-cli-tools     install ansible + cloudflare warp (macOS / Ubuntu)"
    @echo "  just check                 verify tools, key and connectivity"
    @echo ""
    @echo "use"
    @echo "  just connect-ssh           shell on the box (connects WARP first)"
    @echo "  just deploy-ansible        run the setup playbook (connects WARP first)"
    @echo "  just logs                  tail the nocobase journal"
    @echo ""
    @echo "  ...add --lan to either when you are on the home network:"
    @echo "  just connect-ssh --lan"
    @echo "  just deploy-ansible --lan"
    @echo ""
    @echo "data — these touch the database, deploy never does"
    @echo "  just backup                take a backup and fetch it to ./backups"
    @echo "  just restore FILE          restore a .nbdata from ./backups"
    @echo "  just restore-crm-template  install the NocoBase CRM 2.0 template"
    @echo "  just upgrade VERSION       move to a new release and migrate"
    @echo ""
    @echo "extras"
    @echo "  just connect-warp          join the Zero Trust network (--force to re-enrol)"
    @echo "  just write-ssh-key         write the deploy key to {{key_file}}"
    @echo ""
    @echo "config comes from .env — copy .env.example to get started"

alias list := help
# CI calls `just deploy`.
alias deploy := deploy-ansible

# Install everything needed on this machine: ansible, WARP and the CLI bits.
install-cli-tools:
    #!/usr/bin/env bash
    set -euo pipefail

    if [ "{{os()}}" = "macos" ]; then
      if ! command -v brew >/dev/null 2>&1; then
        echo "Homebrew is required: https://brew.sh" >&2
        exit 1
      fi
      command -v ansible-playbook >/dev/null 2>&1 || brew install ansible

      # The WARP cask ships a pkg, so this prompts for your admin password and
      # cannot run unattended. Not fatal: WARP is only needed off the home LAN.
      if ! command -v warp-cli >/dev/null 2>&1; then
        echo "installing Cloudflare WARP — this will ask for your admin password"
        if ! brew install --cask cloudflare-warp; then
          echo "" >&2
          echo "WARP did not install. Install it by hand from https://one.one.one.one" >&2
          echo "Everything else is ready; WARP only matters off the home LAN." >&2
        fi
      fi
    else
      sudo apt-get update -qq
      sudo apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg lsb-release netcat-openbsd openssh-client

      if ! command -v ansible-playbook >/dev/null 2>&1; then
        # pipx gives a current ansible-core; apt's is often several years old.
        if command -v pipx >/dev/null 2>&1; then
          pipx install --include-deps ansible-core
        else
          sudo apt-get install -y ansible
        fi
      fi

      if ! command -v warp-cli >/dev/null 2>&1; then
        curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
          | sudo gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
        # The repo lags new Ubuntu releases; jammy packages work on newer ones.
        codename="$(lsb_release -cs)"
        if ! curl -fsI "https://pkg.cloudflareclient.com/dists/${codename}/Release" >/dev/null 2>&1; then
          echo "no WARP repo for ${codename}, using jammy"
          codename=jammy
        fi
        echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ ${codename} main" \
          | sudo tee /etc/apt/sources.list.d/cloudflare-client.list >/dev/null
        sudo apt-get update -qq
        sudo apt-get install -y cloudflare-warp
      fi
    fi

    echo ""
    echo "installed. next: cp .env.example .env, add the deploy key, then 'just check'"

# Verify tools, config, key and connectivity.
check:
    #!/usr/bin/env bash
    # Deliberately no `set -e`: report every problem in one pass, not just the first.
    fail=0
    ok()   { printf "  [ok]   %s\n" "$1"; }
    bad()  { printf "  [FAIL] %s\n" "$1"; fail=1; }
    warn() { printf "  [warn] %s\n" "$1"; }

    echo "tools"
    for t in ssh ssh-keygen nc curl; do
      command -v "$t" >/dev/null 2>&1 && ok "$t" || bad "$t is missing - run 'just install-cli-tools'"
    done
    if command -v ansible-playbook >/dev/null 2>&1; then ok "ansible-playbook"
    else bad "ansible-playbook missing - run 'just install-cli-tools'"; fi
    if command -v warp-cli >/dev/null 2>&1; then ok "warp-cli"
    else warn "warp-cli not installed - only needed off the home LAN"; fi

    echo "config"
    ok "target {{user}}@{{host}}:{{port}}"

    echo "key"
    keyfile=""
    if [ -n "${NOCOBASE_SSH_PRIVATE_KEY:-}" ]; then
      tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
      if printf '%s' "$NOCOBASE_SSH_PRIVATE_KEY" | grep -q 'BEGIN .*PRIVATE KEY'; then
        printf '%s\n' "$NOCOBASE_SSH_PRIVATE_KEY" > "$tmp"
      else
        printf '%s' "$NOCOBASE_SSH_PRIVATE_KEY" | { base64 -d 2>/dev/null || base64 -D; } > "$tmp" 2>/dev/null
      fi
      chmod 600 "$tmp"
      if ssh-keygen -y -f "$tmp" >/dev/null 2>&1; then
        ok "NOCOBASE_SSH_PRIVATE_KEY parses ($(ssh-keygen -lf "$tmp" | awk '{print $2}'))"
        keyfile="$tmp"
      else
        bad "NOCOBASE_SSH_PRIVATE_KEY is set but does not parse as a private key"
      fi
    elif [ -f "{{key_file}}" ]; then
      warn "NOCOBASE_SSH_PRIVATE_KEY unset - falling back to {{key_file}}"
      keyfile="{{key_file}}"
    else
      bad "no key: set NOCOBASE_SSH_PRIVATE_KEY in .env (see .env.example)"
    fi

    echo "network"
    # Are we on the home network? ifconfig on macOS, ip on Linux.
    lan_ip="$( { ifconfig 2>/dev/null; ip -4 addr show 2>/dev/null; } \
      | sed -nE 's/.*inet (addr:)?(192\.168\.1\.[0-9]+).*/\2/p' | head -1 )"
    if [ -n "$lan_ip" ]; then
      on_lan=1; ok "on the home LAN as $lan_ip — WARP optional"
    else
      on_lan=0; ok "off the home LAN — reaching the box needs WARP"
    fi

    warp_up=0
    if command -v warp-cli >/dev/null 2>&1; then
      st="$(warp-cli --accept-tos status 2>/dev/null || warp-cli status 2>&1)"
      # "Free" is consumer WARP. It connects happily but is not enrolled in the
      # Zero Trust org, so it does NOT reach 192.168.1.5 — without this check a
      # consumer account looks identical to a working one.
      acct="$(warp-cli registration show 2>/dev/null | sed -nE 's/.*[Aa]ccount type: *//p' | head -1)"
      case "$st" in
        *Connected*)
          if [ -n "$acct" ] && [ "$acct" != "Free" ]; then
            warp_up=1; ok "WARP connected to Zero Trust ($acct)"
          elif [ "$on_lan" = 1 ]; then
            warn "WARP is on the consumer '$acct' account, not your Zero Trust org (fine, you are on the LAN)"
          else
            bad "WARP is on the consumer '$acct' account - run 'just connect-warp' to enrol"
          fi ;;
        *)
          if [ "$on_lan" = 1 ]; then warn "WARP not connected (fine, you are on the LAN)"
          else bad "WARP not connected - run 'just connect-warp'"; fi ;;
      esac
    elif [ "$on_lan" != 1 ]; then
      bad "warp-cli not installed and you are off the LAN - run 'just install-cli-tools'"
    fi

    if [ "{{os()}}" = "macos" ]; then nc_t=(-G 5 -w 5); else nc_t=(-w 5); fi
    if nc -z "${nc_t[@]}" "{{host}}" "{{port}}" 2>/dev/null; then
      # The split tunnel routes 192.168.1.5 over WARP whenever WARP is up, even
      # when you are sitting on the home network.
      if [ "$warp_up" = 1 ]; then via="via WARP"; else via="via LAN"; fi
      ok "tcp {{host}}:{{port}} open ($via)"
      if [ -n "$keyfile" ]; then
        if ssh -i "$keyfile" -p "{{port}}" -o IdentitiesOnly=yes -o BatchMode=yes \
             -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
             "{{user}}@{{host}}" true 2>/dev/null; then
          ok "ssh auth as {{user}}"
        else
          bad "tcp works but ssh auth failed - wrong key?"
        fi
      fi
    elif [ "$on_lan" = 1 ]; then
      bad "cannot reach {{host}}:{{port}} on the LAN - is the container running?"
    else
      bad "cannot reach {{host}}:{{port}} - run 'just connect-warp'"
    fi

    echo ""
    [ "$fail" -eq 0 ] && echo "all good" || echo "some checks failed (above)"
    exit "$fail"

# Join the Zero Trust network — add --force to enrol even when already reachable.
connect-warp mode="":
    #!/usr/bin/env bash
    set -euo pipefail

    # macOS BSD nc applies -w only to idle/read timeouts, NOT to the TCP connect —
    # a blackholed route then blocks for the OS default of ~75s. -G bounds the
    # connect itself, and only exists on BSD nc, so it is keyed off the OS.
    if [ "{{os()}}" = "macos" ]; then nc_t=(-G 5 -w 5); else nc_t=(-w 5); fi

    if [ "{{mode}}" != "--force" ] && nc -z "${nc_t[@]}" "{{host}}" "{{port}}" 2>/dev/null; then
      echo "{{host}}:{{port}} already reachable — WARP not needed (use --force to enrol anyway)"
      exit 0
    fi

    if ! command -v warp-cli >/dev/null 2>&1; then
      echo "WARP is not installed — run 'just install-cli-tools' first" >&2
      exit 1
    fi

    # --accept-tos is required on Linux and rejected by some macOS builds.
    warp_cli() { warp-cli --accept-tos "$@" 2>/dev/null || warp-cli "$@"; }

    : "${CF_TEAM_NAME:?set CF_TEAM_NAME in .env}"
    : "${CF_WARP_CLIENT_ID:?set CF_WARP_CLIENT_ID in .env}"
    : "${CF_WARP_CLIENT_SECRET:?set CF_WARP_CLIENT_SECRET in .env}"

    # Identical enrolment on both systems — the service token from .env, exactly
    # what CI uses. No browser, no email, no identity provider. Only the config
    # location and the reload mechanism differ.
    if [ "{{os()}}" = "macos" ]; then
      mdm_dir="/Library/Application Support/Cloudflare"
    else
      mdm_dir="/var/lib/cloudflare-warp"
    fi

    # The WARP daemon runs as root and reads only this path — a copy under $HOME is
    # ignored (verified: `mdm get-configs` stays empty). So the write needs sudo,
    # but only once: later runs reuse the file and never prompt.
    if [ -f "$mdm_dir/mdm.xml" ]; then
      echo "-> $mdm_dir/mdm.xml already present (no sudo needed)"
    else
    echo "-> writing $mdm_dir/mdm.xml (needs sudo, once)"
    sudo mkdir -p "$mdm_dir"
    sudo tee "$mdm_dir/mdm.xml" >/dev/null <<XML
    <dict>
      <key>organization</key>
      <string>${CF_TEAM_NAME}</string>
      <key>auth_client_id</key>
      <string>${CF_WARP_CLIENT_ID}</string>
      <key>auth_client_secret</key>
      <string>${CF_WARP_CLIENT_SECRET}</string>
      <key>service_mode</key>
      <string>warp</string>
    </dict>
    XML
    sudo chmod 600 "$mdm_dir/mdm.xml"
    echo "-> mdm.xml written"
    fi

    echo "-> reloading the warp daemon"
    if [ "{{os()}}" = "macos" ]; then
      warp_cli mdm refresh >/dev/null 2>&1 || true
    else
      sudo systemctl restart warp-svc
    fi

    # Talking to a daemon that has not started yet fails in a way that looks
    # exactly like a bad token, so wait for the socket first.
    echo "-> waiting for the daemon"
    for _ in $(seq 1 30); do
      warp_cli status >/dev/null 2>&1 && break
      sleep 2
    done

    # A registration held against another account blocks the token from taking
    # effect; dropping it is harmless when there is none.
    echo "-> checking existing registration"
    acct="$(warp_cli registration show 2>/dev/null | sed -nE 's/.*[Aa]ccount type: *//p' | head -1)"
    if [ -n "$acct" ] && [ "$acct" = "Free" ]; then
      echo "dropping the consumer WARP registration so the service token can enrol"
      warp_cli registration delete >/dev/null 2>&1 || true
    fi

    # No ORG argument: it comes from mdm.xml, along with the token that authorises it.
    echo "-> registering with the service token"
    warp_cli registration new >/dev/null 2>&1 || true
    echo "-> connecting"
    warp_cli connect || true
    echo "-> polling status"

    # "Disconnected" does not contain "Connected", so this test is safe.
    for _ in $(seq 1 30); do
      status="$(warp_cli status 2>&1 || true)"
      echo "$status"
      case "$status" in *Connected*) echo "WARP connected"; exit 0 ;; esac
      sleep 2
    done

    echo "" >&2
    echo "WARP did not reach Connected. Check with:" >&2
    echo "  warp-cli status              'Registration Missing' means the service" >&2
    echo "                               token is rejected by the enrolment policy" >&2
    echo "  warp-cli registration show   'Account type' should not be Free" >&2
    exit 1

# Open a shell on the box. Add --lan on the home network to skip WARP.
connect-ssh mode="": write-ssh-key
    #!/usr/bin/env bash
    set -euo pipefail
    [ "{{mode}}" = "--lan" ] || just connect-warp
    exec ssh -i "{{key_file}}" -p "{{port}}" "{{user}}@{{host}}"

# Run the setup playbook. Add --lan on the home network to skip WARP.
deploy-ansible mode="": write-ssh-key
    #!/usr/bin/env bash
    set -euo pipefail
    [ "{{mode}}" = "--lan" ] || just connect-warp
    just _ansible playbook.yml

# Take a backup and fetch it into ./backups.
backup mode="": write-ssh-key
    #!/usr/bin/env bash
    set -euo pipefail
    [ "{{mode}}" = "--lan" ] || just connect-warp
    just _ansible backup.yml

# Restore a .nbdata archive. Replaces every table in the database.
restore file mode="": write-ssh-key
    #!/usr/bin/env bash
    set -euo pipefail
    [ -f "{{file}}" ] || { echo "no such file: {{file}}" >&2; exit 1; }
    echo "This REPLACES the whole ${POSTGRES_DATABASE_NAME} database with {{file}}."
    read -r -p "Type the database name to continue: " answer
    [ "$answer" = "${POSTGRES_DATABASE_NAME}" ] || { echo "aborted" >&2; exit 1; }
    [ "{{mode}}" = "--lan" ] || just connect-warp
    just _ansible restore.yml -e restore_confirm=true -e "restore_local=$(cd "$(dirname "{{file}}")" && pwd)/$(basename "{{file}}")"

# Install the published NocoBase CRM 2.0 template. Replaces the whole database.
restore-crm-template mode="": write-ssh-key
    #!/usr/bin/env bash
    set -euo pipefail
    echo "This REPLACES the whole ${POSTGRES_DATABASE_NAME} database with the CRM template."
    read -r -p "Type the database name to continue: " answer
    [ "$answer" = "${POSTGRES_DATABASE_NAME}" ] || { echo "aborted" >&2; exit 1; }
    [ "{{mode}}" = "--lan" ] || just connect-warp
    just _ansible restore.yml -e restore_confirm=true -e restore_crm=true

# Move to a new NocoBase release and run its migrations. Back up first.
upgrade version mode="": write-ssh-key
    #!/usr/bin/env bash
    set -euo pipefail
    [ "{{mode}}" = "--lan" ] || just connect-warp
    just backup --lan
    just _ansible upgrade.yml -e upgrade_to={{version}} -e upgrade_backup_taken=true

# Tail the application log.
logs mode="": write-ssh-key
    #!/usr/bin/env bash
    set -euo pipefail
    [ "{{mode}}" = "--lan" ] || just connect-warp
    exec ssh -i "{{key_file}}" -p "{{port}}" "{{user}}@{{host}}" journalctl -u nocobase -f -n 100

# Write the deploy key to disk. Accepts a raw PEM or the base64 form.
write-ssh-key:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
    if printf '%s' "${NOCOBASE_SSH_PRIVATE_KEY}" | grep -q 'BEGIN .*PRIVATE KEY'; then
      printf '%s\n' "${NOCOBASE_SSH_PRIVATE_KEY}" > "{{key_file}}"
    else
      # GNU base64 decodes with -d, BSD/macOS with -D.
      printf '%s' "${NOCOBASE_SSH_PRIVATE_KEY}" | { base64 -d 2>/dev/null || base64 -D; } > "{{key_file}}"
    fi
    chmod 600 "{{key_file}}"
    # Fail here rather than inside ansible, where a bad key looks like a refused
    # connection.
    ssh-keygen -y -f "{{key_file}}" >/dev/null

# Every play runs the same way: check the box answers, then hand ansible the
# inventory and database settings from .env. Recipes differ only in arguments.
_ansible play *args: _reachable
    #!/usr/bin/env bash
    set -euo pipefail
    cd ansible
    NOCOBASE_HOST="{{host}}" NOCOBASE_SSH_PORT="{{port}}" NOCOBASE_SSH_USER="{{user}}" \
    ANSIBLE_HOST_KEY_CHECKING=False \
      ansible-playbook "{{play}}" --private-key "{{key_file}}" {{args}}

# Confirm the box answers, so routing and SSH failures stay distinguishable.
_reachable:
    #!/usr/bin/env bash
    set -euo pipefail
    # macOS BSD nc applies -w only to idle/read timeouts, NOT to the TCP connect —
    # a blackholed route then blocks for the OS default of ~75s. -G bounds the
    # connect itself, and only exists on BSD nc, so it is keyed off the OS.
    if [ "{{os()}}" = "macos" ]; then nc_t=(-G 5 -w 5); else nc_t=(-w 5); fi
    for _ in $(seq 1 15); do
      if nc -z "${nc_t[@]}" "{{host}}" "{{port}}" 2>/dev/null; then
        echo "{{host}}:{{port}} reachable"; exit 0
      fi
      sleep 2
    done
    echo "cannot reach {{host}}:{{port}} — run 'just check'" >&2
    exit 1
