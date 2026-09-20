import { performance } from 'node:perf_hooks';

const EPSILON = 1e-9;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireValue(condition, message) {
  if (!condition) throw new TypeError(message);
}

function exactFields(value, expected, label) {
  requireValue(record(value), `${label} 必須是物件。`);
  requireValue(Object.keys(value).every(key => expected.includes(key)) && expected.every(key => Object.hasOwn(value, key)), `${label} 欄位不符合配送資料格式。`);
}

function name(value, label) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 160, `${label} 必須是 1–160 字的文字。`);
  return value.trim();
}

function number(value, minimum, maximum, label) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum, `${label} 必須介於 ${minimum} 與 ${maximum} 之間。`);
  return Object.is(value, -0) ? 0 : value;
}

function location(value, label) {
  return {
    id: value.id,
    name: name(value.name, `${label}名稱`),
    lat: number(value.lat, -90, 90, `${label}緯度`),
    lng: number(value.lng, -180, 180, `${label}經度`),
  };
}

/** Validate a single, preloaded car delivery tour. Never converts free text to addresses. */
export function validateDeliveryDraft(raw) {
  exactFields(raw, ['depot', 'stops', 'departureMinutes', 'capacity', 'returnToDepot'], '配送草稿');
  exactFields(raw.depot, ['id', 'name', 'lat', 'lng'], '起點');
  requireValue(raw.depot.id === 'depot', '起點 ID 必須為 depot。');
  requireValue(Array.isArray(raw.stops) && raw.stops.length >= 2 && raw.stops.length <= 7, '配送站點必須有 2–7 站。');
  requireValue(typeof raw.returnToDepot === 'boolean', '是否返回起點必須是布林值。');
  const seen = new Set(['depot']);
  const stops = Array.from(raw.stops, (stop, index) => {
    const label = `站點 ${index + 1}`;
    exactFields(stop, ['id', 'name', 'lat', 'lng', 'earliest', 'latest', 'serviceMinutes', 'demand'], label);
    requireValue(typeof stop.id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(stop.id) && !seen.has(stop.id), `${label} ID 必須唯一，且不能使用 depot。`);
    seen.add(stop.id);
    const earliest = number(stop.earliest, 0, 1440, `${label}最早服務時間`);
    const latest = number(stop.latest, 0, 1440, `${label}最晚服務時間`);
    requireValue(earliest <= latest, `${label}時間窗起點不可晚於終點。`);
    return {
      ...location(stop, label),
      earliest,
      latest,
      serviceMinutes: number(stop.serviceMinutes, 0, 1440, `${label}服務分鐘數`),
      demand: number(stop.demand, 0, 1e9, `${label}需求量`),
    };
  });
  const capacity = number(raw.capacity, 0, 1e9, '車輛容量');
  requireValue(capacity > 0, '車輛容量必須大於 0。');
  return {
    depot: location(raw.depot, '起點'),
    stops,
    departureMinutes: number(raw.departureMinutes, 0, 1440, '出發分鐘數'),
    capacity,
    returnToDepot: raw.returnToDepot,
  };
}

function matrixErrors(matrix, size) {
  if (!record(matrix)) return ['路網矩陣必須是物件。'];
  const errors = [];
  for (const field of ['durations', 'distances']) {
    const rows = matrix[field];
    if (!Array.isArray(rows) || rows.length !== size) { errors.push(`${field} 必須有 ${size} 列。`); continue; }
    for (let row = 0; row < size; row++) {
      if (!Array.isArray(rows[row]) || rows[row].length !== size) { errors.push(`${field}[${row}] 必須有 ${size} 欄。`); continue; }
      for (let col = 0; col < size; col++) {
        const value = rows[row][col];
        if (value !== null && !(typeof value === 'number' && Number.isFinite(value) && value >= 0)) errors.push(`${field}[${row}][${col}] 必須是非負有限數值或 null。`);
        if (row === col && value !== 0 && value !== null) errors.push(`${field}[${row}][${col}] 對角線必須為 0 或 null。`);
      }
    }
  }
  return errors;
}

function emptyResult(started, capacityExceeded, reason, errors = [], permutations = 0) {
  return {
    order: [], legs: [],
    distanceMeters: null, driveMinutes: null, totalMinutes: null,
    lateMinutes: null, lateStops: null,
    capacityExceeded, feasible: false,
    elapsedMs: performance.now() - started, permutations,
    infeasibilityReasons: [reason, ...(capacityExceeded ? ['capacity_exceeded'] : [])],
    ...(errors.length > 0 ? { matrixErrors: errors } : {}),
  };
}

function better(candidate, current) {
  if (!current) return true;
  for (const key of ['lateStops', 'lateMinutes', 'totalMinutes', 'distanceMeters']) {
    if (candidate[key] < current[key] - EPSILON) return true;
    if (candidate[key] > current[key] + EPSILON) return false;
  }
  return false; // Input stop order provides stable tie breaking.
}

/**
 * Exhaustive asymmetric TSP with service-start time windows, bounded to 7! tours.
 * matrix indices are depot first, followed by the supplied stop order.
 * All cargo is loaded at the depot; this is one car, not a multi-vehicle solver.
 * An infeasible, reachable best tour may be returned for explaining lateness or
 * capacity. No complete reachable tour returns empty order/legs and null totals.
 */
export function solveDelivery(rawDraft, matrix) {
  const started = performance.now();
  const draft = validateDeliveryDraft(rawDraft);
  const demand = draft.stops.reduce((sum, stop) => sum + stop.demand, 0);
  const capacityExceeded = demand > draft.capacity + EPSILON;
  const invalid = matrixErrors(matrix, draft.stops.length + 1);
  if (invalid.length) return emptyResult(started, capacityExceeded, 'invalid_matrix', invalid);

  let best = null;
  let permutations = 0;
  const used = new Array(draft.stops.length).fill(false);
  const order = [];

  function evaluate() {
    permutations += 1;
    const legs = [];
    let previous = 0;
    let departureMinutes = draft.departureMinutes;
    let distanceMeters = 0;
    let driveMinutes = 0;
    let lateMinutes = 0;
    let lateStops = 0;
    const visits = [...order.map(index => index + 1), ...(draft.returnToDepot ? [0] : [])];
    for (const next of visits) {
      const durationSeconds = matrix.durations[previous][next];
      const distance = matrix.distances[previous][next];
      if (durationSeconds === null || distance === null) return;
      const arrivalMinutes = departureMinutes + durationSeconds / 60;
      const stop = next === 0 ? null : draft.stops[next - 1];
      const waitMinutes = stop ? Math.max(0, stop.earliest - arrivalMinutes) : 0;
      const serviceStart = arrivalMinutes + waitMinutes;
      const late = stop ? Math.max(0, serviceStart - stop.latest) : 0;
      const nextDeparture = serviceStart + (stop?.serviceMinutes ?? 0);
      legs.push({
        from: previous === 0 ? draft.depot.id : draft.stops[previous - 1].id,
        to: next === 0 ? draft.depot.id : stop.id,
        distanceMeters: distance, durationSeconds,
        arrivalMinutes, departureMinutes: nextDeparture,
        waitMinutes, lateMinutes: late,
      });
      distanceMeters += distance;
      driveMinutes += durationSeconds / 60;
      lateMinutes += late;
      if (late > EPSILON) lateStops += 1;
      previous = next;
      departureMinutes = nextDeparture;
    }
    const candidate = {
      order: order.map(index => draft.stops[index].id), legs,
      distanceMeters, driveMinutes,
      totalMinutes: departureMinutes - draft.departureMinutes,
      lateMinutes, lateStops,
    };
    if (better(candidate, best)) best = candidate;
  }

  function enumerate() {
    if (order.length === draft.stops.length) { evaluate(); return; }
    for (let i = 0; i < draft.stops.length; i++) {
      if (used[i]) continue;
      used[i] = true; order.push(i); enumerate(); order.pop(); used[i] = false;
    }
  }
  enumerate();
  if (!best) return emptyResult(started, capacityExceeded, 'unreachable', [], permutations);
  return {
    ...best,
    capacityExceeded,
    feasible: !capacityExceeded && best.lateStops === 0,
    elapsedMs: performance.now() - started,
    permutations,
    infeasibilityReasons: [...(best.lateStops > 0 ? ['time_windows'] : []), ...(capacityExceeded ? ['capacity_exceeded'] : [])],
  };
}

function haversineMeters(a, b) {
  const toRadians = Math.PI / 180;
  const latitude = (b.lat - a.lat) * toRadians;
  const longitude = (b.lng - a.lng) * toRadians;
  const h = Math.sin(latitude / 2) ** 2 + Math.cos(a.lat * toRadians) * Math.cos(b.lat * toRadians) * Math.sin(longitude / 2) ** 2;
  return 6_371_008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

/** Synthetic car matrix only: 1.28 x great-circle distance at constant 20 km/h. */
export function fixtureMatrix(rawDraft) {
  const draft = validateDeliveryDraft(rawDraft);
  const points = [draft.depot, ...draft.stops];
  const distances = points.map((from, i) => points.map((to, j) => i === j ? 0 : Math.round(haversineMeters(from, to) * 1.28)));
  const durations = distances.map(row => row.map(meters => Math.round(meters / (20_000 / 3600))));
  return {
    distances, durations,
    provenance: {
      kind: 'fixture', synthetic: true, profile: 'car',
      speedKmh: 20, detourFactor: 1.28,
      description: '合成汽車矩陣：球面直線距離乘 1.28，固定時速 20 公里。不含道路、交通、管制、停靠或機車路權資訊。',
    },
  };
}
