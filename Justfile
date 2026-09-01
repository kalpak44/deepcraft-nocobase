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
    @echo "  just deploy-ansible        run the playbook  (connects WARP first)"
    @echo ""
    @echo "  ...add --lan to either when you are on the home network:"
    @echo "  just connect-ssh --lan"
    @echo "  just deploy-ansible --lan"
    @echo ""
    @echo "extras"
    @echo "  just connect-warp          join the Zero Trust network on its own"
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
    if command -v warp-cli >/dev/null 2>&1; then
      st="$(warp-cli --accept-tos status 2>/dev/null || warp-cli status 2>&1)"
      case "$st" in *Connected*) ok "WARP connected" ;; *) warn "WARP not connected - fine on the LAN, else run 'just connect-warp'" ;; esac
    fi
    if nc -z -w5 "{{host}}" "{{port}}" 2>/dev/null; then
      ok "tcp {{host}}:{{port}} open"
      if [ -n "$keyfile" ]; then
        if ssh -i "$keyfile" -p "{{port}}" -o IdentitiesOnly=yes -o BatchMode=yes \
             -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
             "{{user}}@{{host}}" true 2>/dev/null; then
          ok "ssh auth as {{user}}"
        else
          bad "tcp works but ssh auth failed - wrong key?"
        fi
      fi
    else
      bad "cannot reach {{host}}:{{port}} - run 'just connect-warp' if you are off the LAN"
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://deepcraft-nocobase.pavel-usanli.online/ 2>/dev/null)"
    [ "$code" = "200" ] && ok "public url returns 200" || warn "public url returned ${code:-no response}"

    echo ""
    [ "$fail" -eq 0 ] && echo "all good" || echo "some checks failed (above)"
    exit "$fail"

# Join the Zero Trust network — skipped when the box is already reachable.
connect-warp:
    #!/usr/bin/env bash
    set -euo pipefail

    # BSD and GNU netcat both accept -z -w; present on stock macOS and Ubuntu.
    if nc -z -w5 "{{host}}" "{{port}}" 2>/dev/null; then
      echo "{{host}}:{{port}} already reachable — WARP not needed"
      exit 0
    fi

    if ! command -v warp-cli >/dev/null 2>&1; then
      echo "WARP is not installed — run 'just install-cli-tools' first" >&2
      exit 1
    fi

    # --accept-tos is required on Linux and rejected by some macOS builds.
    warp_cli() { warp-cli --accept-tos "$@" 2>/dev/null || warp-cli "$@"; }

    if [ "{{os()}}" = "macos" ]; then
      # teams-enroll opens a browser for the SSO login. Older builds lack the
      # subcommand, in which case the GUI hint at the end of this recipe applies.
      warp_cli teams-enroll "${CF_TEAM_NAME}" 2>/dev/null || true
      warp_cli connect 2>/dev/null || true
    else
      # Headless enrolment is driven entirely by mdm.xml.
      sudo mkdir -p /var/lib/cloudflare-warp
      sudo tee /var/lib/cloudflare-warp/mdm.xml >/dev/null <<XML
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
      sudo chmod 600 /var/lib/cloudflare-warp/mdm.xml
      sudo systemctl restart warp-svc

      # Talking to a daemon that has not started yet fails in a way that looks
      # exactly like a bad token, so wait for the socket first.
      for _ in $(seq 1 30); do
        warp_cli status >/dev/null 2>&1 && break
        sleep 2
      done
      warp_cli connect || true
    fi

    # "Disconnected" does not contain "Connected", so this test is safe.
    for _ in $(seq 1 30); do
      status="$(warp_cli status 2>&1 || true)"
      echo "$status"
      case "$status" in *Connected*) echo "WARP connected"; exit 0 ;; esac
      sleep 2
    done

    if [ "{{os()}}" = "macos" ]; then
      echo "" >&2
      echo "Could not connect automatically. Open the Cloudflare WARP app:" >&2
      echo "  Preferences -> Account -> Login with Cloudflare Zero Trust" >&2
      echo "  team name: ${CF_TEAM_NAME:-proud-block-d46f}" >&2
    fi
    echo "WARP did not reach Connected" >&2
    exit 1

# Open a shell on the box. Add --lan on the home network to skip WARP.
connect-ssh mode="": write-ssh-key
    #!/usr/bin/env bash
    set -euo pipefail
    [ "{{mode}}" = "--lan" ] || just connect-warp
    exec ssh -i "{{key_file}}" -p "{{port}}" "{{user}}@{{host}}"

# Run the ansible playbook. Add --lan on the home network to skip WARP.
deploy-ansible mode="": write-ssh-key
    #!/usr/bin/env bash
    set -euo pipefail
    [ "{{mode}}" = "--lan" ] || just connect-warp
    just _reachable
    cd ansible
    NOCOBASE_HOST="{{host}}" NOCOBASE_SSH_PORT="{{port}}" NOCOBASE_SSH_USER="{{user}}" \
    ANSIBLE_HOST_KEY_CHECKING=False \
      ansible-playbook playbook.yml --private-key "{{key_file}}"

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

# Confirm the box answers, so routing and SSH failures stay distinguishable.
_reachable:
    #!/usr/bin/env bash
    set -euo pipefail
    for _ in $(seq 1 15); do
      if nc -z -w5 "{{host}}" "{{port}}" 2>/dev/null; then
        echo "{{host}}:{{port}} reachable"; exit 0
      fi
      sleep 2
    done
    echo "cannot reach {{host}}:{{port}} — run 'just check'" >&2
    exit 1
