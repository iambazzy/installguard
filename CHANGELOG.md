# Changelog

## 1.0.0 (2026-11-24)

First stable release.

- **Checks the whole dependency tree, not just the packages you name.** Before installing, installguard previews the full install without running any package code (npm lockfile-only resolution, `pip --dry-run --report` on wheels, `uv --dry-run`) and checks every package that would be added.
- **Lockfile installs are checked too:** `npm ci`, plain `npm install`, `yarn`, `pnpm install`, `bun install`, `poetry install`, `uv sync`, `pipenv install`.
- **`audit` reads lockfiles:** package-lock.json, npm-shrinkwrap.json, yarn.lock (v1 and v2+), pnpm-lock.yaml, bun.lock, poetry.lock, uv.lock and Pipfile.lock.
- **Much bigger typosquat lists:** the 4,000 most-downloaded npm packages and 5,000 most-downloaded PyPI packages (was 340), rebuilt with `npm run update-popular`.
- **Fast:** popular packages are checked through small per-version endpoints, download counts are fetched in batches, and results are cached on disk. An 800-package lockfile takes about 2 seconds on a repeat run.
- **Reliable on bad networks:** retries on timeouts and server errors, and stops calling an unreachable service instead of waiting on it for every package.
- **New `minReleaseAgeDays` policy** to block releases younger than a set age, including in dependencies.
- **Fewer false alarms:** long-standing packages aren't flagged as lookalikes, naming families (`tree-sitter-c`, `tree-sitter-hcl`) aren't typos of each other, and fresh-release notes on busy projects are quiet by default. Tested against nearly 900 legitimate packages and 52 known-bad names.
- Windows: arguments with spaces and shell characters are passed through safely. Ctrl+C goes to the installer.
- New `--direct` flag and `installguard cache` / `cache clear` commands.

## 0.1.0 (2026-11-24)

First release.

- Wraps npm, pnpm, yarn, bun, pip, `python -m pip`, uv, poetry and pipx installs
- Checks: missing packages, lookalike names, new packages, low downloads, install scripts, new publishers, deprecated or yanked versions, npm security placeholders
- `check`, `scan` and `audit` commands, with JSON output
- `hook` command for AI coding agents
- GitHub Action for pull requests
- Zero dependencies
