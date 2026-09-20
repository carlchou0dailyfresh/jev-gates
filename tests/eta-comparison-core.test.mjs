import test from 'node:test';
import assert from 'node:assert/strict';
import { compareEtaSession, aggregateEtaComparisons, ETA_PAIR_WINDOW_SECONDS } from '../workbench/server/eta-comparison-core.mjs';

const BASE = Date.parse('2026-09-20T08:00:00.000Z');
const iso = seconds => new Date(BASE + seconds * 1000).toISOString();
const options = { now: BASE + 3600_000 };
const estimate = (minSeconds, maxSeconds = minSeconds) => ({ minSeconds, maxSeconds });
function drive(id = 'drive-1', localSeconds = 600, googleSeconds = 660) {
  const context = { originKey: 'taipei-station', destinationKey: 'taipei-101', departureAt: iso(30), routeKey: 'unverified-route-description' };
  const prediction = (captured, seconds, manual = false) => ({ kind: 'DRIVE_TRIP', context: { ...context }, basis: 'live', capturedAt: iso(captured), sourceTimestamp: { at: iso(captured - (manual ? 0 : 5)), basis: manual ? 'manual_display_observed' : 'local_forecast_generated' }, estimate: estimate(seconds) });
  return { id, scenario: { id: 'off_peak', label: '合成測試資料，非道路实測', kind: 'DRIVE_TRIP', routeAlignment: 'unverified' }, local: prediction(0, localSeconds), google: prediction(5, googleSeconds, true) };
}
function actualFor(session, seconds = 630) {
  const startedAt = session.local.context[session.scenario.kind === 'DRIVE_TRIP' ? 'departureAt' : 'referenceAt'];
  const completedAt = new Date(Date.parse(startedAt) + seconds * 1000).toISOString();
  return { kind: session.scenario.kind, context: { ...session.local.context }, basis: 'live', startedAt, completedAt, recordedAt: new Date(Date.parse(completedAt) + 5000).toISOString(), source: 'manual_observation', selfReported: true, samePathConfirmed: true, nextVehicleConfirmed: true };
}
function bus(id = 'bus-1') {
  const context = { stopId: 'stop-101', routeId: 'route-307', direction: '0', referenceAt: iso(0) };
  return { id, scenario: { id: 'bus_fresh', kind: 'BUS_WAIT' },
    local: { kind: 'BUS_WAIT', context: { ...context }, basis: 'live', capturedAt: iso(30), sourceTimestamp: { at: iso(0), basis: 'provider_updated' }, estimate: estimate(300) },
    google: { kind: 'BUS_WAIT', context: { ...context }, basis: 'live', capturedAt: iso(60), sourceTimestamp: { at: iso(60), basis: 'manual_display_observed' }, estimate: estimate(240) } };
}

test('point comparison reports signed local-minus-Google delta but no accuracy without actual', () => {
  const result = compareEtaSession(drive(), options);
  assert.equal(result.status, 'comparable'); assert.equal(result.evidenceLevel, 'observed_only');
  assert.equal(result.comparison.signedDeltaSeconds, -60); assert.equal(result.comparison.absoluteDifferenceSeconds, 60);
  assert.equal(result.accuracy.status, 'missing_actual'); assert.equal(result.accuracy.actualSeconds, null);
  assert.match(result.warnings.join(' '), /無法核實/);
  assert.equal(JSON.stringify(result).includes('accuracyPercent'), false);
});

test('freshness is checked at capture, so a completed historical session remains assessable', () => {
  const session = drive(); session.actual = actualFor(session);
  const result = compareEtaSession(session, options);
  assert.equal(result.status, 'comparable'); assert.equal(result.accuracy.status, 'eligible');
  assert.equal(result.accuracy.actualSeconds, 630); assert.equal(result.accuracy.selfReported, true);
  assert.deepEqual(result.accuracy.localErrorRangeSeconds, { min: -30, max: -30 });
  assert.deepEqual(result.accuracy.googleErrorRangeSeconds, { min: 30, max: 30 });
});

test('an interval remains a range and is never replaced by a midpoint', () => {
  const session = drive(); session.google.estimate = estimate(540, 720); session.google.precision = 'reported_interval'; session.actual = actualFor(session, 630);
  const result = compareEtaSession(session, options);
  assert.deepEqual(result.comparison.signedDeltaRangeSeconds, { min: -120, max: 60 });
  assert.deepEqual(result.comparison.absoluteDifferenceRangeSeconds, { min: 0, max: 120 });
  assert.equal(result.comparison.signedDeltaSeconds, null); assert.equal(result.comparison.absoluteDifferenceSeconds, null);
  const summary = aggregateEtaComparisons([session], options);
  assert.equal(summary.metrics.google.meanAbsoluteErrorSeconds, null);
  assert.deepEqual(summary.metrics.google.meanAbsoluteErrorRangeSeconds, { min: 0, max: 90 });
  assert.deepEqual(summary.metrics.google.biasRangeSeconds, { min: -90, max: 90 });
  assert.deepEqual(summary.metrics.google.within60Seconds, { guaranteedCount: 0, possibleCount: 1, total: 1 });
  assert.deepEqual(summary.metrics.google.within120Seconds, { guaranteedCount: 1, possibleCount: 1, total: 1 });
});

test('bus waits align source snapshot and observation times instead of counting fetch lag as error', () => {
  const session = bus(); session.actual = actualFor(session, 310);
  const result = compareEtaSession(session, options);
  assert.equal(result.status, 'comparable'); assert.equal(result.comparison.signedDeltaSeconds, 0);
  assert.deepEqual(result.comparison.localRangeSeconds, { min: 300, max: 300 });
  assert.deepEqual(result.comparison.googleRangeSeconds, { min: 300, max: 300 });
  assert.equal(result.accuracy.status, 'eligible'); assert.deepEqual(result.accuracy.localErrorRangeSeconds, { min: -10, max: -10 });
  session.local.estimateReferenceAt = iso(5);
  assert.equal(compareEtaSession(session, options).comparison.signedDeltaSeconds, 5);
});

test('a recently cached bus snapshot may be captured before the common waiting start without fabricating source time', () => {
  const session = bus(); session.local.capturedAt = iso(10); session.local.context.referenceAt = session.google.context.referenceAt = iso(20);
  const result = compareEtaSession(session, options);
  assert.equal(result.status, 'comparable'); assert.equal(result.comparison.signedDeltaSeconds, 0);
  assert.deepEqual(result.comparison.localRangeSeconds, { min: 280, max: 280 });
  assert.equal(result.timestamps.localSourceAt, iso(0)); assert.equal(result.timestamps.localCapturedAt, iso(10));
});

test('API response observation times do not claim verified provider or traffic-data freshness', () => {
  const session = drive(); session.local.sourceTimestamp = { at: session.local.capturedAt, basis: 'response_observed' };
  session.google.sourceTimestamp = { at: session.google.capturedAt, basis: 'response_observed' };
  const result = compareEtaSession(session, options);
  assert.equal(result.status, 'comparable'); assert.equal(result.evidenceLevel, 'observed_only'); assert.match(result.warnings.join(' '), /API 回應/);
});

test('whole-journey versus waiting and different stop/route/direction/reference contexts are rejected', () => {
  const wrongKind = bus(); wrongKind.google.kind = 'DRIVE_TRIP';
  assert.equal(compareEtaSession(wrongKind, options).status, 'incomparable');
  for (const [field, value] of [['stopId', 'other-stop'], ['routeId', 'other-route'], ['direction', '1'], ['referenceAt', iso(1)]]) {
    const session = bus(); session.google.context[field] = value;
    const result = compareEtaSession(session, options); assert.equal(result.status, 'incomparable'); assert.ok(result.reasonCodes.includes('pair_context_mismatch'));
  }
  const wrongDeparture = drive(); wrongDeparture.google.context.departureAt = iso(31);
  assert.ok(compareEtaSession(wrongDeparture, options).reasonCodes.includes('pair_context_mismatch'));
});

test('same OD can compare unverified routes but accuracy needs explicit self-reported same-path observation', () => {
  const session = drive(); session.local.context.routeKey = 'via-A'; session.google.context.routeKey = 'via-B'; session.actual = actualFor(session); session.actual.samePathConfirmed = false;
  const result = compareEtaSession(session, options);
  assert.equal(result.status, 'comparable'); assert.equal(result.accuracy.status, 'ineligible'); assert.ok(result.accuracy.reasonCodes.includes('actual_path_unconfirmed'));
  session.scenario.routeAlignment = 'same_path_confirmed';
  assert.equal(compareEtaSession(session, options).accuracy.status, 'ineligible', 'a scenario label cannot replace the actual confirmation');
  session.actual.samePathConfirmed = true; assert.equal(compareEtaSession(session, options).accuracy.status, 'eligible');
});

test('source and pair freshness cutoffs include 120 seconds and reject one millisecond beyond', () => {
  assert.equal(ETA_PAIR_WINDOW_SECONDS, 120);
  const session = drive(); session.local.sourceTimestamp.at = iso(-120); session.google.capturedAt = iso(120); session.google.sourceTimestamp.at = iso(120);
  assert.equal(compareEtaSession(session, options).status, 'comparable');
  session.local.sourceTimestamp.at = iso(-120.001);
  assert.ok(compareEtaSession(session, options).reasonCodes.includes('local_source_stale'));
  session.local.sourceTimestamp.at = iso(0); session.google.capturedAt = iso(120.001); session.google.sourceTimestamp.at = iso(120.001);
  assert.ok(compareEtaSession(session, options).reasonCodes.includes('pair_window_exceeded'));
});

test('future, missing, malformed source timestamps and invalid intervals are rejected', () => {
  for (const sourceAt of [null, '', '2026-09-20 08:00:00', '2026-02-30T08:00:00Z', iso(.001)]) {
    const session = drive(); session.local.sourceTimestamp.at = sourceAt;
    assert.equal(compareEtaSession(session, options).status, 'incomparable');
  }
  const capturedFuture = drive(); capturedFuture.local.capturedAt = iso(3601); assert.ok(compareEtaSession(capturedFuture, options).reasonCodes.includes('local_capture_future'));
  for (const interval of [estimate(-1), estimate(20, 10), estimate(NaN), estimate(Infinity), estimate(86401)]) {
    const session = drive(); session.google.estimate = interval; assert.equal(compareEtaSession(session, options).status, 'incomparable');
  }
});

test('live/synthetic observations cannot mix and synthetic scenarios never count as real accuracy', () => {
  const session = drive(); session.google.basis = 'synthetic';
  assert.ok(compareEtaSession(session, options).reasonCodes.includes('mixed_synthetic_live'));
  session.local.basis = 'synthetic'; session.actual = { ...actualFor(session), basis: 'synthetic' };
  const result = compareEtaSession(session, options);
  assert.equal(result.status, 'comparable'); assert.equal(result.evidenceLevel, 'synthetic'); assert.equal(result.accuracy.status, 'synthetic_only');
  assert.equal(aggregateEtaComparisons([session], options).eligibleAccuracyCount, 0);
});

test('predictions collected at or after actual arrival, or after drive departure, do not score', () => {
  const afterArrival = bus(); afterArrival.actual = actualFor(afterArrival, 60);
  assert.ok(compareEtaSession(afterArrival, options).accuracy.reasonCodes.includes('prediction_after_actual'));
  const afterDeparture = drive(); afterDeparture.local.capturedAt = iso(31); afterDeparture.actual = actualFor(afterDeparture);
  assert.ok(compareEtaSession(afterDeparture, options).accuracy.reasonCodes.includes('drive_prediction_after_departure'));
  const tooEarly = drive(); tooEarly.local.context.departureAt = tooEarly.google.context.departureAt = iso(121); tooEarly.actual = actualFor(tooEarly);
  assert.ok(compareEtaSession(tooEarly, options).accuracy.reasonCodes.includes('drive_prediction_too_early'));
});

test('actual must match the session, be a completed nonfuture self-report and confirm the next vehicle', () => {
  const base = bus(); base.actual = actualFor(base, 300);
  for (const mutate of [
    actual => { actual.context.direction = '1'; }, actual => { actual.completedAt = iso(3601); actual.recordedAt = iso(3602); },
    actual => { actual.source = 'google_maps'; }, actual => { actual.selfReported = false; },
    actual => { actual.nextVehicleConfirmed = false; }, actual => { actual.startedAt = iso(1); }, actual => { actual.recordedAt = iso(299); },
  ]) { const session = structuredClone(base); mutate(session.actual); assert.equal(compareEtaSession(session, options).accuracy.status, 'ineligible'); }
});

test('an already-passed bus arrival is not silently clamped to zero waiting seconds', () => {
  const session = bus(); session.local.context.referenceAt = session.google.context.referenceAt = iso(20); session.local.estimate = estimate(5);
  assert.ok(compareEtaSession(session, options).reasonCodes.includes('arrival_before_wait_start'));
});

test('paired MAE, nearest-rank p90, bias and tolerance counts use only the same eligible sessions', () => {
  const errors = [-200, -120, -60, -30, 0, 30, 60, 90, 120, 300];
  const sessions = errors.map((error, i) => { const session = drive(`metric-${i}`, 600 + error, 660); session.actual = actualFor(session, 600); return session; });
  const unobserved = drive('no-actual'), mismatch = drive('mismatch'); mismatch.google.context.destinationKey = 'other'; mismatch.actual = actualFor(mismatch);
  const result = aggregateEtaComparisons([...sessions, unobserved, mismatch], options);
  assert.equal(result.eligibleAccuracyCount, 10); assert.equal(result.excludedFromAccuracyCount, 2);
  assert.equal(result.metrics.local.meanAbsoluteErrorSeconds, 101); assert.equal(result.metrics.local.p90AbsoluteErrorSeconds, 200); assert.equal(result.metrics.local.biasSeconds, 19);
  assert.deepEqual(result.metrics.local.within60Seconds, { guaranteedCount: 5, possibleCount: 5, total: 10 });
  assert.deepEqual(result.metrics.local.within120Seconds, { guaranteedCount: 8, possibleCount: 8, total: 10 });
  assert.equal(result.metrics.google.meanAbsoluteErrorSeconds, 60); assert.equal(result.metrics.google.biasSeconds, 60); assert.equal(result.metrics.google.count, 10);
  assert.equal(result.percentileMethod, 'nearest_rank'); assert.equal(JSON.stringify(result).includes('accuracyPercent'), false);
});

test('zero eligible observations produce null metrics, not invented scores or accuracy percentages', () => {
  const result = aggregateEtaComparisons([drive()], options);
  assert.equal(result.eligibleAccuracyCount, 0);
  for (const metrics of Object.values(result.metrics)) {
    assert.equal(metrics.count, 0); assert.equal(metrics.meanAbsoluteErrorSeconds, null); assert.equal(metrics.meanAbsoluteErrorRangeSeconds, null);
    assert.equal(metrics.p90AbsoluteErrorSeconds, null); assert.equal(metrics.biasSeconds, null); assert.equal(metrics.within60Seconds.total, 0);
  }
});

test('duplicate session IDs cannot inflate paired accuracy counts', () => {
  const session = drive('duplicate'); session.actual = actualFor(session);
  const result = aggregateEtaComparisons([session, structuredClone(session)], options);
  assert.equal(result.eligibleAccuracyCount, 0); assert.deepEqual(result.duplicateSessionIds, ['duplicate']);
});

test('rounded displayed minutes carry approximate precision without inventing Google rounding bounds', () => {
  const session = drive(); session.google.precision = 'rounded_minutes'; session.actual = actualFor(session);
  const result = compareEtaSession(session, options);
  assert.equal(result.comparison.precision, 'approximate'); assert.equal(result.comparison.containsRoundedInputs, true);
  assert.deepEqual(result.comparison.googleRangeSeconds, { min: 660, max: 660 });
  assert.equal(aggregateEtaComparisons([session], options).containsRoundedInputs, true);
});

test('manual import wrappers are accepted as observations, without mutation or hidden persistence', () => {
  const session = drive(); const wrapper = { kind: 'manual_eta_observation', version: 1, session };
  const before = JSON.stringify(wrapper), result = compareEtaSession(wrapper, options);
  assert.equal(result.status, 'comparable'); assert.equal(JSON.stringify(wrapper), before);
  assert.equal(compareEtaSession({ kind: 'manual_eta_observation', version: 2, session }, options).status, 'incomparable');
});

test('six explicitly synthetic scenarios cover peak/off-peak/interval/fresh/stale/direction cases without real-world scores', () => {
  const scenarios = [drive('peak'), drive('off-peak'), drive('google-interval'), bus('fresh-wait'), bus('stale-source'), bus('wrong-direction')];
  scenarios.forEach(session => { session.local.basis = 'synthetic'; session.google.basis = 'synthetic'; session.scenario.label = '合成 fixture；不是實際觀察'; });
  scenarios[2].google.estimate = estimate(600, 900); scenarios[4].local.sourceTimestamp.at = iso(-300); scenarios[5].google.context.direction = '1';
  const result = aggregateEtaComparisons(scenarios, options);
  assert.equal(result.sessionCount, 6); assert.equal(result.comparableCount, 4); assert.equal(result.incomparableCount, 2); assert.equal(result.eligibleAccuracyCount, 0);
});
