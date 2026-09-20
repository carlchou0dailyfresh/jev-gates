export type EtaKind = 'DRIVE_TRIP' | 'BUS_WAIT';
export type EtaRange = { min: number; max: number };
export type EtaContext = {
  originKey?: string; destinationKey?: string; departureAt?: string; routeKey?: string;
  stopId?: string; routeId?: string; direction?: string; referenceAt?: string;
};
export type EtaPrediction = {
  kind: EtaKind;
  context: EtaContext;
  basis: 'live' | 'synthetic';
  capturedAt: string;
  sourceTimestamp: { at: string; basis: 'provider_updated' | 'local_forecast_generated' | 'manual_display_observed' | 'response_observed' };
  estimateReferenceAt?: string;
  estimate: { minSeconds: number; maxSeconds: number };
  precision?: 'seconds' | 'rounded_minutes' | 'reported_interval';
};
export type EtaActual = {
  kind: EtaKind; context: EtaContext; basis: 'live' | 'synthetic';
  startedAt: string; completedAt: string; recordedAt: string;
  source: 'manual_observation'; selfReported: true;
  samePathConfirmed?: boolean; nextVehicleConfirmed?: boolean;
};
export type EtaSession = {
  id: string;
  scenario: { id: string; label?: string; kind: EtaKind; routeAlignment?: 'unverified' | 'same_path_confirmed' };
  local: EtaPrediction; google: EtaPrediction; actual?: EtaActual;
};
export type EtaComparison = {
  version: 1; id: string | null; scenarioId: string | null; kind: EtaKind | null;
  status: 'comparable' | 'incomparable';
  evidenceLevel: 'provider_timestamps' | 'observed_only' | 'synthetic' | 'unknown';
  reasons: string[]; reasonCodes: string[]; warnings: string[];
  comparison: null | {
    unit: 'seconds'; interpretation: 'trip_duration' | 'wait_normalized_to_reference';
    localRangeSeconds: EtaRange; googleRangeSeconds: EtaRange;
    signedDeltaRangeSeconds: EtaRange; absoluteDifferenceRangeSeconds: EtaRange;
    signedDeltaSeconds: number | null; absoluteDifferenceSeconds: number | null;
    containsRoundedInputs: boolean; precision: 'reported' | 'approximate';
  };
  accuracy: {
    status: 'eligible' | 'missing_actual' | 'ineligible' | 'synthetic_only';
    reasons: string[]; reasonCodes: string[]; actualSeconds: number | null;
    selfReported: boolean; actualSource: 'manual_observation' | null;
    localErrorRangeSeconds: EtaRange | null; googleErrorRangeSeconds: EtaRange | null;
    containsRoundedInputs: boolean;
  };
  timestamps: {
    localCapturedAt: string | null; googleCapturedAt: string | null;
    localSourceAt: string | null; googleSourceAt: string | null;
    pairGapSeconds: number | null; evaluatedAt: string;
  };
};
export type EtaErrorMetrics = {
  count: number; meanAbsoluteErrorSeconds: number | null; meanAbsoluteErrorRangeSeconds: EtaRange | null;
  p90AbsoluteErrorSeconds: number | null; p90AbsoluteErrorRangeSeconds: EtaRange | null;
  biasSeconds: number | null; biasRangeSeconds: EtaRange | null;
  within60Seconds: { guaranteedCount: number; possibleCount: number; total: number };
  within120Seconds: { guaranteedCount: number; possibleCount: number; total: number };
};
export type EtaAggregate = {
  sessionCount: number; comparableCount: number; incomparableCount: number;
  eligibleAccuracyCount: number; excludedFromAccuracyCount: number; duplicateSessionIds: string[];
  containsRoundedInputs: boolean; percentileMethod: 'nearest_rank'; actualSource: 'manual_self_reported_only';
  metrics: { local: EtaErrorMetrics; google: EtaErrorMetrics }; results: EtaComparison[];
};
export type EtaComparisonOptions = { now?: number | string };
export const ETA_PAIR_WINDOW_SECONDS: 120;
export function compareEtaSession(session: EtaSession | unknown, options?: EtaComparisonOptions): EtaComparison;
export function aggregateEtaComparisons(sessions: (EtaSession | unknown)[], options?: EtaComparisonOptions): EtaAggregate;
