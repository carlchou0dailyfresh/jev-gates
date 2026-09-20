/** Browser-safe, deterministic observation comparison. No network, storage, provider SDK or midpoint imputation. */
export const ETA_PAIR_WINDOW_SECONDS = 120;
const WINDOW_MS = ETA_PAIR_WINDOW_SECONDS * 1000;
const KINDS = ['DRIVE_TRIP', 'BUS_WAIT'];
const SOURCE_BASES = ['provider_updated', 'local_forecast_generated', 'manual_display_observed', 'response_observed'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const range = (min, max) => ({ min, max });
const isPoint = value => value.min === value.max;
const scalar = value => value && isPoint(value) ? value.min : null;
const issue = (list, code, message) => { if (!list.some(item => item.code === code)) list.push({ code, message }); };
const unwrap = input => object(input) && input.kind === 'manual_eta_observation' && input.version === 1 ? input.session : input;

function timestamp(value) {
  if (typeof value !== 'string') return NaN;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) return NaN;
  const [, y, m, d, h, min, sec, , zoneH = '0', zoneM = '0'] = match;
  const [year, month, day, hour, minute, second] = [y, m, d, h, min, sec].map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 2200 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59
    || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || Number(zoneH) > 14 || Number(zoneM) > 59 || (Number(zoneH) === 14 && Number(zoneM) !== 0)) return NaN;
  return Date.parse(value);
}
function clock(options) {
  const now = options?.now === undefined ? Date.now() : typeof options.now === 'string' ? timestamp(options.now) : options.now;
  if (!finite(now) || !Number.isFinite(new Date(now).getTime())) throw new TypeError('A finite evaluation clock is required.');
  return now;
}
function contextFields(kind) {
  return kind === 'DRIVE_TRIP' ? ['originKey', 'destinationKey', 'departureAt'] : ['stopId', 'routeId', 'direction', 'referenceAt'];
}
function contextValid(context, kind) {
  if (!object(context) || !KINDS.includes(kind)) return false;
  const timeField = kind === 'DRIVE_TRIP' ? 'departureAt' : 'referenceAt';
  return contextFields(kind).every(field => field === timeField ? Number.isFinite(timestamp(context[field])) : key(context[field]))
    && (kind !== 'BUS_WAIT' || ['0', '1'].includes(context.direction));
}
function sameContext(a, b, kind) {
  if (!contextValid(a, kind) || !contextValid(b, kind)) return false;
  const timeField = kind === 'DRIVE_TRIP' ? 'departureAt' : 'referenceAt';
  return contextFields(kind).every(field => field === timeField ? timestamp(a[field]) === timestamp(b[field]) : a[field] === b[field]);
}
function inspectPrediction(value, side, kind, now, issues) {
  if (!object(value)) { issue(issues, `${side}_missing`, `${side === 'local' ? '本系統' : 'Google'}預估紀錄缺失。`); return null; }
  if (value.kind !== kind) issue(issues, `${side}_measurement_mismatch`, '等待時間與全程時間不能互相比較。');
  if (!contextValid(value.context, kind)) issue(issues, `${side}_context_missing`, '預估缺少完整的路段、站牌方向或共同時間基準。');
  if (!['live', 'synthetic'].includes(value.basis)) issue(issues, `${side}_basis_missing`, '必須明示預估是真實觀察或合成資料。');
  const captured = timestamp(value.capturedAt), source = timestamp(value.sourceTimestamp?.at);
  if (!Number.isFinite(captured)) issue(issues, `${side}_capture_missing`, '缺少有效且含時區的擷取時間。');
  else if (captured > now) issue(issues, `${side}_capture_future`, '擷取時間位於未來，不能使用。');
  if (!Number.isFinite(source) || !SOURCE_BASES.includes(value.sourceTimestamp?.basis)) issue(issues, `${side}_source_time_missing`, '缺少來源時間或其代表意義，不能假設資料新鮮。');
  else if (source > now || (Number.isFinite(captured) && source > captured)) issue(issues, `${side}_source_future`, '來源時間晚於擷取時間或目前時鐘，不能使用。');
  else if (Number.isFinite(captured) && captured - source > WINDOW_MS) issue(issues, `${side}_source_stale`, '來源時間距擷取超過 120 秒，不能當作同一時刻的預估。');
  const estimate = value.estimate;
  if (!object(estimate) || !finite(estimate.minSeconds) || !finite(estimate.maxSeconds) || estimate.minSeconds < 0 || estimate.maxSeconds < estimate.minSeconds || estimate.maxSeconds > 86400) {
    issue(issues, `${side}_estimate_invalid`, '預估必須是 0–86400 秒內的點值或有序區間。');
  }
  if (value.precision !== undefined && !['seconds', 'rounded_minutes', 'reported_interval'].includes(value.precision)) issue(issues, `${side}_precision_invalid`, '預估精度標記無效。');
  const anchor = value.estimateReferenceAt === undefined ? source : timestamp(value.estimateReferenceAt);
  if (kind === 'BUS_WAIT') {
    const reference = timestamp(value.context?.referenceAt);
    if (!Number.isFinite(anchor) || anchor > captured || anchor > now || captured - anchor > WINDOW_MS) issue(issues, `${side}_wait_reference_invalid`, '到站預估起算時間缺失、位於未來或距擷取超過 120 秒。');
    if (Number.isFinite(reference) && (reference > now || (Number.isFinite(captured) && reference - captured > WINDOW_MS))) issue(issues, `${side}_wait_start_future`, '共同等候起點位於未來，或距預估擷取超過 120 秒。');
  }
  return { value, captured, source, anchor };
}
function normalizedPrediction(prediction, kind) {
  const estimate = prediction.value.estimate;
  const offset = kind === 'BUS_WAIT' ? (prediction.anchor - timestamp(prediction.value.context.referenceAt)) / 1000 : 0;
  return range(estimate.minSeconds + offset, estimate.maxSeconds + offset);
}
function absoluteRange(value) {
  return range(value.min <= 0 && value.max >= 0 ? 0 : Math.min(Math.abs(value.min), Math.abs(value.max)), Math.max(Math.abs(value.min), Math.abs(value.max)));
}
function emptyAccuracy(status, issues = []) {
  return { status, reasons: issues.map(item => item.message), reasonCodes: issues.map(item => item.code), actualSeconds: null,
    selfReported: false, actualSource: null, localErrorRangeSeconds: null, googleErrorRangeSeconds: null, containsRoundedInputs: false };
}
function assessActual(session, local, google, comparison, now) {
  if (session.local?.basis === 'synthetic' && session.google?.basis === 'synthetic') return emptyAccuracy('synthetic_only', [{ code: 'synthetic_not_accuracy', message: '合成情境不能加入真實準確度統計。' }]);
  if (session.actual === undefined || session.actual === null) return emptyAccuracy('missing_actual', [{ code: 'actual_missing', message: '尚未記錄實際結果，只能比較預估差異。' }]);
  const actual = session.actual, issues = [];
  if (!comparison || !local || !google) issue(issues, 'pair_incomparable', '這組預估未通過配對檢查，不能計算準確度。');
  if (!object(actual)) return emptyAccuracy('ineligible', [{ code: 'actual_invalid', message: '實際觀察紀錄無效。' }]);
  const kind = session.scenario?.kind;
  if (actual.source !== 'manual_observation' || actual.selfReported !== true) issue(issues, 'actual_source_invalid', '實際結果必須明示為人工自報的實地觀察；Google 預估不是實際結果。');
  if (actual.kind !== kind || !sameContext(actual.context, session.local?.context, kind) || !sameContext(actual.context, session.google?.context, kind)) issue(issues, 'actual_context_mismatch', '實際結果與配對的量測、地點、方向或時間基準不同。');
  if (actual.basis !== 'live' || session.local?.basis !== 'live' || session.google?.basis !== 'live') issue(issues, 'actual_basis_mismatch', '真實準確度只能使用真實預估與真實觀察。');
  const started = timestamp(actual.startedAt), completed = timestamp(actual.completedAt), recorded = timestamp(actual.recordedAt);
  if (![started, completed, recorded].every(Number.isFinite)) issue(issues, 'actual_time_missing', '實際觀察缺少有效的開始、完成或記錄時間。');
  else {
    if (started > now || completed > now || recorded > now) issue(issues, 'actual_future', '實際觀察的時間不能位於未來。');
    if (completed < started || recorded < completed || completed - started > 86400_000) issue(issues, 'actual_time_order', '實際觀察時間順序或時長無效。');
    if (local && google && (local.captured >= completed || google.captured >= completed)) issue(issues, 'prediction_after_actual', '兩筆預估都必須在實際結果發生之前擷取。');
    const reference = timestamp(actual.context?.[kind === 'DRIVE_TRIP' ? 'departureAt' : 'referenceAt']);
    if (started !== reference) issue(issues, 'actual_start_mismatch', '實測開始時間必須等於這組比較的共同起算時間。');
    if (kind === 'DRIVE_TRIP' && local && google) {
      if (local.captured > started || google.captured > started) issue(issues, 'drive_prediction_after_departure', '全程預估必須在實際出發前或出發時擷取。');
      else if (started - local.captured > WINDOW_MS || started - google.captured > WINDOW_MS) issue(issues, 'drive_prediction_too_early', '實際出發距預估擷取超過 120 秒，不能當作同一趟即刻出發比較。');
    }
  }
  if (kind === 'DRIVE_TRIP' && actual.samePathConfirmed !== true) issue(issues, 'actual_path_unconfirmed', '尚未人工確認實際走的是兩筆預估共同比較的路徑；相同起終點不足以證明。');
  if (kind === 'BUS_WAIT' && actual.nextVehicleConfirmed !== true) issue(issues, 'actual_vehicle_unconfirmed', '尚未人工確認觀察的是同站牌、路線及方向的下一班車。');
  if (issues.length) return emptyAccuracy('ineligible', issues);
  const actualSeconds = (completed - started) / 1000;
  return { status: 'eligible', reasons: [], reasonCodes: [], actualSeconds, selfReported: true, actualSource: 'manual_observation',
    localErrorRangeSeconds: range(comparison.localRangeSeconds.min - actualSeconds, comparison.localRangeSeconds.max - actualSeconds),
    googleErrorRangeSeconds: range(comparison.googleRangeSeconds.min - actualSeconds, comparison.googleRangeSeconds.max - actualSeconds),
    containsRoundedInputs: comparison.containsRoundedInputs };
}

/** Manual import wrappers {kind:'manual_eta_observation',version:1,session} are data only and never cause network or persistence. */
export function compareEtaSession(input, options = {}) {
  const now = clock(options), session = unwrap(input), issues = [], warnings = [];
  const safe = object(session) ? session : {};
  if (!key(safe.id)) issue(issues, 'session_id_missing', '比較需要獨立的觀察編號。');
  const scenario = object(safe.scenario) ? safe.scenario : {}, kind = KINDS.includes(scenario.kind) ? scenario.kind : null;
  if (!key(scenario.id) || !kind) issue(issues, 'scenario_invalid', '情境或量測類型缺失。');
  if (scenario.routeAlignment !== undefined && !['unverified', 'same_path_confirmed'].includes(scenario.routeAlignment)) issue(issues, 'alignment_invalid', '路徑核對標記無效。');
  const local = inspectPrediction(safe.local, 'local', kind, now, issues), google = inspectPrediction(safe.google, 'google', kind, now, issues);
  const pairGapSeconds = local && google && Number.isFinite(local.captured) && Number.isFinite(google.captured) ? Math.abs(local.captured - google.captured) / 1000 : null;
  if (local && google) {
    if (!sameContext(local.value.context, google.value.context, kind)) issue(issues, 'pair_context_mismatch', kind === 'BUS_WAIT' ? '站牌、路線、方向或共同等候起點不同，不能配對。' : '起終點或出發時間不同，不能配對。');
    if (local.value.basis !== google.value.basis) issue(issues, 'mixed_synthetic_live', '合成預估不能與真實觀察混合比較。');
    if (pairGapSeconds !== null && pairGapSeconds > ETA_PAIR_WINDOW_SECONDS) issue(issues, 'pair_window_exceeded', '兩筆預估擷取時間相差超過 120 秒。');
  }
  const evidenceLevel = local?.value.basis === 'synthetic' && google?.value.basis === 'synthetic' ? 'synthetic'
    : [local, google].some(p => ['manual_display_observed', 'response_observed'].includes(p?.value.sourceTimestamp?.basis)) ? 'observed_only'
      : local && google ? 'provider_timestamps' : 'unknown';
  if (evidenceLevel === 'observed_only') warnings.push('畫面讀值或 API 回應時間只證明當時取得預估；無法核實 Google 或其他供應者何時更新底層資料。');
  if (kind === 'DRIVE_TRIP') warnings.push('相同起終點與 routeKey 都不證明路徑相同；準確度需要另行人工確認實走路徑。');
  let comparison = null;
  if (!issues.length && local && google) {
    const localRangeSeconds = normalizedPrediction(local, kind), googleRangeSeconds = normalizedPrediction(google, kind);
    if (localRangeSeconds.min < 0 || googleRangeSeconds.min < 0) issue(issues, 'arrival_before_wait_start', '預估到站區間早於共同等候起點，不能把已經過時的預估夾成零秒。');
    else {
      const signedDeltaRangeSeconds = range(localRangeSeconds.min - googleRangeSeconds.max, localRangeSeconds.max - googleRangeSeconds.min);
      const absoluteDifferenceRangeSeconds = absoluteRange(signedDeltaRangeSeconds);
      const containsRoundedInputs = [local, google].some(p => p.value.precision === 'rounded_minutes');
      comparison = { unit: 'seconds', interpretation: kind === 'DRIVE_TRIP' ? 'trip_duration' : 'wait_normalized_to_reference', localRangeSeconds, googleRangeSeconds,
        signedDeltaRangeSeconds, absoluteDifferenceRangeSeconds, signedDeltaSeconds: scalar(signedDeltaRangeSeconds), absoluteDifferenceSeconds: scalar(absoluteDifferenceRangeSeconds),
        containsRoundedInputs, precision: containsRoundedInputs ? 'approximate' : 'reported' };
      if (containsRoundedInputs) warnings.push('包含畫面以整分鐘呈現的讀值；差異是近似比較，不能聲稱秒級精度，也未假定供應者的四捨五入規則。');
    }
  }
  return { version: 1, id: key(safe.id) ? safe.id : null, scenarioId: key(scenario.id) ? scenario.id : null, kind,
    status: comparison ? 'comparable' : 'incomparable', evidenceLevel, reasons: issues.map(item => item.message), reasonCodes: issues.map(item => item.code), warnings, comparison,
    accuracy: assessActual(safe, local, google, comparison, now),
    timestamps: { localCapturedAt: Number.isFinite(local?.captured) ? new Date(local.captured).toISOString() : null, googleCapturedAt: Number.isFinite(google?.captured) ? new Date(google.captured).toISOString() : null,
      localSourceAt: Number.isFinite(local?.source) ? new Date(local.source).toISOString() : null, googleSourceAt: Number.isFinite(google?.source) ? new Date(google.source).toISOString() : null,
      pairGapSeconds, evaluatedAt: new Date(now).toISOString() } };
}

function errorMetrics(errors) {
  const count = errors.length, absolute = errors.map(absoluteRange);
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  // Nearest-rank p90: the ceil(.9 * n)-th ordered observation, one-based. Bound endpoints are monotone statistics, not midpoints.
  const p90 = values => [...values].sort((a, b) => a - b)[Math.ceil(.9 * values.length) - 1];
  const meanAbsoluteErrorRangeSeconds = count ? range(mean(absolute.map(e => e.min)), mean(absolute.map(e => e.max))) : null;
  const p90AbsoluteErrorRangeSeconds = count ? range(p90(absolute.map(e => e.min)), p90(absolute.map(e => e.max))) : null;
  const biasRangeSeconds = count ? range(mean(errors.map(e => e.min)), mean(errors.map(e => e.max))) : null;
  const within = seconds => ({ guaranteedCount: absolute.filter(e => e.max <= seconds).length, possibleCount: absolute.filter(e => e.min <= seconds).length, total: count });
  return { count, meanAbsoluteErrorSeconds: scalar(meanAbsoluteErrorRangeSeconds), meanAbsoluteErrorRangeSeconds,
    p90AbsoluteErrorSeconds: scalar(p90AbsoluteErrorRangeSeconds), p90AbsoluteErrorRangeSeconds,
    biasSeconds: scalar(biasRangeSeconds), biasRangeSeconds, within60Seconds: within(60), within120Seconds: within(120) };
}

/** All error statistics use the same matched, live, manually observed session set for both predictors. Google is never ground truth. */
export function aggregateEtaComparisons(sessions, options = {}) {
  if (!Array.isArray(sessions) || sessions.length > 1000) throw new TypeError('Provide at most 1000 comparison sessions.');
  const now = clock(options), results = sessions.map(session => compareEtaSession(session, { now }));
  const frequencies = new Map();
  for (const result of results) if (result.id !== null) frequencies.set(result.id, (frequencies.get(result.id) || 0) + 1);
  const duplicateSessionIds = [...frequencies.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort();
  const duplicateIds = new Set(duplicateSessionIds);
  const eligible = results.filter(result => result.status === 'comparable' && result.accuracy.status === 'eligible' && !duplicateIds.has(result.id));
  return { sessionCount: results.length, comparableCount: results.filter(result => result.status === 'comparable').length,
    incomparableCount: results.filter(result => result.status !== 'comparable').length, eligibleAccuracyCount: eligible.length,
    excludedFromAccuracyCount: results.length - eligible.length, duplicateSessionIds,
    containsRoundedInputs: eligible.some(result => result.accuracy.containsRoundedInputs), percentileMethod: 'nearest_rank', actualSource: 'manual_self_reported_only',
    metrics: { local: errorMetrics(eligible.map(result => result.accuracy.localErrorRangeSeconds)), google: errorMetrics(eligible.map(result => result.accuracy.googleErrorRangeSeconds)) }, results };
}
