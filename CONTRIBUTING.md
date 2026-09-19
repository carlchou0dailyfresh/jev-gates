# Contributing

Use Node.js 22 or newer, then run `npm ci` and `npm test`. There are no production dependencies. The compiler and Node type definitions are development dependencies.

Keep pull requests focused. For behavioral changes, add a small test covering the failure or boundary that motivated the change. Use mock providers for repeatable tests; CI must not require network inference, API keys, or a paid account.

The core contract is intentionally small:

- Provider answers are evidence, not executable instructions.
- `UNKNOWN` remains a distinct value through composition.
- Ordinary code performs exact comparison and logic.
- Semantic thresholds are explicit circuit policy.
- Missing or invalid provider answers must never silently become `FALSE`.

Document breaking changes, model assumptions, and whether validation used fixtures or real inference. Check `npm run demo` and `npm pack --dry-run` before a release.

## README translations

Use [README.md](README.md) as the source when updating translations. The project provides English, Traditional Chinese, Simplified Chinese, Japanese, Korean, Spanish, French, German, and Brazilian Portuguese READMEs. Keep every language version aligned when changing features, setup instructions, examples, or limitations.

Translate prose, headings, diagram labels, and code comments. Keep executable commands, JavaScript examples, API identifiers, paths, model versions, and numeric thresholds consistent with the English source. Preserve the distinctions between mock results, live inference, calibrated model quality, and verified tool outcomes.

When adding a language, update the language navigation in every README and verify all relative links. `package.json` includes `README*.md` so translations ship in the package. Detailed documents under `docs/` are currently in English; make that clear in translated READMEs. Translation availability does not establish model quality in that language.

For bugs, include a sanitized circuit and minimal mock response. For provider changes, include protocol fixtures and malformed-response cases. For security concerns, see [SECURITY.md](SECURITY.md).

Contributions are made under the repository's [MIT license](LICENSE).
