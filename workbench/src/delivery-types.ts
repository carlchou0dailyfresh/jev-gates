import type { Health, Mode, Truth } from "./types";

export type MapProvider = "fixture" | "osrm" | "google";
export interface DeliveryPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
}
export interface DeliveryStop extends DeliveryPoint {
  earliest: number;
  latest: number;
  serviceMinutes: number;
  demand: number;
}
export interface DeliveryDraft {
  depot: DeliveryPoint;
  stops: DeliveryStop[];
  departureMinutes: number;
  capacity: number;
  returnToDepot: boolean;
}
export interface DeliveryEvent {
  id: string;
  kind: "note" | "structured";
  text: string;
  expectedRefresh?: boolean;
  patch?: { stopId: string; latest?: number };
  duplicateOf?: string;
}
export interface DeliveryConfig {
  scenario: {
    title: string;
    description: string;
    synthetic: boolean;
    draft: DeliveryDraft;
    events: DeliveryEvent[];
  };
  maps: { osrm: boolean; googleConfigured: boolean };
  health: Pick<Health, "localjev" | "typesafe">;
}
export interface DeliveryLeg {
  from: string;
  to: string;
  distanceMeters: number;
  durationSeconds: number;
  arrivalMinutes: number;
  departureMinutes: number;
  waitMinutes: number;
  lateMinutes: number;
}
export interface DeliveryPlan {
  id: string;
  draft: DeliveryDraft;
  createdAt: string;
  comparisonAllowed?: boolean;
  geometryError?: string | null;
  plan: {
    order: string[];
    legs: DeliveryLeg[];
    distanceMeters: number | null;
    driveMinutes: number | null;
    totalMinutes: number | null;
    lateMinutes: number | null;
    lateStops: number | null;
    capacityExceeded: boolean;
    feasible: boolean;
    elapsedMs: number;
    permutations: number;
    infeasibilityReasons?: string[];
  };
  matrix: { provenance: unknown; metrics: unknown };
  geometry: {
    coordinates: [number, number][];
    provenance: unknown;
    metrics: unknown;
  };
  metrics: { requests: number; elements: number; elapsedMs: number };
}
export interface DeliveryPrices {
  mapRequestUsd: number | null;
  mapElementUsd: number | null;
  semanticQuestionUsd: number | null;
  cpuSecondUsd: number | null;
}
export interface DeliveryStep {
  eventId: string;
  text: string;
  decision: "refresh" | "skip";
  truth?: Truth;
  reason: string;
  gateSignals?: Record<
    string,
    { truth?: Truth; reason?: string; answer?: { noul?: number } } | Truth
  >;
  planChanged?: boolean;
  feasible?: boolean;
}
export interface DeliveryStrategy {
  id: "always" | "rules" | "single" | "stacked";
  name: string;
  replans: number;
  mapRefreshDecisions: number;
  modelRequests: number;
  modelQuestions: number;
  semanticMs: number;
  solverMs: number;
  totalMs: number;
  missedRefreshes: number | null;
  falseRefreshes: number | null;
  skipped: number;
  estimatedCostUsd: number | null;
  steps: DeliveryStep[];
}
export interface DeliveryComparison {
  id: string;
  createdAt: string;
  mode: Mode;
  matrixProvenance: unknown;
  strategies: DeliveryStrategy[];
  actual: {
    mapRequests: number;
    modelRequests: number;
    modelQuestions: number;
    elapsedMs: number;
  };
  warnings: string[];
  events: DeliveryEvent[];
  checksum: string;
}
