# Release verification

Recorded on 2026-09-19 for the initial release.

| Layer | Observed result | Scope |
| --- | --- | --- |
| Local build and tests | 49 tests passed on Node.js 25.9.0 | Logic, graph validation, malformed responses, local HTTP fixtures, CLI, controller recovery |
| Packed package | Installed the generated archive into a temporary project; library import and executable passed | Actual package contents, with no runtime dependencies |
| Controller example | Created a real local CSV, checked its header and rows, then reached `completed` | Simulated readiness condition, real local file verification |
| LocalJev integration | One live batch evaluated three questions in the synthetic support example; final output was `TRUE` | `localjev-0.2`; `/ready` reported upstream `gemma3:27b` |
| Hosted TypeSafe integration | Validated against protocol fixtures; no live hosted request made | Requires a configured account and separate live validation |

The LocalJev call took approximately 13.1 seconds for this one run. Warm-up state was not controlled; this is a connectivity/inference check, not a speed or accuracy benchmark. Its evaluation response identified the bridge version but did not independently attest the upstream model. The upstream name above came from the local service's readiness endpoint.

Offline example probabilities are hand-written fixtures. Neither these tests nor the live synthetic example calibrate the example thresholds or establish that additional semantic layers improve accuracy.

GitHub CI separately runs the offline suite on Node.js 22 and 24. Consult the repository's current Actions results for the exact commit under review.
