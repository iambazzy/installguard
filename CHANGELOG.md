# Changelog

## Unreleased

- Version ranges (`^4.19.0`, `~1.2`, `1.x`) are resolved to the release npm would actually install, in both `audit` and install commands
- Fewer false alarms: verified CI publishing is never treated as a new publisher, and maintainer changes or odd install scripts on widely used packages only warn when the release is brand new
- Tested against 340 popular npm and PyPI packages: only genuinely deprecated ones are flagged

## 0.1.0 (2026-11-24)

First release.

- Wraps npm, pnpm, yarn, bun, pip, `python -m pip`, uv, poetry and pipx installs
- Checks: missing packages, lookalike names, new packages, low downloads, install scripts, new publishers, deprecated or yanked versions, npm security placeholders
- `check`, `scan` and `audit` commands, with JSON output
- `hook` command for AI coding agents
- GitHub Action for pull requests
- Zero dependencies
