# Contributing

Thanks for helping make installs safer!

## Getting started

```sh
git clone https://github.com/iambazzy/installguard
cd installguard
npm test            # no install step needed: zero dependencies
node bin/installguard.js check express
```

## Ground rules

- **No runtime dependencies.** installguard must not add to anyone's supply chain. Use Node's standard library.
- **Every new check needs a test** in `test/analyze.test.js`. Checks live in `src/analyze.js` as plain functions of registry metadata, so they're easy to test without the network.
- **Avoid false alarms.** A noisy security tool gets turned off. If a check would flag lots of legitimate packages, make it `low` or tie it to other signals.
- **Plain-language messages.** Findings should make sense to someone who has never heard the word "typosquatting".

## Good first contributions

- Add names to the popular-package lists in `src/data/popular.js`
- Support another installer or flag in `src/parse.js`
- New ecosystems: crates.io, Go modules, RubyGems
- Hooks and setup guides for other AI coding agents

## Reporting a malicious package

If installguard helped you find real malware, report it to the registry first ([npm](https://www.npmjs.com/support), [PyPI](https://pypi.org/security/)), then open an issue here so we can add a test for that pattern.
