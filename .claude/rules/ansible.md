# Ansible

- One role per concern, under `ansible/roles/<name>/`. Wire it into
  `ansible/playbook.yml`; roles run in listed order.
- Every tunable goes in the role's `defaults/main.yml` with a comment saying what
  empty/unset means. No magic values inline in tasks.
- Use fully qualified module names (`ansible.builtin.apt`, not `apt`).
- Task names are sentences describing intent, capitalised, no trailing period.
- Idempotent by default — see [Idempotence](#idempotence) below. It is the rule
  the rest of this file exists to serve, not a nicety.
- Prefix role-internal facts and registered vars with `_`.
- Validate before applying (`nginx -t`), then `meta: flush_handlers` before any
  task that verifies the result.
- Finish a role with a verification task — hit the port, run the binary — so a
  broken deploy fails in ansible rather than later.
- Verify anything downloaded (checksum, signature). Never guess an
  architecture or version: `assert` and fail loudly instead.
- The container has free internet egress; only LAN egress is firewalled. It ships
  `wget` and `gzip`, not `curl` or `xz` — install what you need.
- `gather_facts: true` is required; roles read `ansible_architecture`.
- Nothing host-specific in `inventory.yml` — connection details come from
  `NOCOBASE_HOST` / `NOCOBASE_SSH_PORT` / `NOCOBASE_SSH_USER`.

## Idempotence

`ansible/playbook.yml` must be safe to apply at any moment, however many times,
without anyone having to ask whether now is a good time. CI runs it on every
push to `main`; a developer runs it to find out what state the box is in. That
only holds if a run against an already-converged box does nothing at all.

**The acceptance test is running it twice.** The second run must report
`changed=0` and fire no handlers. Do this before calling a role finished — it
is the only way to find out, and it costs one command:

```bash
just deploy-ansible --lan   # converge
just deploy-ansible --lan   # must end: changed=0 ... failed=0
```

A task that reports `changed` on a converged box is a bug, not noise. It
notifies a handler, the handler restarts a service, and a deploy that altered
nothing drops the application for the duration — so the cost of getting this
wrong is downtime, and the second run is where it shows up.

How to get there:

- `changed_when: false` on anything read-only, including every verification
  task at the end of a role.
- `creates:`/`removes:` on `command` and `unarchive`, so an expensive step is
  skipped rather than repeated.
- `template` and `copy` over `lineinfile` and shell edits: they converge on
  content and report honestly. Rewriting a file every run is fine; the module
  only reports `changed` when the bytes differ.
- Guard expensive or destructive steps behind a computed `_needed` fact.
- When a command gives no honest signal — `yarn install` reruns its build every
  time and never says "already up to date" — set `changed_when: false` and
  fingerprint the artefact before and after instead, letting the checksum
  decide. Never read intent out of a command's log line.
- `changed_when: true` is only correct on a task already guarded by a `when:`
  that makes it run solely when there is work to do.
- Detect state; do not delete it to force convergence. Wiping a directory so
  the next task can recreate it is a rebuild wearing idempotence as a costume.

**The data plays are the deliberate exception.** `backup.yml`, `restore.yml`
and `upgrade.yml` move data — `restore.yml` replaces every table — so they are
not idempotent and must never be run unprompted. That is exactly why they live
outside `playbook.yml`, behind their own `just` recipes and a typed
confirmation. Nothing in the setup playbook may import or trigger them.
