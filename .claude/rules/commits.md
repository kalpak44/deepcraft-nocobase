# Commits

- Short, clear, one line. Imperative mood, lowercase, no trailing period.
- Nobody, no description, no bullet lists, unless the user asks for one.
- Never add a `Co-Authored-By` trailer, and never add "Generated with Claude Code".
- No emoji, no `type(scope):` prefixes.
- One logical change per commit.
- Commit only when asked.

Good:

```
install the current node lts on nocobase
report whether the box is reached via lan or warp
drop the repository secrets section from the readme
```

Bad:

```
feat(nodejs): add Node.js LTS installation support 🚀

This commit adds a new role that...

Co-Authored-By: ...
```
