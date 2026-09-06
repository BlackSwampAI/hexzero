export const WORLD_SCENARIO_LIMITS = {
  minimumAgents: 1,
  maximumAgents: 32,
  minimumResolution: 8,
  maximumResolution: 11,
  maximumGeneratedCells: 5_000,
  maximumRadius: 40,
  highDensityCellsPerAgent: 10,
  observedOtherAgents: 7,
  maximumNearbyAgentObservations: 8,
  minimumCommunicationRangeKm: 0.1,
  maximumCommunicationRangeKm: 100,
  minimumTickIntervalMinutes: 1,
  maximumTickIntervalMinutes: 60,
  maximumProviderAttempts: 100_000,
} as const;

export const WORLD_RADIUS_PRESETS = {
  tiny: { radius: 3, expectedCellCount: 37 },
  current: { radius: 6, expectedCellCount: 127 },
  medium: { radius: 12, expectedCellCount: 469 },
  large: { radius: 20, expectedCellCount: 1_261 },
  'very-large': { radius: 40, expectedCellCount: 4_921 },
} as const;

export const PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS = {
  displayedEligiblePairs: 12,
  acceptableProposals: 8,
  leaveAvailableAgentIds: 8,
  blockerExamples: 8,
  serializedUtf8Bytes: 4_096,
} as const;
