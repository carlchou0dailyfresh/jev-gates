import { digest, jsonCopy } from './json.js';
import { and } from './logic.js';
import { mountCircuit } from './compose.js';
import { validateCircuit } from './validation.js';
import { validateEvidenceRecord, validateGateSpec } from './artifact.js';
import type { Circuit, Json, Signal, Truth } from './types.js';
import type { EvidenceRecord, GateSpec, UncertaintyPolicy } from './workbench-types.js';

export interface EvidenceDecision extends Signal {
  evidenceIds: string[]; missing: string[]; metadata: Json;
}
function decision(truth: Truth, reason: string, evidenceIds: string[] = [], missing: string[] = [], metadata: Json = {}): EvidenceDecision { return { truth, reason, evidenceIds, missing, metadata }; }
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function timestamp(value: string): number { assert(/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), 'Timestamp must be explicit ISO time'); return Date.parse(value); }

/** Locating a quote only establishes its presence, never support for a claim. */
export function evidenceRequired(evidence: EvidenceRecord[], requiredSourceIds: string[]): EvidenceDecision {
  assert(new Set(requiredSourceIds).size === requiredSourceIds.length, 'Required source ids must be unique');
  const missing = requiredSourceIds.filter(id => !evidence.some(e => e.sourceId === id));
  const invalid: string[] = [], ids: string[] = [];
  for (const raw of evidence.filter(e => requiredSourceIds.includes(e.sourceId))) {
    try { const valid = validateEvidenceRecord(raw); if (!valid.citations.length) invalid.push(valid.sourceId); else ids.push(valid.evidenceId); }
    catch { invalid.push(raw.sourceId); }
  }
  return missing.length || invalid.length ? decision('UNKNOWN', 'evidence_missing_or_unlocatable', ids, [...missing, ...invalid], { locatingTextDoesNotEstablishSupport: true })
    : decision('TRUE', 'required_evidence_located', ids, [], { locatingTextDoesNotEstablishSupport: true });
}
export interface SupportObservation { claim: string; evidenceId: string; relation: 'supports' | 'refutes' | 'mixed' | 'insufficient'; citationIndex: number }
/** Semantic adjudications are explicit inputs from the provider or reviewer, never inferred from matching text. */
export function claimSupport(claim: string, observations: SupportObservation[], evidence: EvidenceRecord[]): EvidenceDecision {
  assert(claim.trim().length > 0, 'A bounded claim is required');
  const accepted: SupportObservation[] = [], missing: string[] = [];
  for (const observation of observations) {
    assert(observation.claim === claim && ['supports', 'refutes', 'mixed', 'insufficient'].includes(observation.relation), 'Observation must address the exact claim');
    const source = evidence.find(e => e.evidenceId === observation.evidenceId);
    try { assert(source, 'missing'); validateEvidenceRecord(source); assert(Number.isSafeInteger(observation.citationIndex) && source.citations[observation.citationIndex], 'citation'); accepted.push(observation); }
    catch { missing.push(observation.evidenceId); }
  }
  const support = accepted.filter(o => o.relation === 'supports').map(o => o.evidenceId), refute = accepted.filter(o => o.relation === 'refutes').map(o => o.evidenceId);
  const conflict = (support.length > 0 && refute.length > 0) || accepted.some(o => o.relation === 'mixed');
  const metadata: Json = { claim, support, refute, observations: jsonCopy(accepted) as unknown as Json, sourceTruthfulnessAssessed: false };
  if (missing.length || !accepted.length) return decision('UNKNOWN', 'claim_evidence_missing', accepted.map(o => o.evidenceId), missing, metadata);
  if (conflict) return decision('UNKNOWN', 'evidence_conflict', accepted.map(o => o.evidenceId), ['Resolve conflicting claim evidence'], metadata);
  if (accepted.some(o => o.relation === 'insufficient')) return decision('UNKNOWN', 'claim_support_insufficient', accepted.map(o => o.evidenceId), ['Evidence addressing the bounded claim'], metadata);
  return decision(support.length ? 'TRUE' : 'FALSE', support.length ? 'claim_supported' : 'claim_refuted', accepted.map(o => o.evidenceId), [], metadata);
}
export function scopeMatch(required: EvidenceRecord['scope'], source: EvidenceRecord): EvidenceDecision {
  validateEvidenceRecord(source); const mismatch: string[] = [], missing: string[] = [];
  for (const key of ['task', 'subject'] as const) if (required[key] !== undefined) {
    if (source.scope[key] === undefined) missing.push(key); else if (source.scope[key] !== required[key]) mismatch.push(key);
  }
  for (const key of ['conditions', 'metrics'] as const) for (const value of required[key] ?? []) {
    if (source.scope[key] === undefined) missing.push(`${key}:${value}`); else if (!source.scope[key]!.includes(value)) mismatch.push(`${key}:${value}`);
  }
  return decision(mismatch.length ? 'FALSE' : missing.length ? 'UNKNOWN' : 'TRUE', mismatch.length ? 'scope_mismatch' : missing.length ? 'scope_missing' : 'scope_matched', [source.evidenceId], missing, { mismatch });
}
export interface ConflictPolicy { version: string; mode: 'abstain' | 'request-more'; }
export function handleConflict(supporting: EvidenceRecord[], refuting: EvidenceRecord[], policy: ConflictPolicy): EvidenceDecision {
  assert(policy.version.length > 0 && ['abstain', 'request-more'].includes(policy.mode), 'Versioned conflict policy required');
  [...supporting, ...refuting].forEach(validateEvidenceRecord);
  const ids = [...new Set([...supporting, ...refuting].map(e => e.evidenceId))];
  if (supporting.length && refuting.length) return decision('UNKNOWN', 'evidence_conflict', ids, [policy.mode === 'request-more' ? 'Independent evidence that resolves the contradiction' : 'Review conflicting evidence'], { policyVersion: policy.version, support: supporting.map(e => e.evidenceId), refute: refuting.map(e => e.evidenceId) });
  return decision(supporting.length ? 'TRUE' : refuting.length ? 'FALSE' : 'UNKNOWN', ids.length ? 'unopposed_evidence' : 'evidence_missing', ids, ids.length ? [] : ['Evidence for or against the claim'], { policyVersion: policy.version });
}
export function freshness(source: EvidenceRecord, now: string, maxAgeMs: number, requiredVersion?: string): EvidenceDecision {
  validateEvidenceRecord(source); assert(Number.isFinite(maxAgeMs) && maxAgeMs >= 0, 'Nonnegative maxAgeMs required');
  const nowMs = timestamp(now), observed = source.freshness.observedAt;
  if (!observed) return decision('UNKNOWN', 'observation_time_missing', [source.evidenceId], ['Timestamp of the original observation']);
  const ageMs = nowMs - timestamp(observed);
  if (ageMs < 0) return decision('UNKNOWN', 'observation_in_future', [source.evidenceId], ['Correct observation timestamp']);
  if (requiredVersion !== undefined && source.freshness.version === undefined) return decision('UNKNOWN', 'source_version_missing', [source.evidenceId], ['Source version']);
  if (requiredVersion !== undefined && source.freshness.version !== requiredVersion) return decision('FALSE', 'source_version_mismatch', [source.evidenceId]);
  const stale = ageMs > maxAgeMs || (source.freshness.validUntil !== undefined && nowMs > timestamp(source.freshness.validUntil));
  return decision(stale ? 'UNKNOWN' : 'TRUE', stale ? 'evidence_stale' : 'evidence_fresh', [source.evidenceId], stale ? ['Fresh observation within the required time window'] : [], { ageMs, maxAgeMs, now });
}
export interface ConstraintInput { id: string; truth: Truth; priority: number; veto: boolean; reason: string }
export function constraints(inputs: ConstraintInput[]): EvidenceDecision {
  assert(inputs.length > 0 && new Set(inputs.map(c => c.id)).size === inputs.length, 'Unique nonempty constraints required');
  inputs.forEach(c => assert(['TRUE', 'FALSE', 'UNKNOWN'].includes(c.truth) && Number.isFinite(c.priority) && typeof c.veto === 'boolean', 'Invalid constraint'));
  const ordered = [...inputs].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const veto = ordered.find(c => c.veto && c.truth === 'FALSE');
  const truth = veto ? 'FALSE' : and(ordered.map(c => c.truth));
  return decision(truth, veto ? 'constraint_veto' : truth === 'TRUE' ? 'constraints_satisfied' : truth === 'FALSE' ? 'constraint_violation' : 'constraint_unknown', [], ordered.filter(c => c.truth === 'UNKNOWN').map(c => c.id), { precedence: ordered.map(c => c.id), veto: veto?.id ?? null, constraints: jsonCopy(ordered) as unknown as Json });
}
export function uncertaintyRouting(policies: UncertaintyPolicy[], route: Omit<UncertaintyPolicy, 'policy' | 'version'>): UncertaintyPolicy | null {
  const matches = policies.filter(p => ['nodeId', 'provider', 'model', 'language', 'scenario'].every(key => p[key as keyof typeof route] === route[key as keyof typeof route]));
  assert(matches.length <= 1, 'Ambiguous uncertainty policy route');
  return matches[0] ? jsonCopy(matches[0]) : null;
}
export function counterexample(candidates: Array<{ id: string; witness: Json }>, verify: (witness: Json) => boolean): EvidenceDecision {
  const checked = candidates.map(c => { try { return { id: c.id, valid: verify(jsonCopy(c.witness)) === true, error: false }; } catch { return { id: c.id, valid: false, error: true }; } }), found = checked.filter(c => c.valid);
  if (!found.length && checked.some(c => c.error)) return decision('UNKNOWN', 'counterexample_verification_failed', [], ['Repair deterministic witness validation'], { checked, absenceIsProof: false });
  return decision(found.length ? 'FALSE' : 'UNKNOWN', found.length ? 'counterexample_verified' : 'no_counterexample_found', [], found.length ? [] : ['Additional counterexample search or independent proof'], { checked, absenceIsProof: false });
}
export function coverageCheck(required: string[], coveredBy: Record<string, string[]>, circuit: Circuit): EvidenceDecision {
  const validated = validateCircuit(circuit), ids = new Set(validated.nodes.map(n => n.id));
  assert(required.length > 0 && new Set(required).size === required.length, 'Unique required coverage dimensions needed');
  for (const nodes of Object.values(coveredBy)) assert(nodes.length > 0 && nodes.every(id => ids.has(id)), 'Coverage references missing nodes');
  const missing = required.filter(key => !Object.hasOwn(coveredBy, key));
  return decision(missing.length ? 'FALSE' : 'TRUE', missing.length ? 'structural_coverage_missing' : 'structural_coverage_complete', [], missing, { onlySpecifiedDimensionsChecked: true, coveredBy });
}
export interface TemporalObservation { at: string; truth: Truth; evidenceId: string }
export interface TemporalContract { version: string; now: string; windowMs: number; maxGapMs: number; minSamples: number; mode: 'all' | 'any' }
export function temporalCondition(observations: TemporalObservation[], contract: TemporalContract): EvidenceDecision {
  assert(contract.version.length > 0 && Number.isFinite(contract.windowMs) && contract.windowMs > 0 && Number.isFinite(contract.maxGapMs) && contract.maxGapMs > 0 && Number.isSafeInteger(contract.minSamples) && contract.minSamples > 0 && ['all', 'any'].includes(contract.mode), 'Invalid temporal contract');
  const now = timestamp(contract.now), sorted = observations.map(o => ({ ...o, time: timestamp(o.at) })).sort((a, b) => a.time - b.time);
  assert(new Set(sorted.map(o => o.time)).size === sorted.length && sorted.every(o => ['TRUE', 'FALSE', 'UNKNOWN'].includes(o.truth) && o.time <= now), 'Duplicate/future/invalid observation');
  const inWindow = sorted.filter(o => o.time >= now - contract.windowMs), ids = inWindow.map(o => o.evidenceId);
  const metadata: Json = { contract: jsonCopy(contract) as unknown as Json, sampleCount: inWindow.length, snapshotDigest: digest(observations) };
  if (inWindow.length < contract.minSamples) return decision('UNKNOWN', 'temporal_missing_samples', ids, ['More observations within the window'], metadata);
  const gaps = [inWindow[0]!.time - (now - contract.windowMs), ...inWindow.slice(1).map((o, i) => o.time - inWindow[i]!.time), now - inWindow.at(-1)!.time];
  if (gaps.some(g => g > contract.maxGapMs)) return decision('UNKNOWN', 'temporal_gap_or_stale', ids, ['Fill observation gaps or refresh stale observation'], metadata);
  const values = inWindow.map(o => o.truth);
  const truth = contract.mode === 'all' ? and(values) : values.includes('TRUE') ? 'TRUE' : values.includes('UNKNOWN') ? 'UNKNOWN' : 'FALSE';
  return decision(truth, 'temporal_' + contract.mode, ids, [], metadata);
}
export interface VersionedSubcircuit { schemaVersion: '1.0'; id: string; version: string; inputSchema: Json; outputContract: Record<string, string>; circuit: Circuit; testsDigest: string; digest: string }
export function versionedSubcircuit(input: Omit<VersionedSubcircuit, 'schemaVersion' | 'digest'>, previous?: VersionedSubcircuit): VersionedSubcircuit {
  assert(/^[A-Za-z][A-Za-z0-9_-]*$/.test(input.id) && /^\d+\.\d+\.\d+$/.test(input.version), 'Versioned subcircuit requires safe id and semver');
  const circuit = validateCircuit(input.circuit); assert(/^[a-f0-9]{64}$/.test(input.testsDigest), 'Tests digest required');
  assert(circuit.outputs.length === Object.keys(input.outputContract).length && circuit.outputs.every(id => typeof input.outputContract[id] === 'string'), 'Output contract must cover exactly all outputs');
  const content = { ...jsonCopy(input), circuit, schemaVersion: '1.0' as const }, result = { ...content, digest: digest(content) };
  if (previous?.id === input.id && previous.digest !== result.digest) assert(previous.version !== input.version, 'Modified subcircuit requires a new version');
  return result;
}
export function mountVersionedSubcircuit(prefix: string, value: VersionedSubcircuit): ReturnType<typeof mountCircuit> {
  const { digest: expected, ...content } = value; assert(expected === digest(content), 'Subcircuit integrity mismatch'); return mountCircuit(prefix, value.circuit);
}
const catalogExamples: Record<string, [string, string]> = {
  'evidence-required': ['All required sources have exact located citations: TRUE', 'A required citation is absent or mismatched: UNKNOWN'],
  'claim-support': ['A cited observation explicitly supports the bounded claim: TRUE', 'One observation supports and another refutes that claim: UNKNOWN'],
  'scope-match': ['Task, subject, conditions and metrics all match: TRUE', 'The requested model differs from the observed model: FALSE'],
  'conflict-handling': ['Only supporting observations under the policy: TRUE', 'Supporting and refuting observations under abstain policy: UNKNOWN'],
  'freshness': ['Observation age equals the maximum allowed age: TRUE', 'Observation is older than the window: UNKNOWN'],
  'constraint-veto': ['All exact constraints are TRUE: TRUE', 'One recorded veto is FALSE despite other TRUE inputs: FALSE'],
  'uncertainty-routing': ['One full identity match selects that versioned policy', 'No match returns null and requires abstention or review'],
  'counterexample': ['A checked witness contradicts the candidate: FALSE', 'No candidate passes witness verification: UNKNOWN'],
  'coverage': ['Every explicitly requested dimension maps to existing nodes: TRUE', 'A requested cost dimension has no mapped node: FALSE'],
  'temporal': ['All samples and window gaps satisfy the contract: TRUE', 'Too few samples or an excessive gap: UNKNOWN'],
  'reusable-subcircuit': ['An intact versioned circuit mounts under a unique namespace', 'Changed content under the same version is rejected'],
};
export const semanticGateCatalog: GateSpec[] = [
  ['evidence-required', 'Are the required source citations locatable?', ['Missing source', 'Invalid citation']],
  ['claim-support', 'Does cited text support this bounded claim?', ['Mixed support', 'Insufficient evidence']],
  ['scope-match', 'Does the source cover the requested scope?', ['Missing scope']],
  ['conflict-handling', 'Is the evidence consistent under the conflict policy?', ['Supporting and refuting evidence']],
  ['freshness', 'Is the observation within the explicit validity window?', ['Missing timestamp', 'Stale evidence']],
  ['constraint-veto', 'Do exact constraints permit the candidate?', ['Unobserved constraint']],
  ['uncertainty-routing', 'Which exact node/provider/model/language/scenario policy applies?', ['No calibrated route']],
  ['counterexample', 'Is there a verified counterexample?', ['No checked counterexample found']],
  ['coverage', 'Are all explicitly requested dimensions mapped to nodes?', []],
  ['temporal', 'Do timestamped observations meet the window contract?', ['Missing samples', 'Gaps or stale observation']],
  ['reusable-subcircuit', 'Does a versioned subcircuit satisfy its declared contract?', ['Unvalidated contract']],
].map(([gateId, question, unknownConditions]) => validateGateSpec({ schemaVersion: '1.0', gateId, version: '1.0.0', question, inputSchema: { type: 'object' }, evidenceIds: [], outputType: 'truth', unknownConditions, policy: { version: '1.0.0', implementation: gateId }, calibrationVersion: null, examples: [{ case: catalogExamples[String(gateId)]![0] }], counterexamples: [{ case: catalogExamples[String(gateId)]![1] }] }));
