# deepcraft-nocobase

Ansible automation for a single VM (`nocobase-lxc`, an LXC container at
`192.168.1.5:22022`) hardened by `homelab-infra`. Everything is driven through
`just`; CI runs the same recipes.

## Layout

| path | what |
|---|---|
| `Justfile` | every command — setup, checks, deploy. CI calls these, not raw ansible |
| `ansible/playbook.yml` | one play, `hosts: nocobase`, roles in order |
| `ansible/roles/*` | one role per concern (`nginx`, `nodejs`) |
| `ansible/inventory.yml` | host details come from env vars, nothing committed |
| `.github/workflows/deploy.yml` | deploys on push to `main` touching `ansible/`, `Justfile`, or itself |
| `.env.example` | copy to `.env`; `.env` is gitignored |

## Commands

```bash
just check                      # tools, key, connectivity — run this first when something breaks
just deploy-ansible             # deploy over WARP
just deploy-ansible --lan       # deploy from the home LAN, skips WARP
just connect-ssh [--lan]        # shell on the box
```

Never invoke `ansible-playbook` directly — the recipe writes the key, joins
WARP and exports the inventory env vars.

## Rules

@.claude/rules/commits.md
@.claude/rules/ansible.md
@.claude/rules/secrets.md
