# Evaluate a complete semantic circuit

The fixtures in `examples/` test wiring and policy behavior. They are hand-written expected responses, not outputs from a model and not evidence of accuracy, calibration, or latency.

## Build a labeled dataset

Start with representative observations and independently reviewed expected decisions. Include routine cases, ambiguous cases, missing fields, contradictory evidence, and text that attempts to instruct the evaluator. Label both individual semantic questions and the final intended decision where practical.

Separate threshold-development data from held-out evaluation data. Split related examples together so repeated customer messages or near duplicates do not leak between sets. Record the circuit version, question wording, thresholds, provider, resolved model version, and LocalJev upstream configuration.

## Measure decisions and abstention together

Report at least:

- Correct and incorrect known outputs, with false positives and false negatives separately.
- Coverage: the fraction of examples with a known final output.
- Abstention rate and the reasons for unknown signals.
- Per-node failures and end-to-end failures, including timeouts and malformed responses.
- Provider calls, tokens when available, and observed end-to-end latency distributions.

A circuit that abstains on nearly everything can have excellent accuracy on its few known outputs. Always report coverage alongside that accuracy. Measure different languages and use cases separately when their behavior differs.

## Choose thresholds from evidence

The sample thresholds are design examples. Tune thresholds to the errors your application can tolerate, then evaluate the frozen policy on held-out observations. Review cases close to each threshold and examine how often claimed probabilities agree with observed outcomes.

TypeSafe's [confidence documentation](https://docs.typesafe.ai/confidence) distinguishes answer distributions from the confidence statistic used by choice and score. This project uses Noul bands, a choice probability-and-margin policy, and a score confidence floor. None is a universal probability that the final workflow will succeed.

Pin a model version for repeatable evaluations and rerun the dataset when changing the provider, model, prompt, context shape, or thresholds. Aliases may move to a different model; the [model documentation](https://docs.typesafe.ai/models) describes that behavior.

## Test the value of stacking

Compare a single question, independent atomic questions plus code, and your layered circuit on the same held-out examples. Measure errors, coverage, calls, and latency for each. Add a layer only if the measured tradeoff is useful.

Related judgments are correlated. Repeating one model's opinion through multiple gates does not provide independent confirmation. A later layer can amplify a wrong premise. The engine preserves original observations alongside explicit context, but this design alone does not establish improved accuracy.

Do not multiply per-question probabilities or treat a `kofn` vote as a calibrated joint probability. Where a final calibrated probability is required, fit and validate an appropriate separate model using held-out evidence.

## Keep provider results separate

[LocalJev's implementation](https://github.com/githubnext/localjev) uses generated probability values from an upstream model. Protocol compatibility does not imply the same probability interpretation, quality, speed, or calibration as hosted JEV. Maintain separate evaluation records and threshold policies for each backend and model configuration.

## Verify the application too

Test controller paths for true, false, unknown, transport failure, failed tool verification, process interruption, pending-operation recovery, and budget exhaustion. Live tool success requires actual evidence from the destination system. A semantic result, mock receipt, or local test does not establish that evidence.
