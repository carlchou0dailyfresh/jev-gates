# Versioned workbench contracts

All workbench objects use `schemaVersion: "1.0"`. Circuit keeps the existing `version: 1` and public API. JSON Schemas are in `schemas/`; the authoritative runtime validators are exported from `artifact.ts`, with circuit validation in `validation.ts`. A JSON Schema pass alone cannot validate cryptographic linkage or DAG semantics. Runtime verification is always required on import.

| Object | Contract and limitation |
| --- | --- |
| EvidenceRecord | Original text, source identity, synthetic/public/user origin, URL or local locator, retrieval time, content digest, citation offsets, scope and explicit freshness. Citation offsets count JavaScript UTF-16 code units. Every quote must match its original slice. A located quote does not establish claim support. |
| GateSpec | Single bounded question, version, input schema, explicit evidence references, output domain, UNKNOWN conditions, versioned policy, calibration version or null, examples/counterexamples. Helper-specific preconditions enforce the concrete input contracts. The catalog is engineering documentation, not a calibrated model. |
| DecisionSignal | Three-valued truth, reason code, immutable input and policy digests, provider, actual reported model, optional upstream model, original Answer without manufactured confidence and execution provenance. `evidenceIds` in generated semantic metadata lists evidence actually present in the selected semantic state, matched by evidence id and content digest to the register. It does not claim that the source supports the decision. |
| RunArtifact | Circuit, immutable input, evidence, complete provider-level requests/responses, optional HTTP transport capture, actual events, budget ledger, results, action records, assessment and SHA-256 integrity. Child runs require parent id and a reason; they do not edit the parent. |
| ActionRecord | Stable operation id, target, input/policy digests, execution state, optional receipt/query and destination-verification evidence. Common fields in receipts must match the action. An imported receipt is a recorded claim, not authenticated external proof. |
| Assessment | `passed`, `failed` or `not_evaluated`, label/split versions, applicable datasets, metrics, sample count and independent-review flag. Passed/failed require labels, split version and nonzero samples. Workflow completion never creates a quality pass. |

`createRunArtifact({circuit,input,provider?,evidence?,mode?,budget?,parentRunId?,changeReason?,scenarioId?,actions?,assessment?,signal?,onEvent?})` validates and executes the shared core. `sealArtifact(artifact)` refreshes integrity after controlled changes and returns the same object. It does not certify arbitrary content. `verifyArtifact(value)` returns `{valid,errors}` after full verification; `replayArtifact(value)` also returns the deterministic replay result.

## Integrity and offline replay

The SHA-256 covers canonical JSON of every artifact field except `integrity`. Evidence, circuit, input, request and policy digests are separately linked. Verification recomputes exact rules, logic, conditional skips and each validated semantic answer's declared policy; it verifies node order, output signals, provider calls, raw/normalized response relationships, decision metadata, events and budget accounting. Reordered JSON keys are harmless; duplicated/missing question ids, changed policies, mismatched evidence quotes, traces and receipts are rejected.

Replay has no provider or tool argument and never invokes either. It only interprets data and existing receipts; no imported code or shell instruction is executable. Clock-based cancellation/timeouts are historical operational observations. Their accounting is checked, but a fully rewritten and rehashed history cannot be authenticated without an external signature/trust anchor. A hash proves consistency, not the source's identity, truthfulness or scientific validity.

`requests[].response` is the validated normalized result. `rawResponse` is the JSON object returned by a Provider before engine validation. For the built-in HTTP adapters, `transport.request` and `transport.response` separately retain the transmitted JSON body and received JSON body, including extensions dropped by normalization. Headers and API keys are never captured. A known API key echoed by the server is defensively redacted in transport capture and causes the semantic response to be rejected, preventing normalized fields from retaining it. Malformed UTF-8/non-JSON responses and HTTP error bodies are not retained; safe failure metadata is retained instead. Third-party providers may not expose transport capture.

## Budgets and events

Run limits separately bound calls, nodes, total elapsed time and each gate request; optional token/cost limits stop further calls. A batch never sends more questions than the remaining node budget. The total deadline also bounds providers that ignore AbortSignal. A timeout or cancellation records partial results as UNKNOWN and stops relevant future work. Provider callback results arriving after cancellation cannot alter the sealed run.

Token usage is summed only when every attempted request provides valid counts. Otherwise it is `unknown`, never zero. Cost remains `unknown` for nonempty runs because adapters do not supply a trusted price/usage contract. With a finite token/cost limit and unknown usage, the next call is conservatively blocked. A zero budget blocks the first call. Known token limits are checked between calls: the last call can exceed the remaining token allowance because this protocol offers no enforceable per-request token reservation. Do not describe this as an exact spend cap.

Events are emitted by actual core execution: run start/end, provider start/complete/fail and node complete. Each has sequence and timestamp, with request linkage and observable decision where applicable. UI playback replays this history; it does not simulate hidden reasoning or undo executed actions. Gate timeout, failed provider and abstained policy are distinct in event/trace metadata.

## Controller and adapter contract

The existing controller keeps its public behavior and now accepts `gateTimeoutMs`, `toolTimeoutMs`, `verifyTimeoutMs` and `signal`. It propagates a phase-local AbortSignal to gate and action contexts and bounds implementations that ignore it. Cancellation never proves that the destination cancelled its action. Tool failures/timeouts retain the persisted pending operation. Verification failure or timeout cannot advance the state.

Before executing, the controller saves operation id, target tool, input digest and definition/policy digest. `resolvePending(receipt)` verifies external evidence without resubmission. `queryPending()` calls the adapter's optional query method with the same id, then verifies. A query adapter must never implement execute/retry. The caller's exact destination evidence is required for completion; a model's report is insufficient.

`FileCheckpointStore` atomically writes private files (0600) and uses an exclusive writer lock for controller transitions. Competing or stale controller instances are rejected. A crashed writer leaves a lock: inspect the destination and checkpoint before removing it manually. A generic custom store without `withLock` only has per-controller-instance exclusion; callers must implement their own single-writer guarantee. No implementation promises external exactly-once execution.

## Source and model separation

Record input origin (`synthetic`/`public-source`/`user-provided`), provider execution (`fixture`/`recorded-live`/`live-localjev`/`live-typesafe`) and tool realm (`sandbox`/`live`) separately. A real model interpreting synthetic evidence remains a synthetic scenario. LocalJev bridge model and upstream model remain separate metadata; operator-supplied upstream metadata is not an independently observed model attestation. Noul, Choice and Score values retain their own types and policies and must not be multiplied into an end-to-end success probability.
