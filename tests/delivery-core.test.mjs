import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixtureMatrix, solveDelivery, validateDeliveryDraft } from '../workbench/server/delivery-core.mjs';

function draftFor(count = 2, patch = {}) {
  return {
    depot: { id: 'depot', name: '起點', lat: 25.05, lng: 121.52 },
    stops: Array.from({ length: count }, (_, index) => ({ id: `s${index + 1}`, name: `站點${index + 1}`, lat: 25.05 + index * 0.004, lng: 121.53 + index * 0.005, earliest: 0, latest: 1440, serviceMinutes: 0, demand: 1 })),
    departureMinutes: 540, capacity: 10, returnToDepot: true,
    ...patch,
  };
}

function matrix(minutes, distances) {
  return { durations: minutes.map(row => row.map(value => value === null ? null : value * 60)), distances: distances ?? minutes.map(row => row.map(value => value === null ? null : value * 100)) };
}

function permutations(values) {
  return values.length === 0 ? [[]] : values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest]));
}

// Independent small oracle uses explicit tuples and fixed index tours.
function bruteOracle(draft, routes) {
  return permutations(draft.stops.map((_, index) => index + 1)).map(order => {
    const path = [0, ...order, ...(draft.returnToDepot ? [0] : [])];
    let clock = draft.departureMinutes;
    let late = 0, lateCount = 0, distance = 0;
    for (let edge = 1; edge < path.length; edge++) {
      clock += routes.durations[path[edge - 1]][path[edge]] / 60;
      distance += routes.distances[path[edge - 1]][path[edge]];
      if (path[edge] !== 0) {
        const stop = draft.stops[path[edge] - 1];
        clock = Math.max(clock, stop.earliest);
        late += Math.max(0, clock - stop.latest);
        lateCount += clock > stop.latest ? 1 : 0;
        clock += stop.serviceMinutes;
      }
    }
    return { order: order.map(i => draft.stops[i - 1].id), cost: [lateCount, late, clock - draft.departureMinutes, distance] };
  }).sort((a, b) => {
    for (let i = 0; i < 4; i++) if (a.cost[i] !== b.cost[i]) return a.cost[i] - b.cost[i];
    return 0;
  })[0];
}

test('delivery exact tour agrees with independent brute-force oracle across asymmetric matrices', () => {
  for (let seed = 1; seed <= 18; seed++) {
    const draft = draftFor(4);
    draft.stops = draft.stops.map((stop, i) => {
      const earliest = 540 + ((seed * 11 + i * 13) % 38);
      return { ...stop, earliest, latest: earliest + 5 + ((seed * 7 + i * 17) % 35), serviceMinutes: 2 + i };
    });
    const times = Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => i === j ? 0 : 2 + ((seed * 5 + i * 17 + j * 11 + i * j * 3) % 25)));
    const distances = times.map((row, i) => row.map((t, j) => i === j ? 0 : t * 91 + (i + j) * 13));
    const routes = matrix(times, distances);
    const expected = bruteOracle(draft, routes);
    const actual = solveDelivery(draft, routes);
    assert.deepEqual(actual.order, expected.order, `seed ${seed}`);
    assert.deepEqual([actual.lateStops, actual.lateMinutes, actual.totalMinutes, actual.distanceMeters], expected.cost);
    assert.equal(actual.permutations, 24);
  }
});

test('delivery respects directed edges instead of reversing a cheap route', () => {
  const result = solveDelivery(draftFor(), matrix([[0, 2, 20], [20, 0, 2], [2, 20, 0]]));
  assert.deepEqual(result.order, ['s1', 's2']);
  assert.deepEqual(result.legs.map(leg => [leg.from, leg.to]), [['depot', 's1'], ['s1', 's2'], ['s2', 'depot']]);
  assert.equal(result.driveMinutes, 6);
  assert.equal(result.totalMinutes, 6);
  assert.equal(result.feasible, true);
});

test('delivery waits before a window and applies deadline to service start, not completion', () => {
  const draft = draftFor(2, { returnToDepot: false });
  draft.stops[0] = { ...draft.stops[0], earliest: 560, latest: 560, serviceMinutes: 12 };
  draft.stops[1] = { ...draft.stops[1], latest: 620, serviceMinutes: 3 };
  const result = solveDelivery(draft, matrix([[0, 5, 50], [5, 0, 5], [50, 40, 0]]));
  assert.deepEqual(result.order, ['s1', 's2']);
  assert.deepEqual(result.legs[0], { from: 'depot', to: 's1', distanceMeters: 500, durationSeconds: 300, arrivalMinutes: 545, departureMinutes: 572, waitMinutes: 15, lateMinutes: 0 });
  assert.equal(result.totalMinutes, 40);
  assert.equal(result.lateStops, 0);
  assert.equal(result.feasible, true);
  assert.equal(result.legs.length, 2);
});

test('delivery minimizes late stop count before lateness, elapsed time, and distance', () => {
  const draft = draftFor(2, { returnToDepot: false });
  draft.stops[0].latest = 548;
  draft.stops[1].latest = 548;
  // s1->s2 has one very late stop; s2->s1 has two slightly late stops.
  const result = solveDelivery(draft, matrix([[0, 4, 9], [1, 0, 100], [1, 1, 0]]));
  assert.deepEqual(result.order, ['s1', 's2']);
  assert.equal(result.lateStops, 1);
  assert.equal(result.lateMinutes, 96);
  assert.equal(result.feasible, false);
  assert.deepEqual(result.infeasibilityReasons, ['time_windows']);
});

test('delivery uses distance as final tie-break after equal time-window and elapsed objectives', () => {
  const result = solveDelivery(draftFor(), matrix([[0, 5, 5], [5, 0, 5], [5, 5, 0]], [[0, 900, 100], [100, 0, 900], [900, 100, 0]]));
  assert.deepEqual(result.order, ['s2', 's1']);
  assert.equal(result.distanceMeters, 300);
  assert.equal(result.totalMinutes, 15);
});

test('delivery capacity checks all depot-loaded demand, not only the largest stop', () => {
  const draft = draftFor(2, { capacity: 5 });
  draft.stops.forEach(stop => { stop.demand = 3; });
  const result = solveDelivery(draft, matrix([[0, 5, 5], [5, 0, 5], [5, 5, 0]]));
  assert.equal(result.capacityExceeded, true);
  assert.equal(result.feasible, false);
  assert.equal(result.order.length, 2);
  assert.deepEqual(result.infeasibilityReasons, ['capacity_exceeded']);
  draft.capacity = 6;
  assert.equal(solveDelivery(draft, matrix([[0, 5, 5], [5, 0, 5], [5, 5, 0]])).feasible, true);
});

test('delivery skips unreachable permutations but keeps a complete reachable directed tour', () => {
  const result = solveDelivery(draftFor(), matrix([[0, 2, null], [null, 0, 2], [2, null, 0]]));
  assert.deepEqual(result.order, ['s1', 's2']);
  assert.equal(result.feasible, true);
  assert.equal(result.permutations, 2);
});

test('delivery never fabricates a route when all complete tours are unreachable', () => {
  const result = solveDelivery(draftFor(), matrix([[0, 2, null], [null, 0, null], [null, null, 0]]));
  assert.equal(result.feasible, false);
  assert.deepEqual(result.order, []);
  assert.deepEqual(result.legs, []);
  assert.equal(result.distanceMeters, null);
  assert.equal(result.totalMinutes, null);
  assert.equal(result.lateStops, null);
  assert.equal(result.permutations, 2);
  assert.deepEqual(result.infeasibilityReasons, ['unreachable']);
});

test('delivery detects unreachable return edge and respects returnToDepot=false', () => {
  const draft = draftFor();
  const routes = matrix([[0, 2, 3], [null, 0, 2], [null, 2, 0]]);
  assert.equal(solveDelivery(draft, routes).feasible, false);
  draft.returnToDepot = false;
  assert.equal(solveDelivery(draft, routes).feasible, true);
  routes.distances[1][2] = null;
  assert.deepEqual(solveDelivery(draft, routes).order, ['s2', 's1']);
});

test('delivery malformed matrices are explicitly infeasible, never silently replaced with fixture', () => {
  const draft = draftFor();
  const valid = matrix([[0, 2, 3], [2, 0, 2], [3, 2, 0]]);
  const invalidMatrices = [null, {}, { ...valid, durations: [[0]] }, { ...valid, distances: [[0, -1, 1], [1, 0, 1], [1, 1, 0]] }, { ...valid, durations: [[0, NaN, 1], [1, 0, 1], [1, 1, 0]] }, { ...valid, distances: [[0, Infinity, 1], [1, 0, 1], [1, 1, 0]] }];
  const sparse = matrix([[0, 2, 3], [2, 0, 2], [3, 2, 0]]); delete sparse.durations[0][1]; invalidMatrices.push(sparse);
  for (const routes of invalidMatrices) {
    const result = solveDelivery(draft, routes);
    assert.equal(result.feasible, false);
    assert.deepEqual(result.order, []);
    assert.equal(result.permutations, 0);
    assert.deepEqual(result.infeasibilityReasons, ['invalid_matrix']);
    assert.ok(result.matrixErrors.length > 0);
  }
});

test('delivery validates coordinates, windows, capacities, IDs, bounds, and fixed car scope', () => {
  const invalidDrafts = [];
  for (const mutate of [d => { d.depot.lat = 91; }, d => { d.stops[0].lng = -181; }, d => { d.stops[0].earliest = 601; d.stops[0].latest = 600; }, d => { d.departureMinutes = 1441; }, d => { d.departureMinutes = '09:00'; }, d => { d.stops[0].serviceMinutes = -1; }, d => { d.capacity = 0; }, d => { d.stops[1].id = d.stops[0].id; }, d => { d.stops[0].id = 'depot'; }, d => { d.returnToDepot = 'yes'; }, d => { d.profile = 'motorcycle'; }, d => { d.stops[0] = null; }]) {
    const draft = draftFor(); mutate(draft); invalidDrafts.push(draft);
  }
  invalidDrafts.push(draftFor(1), draftFor(8));
  for (const draft of invalidDrafts) assert.throws(() => validateDeliveryDraft(draft), TypeError);
  const source = draftFor(); source.depot.name = '  起點  ';
  const normalized = validateDeliveryDraft(source);
  assert.equal(normalized.depot.name, '起點');
  normalized.stops[0].name = 'changed';
  assert.equal(source.stops[0].name, '站點1');
});

test('delivery enumerates every one of 7! tours with stable ties and no input mutation', () => {
  const draft = draftFor(7);
  const routes = matrix(Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => i === j ? 0 : 1)));
  const before = JSON.stringify({ draft, routes });
  const first = solveDelivery(draft, routes);
  assert.equal(first.permutations, 5040);
  assert.deepEqual(first.order, draft.stops.map(stop => stop.id));
  assert.equal(first.driveMinutes, 8);
  assert.equal(first.totalMinutes, 8);
  assert.equal(JSON.stringify({ draft, routes }), before);
  const second = solveDelivery(draft, routes);
  const { elapsedMs: firstTime, ...a } = first;
  const { elapsedMs: secondTime, ...b } = second;
  assert.deepEqual(a, b);
  assert.ok(firstTime >= 0 && secondTime >= 0);
});

test('delivery fixture is deterministic, explicitly synthetic, and uses car estimates', () => {
  const draft = draftFor(3);
  const result = fixtureMatrix(draft);
  assert.deepEqual(result, fixtureMatrix(draft));
  assert.equal(result.provenance.synthetic, true);
  assert.equal(result.provenance.profile, 'car');
  assert.equal(result.provenance.speedKmh, 20);
  assert.equal(result.distances.length, 4);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    assert.equal(result.distances[i][j], result.distances[j][i]);
    assert.equal(result.durations[i][j], Math.round(result.distances[i][j] / (20_000 / 3600)));
    assert.equal(i === j ? result.distances[i][j] === 0 : result.distances[i][j] > 0, true);
  }
});

test('delivery six-stop sample is synthetic and text events never carry address mutations', async () => {
  const sample = JSON.parse(await readFile(new URL('../workbench/delivery-scenario.json', import.meta.url), 'utf8'));
  assert.equal(sample.schemaVersion, 1);
  assert.equal(sample.synthetic, true);
  assert.equal(sample.draft.stops.length, 6);
  assert.equal(sample.events.length, 6);
  assert.equal(new Set(sample.events.map(e => e.id)).size, 6);
  assert.deepEqual(sample.events.filter(e => e.duplicateOf).map(e => e.text), [sample.events[0].text]);
  for (const event of sample.events) {
    assert.equal(typeof event.expectedRefresh, 'boolean');
    if (event.kind === 'note') assert.equal(event.patch, undefined);
    else {
      assert.deepEqual(Object.keys(event.patch).sort(), ['latest', 'stopId']);
      assert.ok(sample.draft.stops.some(stop => stop.id === event.patch.stopId));
    }
  }
  const result = solveDelivery(sample.draft, fixtureMatrix(sample.draft));
  assert.equal(result.permutations, 720);
  assert.equal(result.feasible, true);
  assert.equal(result.order.length, 6);
  assert.equal(result.legs.length, 7);
  const changed = structuredClone(sample.draft);
  const patch = sample.events.find(e => e.kind === 'structured').patch;
  Object.assign(changed.stops.find(s => s.id === patch.stopId), { latest: patch.latest });
  const replanned = solveDelivery(changed, fixtureMatrix(changed));
  assert.equal(replanned.permutations, 720);
  assert.notDeepEqual(replanned.order, result.order);
});
