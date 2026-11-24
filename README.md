<div align="center">

# 🛡️ installguard

**Check packages before you install them.**

Catches fake, typosquatted and AI-hallucinated packages on **npm** and **PyPI**, before they run code on your machine.

[![CI](https://github.com/iambazzy/installguard/actions/workflows/ci.yml/badge.svg)](https://github.com/iambazzy/installguard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/installguard?color=2ea44f)](https://www.npmjs.com/package/installguard)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-2ea44f)](package.json)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-ea4aaa)](https://github.com/sponsors/iambazzy)

<img src="docs/demo.svg" alt="installguard catching a typo and an AI-hallucinated package" width="760">

</div>

---

## Why

AI coding assistants sometimes suggest packages **that don't exist**. Attackers watch for those names, register them and fill them with malware. This is called *slopsquatting*. Add the classic typo trick (`reqeusts`, `axois`, `lodahs`) and a single `npm install` or `pip install` is enough to get compromised.

Package managers install whatever you ask for. **installguard asks a few questions first:**

- Does this package actually exist?
- Is the name one or two letters away from a famous package?
- Was it published days ago, with almost no downloads?
- Does it run a script during install, and does that script download or execute code?
- Was the latest version published by someone who has never published this package before?

If everything looks normal, your install runs as usual. If not, you see why and decide.

## Install

```sh
npm install -g installguard
```

Requires Node.js 18.17 or newer. **installguard has zero dependencies**, because a security tool shouldn't add to your supply chain.

## Use

Put `installguard` in front of any install command:

```sh
installguard npm install express
installguard pip install requests==2.32.3
installguard pnpm add zod
installguard uv pip install httpx
```

Works with **npm, pnpm, yarn, bun, pip, pip3, `python -m pip`, uv, poetry and pipx**. Anything that isn't an install (`npm run build`, `pip list`) passes straight through.

### Make it automatic

Add these to your `~/.bashrc` or `~/.zshrc` and you never have to think about it:

```sh
alias npm='installguard npm'
alias pnpm='installguard pnpm'
alias pip='installguard pip'
```

### Check without installing

```sh
installguard check express lodash          # npm (default)
installguard check --pypi numpy pandas     # PyPI
installguard check npm:axios pypi:requests # mix both
installguard scan "cd app && npm i axois && pip install reqeusts"
```

### Audit a project

```sh
installguard audit .
```

Checks every dependency in `package.json` and `requirements*.txt`. Exits with code `1` if anything is risky, so it drops straight into CI.

## Protect your AI coding agent

This is where installguard really helps: agents install packages without reading the warnings. installguard can **block** a risky install *before* the agent runs it, and tell the agent why so it can fix the name itself.

Point any agent that supports pre-command hooks at `installguard hook`. For agents configured with a JSON hooks file, the setup usually looks like this:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "installguard hook" }]
      }
    ]
  }
}
```

**Any other tool:** pipe the command to `installguard hook`. It accepts JSON (`{"tool_input": {"command": "..."}}` or `{"command": "..."}`) or plain text, and exits `2` with the reason on stderr when it blocks.

## GitHub Action

Fail a pull request when it adds a risky dependency:

```yaml
# .github/workflows/deps.yml
name: Dependency check
on: [pull_request]
jobs:
  installguard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: iambazzy/installguard@v0
        with:
          path: .          # folder with package.json / requirements.txt
          strict: false    # true = also fail on "check this" findings
```

## What it checks

| Check | Severity | Why it matters |
|---|---|---|
| Package doesn't exist | 🔴 critical | Hallucinated names are free for attackers to register |
| npm security placeholder | 🔴 critical | npm removed it, usually for malware |
| Name looks like a popular package | 🟠 high | Typosquatting (`axois` → `axios`) |
| First published under 7 days ago | 🟠 high | Most malicious packages are brand new |
| Install script that downloads or runs code | 🟠 high | `curl … \| sh` in `postinstall` is a classic payload |
| Requested version doesn't exist | 🟠 high | Often a hallucinated version number |
| Version was yanked | 🟠 high | Authors pulled it for a reason |
| Published under 30 days ago | 🟡 medium | Worth a second look |
| Under 100 downloads last week | 🟡 medium | Nobody else is using it |
| Any install script on a little-used package | 🟡 medium | Code runs on your machine at install time |
| New publisher on an established package | 🟡 medium | What an account takeover looks like |
| Deprecated | 🟡 medium | Usually there's a better option |
| No source repository, single version, sdist only | ⚪ low | Context, never blocks |

**Verdicts:** 🔴 and 🟠 stop the install and ask you first. 🟡 is shown but doesn't stop the install unless you pass `--strict`. In CI and agent hooks, where there's no one to ask, risky installs are blocked.

## Options

```
-y, --yes       continue without asking, even if something looks risky
--strict        also stop on medium ("check this") findings
--dry-run       check only, never run the install
--json          machine-readable results on stdout
-v, --verbose   show every finding, including minor ones
```

**Exit codes:** `0` ok · `1` stopped because of a risky package · `2` error

### Allow-list

For private or internal packages, create `.installguardrc.json` in your project (or home folder):

```json
{ "allow": ["my-company-internal-lib"], "strict": false }
```

Or set `INSTALLGUARD_ALLOW=pkg-a,pkg-b`.

## How it works

installguard reads public metadata from the npm registry, the npm downloads API, PyPI's JSON API and pypistats. It never runs or downloads package code. Lookups run in parallel and take about a second. If a registry can't be reached, it says so and lets the install continue rather than guessing.

## Roadmap

- [ ] crates.io (Rust) and Go modules
- [ ] `pyproject.toml`, `poetry.lock` and lockfile scanning
- [ ] Local cache for faster repeat checks
- [ ] Hooks for Cursor, Windsurf and other agents
- [ ] Check maintainers' 2FA status and provenance attestations
- [ ] Larger, auto-updated popular-package lists

Ideas and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Support this project

installguard is free and open source, built and maintained by [@iambazzy](https://github.com/iambazzy) in my spare time. If it caught something for you, or your team relies on it, please consider supporting it:

<a href="https://github.com/sponsors/iambazzy"><img src="https://img.shields.io/badge/GitHub%20Sponsors-%E2%9D%A4-ea4aaa?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="Sponsor on GitHub"></a>
<a href="https://buymeacoffee.com/iambazzy"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black" alt="Buy me a coffee"></a>

**Companies:** sponsorship tiers include your logo here and priority on issues. [Get in touch](mailto:mohammadbasit0404@gmail.com).

A ⭐ on the repo helps more people find it.

## License

[MIT](LICENSE) © Mohammad Basit
