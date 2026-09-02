# Ansible

- One role per concern, under `ansible/roles/<name>/`. Wire it into
  `ansible/playbook.yml`; roles run in listed order.
- Every tunable goes in the role's `defaults/main.yml` with a comment saying what
  empty/unset means. No magic values inline in tasks.
- Use fully qualified module names (`ansible.builtin.apt`, not `apt`).
- Task names are sentences describing intent, capitalised, no trailing period.
- Idempotent by default: `changed_when: false` on read-only commands, `creates:`
  on unarchive, guard expensive steps behind a computed `_needed` fact.
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
