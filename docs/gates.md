# Fine-grained semantic gates

These exported helpers preserve the original TRUE/FALSE/UNKNOWN logic tables. They return `{truth,reason,evidenceIds,missing,metadata}` and use versioned, explicit inputs. They do not change AND/OR/NOT/XOR/NAND/NOR/k-of-n or invent a global confidence threshold. Their tests are engineering tests; no model-quality calibration is implied.

| Helper | Preconditions and decision rule | UNKNOWN / failure | Evidence and checks |
| --- | --- | --- | --- |
| `evidenceRequired` | Unique required source ids; verify original content digest and at least one exact quote per required source. TRUE means the required text can be located. | Missing source, malformed digest or unlocatable citation → UNKNOWN. | Available original text and its exact slices. Text presence is not claim support. |
| `claimSupport` | Nonempty bounded claim; each explicit semantic/reviewer adjudication must address that exact claim and valid citation. All supported → TRUE; all refuted → FALSE. | Missing citation, insufficient relation, mixed relation or support/refute conflict → UNKNOWN. | Original EvidenceRecords and separate support/refute ids retained. Does not judge source truthfulness. |
| `scopeMatch` | Compare task and subject exactly; each required condition/metric must appear in source scope. Any explicit mismatch → FALSE. | Missing requested scope field → UNKNOWN. | Each task, subject, condition and metric mismatch is listed. No cross-paper ranking. |
| `handleConflict` | Versioned `abstain` or `request-more` policy. Unopposed support → TRUE; unopposed refutation → FALSE. | Both sides or no evidence → UNKNOWN. | Both source lists retained; no majority-vote shortcut. |
| `freshness` | Explicit ISO `now`, observation time, nonnegative age limit and optional required version. Valid within inclusive boundaries → TRUE; wrong known version → FALSE. | Missing time/version, future observation, age beyond window or expired validity → UNKNOWN. | Exact arithmetic, no model date estimates. Retrieval time does not replace observation time. |
| `constraints` | Unique constraint ids, finite numeric priority, explicit veto flag and truth. Lower priority number wins recorded veto precedence. FALSE veto dominates; otherwise ternary AND. | Missing facts remain UNKNOWN unless another exact constraint rejects the candidate. | Ordered ids, veto id and exact caller-supplied conditions retained. |
| `uncertaintyRouting` | Exact node/provider/model/language/scenario match; one versioned policy only. | No match → null; multiple matches rejected. | Caller must use an explicit abstention/review route for null. No implicit universal score line. |
| `counterexample` | Candidate JSON witnesses checked by a deterministic verifier. A verified counterexample refutes candidate (FALSE). | No verified witness → UNKNOWN, never proof of truth. | Checked witness ids and validity flags retained. |
| `coverageCheck` | Nonempty, unique requested dimensions and valid existing DAG node mappings. All requested mappings present → TRUE; missing → FALSE. | Invalid node references rejected. | Structural coverage only; cannot establish that all important factors were requested. |
| `temporalCondition` | Versioned immutable observations and explicit now/window/max-gap/min-samples/mode. All/any applies ternary semantics to in-window observations. | Too few samples, excessive gaps or stale final sample → UNKNOWN. Duplicate/future samples rejected. | Inclusive window start, maximum gap includes both window boundaries. Snapshot digest and sample count retained. |
| `versionedSubcircuit` / `mountVersionedSubcircuit` | Safe namespace, semver, validated DAG, exact output contract, input-schema declaration and test-results digest. Mount rewrites all node references. | Changed content without new version or mismatched digest rejected. | Test digest is provenance, not evidence that the tests actually passed. Callers execute tests before promotion. |

Runtime contracts are exported as TypeScript interfaces and JSON Schemas in `schemas/`. GateSpec catalog entries use `calibrationVersion: null`; their illustrative example/counterexample cases are not a model training set. Runnable success/failure/counterexample fixtures and adversarial tests live in `tests/semantic-gates.test.mjs`, while scenario-specific datasets and frozen evaluation protocols are documented separately.

Composition example:

```ts
const required = evidenceRequired(sources, ['paper-A']);
const scope = scopeMatch({ task: 'bounded retrieval', metrics: ['accuracy'] }, sources[0]);
const fresh = freshness(sources[0], '2026-09-20T00:00:00.000Z', 86_400_000);
// Supply these observable truths as exact input to a Circuit; use a separate
// bounded semantic node for claim support. A quote locator is never that node.
```

The helpers deliberately distinguish a bad/missing observation from an operational provider error. Assessment must also distinguish these: a failed API returning UNKNOWN cannot count as a correct model abstention merely because the reference answer is UNKNOWN.
