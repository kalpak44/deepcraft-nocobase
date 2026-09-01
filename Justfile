# deepcraft-nocobase
#
# Usage:
#   just deploy      # what CI runs: WARP + ssh key + ansible
#   just apply       # ansible only — use this on the home LAN
#   just warp        # install and connect the WARP client (Linux)
#   just ssh-key     # write the deploy key to disk
#   just ssh         # open a shell on the box
#   just list        # show everything
#
# Env vars (CI injects them from repo secrets; export them yourself locally):
#
#   NOCOBASE_HOST              192.168.1.5
#   NOCOBASE_SSH_PORT          22022
#   NOCOBASE_SSH_USER          root
#   NOCOBASE_SSH_PRIVATE_KEY   deploy key, PEM or base64
#   CF_TEAM_NAME               Zero Trust team name        (just warp only)
#   CF_WARP_CLIENT_ID          service token client id     (just warp only)
#   CF_WARP_CLIENT_SECRET      service token client secret (just warp only)

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

key_file := "$HOME/.ssh/nocobase_ed25519"

_help:
    @just --list

# Everything CI needs, in order.
deploy: warp apply

# Install the WARP client and join the Zero Trust network (Linux, off-LAN only).
#
# On the home LAN the box is directly reachable and this is unnecessary.
warp:
    #!/usr/bin/env bash
    set -euo pipefail
    if warp-cli --accept-tos status 2>/dev/null | grep -q Connected; then
      echo "WARP already connected"
      exit 0
    fi

    if ! command -v warp-cli >/dev/null 2>&1; then
      curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
        | sudo gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
      # The repo lags new Ubuntu releases; jammy packages work on newer runners.
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

    # Service-token enrolment is driven entirely by mdm.xml.
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
      warp-cli --accept-tos status >/dev/null 2>&1 && break
      sleep 2
    done

    warp-cli --accept-tos connect || true

    # "Disconnected" does not contain "Connected", so this test is safe.
    for _ in $(seq 1 30); do
      status="$(warp-cli --accept-tos status 2>&1 || true)"
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
      printf '%s' "${NOCOBASE_SSH_PRIVATE_KEY}" | base64 -d > "{{key_file}}"
    fi
    chmod 600 "{{key_file}}"
    # Fail here rather than inside ansible, where a bad key looks like a refused
    # connection.
    ssh-keygen -y -f "{{key_file}}" >/dev/null
    echo "wrote {{key_file}}"

# Check the box answers before ansible does.
#
# Keeps a routing failure and an SSH failure from looking identical.
reachable:
    #!/usr/bin/env bash
    set -euo pipefail
    host="${NOCOBASE_HOST}"; port="${NOCOBASE_SSH_PORT:-22022}"
    for _ in $(seq 1 15); do
      if nc -z -w5 "$host" "$port"; then echo "$host:$port reachable"; exit 0; fi
      sleep 2
    done
    echo "cannot reach $host:$port" >&2
    exit 1

# Run the playbook.
apply: ssh-key reachable
    #!/usr/bin/env bash
    set -euo pipefail
    cd ansible
    ANSIBLE_HOST_KEY_CHECKING=False \
      ansible-playbook playbook.yml --private-key "{{key_file}}"

# Open a shell on the box.
ssh: ssh-key
    ssh -i "{{key_file}}" -p "${NOCOBASE_SSH_PORT:-22022}" \
      "${NOCOBASE_SSH_USER:-root}@${NOCOBASE_HOST}"

# Print WARP and connectivity state — run this first when a deploy fails.
doctor:
    #!/usr/bin/env bash
    set +e
    echo "--- warp"
    warp-cli --accept-tos status 2>&1 || echo "warp-cli not installed"
    echo "--- target"
    nc -z -w5 "${NOCOBASE_HOST:-192.168.1.5}" "${NOCOBASE_SSH_PORT:-22022}" \
      && echo "ssh port reachable" || echo "ssh port NOT reachable"
    echo "--- public url"
    curl -s -o /dev/null -w "https://deepcraft-nocobase.pavel-usanli.online -> HTTP %{http_code}\n" \
      --max-time 15 https://deepcraft-nocobase.pavel-usanli.online/

list:
    @echo "deploy    WARP + ssh key + ansible (what CI runs)"
    @echo "apply     ansible only - use on the home LAN"
    @echo "warp      install + connect the WARP client (Linux)"
    @echo "ssh-key   write the deploy key to {{key_file}}"
    @echo "ssh       open a shell on the box"
    @echo "doctor    print WARP + connectivity state"
