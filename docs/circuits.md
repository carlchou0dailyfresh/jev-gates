# Circuit reference

A circuit is a directed acyclic graph. Dependencies come from logic `inputs`, semantic `context`, and semantic `when`. File order does not determine execution order. Invalid graphs, unknown references, unsupported fields, and invalid policies are rejected before evaluation.

```json
{
  "version": 1,
  "name": "example",
  "nodes": [
    { "id": "paid", "kind": "rule", "path": "/invoice/paid", "op": "eq", "value": true },
    { "id": "approved", "kind": "constant", "value": "UNKNOWN" },
    { "id": "ready", "kind": "logic", "op": "and", "inputs": ["paid", "approved"] }
  ],
  "outputs": ["ready"]
}
```

Every node produces `{ truth, reason, answer? }`. Truth is always the string `TRUE`, `FALSE`, or `UNKNOWN`; never coerce this value with JavaScript's `Boolean()`.

## Semantic nodes

```json
{
  "id": "urgent",
  "kind": "semantic",
  "input": "/message",
  "question": {
    "type": "noul",
    "instructions": "Does this message describe an explicit urgent deadline?"
  },
  "policy": { "type": "noul", "falseAt": 0.2, "trueAt": 0.8 }
}
```

`input` is a JSON Pointer into the original input. Omit it or use `""` to select the entire input. `/items/0/title` selects an array element's field; `~1` represents `/` and `~0` represents `~` inside a pointer segment. A missing selected field yields `UNKNOWN` without a model call.

Questions use the [JEV API's three primitives](https://docs.typesafe.ai/api): `noul` returns a yes/no probability, `choice` returns a selected label and distribution, and `score` returns a probability-weighted rubric level. This library maps those answers through its own policies:

| Policy | TRUE | FALSE | UNKNOWN |
| --- | --- | --- | --- |
| `noul` | `noul >= trueAt` | `noul <= falseAt` | Between the thresholds |
| `score` | `score >= trueAt` | `score <= falseAt` | Between thresholds or below `minConfidence` |
| `choice` | Accepted label in `trueLabels` | Accepted label in `falseLabels` | `unknownLabels`, low selected probability, or small winning margin |

Noul thresholds require `0 <= falseAt < trueAt <= 1`. Score thresholds use the rubric's zero-based scale, from `0` to `criteria.length - 1`, not necessarily a zero-to-one scale. A score's `minConfidence` must also pass before either true or false is emitted.

For a choice, the selected label must have probability at least `minProbability`; its probability minus the highest other label's probability must be at least `minMargin`. Every declared choice label must appear exactly once across `trueLabels`, `falseLabels`, and `unknownLabels`. These arrays are all required. `trueLabels` and `falseLabels` may be empty; `unknownLabels` must contain at least one label. The provider's confidence is recorded but does not replace these choice policy checks.

Malformed distributions, unknown answer labels, missing answers, mismatched types, and other invalid responses make the affected request's nodes unknown. A malformed answer in a batch invalidates that batch. The examples' thresholds and fixture probabilities have not been calibrated on real customer data.

## Layering semantics

Add `context` to pass explicit prior signals into another semantic node:

```json
{
  "id": "review",
  "kind": "semantic",
  "input": "/message",
  "context": ["impact", "relevant_topic"],
  "when": "candidate",
  "question": {
    "type": "noul",
    "instructions": "Using the observation and advisory prior signals, does the original message establish a concrete problem requiring specialist review? Prior signals can be wrong."
  },
  "policy": { "type": "noul", "falseAt": 0.15, "trueAt": 0.85 }
}
```

This node receives a state with this shape:

```text
{
  observation: <selected original input>,
  signals: {
    impact: { truth, reason, answer? },
    relevant_topic: { truth, reason, answer? }
  }
}
```

The selected original observation is retained so the second layer can inspect actual input rather than merely repeat earlier labels. No entire trace, tool credentials, or unselected input fields are added automatically.

`when` must be `TRUE` for evaluation. `FALSE` skips the node with reason `condition_false`; `UNKNOWN` skips it with `condition_unknown`. Both skipped nodes themselves emit `UNKNOWN`, since their questions were not evaluated. Unknown context emits `context_unknown` without making a call. This conservative propagation cannot be overridden by wording the downstream question differently.

See [layered-review.json](../examples/layered-review.json) for a complete circuit.

## Exact rules

Rule nodes use `path` as a JSON Pointer. `eq` and `neq` compare JSON values structurally and preserve their types: `5` does not equal `"5"`. Object key order does not affect equality; array order does.

`gt`, `gte`, `lt`, and `lte` require numeric operands. A numeric string is not converted to a number; it produces `UNKNOWN`. Do arithmetic, parsing, counting, date calculation, and domain validation before running the circuit.

`exists` checks whether the path exists, so a present `null` value still exists. Missing input yields `UNKNOWN` for other rule operators. An explicit `exists` rule is the way to ask whether a field is absent.

## Three-valued logic

`and` and `or` use strong Kleene logic:

| A | B | A AND B | A OR B |
| --- | --- | --- | --- |
| TRUE | TRUE | TRUE | TRUE |
| TRUE | FALSE | FALSE | TRUE |
| TRUE | UNKNOWN | UNKNOWN | TRUE |
| FALSE | TRUE | FALSE | TRUE |
| FALSE | FALSE | FALSE | FALSE |
| FALSE | UNKNOWN | FALSE | UNKNOWN |
| UNKNOWN | TRUE | UNKNOWN | TRUE |
| UNKNOWN | FALSE | FALSE | UNKNOWN |
| UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

`not` accepts exactly one input and preserves unknown. `nand` is NOT AND; `nor` is NOT OR. `xor` returns true for an odd number of true inputs, false for an even number, and unknown if any input is unknown.

`kofn` returns true when at least `k` inputs are true. It returns false when even making every unknown input true could not meet `k`. Otherwise it returns unknown. `k` must be an integer from 1 through the number of inputs. A majority vote is just one `kofn` configuration; it is not an accuracy guarantee.

## Reusable subcircuits

```js
import { mountCircuit, runCircuit } from './dist/index.js';

// `supportCircuit` is the parsed support-triage example.
const support = mountCircuit('support', supportCircuit);
const combined = {
  version: 1,
  name: 'support-with-capacity',
  nodes: [
    ...support.nodes,
    { id: 'capacity', kind: 'rule', path: '/queue/available', op: 'gt', value: 0 },
    { id: 'route', kind: 'logic', op: 'and', inputs: [...support.outputs, 'capacity'] },
  ],
  outputs: ['route'],
};
const result = await runCircuit(combined, input, { provider });
```

Mounting prefixes node IDs and all internal references, including `when` and `context`; input JSON Pointers still refer to the original input. For example, `urgent` becomes `support.urgent`. Prefixes must start with a letter and then contain only letters, digits, `_`, or `-`.

## Runtime and CLI

`runCircuit(circuit, input, options)` evaluates one copied input snapshot. It does not reuse results from earlier runs. Ready semantic nodes sharing the same selected state are batched, up to 16 questions and 128 outcomes per call. These are project limits, not claims about provider rate limits.

The default `maxCalls` is 16 and the default per-call `timeoutMs` is 30,000. Failed attempts consume the call budget. There are no automatic retries. A missing provider, exhausted budget, timeout, or transport failure results in unknown affected nodes. The library accepts an optional `AbortSignal`.

The result contains node signals, selected outputs, call metadata, timings, and circuit/input/request digests. `status: "evaluated"` means all requested outputs are known; it does not mean all are true or that an external task is complete. Any unknown output makes the status `"abstained"`.

CLI run exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Every output is known, whether TRUE or FALSE |
| `2` | Invalid input, configuration, or command failure |
| `3` | At least one output is UNKNOWN |

`--max-calls`, `--timeout-ms`, and `--trace` configure runtime limits and optional trace output. Trace files are created without overwriting an existing file. `graph` prints Mermaid source. The CLI has no tool execution or controller command; use the library for those integrations.
