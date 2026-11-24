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

- Add well-known names the generator misses to `src/data/popular-extra.js` (the main lists in `src/data/popular.js` are rebuilt with `npm run update-popular`)
- Support another installer or flag in `src/parse.js`, or another lockfile format in `src/lockfiles.js`
- New ecosystems: crates.io, Go modules, RubyGems, Maven
- Hooks and setup guides for other AI coding agents

## Reporting a malicious package

If installguard helped you find real malware, report it to the registry first ([npm](https://www.npmjs.com/support), [PyPI](https://pypi.org/security/)), then open an issue here so we can add a test for that pattern.
