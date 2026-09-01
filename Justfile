# deepcraft-nocobase
#
# Runs on macOS and Ubuntu. On the home LAN use `just apply`; from anywhere else
# `just deploy`, which connects WARP first.
#
# Usage:
#   just check       # verify tools, key and connectivity - run this first
#   just apply       # WARP + ssh key + ansible   (alias: just deploy)
#   just apply --lan # same, minus WARP — on the home LAN
#   just ssh         # WARP + shell on the box     (also takes --lan)
#   just warp        # connect the WARP client
#   just ssh-key     # write the deploy key to disk
#   just doctor      # print WARP + connectivity state
#   just list        # show everything
#
# Env vars (CI injects them from repo secrets; export them yourself locally):
#
#   NOCOBASE_HOST              192.168.1.5
#   NOCOBASE_SSH_PORT          22022
#   NOCOBASE_SSH_USER          root
#   NOCOBASE_SSH_PRIVATE_KEY   deploy key, PEM or base64
#   CF_TEAM_NAME               Zero Trust team name        (just warp only)
#   CF_WARP_CLIENT_ID          service token client id     (Linux warp only)
#   CF_WARP_CLIENT_SECRET      service token client secret (Linux warp only)

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Loads .env from this directory, so a dev copies .env.example once and every
# recipe works with no exports. CI passes the same names as job env vars.
set dotenv-load := true

key_file := "$HOME/.ssh/nocobase_ed25519"
host     := env_var_or_default("NOCOBASE_HOST", "192.168.1.5")
port     := env_var_or_default("NOCOBASE_SSH_PORT", "22022")
user     := env_var_or_default("NOCOBASE_SSH_USER", "root")

_help:
    @just --list

# CI calls `just deploy`; it is the same thing as `just apply`.
alias deploy := apply

# Connect the WARP client — skipped when the box is already reachable.
warp:
    #!/usr/bin/env bash
    # Linux enrols headlessly with the service token; macOS is a GUI login, so
    # there this checks and instructs rather than automating.
    set -euo pipefail

    # BSD and GNU netcat both accept -z -w; present on stock macOS and Ubuntu.
    if nc -z -w5 "{{host}}" "{{port}}" 2>/dev/null; then
      echo "{{host}}:{{port}} already reachable — WARP not needed"
      exit 0
    fi

    # --accept-tos is required on Linux and rejected by some macOS builds.
    warp_cli() { warp-cli --accept-tos "$@" 2>/dev/null || warp-cli "$@"; }

    if [ "{{os()}}" = "macos" ]; then
      if ! command -v warp-cli >/dev/null 2>&1; then
        cat >&2 <<MSG
    WARP is not installed. On macOS:

      brew install --cask cloudflare-warp

    Then open Cloudflare WARP, go to Preferences -> Account ->
    Login with Cloudflare Zero Trust, and enter the team name:

      ${CF_TEAM_NAME:-proud-block-d46f}
    MSG
        exit 1
      fi
      warp_cli connect || true
    else
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
          | sudo tee /etc/apt/sources.list.d/cloudflare-client.list
        sudo apt-get update -qq
        sudo apt-get install -y cloudflare-warp
      fi

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
    echo "WARP did not reach Connected" >&2
    exit 1

# Write the deploy key. Accepts a raw PEM or the base64 form.
ssh-key:
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
    echo "wrote {{key_file}}"

# Check the box answers, so routing and SSH failures stay distinguishable.
reachable:
    #!/usr/bin/env bash
    set -euo pipefail
    for _ in $(seq 1 15); do
      if nc -z -w5 "{{host}}" "{{port}}" 2>/dev/null; then
        echo "{{host}}:{{port}} reachable"; exit 0
      fi
      sleep 2
    done
    echo "cannot reach {{host}}:{{port}} — try 'just warp' or 'just doctor'" >&2
    exit 1

# Run the playbook — connects WARP first, or pass --lan to skip it.
apply mode="": ssh-key
    #!/usr/bin/env bash
    # just apply        from anywhere
    # just apply --lan  on the home LAN, never touches WARP
    set -euo pipefail
    [ "{{mode}}" = "--lan" ] || just warp
    just reachable
    cd ansible
    NOCOBASE_HOST="{{host}}" NOCOBASE_SSH_PORT="{{port}}" NOCOBASE_SSH_USER="{{user}}" \
    ANSIBLE_HOST_KEY_CHECKING=False \
      ansible-playbook playbook.yml --private-key "{{key_file}}"

# Shell on the box — connects WARP, then ssh with the right key, port and user.
ssh mode="": ssh-key
    #!/usr/bin/env bash
    # just ssh        from anywhere
    # just ssh --lan  on the home LAN, never touches WARP
    set -euo pipefail
    [ "{{mode}}" = "--lan" ] || just warp
    exec ssh -i "{{key_file}}" -p "{{port}}" "{{user}}@{{host}}"

# Check everything needed to reach the box: tools, config, key, connectivity.
check:
    #!/usr/bin/env bash
    # Deliberately no `set -e`: report every problem in one pass, not just the first.
    fail=0
    ok()   { printf "  [ok]   %s\n" "$1"; }
    bad()  { printf "  [FAIL] %s\n" "$1"; fail=1; }
    warn() { printf "  [warn] %s\n" "$1"; }

    echo "tools"
    for t in ssh ssh-keygen nc curl; do
      command -v "$t" >/dev/null 2>&1 && ok "$t" || bad "$t is missing"
    done
    if command -v ansible-playbook >/dev/null 2>&1; then ok "ansible-playbook"
    else bad "ansible-playbook missing - pipx install --include-deps ansible-core"; fi
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
      bad "no key: set NOCOBASE_SSH_PRIVATE_KEY (see .env.example) or run 'just ssh-key'"
    fi

    echo "network"
    if command -v warp-cli >/dev/null 2>&1; then
      st="$(warp-cli --accept-tos status 2>/dev/null || warp-cli status 2>&1)"
      case "$st" in *Connected*) ok "WARP connected" ;; *) warn "WARP not connected - fine on the LAN, else run 'just warp'" ;; esac
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
      bad "cannot reach {{host}}:{{port}} - run 'just warp' if you are off the LAN"
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://deepcraft-nocobase.pavel-usanli.online/ 2>/dev/null)"
    [ "$code" = "200" ] && ok "public url returns 200" || warn "public url returned ${code:-no response}"

    echo
    [ "$fail" -eq 0 ] && echo "all good" || echo "some checks failed (above)"
    exit "$fail"

# Alias kept because CI and older notes call `just doctor`.
alias doctor := check

list:
    @echo "check           verify tools, key and connectivity - run this first"
    @echo "apply [--lan]   WARP + ssh key + ansible   (alias: deploy)"
    @echo "ssh   [--lan]   WARP + shell on the box"
    @echo "warp            connect the WARP client"
    @echo "ssh-key         write the deploy key to {{key_file}}"
    @echo
    @echo "add --lan to ssh/apply on the home LAN to skip WARP"
    @echo "config comes from .env - see .env.example"
