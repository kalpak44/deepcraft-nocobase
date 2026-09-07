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

# The WebDAV share. Both must match ansible/roles/webdav/defaults/main.yml — the
# recipes below manage the accounts in that password file, and the role is what
# points nginx at it.
webdav_htpasswd := env_var_or_default("WEBDAV_HTPASSWD", "/etc/nginx/webdav.htpasswd")
webdav_location := env_var_or_default("WEBDAV_LOCATION", "/webdav")

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
    @echo "webdav — who may mount the file share"
    @echo "  just webdav-users          list the accounts that can mount the share"
    @echo "  just webdav-user-add NAME  create an account, or reset its password"
    @echo "  just webdav-user-remove NAME  revoke access (files on the share are kept)"
    @echo ""
    @echo "data — these touch the database, deploy never does"
    @echo "  just backup                take a backup and fetch it to ./backups"
    @echo "  just restore FILE          restore a .nbdata from ./backups"
    @echo "  just restore-crm-template  install the NocoBase CRM 2.0 template"
    @echo "  just upgrade VERSION       move to a new release and migrate"
    @echo ""
    @echo "plugins — built and released from ./plugins, nothing to do with the box"
    @echo "  just build-plugin NAME     build plugins/NAME into a .tgz"
    @echo "  just release-plugin NAME   build, then replace its GitHub release"
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
    # `registration show` exits non-zero when there is no registration at all,
    # which is the normal state on a fresh CI runner — and under pipefail that
    # would abort the enrolment this recipe exists to perform.
    acct="$(warp_cli registration show 2>/dev/null | sed -nE 's/.*[Aa]ccount type: *//p' | head -1 || true)"
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
    # The play only proves the API answers. Whether the pages still render is a
    # separate question, and the one that reaches users first.
    echo ""
    echo "-> checking the pages still render"
    just smoke

# Load every admin page in a real browser and fail if one kills the tab.
# Needs no SSH: it drives the public URL exactly as a user's browser would.
smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    command -v node >/dev/null 2>&1 || { echo "node is required for 'just smoke'" >&2; exit 1; }
    : "${NOCOBASE_PUBLIC_URL:?set NOCOBASE_PUBLIC_URL in .env}"

    # Kept out of the repo root so the application tree stays free of JS tooling.
    # --silent because a clean install prints more than the check it precedes.
    if [ ! -d scripts/node_modules ]; then
      echo "-> installing playwright (first run only)"
      npm install --prefix scripts --silent
    fi
    # Idempotent, and a no-op once the browser is in the shared cache.
    node scripts/node_modules/playwright/cli.js install --only-shell chromium

    node scripts/smoke.mjs

# Build plugins/NAME into a .tgz under plugins/NAME/dist.
build-plugin name:
    #!/usr/bin/env bash
    set -euo pipefail
    dir="plugins/{{name}}"
    [ -d "$dir" ] || { echo "no such plugin: $dir" >&2; exit 1; }

    # plugins/build.sh drives the NocoBase toolchain, which is yarn 1.22 only —
    # berry cannot resolve the workspace it builds in.
    command -v yarn >/dev/null 2>&1 || { echo "yarn 1.22.x is required" >&2; exit 1; }
    command -v nb   >/dev/null 2>&1 || { echo "the nb CLI is required: npm i -g @nocobase/cli" >&2; exit 1; }

    # The first run downloads a whole NocoBase source tree into $dir/app, which
    # takes minutes and gigabytes. Every later run reuses it.
    bash plugins/build.sh "{{name}}"

# The version in the plugin's package.json names the release, so pushing a
# change without bumping it replaces that release in place — the tag moves to
# the current commit and the download link stays the same. Bump the version to
# start a new release.
#
# Build plugins/NAME and replace its GitHub release.
release-plugin name: (build-plugin name)
    #!/usr/bin/env bash
    set -euo pipefail
    command -v gh >/dev/null 2>&1 || { echo "the gh CLI is required: https://cli.github.com" >&2; exit 1; }

    dir="plugins/{{name}}"
    pkg="$(node -pe "require('./$dir/package.json').name")"
    version="$(node -pe "require('./$dir/package.json').version")"
    runtime="$(node -pe "require('./$dir/package.json').nocobase.supportedVersions.join(', ')")"
    tag="{{name}}-v${version}"

    # build.sh clears dist/ before packing, so anything else here means the
    # build did not finish and the asset would be stale.
    shopt -s nullglob
    tarballs=("$dir"/dist/*.tgz)
    shopt -u nullglob
    if [ "${#tarballs[@]}" -ne 1 ]; then
      echo "expected exactly one tarball in $dir/dist, found ${#tarballs[@]}" >&2
      exit 1
    fi
    tarball="${tarballs[0]}"

    # Delete rather than edit: `gh release edit` cannot move a tag, so an
    # in-place update would leave the release pointing at the old commit.
    if gh release view "$tag" >/dev/null 2>&1; then
      echo "-> $tag already exists, replacing it"
      gh release delete "$tag" --yes --cleanup-tag
    fi

    echo "-> publishing $tag from $(basename "$tarball")"
    gh release create "$tag" "$tarball" \
      --target "$(git rev-parse HEAD)" \
      --title "$pkg $version" \
      --notes "$(printf '%s\n' \
        "\`$pkg\` $version, built against NocoBase $runtime." \
        "" \
        "Install it in **Plugin manager → Add new plugin → Upload** with the" \
        "\`.tgz\` below, or drop the file into \`storage/plugins/\` on the box." \
        "" \
        "Rebuilt from \`$(git rev-parse --short HEAD)\`.")"

# Tail the application log.
logs mode="": write-ssh-key
    #!/usr/bin/env bash
    set -euo pipefail
    [ "{{mode}}" = "--lan" ] || just connect-warp
    exec ssh -i "{{key_file}}" -p "{{port}}" "{{user}}@{{host}}" journalctl -u nocobase -f -n 100

# ── WebDAV accounts ──────────────────────────────────────────────────────────
#
# Share accounts are runtime state, not deploy state: the webdav role creates the
# password file empty and never writes to it again, because CI applies
# playbook.yml on every push to main and would delete anything it declared.
#
# These recipes reach the box over SSH, so off the LAN they still need WARP —
# that is the admin path. The people using the share need none of it: they mount
# an https:// URL through the Cloudflare hostname with no client software.
#
# nginx re-reads the password file per request, so none of these need a reload.

# List the accounts that can mount the share.
webdav-users mode="": write-ssh-key
    #!/usr/bin/env bash
    set -euo pipefail
    [ "{{mode}}" = "--lan" ] || just connect-warp
    ssh -i "{{key_file}}" -p "{{port}}" "{{user}}@{{host}}" bash -s "{{webdav_htpasswd}}" <<'REMOTE'
    set -eu
    file="$1"
    if [ ! -f "$file" ]; then
      echo "no password file at $file - run 'just deploy-ansible' first" >&2
      exit 1
    fi
    if [ ! -s "$file" ]; then
      echo "(no accounts yet - add one with 'just webdav-user-add NAME')"
      exit 0
    fi
    cut -d: -f1 "$file" | sort
    REMOTE

# Create a share account, or reset the password of one that already exists.
webdav-user-add name mode="": write-ssh-key
    #!/usr/bin/env bash
    set -euo pipefail
    # Bound through single quotes before anything reads it: inside double quotes
    # this shell would expand a $(...) in the argument while validating it, so the
    # check would reject the result only after the command had already run.
    name='{{name}}'
    [[ "$name" =~ ^[A-Za-z0-9._@-]{1,64}$ ]] || {
      echo "invalid username '$name' - letters, digits and . _ @ - only" >&2
      exit 1
    }
    [ "{{mode}}" = "--lan" ] || just connect-warp

    # read -s so it is never echoed, twice so a typo cannot become a password
    # nobody knows.
    read -rsp "password for $name: " pw; echo
    read -rsp "repeat: " pw2; echo
    [ -n "$pw" ] || { echo "empty password refused" >&2; exit 1; }
    [ "$pw" = "$pw2" ] || { echo "passwords do not match" >&2; exit 1; }

    # base64, so whatever the password contains cannot break the script's
    # quoting — the alphabet is alphanumeric plus + / =. It travels inside the
    # script on stdin rather than as an argument, so it never appears in argv or
    # in ps on the box. \$ below is escaped to defer to the remote shell; $name
    # and $pw_b64 are meant to expand here.
    pw_b64=$(printf '%s' "$pw" | base64 | tr -d '\n')
    ssh -i "{{key_file}}" -p "{{port}}" "{{user}}@{{host}}" bash -s <<REMOTE
    set -eu
    name='$name'
    file='{{webdav_htpasswd}}'
    loc='{{webdav_location}}'
    pw=\$(printf '%s' '$pw_b64' | base64 -d)
    [ -f "\$file" ] || { echo "no password file at \$file - run 'just deploy-ansible' first" >&2; exit 1; }
    # -i reads the password from stdin. Never -c, which would truncate the file
    # and delete every other account. -B is bcrypt.
    printf '%s' "\$pw" | htpasswd -B -i "\$file" "\$name" >/dev/null 2>&1
    # Proves the account works through nginx, not merely that a line was written:
    # a wrong file mode or an unsupported hash both look fine on disk.
    #
    # The credentials go in a 0600 config file rather than on curl's command
    # line, and as an already-encoded Authorization header rather than as a
    # 'user =' line. curl unescapes backslash sequences inside a quoted config
    # value, so a password containing a backslash or a double quote arrived at
    # nginx altered and this check 401'd on an account that was in fact
    # working. Base64's alphabet cannot contain either.
    #
    # Nothing in this heredoc may use a backtick or a stray backslash: it is
    # unquoted so the local shell expands it, and both would be eaten here
    # instead of reaching the box.
    umask 077
    rc=\$(mktemp)
    trap 'rm -f "\$rc"' EXIT
    printf 'header = "Authorization: Basic %s"\n' \
      "\$(printf '%s:%s' "\$name" "\$pw" | base64 | tr -d '\n')" > "\$rc"
    code=\$(curl -K "\$rc" -s -o /dev/null -w '%{http_code}' -X PROPFIND "http://127.0.0.1\$loc/")
    [ "\$code" = 207 ] || { echo "account written but nginx answered \$code, expected 207" >&2; exit 1; }
    REMOTE
    echo "$name can now mount the share (verified against nginx)"

# Revoke access. Files the account left on the share are kept.
webdav-user-remove name mode="": write-ssh-key
    #!/usr/bin/env bash
    set -euo pipefail
    name='{{name}}'
    [[ "$name" =~ ^[A-Za-z0-9._@-]{1,64}$ ]] || { echo "invalid username '$name'" >&2; exit 1; }
    echo "This removes the share account '$name'. Files it uploaded are kept."
    read -r -p "Type the username to continue: " answer
    [ "$answer" = "$name" ] || { echo "aborted" >&2; exit 1; }
    [ "{{mode}}" = "--lan" ] || just connect-warp
    ssh -i "{{key_file}}" -p "{{port}}" "{{user}}@{{host}}" bash -s "$name" "{{webdav_htpasswd}}" <<'REMOTE'
    set -eu
    name="$1"; file="$2"
    cut -d: -f1 "$file" | grep -qx "$name" || { echo "no such account: $name" >&2; exit 1; }
    htpasswd -D "$file" "$name" >/dev/null 2>&1
    cut -d: -f1 "$file" | grep -qx "$name" && { echo "delete did not take effect" >&2; exit 1; }
    exit 0
    REMOTE
    echo "$name can no longer mount the share"

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
