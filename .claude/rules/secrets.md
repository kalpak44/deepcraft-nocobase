# Secrets and hosts

- Never commit `.env`. Add new variables to `.env.example` with an empty value
  and a comment on where to get it.
- No keys, tokens, passwords or private IPs hardcoded in `ansible/`, the
  `Justfile` or workflows — read them from the environment.
- CI reads the same variable names from repo secrets; adding a new one means
  adding it to `.env.example` *and* the `env:` block in
  `.github/workflows/deploy.yml`.
- Don't print secret values in recipe or task output; report presence and
  fingerprints instead.
