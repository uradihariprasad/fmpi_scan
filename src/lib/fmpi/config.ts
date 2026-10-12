import type { EngineConfig, Timeframe } from "./types";

/**
 * Initial research weights per the FMPI specification.
 * These are engineering starting points — stored in configuration,
 * never hardcoded through the calculation paths.
 */
export const DEFAULT_CONFIG: EngineConfig = {
  weights: {
    price_pressure: 0.3,
    volume_participation: 0.2,
    futures_positioning: 0.2,
    options_positioning: 0.15,
    price_structure: 0.1,
    acceleration_persistence: 0.05,
  },
  logisticK: 3.2,
  percentileBlend: 0.25,
  percentileWindow: 240,
  percentileMinSamples: 60,
  zoneWindow: 240,
  zoneMinSamples: 60,
  zoneQuantiles: [5, 15, 40, 60, 85, 95],
  zoneSmoothing: 0.2,
  smoothingAlpha: { "5m": 0.3, "10m": 0.26 } as Record<Timeframe, number>,
  volLookback: 20,
  volumeLookback: 20,
  structureLookback: 40,
  atrLookback: 14,
  slopeWindow: 3,
  accelWindow: 3,
  swingConfirmBars: 3,
  swingNoise: 3.2,
  swingProminence: 5.5,
  divergenceMinSeparation: 6,
  divergenceMinDiff: 1.5,
  minCandles: 30,
  minCoverage: 0.45,
};

export function withConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    weights: { ...DEFAULT_CONFIG.weights, ...(overrides.weights ?? {}) },
    smoothingAlpha: { ...DEFAULT_CONFIG.smoothingAlpha, ...(overrides.smoothingAlpha ?? {}) },
    zoneQuantiles: overrides.zoneQuantiles ?? DEFAULT_CONFIG.zoneQuantiles,
  };
}
