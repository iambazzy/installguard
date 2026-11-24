# Changelog

## 0.1.0 (2026-11-24)

First release.

- Wraps npm, pnpm, yarn, bun, pip, `python -m pip`, uv, poetry and pipx installs
- Checks: missing packages, lookalike names, new packages, low downloads, install scripts, new publishers, deprecated or yanked versions, npm security placeholders
- `check`, `scan` and `audit` commands, with JSON output
- `hook` command for Claude Code and other AI agents
- GitHub Action for pull requests
- Zero dependencies
