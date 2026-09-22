import { z } from 'zod';
export * from './limits';
import { WORLD_SCENARIO_LIMITS } from './limits';

export const MODEL_SUMMARY_MAX_LENGTH = 240;
export const DEFAULT_MINIMUM_TICK_INTERVAL_MINUTES = 5;
export const DEFAULT_MAXIMUM_TICK_INTERVAL_MINUTES = 10;
export const DEFAULT_PROVIDER_ATTEMPT_LIMIT = 1_000;
export const NEUTRAL_AGENT_COLOR = '#b2d3a8';
export const RECENT_CONTROL_CHANGE_LIMIT = 6;
export const RECENT_ZERO_STRATEGIC_EVENT_LIMIT = 12;
export const PROVIDER_ERROR_MAX_LENGTH = 240;
export const OPENROUTER_MODEL_CONTEXT_MINIMUM = 16_384;
export const OPENROUTER_MAX_OUTPUT_TOKENS = 4_096;
export const OPENROUTER_PROVIDER_TIMEOUT_MS = 75_000;
export const OPENROUTER_429_FALLBACK_BACKOFF_MS = 1_500;
/** Versioned provenance for Agent Zero's structured planning contract. */
export const SWARM_PLANNER_CONTRACT_VERSION = 'swarm-planner-v1';
export const swarmPlannerContractVersionSchema = z.literal(
  SWARM_PLANNER_CONTRACT_VERSION,
);
export const OBJECTIVE_PROMPT_VERSION = 'durable-influence-v3';
export const OPENROUTER_REQUIRED_PARAMETERS = ['max_tokens'] as const;
export const DEVELOPMENT_WORLD_CONFIG = {
  latitude: 41.6528,
  longitude: -83.5379,
  resolution: 9,
  radius: 6,
  cellCount: 127,
  agentCount: 8,
} as const;
export const agentIdSchema = z.uuid().brand<'AgentId'>();
export type AgentId = z.infer<typeof agentIdSchema>;

/** Records the fixed cognition architecture used to produce an experiment. */
export const swarmArchitectureVersionSchema = z.literal('zero-swarm-v1');
export type SwarmArchitectureVersion = z.infer<
  typeof swarmArchitectureVersionSchema
>;

export const eventIdSchema = z.uuid().brand<'EventId'>();
export type EventId = z.infer<typeof eventIdSchema>;

export const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

export const h3CellSchema = z
  .string()
  .regex(/^[0-9a-f]{15}$/i, 'Expected an H3 cell index')
  .brand<'H3Cell'>();
export type H3Cell = z.infer<typeof h3CellSchema>;

export const simulatedPlayerProfileSchema = z.enum([
  'casual-cleaner',
  'trail-hunter-v1',
]);
export type SimulatedPlayerProfile = z.infer<
  typeof simulatedPlayerProfileSchema
>;
export const simulatedPlayerConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    profile: simulatedPlayerProfileSchema,
    seed: z.string().trim().min(1).max(80),
  })
  .strict();
export type SimulatedPlayerConfiguration = z.infer<
  typeof simulatedPlayerConfigurationSchema
>;
export const simulatedPlayerMetricsSchema = z
  .object({
    movements: z.number().int().nonnegative(),
    cellsDisinfected: z.number().int().nonnegative(),
    blockedDisinfections: z.number().int().nonnegative(),
  })
  .strict();
export type SimulatedPlayerMetrics = z.infer<
  typeof simulatedPlayerMetricsSchema
>;
export const simulatedPlayerStateSchema = z
  .object({
    profile: simulatedPlayerProfileSchema,
    currentCell: h3CellSchema,
    metrics: simulatedPlayerMetricsSchema,
  })
  .strict();
export type SimulatedPlayerState = z.infer<typeof simulatedPlayerStateSchema>;

export const hexStateSchema = z.enum(['open', 'infected']);
export type HexState = z.infer<typeof hexStateSchema>;

export const hexSchema = z.discriminatedUnion('state', [
  z.object({
    cell: h3CellSchema,
    state: z.literal('open'),
    controllerAgentId: z.null(),
  }),
  z.object({
    cell: h3CellSchema,
    state: z.literal('infected'),
    controllerAgentId: agentIdSchema.nullable(),
  }),
]);
export type Hex = z.infer<typeof hexSchema>;

export const agentProfileSchema = z.object({
  id: agentIdSchema,
  name: z.string().trim().min(1).max(80),
  color: colorSchema,
  currentCell: h3CellSchema,
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const agentSchema = agentProfileSchema;
export type Agent = z.infer<typeof agentSchema>;

export const moveActionSchema = z.object({
  type: z.literal('move'),
  targetCell: h3CellSchema,
});
export const infectActionSchema = z.object({ type: z.literal('infect') });
export const captureActionSchema = z
  .object({ type: z.literal('capture') })
  .strict();
export const waitActionSchema = z.object({ type: z.literal('wait') });

export const worldActionSchema = z.discriminatedUnion('type', [
  moveActionSchema,
  infectActionSchema,
  captureActionSchema,
  waitActionSchema,
]);
export type WorldAction = z.infer<typeof worldActionSchema>;
export const agentTurnActionSchema = worldActionSchema;
export type AgentTurnAction = WorldAction;

export const swarmDirectiveSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    agentId: agentIdSchema,
    mission: z.enum(['expand', 'hold', 'relocate', 'reinforce', 'evade']),
    targetCell: h3CellSchema.nullable(),
    priority: z.enum(['low', 'normal', 'high']),
    riskTolerance: z.enum(['low', 'medium', 'high']),
    issuedAtTick: z.number().int().nonnegative(),
    expiresAtTick: z.number().int().nonnegative(),
    note: z.string().trim().min(1).max(160).optional(),
  })
  .strict()
  .superRefine((directive, context) => {
    if (directive.expiresAtTick < directive.issuedAtTick)
      context.addIssue({
        code: 'custom',
        path: ['expiresAtTick'],
        message: 'Directive expiry cannot precede its issue tick.',
      });
  });
export type SwarmDirective = z.infer<typeof swarmDirectiveSchema>;

const reflexCandidateSchema = z
  .object({
    id: z
      .string()
      .regex(/^action_[0-9]+$/)
      .max(32),
    description: z.string().trim().min(1).max(280),
  })
  .strict();

export const captureAlertSchema = z
  .object({
    capturedAgentId: agentIdSchema,
    cell: h3CellSchema,
    originatingTick: z.number().int().nonnegative(),
    abandonedCellCount: z.number().int().nonnegative(),
  })
  .strict();
export type CaptureAlert = z.infer<typeof captureAlertSchema>;

export const reflexObservationSchema = z
  .object({
    agentId: agentIdSchema,
    directive: swarmDirectiveSchema,
    currentSituation: z
      .object({
        cellStatus: z.enum(['open', 'friendly-infected', 'other-infected']),
        directiveProgress: z.enum([
          'advancing',
          'at-target',
          'stalled',
          'blocked',
        ]),
        nearbyPressure: z.enum(['low', 'rising', 'high']),
        recentTerritoryTrend: z.enum(['growing', 'stable', 'shrinking']),
        recentActionOutcome: z.enum(['success', 'rejected', 'unknown']),
      })
      .strict(),
    captureAlerts: z.array(captureAlertSchema).max(4).optional(),
    candidates: z.array(reflexCandidateSchema).min(1).max(9),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.directive.agentId !== observation.agentId)
      context.addIssue({
        code: 'custom',
        path: ['directive', 'agentId'],
        message: 'A reflex directive must belong to the observed agent.',
      });
    const ids = observation.candidates.map(({ id }) => id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: 'custom',
        path: ['candidates'],
        message: 'Reflex candidate IDs must be unique.',
      });
  });
export type ReflexObservation = z.infer<typeof reflexObservationSchema>;

/** A server-compiled action Zero may select by opaque identifier. */
export const zeroActionCandidateSchema = z
  .object({
    id: z
      .string()
      .regex(/^zero_action_[0-9]+$/)
      .max(40),
    action: worldActionSchema,
    description: z.string().trim().min(1).max(320),
  })
  .strict();
export type ZeroActionCandidate = z.infer<typeof zeroActionCandidateSchema>;

export const swarmPlanSchema = z
  .object({
    strategySummary: z.string().trim().min(1).max(500),
    directives: z
      .array(swarmDirectiveSchema)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    zeroActionCandidateId: z
      .string()
      .regex(/^zero_action_[0-9]+$/)
      .max(40),
  })
  .strict()
  .superRefine((plan, context) => {
    const directiveIds = plan.directives.map(({ id }) => id);
    const agentIds = plan.directives.map(({ agentId }) => agentId);
    if (new Set(directiveIds).size !== directiveIds.length)
      context.addIssue({
        code: 'custom',
        path: ['directives'],
        message: 'Swarm directive IDs must be unique.',
      });
    if (new Set(agentIds).size !== agentIds.length)
      context.addIssue({
        code: 'custom',
        path: ['directives'],
        message: 'A swarm plan may contain at most one directive per worker.',
      });
  });
export type SwarmPlan = z.infer<typeof swarmPlanSchema>;

export const swarmReplanReasonSchema = z.enum([
  'initial',
  'periodic-review',
  'directive-complete',
  'directive-expired',
  'worker-request',
  'worker-stalled',
  'territory-loss',
  'high-pressure',
  'player-disinfection',
  'roster-changed',
]);
export type SwarmReplanReason = z.infer<typeof swarmReplanReasonSchema>;

export const completedSwarmDirectiveSchema = z
  .object({
    agentId: agentIdSchema,
    directiveId: z.string().trim().min(1).max(80),
  })
  .strict();
export type CompletedSwarmDirective = z.infer<
  typeof completedSwarmDirectiveSchema
>;

export const localPressureSchema = z.enum(['low', 'rising', 'high']);
export type LocalPressure = z.infer<typeof localPressureSchema>;

/**
 * Bounded, event-derived spatial context for Agent Zero. These categories are
 * deliberately coarser than H3 cells or simulated-player state.
 */
export const pressureDirectionSchema = z.enum([
  'N',
  'NE',
  'SE',
  'S',
  'SW',
  'NW',
]);
export type PressureDirection = z.infer<typeof pressureDirectionSchema>;

export const pressureDistanceSchema = z.enum([
  'same-cell',
  'adjacent',
  'nearby',
]);
export type PressureDistance = z.infer<typeof pressureDistanceSchema>;

export const swarmSignalSchema = z
  .object({
    type: z.literal('worker-replan-requested'),
    agentId: agentIdSchema,
    directiveId: z.string().trim().min(1).max(80),
    probability: z.number().finite().min(0).max(1),
  })
  .strict();
export type SwarmSignal = z.infer<typeof swarmSignalSchema>;

/**
 * Strategic input for Agent Zero. This deliberately carries only authoritative
 * world facts and bounded choices; it contains no social or prose-memory data.
 */
export const zeroStrategicObservationSchema = z
  .object({
    zeroAgentId: agentIdSchema,
    tickNumber: z.number().int().nonnegative(),
    virtualTime: z.iso.datetime(),
    cells: z
      .array(
        z
          .object({
            cell: h3CellSchema,
            state: z.enum(['open', 'infected']),
            controllerAgentId: agentIdSchema.nullable(),
          })
          .strict(),
      )
      .min(1),
    agents: z
      .array(
        z
          .object({
            agentId: agentIdSchema,
            position: h3CellSchema,
            controlledCellCount: z.number().int().nonnegative(),
            territoryDelta: z.number().int(),
            localPressure: localPressureSchema,
            pressureDirection: pressureDirectionSchema.nullable(),
            pressureDistance: pressureDistanceSchema.nullable(),
            workerStatus: z
              .enum(['advancing', 'at-target', 'stalled', 'blocked', 'unknown'])
              .optional(),
            directive: swarmDirectiveSchema.nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    recentPlayerPressure: z.array(z.string().trim().min(1).max(180)).max(12),
    recentCaptures: z.array(captureAlertSchema).max(4).optional(),
    replanReasons: z.array(swarmReplanReasonSchema).max(10).optional(),
    completedDirectives: z
      .array(completedSwarmDirectiveSchema)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents)
      .optional(),
    workerReplanRequests: z
      .array(swarmSignalSchema.omit({ type: true }))
      .max(WORLD_SCENARIO_LIMITS.maximumAgents)
      .optional(),
    legalZeroActions: z.array(zeroActionCandidateSchema).min(1).max(9),
    strategicTargetCells: z.array(h3CellSchema).max(80),
  })
  .strict()
  .superRefine((observation, context) => {
    const cells = observation.cells.map(({ cell }) => cell);
    const agents = observation.agents.map(({ agentId }) => agentId);
    const actionIds = observation.legalZeroActions.map(({ id }) => id);
    if (new Set(cells).size !== cells.length)
      context.addIssue({
        code: 'custom',
        path: ['cells'],
        message: 'Strategic cell facts must be unique.',
      });
    if (new Set(agents).size !== agents.length)
      context.addIssue({
        code: 'custom',
        path: ['agents'],
        message: 'Strategic agent facts must be unique.',
      });
    if (!agents.includes(observation.zeroAgentId))
      context.addIssue({
        code: 'custom',
        path: ['zeroAgentId'],
        message: 'Agent Zero must appear in strategic agent facts.',
      });
    if (new Set(actionIds).size !== actionIds.length)
      context.addIssue({
        code: 'custom',
        path: ['legalZeroActions'],
        message: 'Zero action candidate IDs must be unique.',
      });
    const targets = new Set(observation.strategicTargetCells);
    if (
      observation.agents.some(
        ({ directive }) =>
          directive?.targetCell && !targets.has(directive.targetCell),
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['agents'],
        message:
          'Active directive targets must be in the strategic target allowlist.',
      });
  });
export type ZeroStrategicObservation = z.infer<
  typeof zeroStrategicObservationSchema
>;

export const cognitionSourceSchema = z.enum([
  'zero-llm',
  'jev-reflex',
  'deterministic-fallback',
]);
export type CognitionSource = z.infer<typeof cognitionSourceSchema>;

const worldEventBaseSchema = z.object({
  id: eventIdSchema,
  agentId: agentIdSchema,
  occurredAt: z.iso.datetime(),
});

const agentMovedWorldEventSchema = worldEventBaseSchema.extend({
  type: z.literal('agent-moved'),
  fromCell: h3CellSchema,
  toCell: h3CellSchema,
});
const hexInfectedWorldEventSchema = worldEventBaseSchema.extend({
  type: z.literal('hex-infected'),
  cell: h3CellSchema,
  controllerAgentId: agentIdSchema,
});
export const hexCapturedWorldEventSchema = worldEventBaseSchema.extend({
  type: z.literal('hex-captured'),
  cell: h3CellSchema,
  controllerAgentId: agentIdSchema,
  previousControllerAgentId: agentIdSchema.nullable(),
});
export type HexCapturedWorldEvent = z.infer<typeof hexCapturedWorldEventSchema>;
const agentWaitedWorldEventSchema = worldEventBaseSchema.extend({
  type: z.literal('agent-waited'),
});

const simulatedPlayerEventBaseSchema = z.object({
  id: eventIdSchema,
  occurredAt: z.iso.datetime(),
  profile: simulatedPlayerProfileSchema,
  originatingTick: z.number().int().positive(),
});
export const simulatedPlayerMovedEventSchema =
  simulatedPlayerEventBaseSchema.extend({
    type: z.literal('simulated-player-moved'),
    fromCell: h3CellSchema,
    toCell: h3CellSchema,
  });
export const hexDisinfectedWorldEventSchema =
  simulatedPlayerEventBaseSchema.extend({
    type: z.literal('hex-disinfected'),
    cell: h3CellSchema,
    previousControllerAgentId: agentIdSchema.nullable(),
  });
export const simulatedPlayerCleanBlockedEventSchema =
  simulatedPlayerEventBaseSchema.extend({
    type: z.literal('simulated-player-clean-blocked'),
    cell: h3CellSchema,
    blockingAgentId: agentIdSchema,
  });
export const simulatedPlayerAgentCapturedEventSchema =
  simulatedPlayerEventBaseSchema.extend({
    type: z.literal('simulated-player-agent-captured'),
    cell: h3CellSchema,
    capturedAgentId: agentIdSchema,
    abandonedCellCount: z.number().int().nonnegative(),
  });
export const simulatedPlayerEventSchema = z.discriminatedUnion('type', [
  simulatedPlayerMovedEventSchema,
  hexDisinfectedWorldEventSchema,
  simulatedPlayerCleanBlockedEventSchema,
  simulatedPlayerAgentCapturedEventSchema,
]);
export type SimulatedPlayerEvent = z.infer<typeof simulatedPlayerEventSchema>;

export const physicalWorldEventSchema = z.discriminatedUnion('type', [
  agentMovedWorldEventSchema,
  hexInfectedWorldEventSchema,
  hexCapturedWorldEventSchema,
  agentWaitedWorldEventSchema,
]);
export type PhysicalWorldEvent = z.infer<typeof physicalWorldEventSchema>;
export const safeExperimentWorldEventSchema = z.discriminatedUnion('type', [
  agentMovedWorldEventSchema,
  hexInfectedWorldEventSchema,
  hexCapturedWorldEventSchema,
  agentWaitedWorldEventSchema,
  simulatedPlayerMovedEventSchema,
  hexDisinfectedWorldEventSchema,
  simulatedPlayerCleanBlockedEventSchema,
  simulatedPlayerAgentCapturedEventSchema,
]);
export type SafeExperimentWorldEvent = z.infer<
  typeof safeExperimentWorldEventSchema
>;

export const worldEventSchema = z.discriminatedUnion('type', [
  agentMovedWorldEventSchema,
  hexInfectedWorldEventSchema,
  hexCapturedWorldEventSchema,
  agentWaitedWorldEventSchema,
  simulatedPlayerMovedEventSchema,
  hexDisinfectedWorldEventSchema,
  simulatedPlayerCleanBlockedEventSchema,
  simulatedPlayerAgentCapturedEventSchema,
]);
export type WorldEvent = z.infer<typeof worldEventSchema>;

export const invalidActionReasonSchema = z.enum([
  'unknown-agent',
  'invalid-action',
  'not-adjacent',
  'cell-not-in-world',
  'already-infected',
  'capture-open-cell',
  'already-controller',
  'controller-present',
]);
export type InvalidActionReason = z.infer<typeof invalidActionReasonSchema>;

export const captureBlockedReasonSchema = z.enum([
  'capture-open-cell',
  'already-controller',
  'controller-present',
]);
export type CaptureBlockedReason = z.infer<typeof captureBlockedReasonSchema>;

export const captureEligibilitySchema = z.discriminatedUnion('eligible', [
  z.object({ eligible: z.literal(true) }).strict(),
  z
    .object({
      eligible: z.literal(false),
      blockedReason: captureBlockedReasonSchema,
    })
    .strict(),
]);
export type CaptureEligibility = z.infer<typeof captureEligibilitySchema>;

export const worldActionResultSchema = z.discriminatedUnion('accepted', [
  z.object({
    accepted: z.literal(true),
    event: physicalWorldEventSchema,
  }),
  z.object({
    accepted: z.literal(false),
    reason: invalidActionReasonSchema,
    details: z.string().min(1).max(300),
  }),
]);
export type WorldActionResult = z.infer<typeof worldActionResultSchema>;
export const actionResultSchema = worldActionResultSchema;
export type ActionResult = WorldActionResult;

const worldSnapshotObjectSchema = z.object({
  generatedAt: z.iso.datetime(),
  hexes: z
    .array(hexSchema)
    .min(1)
    .max(WORLD_SCENARIO_LIMITS.maximumGeneratedCells),
  agents: z.array(agentSchema).min(0).max(WORLD_SCENARIO_LIMITS.maximumAgents),
  events: z.array(worldEventSchema).max(120),
  simulatedPlayer: simulatedPlayerStateSchema.nullable().default(null),
});

function validateWorldControllers(
  world: Pick<
    z.infer<typeof worldSnapshotObjectSchema>,
    'hexes' | 'agents' | 'simulatedPlayer'
  >,
  context: z.RefinementCtx,
): void {
  const agentIds = new Set(world.agents.map(({ id }) => id));
  if (
    world.simulatedPlayer &&
    !world.hexes.some(({ cell }) => cell === world.simulatedPlayer!.currentCell)
  )
    context.addIssue({
      code: 'custom',
      path: ['simulatedPlayer', 'currentCell'],
      message: 'The simulated player must remain inside the world.',
    });
  for (const [index, hex] of world.hexes.entries()) {
    if (
      hex.state === 'infected' &&
      hex.controllerAgentId !== null &&
      !agentIds.has(hex.controllerAgentId)
    )
      context.addIssue({
        code: 'custom',
        path: ['hexes', index, 'controllerAgentId'],
        message: 'An infected hex controller must be a world agent.',
      });
  }
}

export const worldSnapshotSchema = worldSnapshotObjectSchema.superRefine(
  validateWorldControllers,
);
export type WorldSnapshot = z.infer<typeof worldSnapshotSchema>;

export const cellObservationSchema = z.discriminatedUnion('state', [
  z.object({
    cell: h3CellSchema,
    state: z.literal('open'),
    controllerAgentId: z.null(),
  }),
  z.object({
    cell: h3CellSchema,
    state: z.literal('infected'),
    controllerAgentId: agentIdSchema.nullable(),
  }),
]);
export type CellObservation = z.infer<typeof cellObservationSchema>;

export const nearbyAgentObservationSchema = z.object({
  id: agentIdSchema,
  name: z.string().trim().min(1).max(80),
  currentCell: h3CellSchema,
  distance: z.number().int().nonnegative().default(0),
  distanceKm: z.number().nonnegative().default(0),
  controlledCellCount: z.number().int().nonnegative().default(0),
});

export const publicEventObservationSchema = z.object({
  type: z.enum(['agent-moved', 'hex-infected', 'hex-captured', 'agent-waited']),
  agentId: agentIdSchema,
  occurredAt: z.iso.datetime(),
  summary: z.string().trim().min(1).max(180),
});

export const territoryScoreboardEntrySchema = z.object({
  agentId: agentIdSchema,
  name: z.string().trim().min(1).max(80),
  color: colorSchema,
  controlledCellCount: z
    .number()
    .int()
    .nonnegative()
    .max(WORLD_SCENARIO_LIMITS.maximumGeneratedCells),
});
export const territoryScoreboardSchema = z
  .array(territoryScoreboardEntrySchema)
  .min(0)
  .max(WORLD_SCENARIO_LIMITS.maximumAgents)
  .refine(
    (entries) =>
      new Set(entries.map(({ agentId }) => agentId)).size === entries.length,
    { message: 'Territory scoreboard agent IDs must be unique.' },
  );
export type TerritoryScoreboard = z.infer<typeof territoryScoreboardSchema>;

export const observedControlChangeSchema = z.object({
  eventId: eventIdSchema,
  direction: z.enum(['gained', 'lost']),
  otherAgentId: agentIdSchema,
  otherAgentName: z.string().trim().min(1).max(80),
  cell: h3CellSchema,
  occurredAt: z.iso.datetime(),
});
export type ObservedControlChange = z.infer<typeof observedControlChangeSchema>;

export const observedPlayerThreatSchema = z
  .object({
    eventId: eventIdSchema,
    kind: z.enum(['territory-disinfected', 'nearby-disinfection']),
    cell: h3CellSchema,
    occurredAt: z.iso.datetime(),
    distanceCells: z.number().int().nonnegative(),
    affectedOwnTerritory: z.boolean(),
  })
  .strict();
export type ObservedPlayerThreat = z.infer<typeof observedPlayerThreatSchema>;

export const PATIENT_ZERO_PLAYER_THREAT_FEED_LIMIT = 128;
export const PATIENT_ZERO_PRESSURE_WINDOW_TICKS = 6;
const PATIENT_ZERO_PRESSURE_EVENT_COUNT_LIMIT = 1_000_000;
const patientZeroPressureCountsSchema = z
  .object({
    totalEvents: z
      .number()
      .int()
      .nonnegative()
      .max(PATIENT_ZERO_PRESSURE_EVENT_COUNT_LIMIT),
    disinfections: z
      .number()
      .int()
      .nonnegative()
      .max(PATIENT_ZERO_PRESSURE_EVENT_COUNT_LIMIT),
    blockedCleans: z
      .number()
      .int()
      .nonnegative()
      .max(PATIENT_ZERO_PRESSURE_EVENT_COUNT_LIMIT),
  })
  .strict()
  .superRefine((counts, context) => {
    if (counts.totalEvents !== counts.disinfections + counts.blockedCleans)
      context.addIssue({
        code: 'custom',
        message: 'Player-pressure totals must equal their event categories.',
      });
  });
export const patientZeroPressureContextSchema = z
  .object({
    window: z
      .object({
        tickCount: z
          .number()
          .int()
          .min(1)
          .max(PATIENT_ZERO_PRESSURE_WINDOW_TICKS),
        startTick: z.number().int().positive(),
        endTick: z.number().int().positive(),
      })
      .strict(),
    subject: patientZeroPressureCountsSchema.safeExtend({
      consecutiveAffectedTicks: z
        .number()
        .int()
        .min(1)
        .max(PATIENT_ZERO_PRESSURE_WINDOW_TICKS),
    }),
  })
  .strict()
  .superRefine((pressure, context) => {
    if (
      pressure.window.endTick - pressure.window.startTick + 1 !==
        pressure.window.tickCount ||
      pressure.subject.totalEvents < 1 ||
      pressure.subject.consecutiveAffectedTicks > pressure.window.tickCount ||
      pressure.subject.consecutiveAffectedTicks > pressure.subject.totalEvents
    )
      context.addIssue({
        code: 'custom',
        message: 'Player-pressure window and subject counts must be truthful.',
      });
  });
export type PatientZeroPressureContext = z.infer<
  typeof patientZeroPressureContextSchema
>;
const patientZeroDisinfectionThreatSchema = z
  .object({
    eventId: eventIdSchema,
    kind: z.literal('territory-disinfected'),
    cell: h3CellSchema,
    occurredAt: z.iso.datetime(),
    affectedAgentId: agentIdSchema,
    affectedAgentName: z.string().trim().min(1).max(80),
    pressureContext: patientZeroPressureContextSchema.optional(),
  })
  .strict();
const patientZeroBlockedCleanThreatSchema = z
  .object({
    eventId: eventIdSchema,
    kind: z.literal('occupied-clean-blocked'),
    cell: h3CellSchema,
    occurredAt: z.iso.datetime(),
    blockingAgentId: agentIdSchema,
    blockingAgentName: z.string().trim().min(1).max(80),
    pressureContext: patientZeroPressureContextSchema.optional(),
  })
  .strict();
export const patientZeroPlayerThreatEventSchema = z.discriminatedUnion('kind', [
  patientZeroDisinfectionThreatSchema,
  patientZeroBlockedCleanThreatSchema,
]);
export type PatientZeroPlayerThreatEvent = z.infer<
  typeof patientZeroPlayerThreatEventSchema
>;
export const patientZeroPlayerThreatFeedSchema = z
  .object({
    events: z
      .array(patientZeroPlayerThreatEventSchema)
      .max(PATIENT_ZERO_PLAYER_THREAT_FEED_LIMIT),
    totalEventCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((feed, context) => {
    if (
      feed.events.length > feed.totalEventCount ||
      feed.truncated !== feed.totalEventCount > feed.events.length ||
      new Set(feed.events.map(({ eventId }) => eventId)).size !==
        feed.events.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Patient Zero player-threat counts must be truthful.',
      });
    for (const event of feed.events) {
      if (
        event.pressureContext &&
        (event.kind === 'territory-disinfected'
          ? event.pressureContext.subject.disinfections < 1
          : event.pressureContext.subject.blockedCleans < 1)
      )
        context.addIssue({
          code: 'custom',
          message:
            'Patient Zero event pressure must include the current event.',
        });
    }
  });
export type PatientZeroPlayerThreatFeed = z.infer<
  typeof patientZeroPlayerThreatFeedSchema
>;

export const patientZeroGlobalAgentSchema = z.object({
  id: agentIdSchema,
  name: z.string().trim().min(1).max(80),
  currentCell: h3CellSchema,
  controlledCellCount: z.number().int().nonnegative(),
});

export const patientZeroGlobalViewSchema = z.object({
  agents: z
    .array(patientZeroGlobalAgentSchema)
    .max(WORLD_SCENARIO_LIMITS.maximumAgents),
  individualTerritory: territoryScoreboardSchema,
  recentTerritoryChanges: z
    .array(hexCapturedWorldEventSchema)
    .max(RECENT_CONTROL_CHANGE_LIMIT),
  playerThreatFeed: patientZeroPlayerThreatFeedSchema.nullable().default(null),
});

const agentObservationObjectSchema = z.object({
  agentId: agentIdSchema,
  agentName: z.string().trim().min(1).max(80),
  currentCell: cellObservationSchema,
  captureEligibility: captureEligibilitySchema,
  actionAvailability: z
    .object({
      moveTargetCellIds: z.array(h3CellSchema).min(1).max(6),
      moveOptions: z
        .array(
          z
            .object({
              targetCell: h3CellSchema,
              direction: z.enum(['N', 'NE', 'SE', 'S', 'SW', 'NW']),
              destinationState: hexStateSchema,
              controllerRelationship: z.enum(['open', 'self', 'other']),
              recentlyOccupied: z.boolean(),
              nearbyAgentCount: z
                .number()
                .int()
                .nonnegative()
                .max(WORLD_SCENARIO_LIMITS.maximumNearbyAgentObservations),
            })
            .strict(),
        )
        .max(6)
        .default([]),
      infect: z.discriminatedUnion('available', [
        z.object({ available: z.literal(true) }).strict(),
        z
          .object({
            available: z.literal(false),
            reason: z.literal('current-cell-already-infected'),
          })
          .strict(),
      ]),
      capture: z.discriminatedUnion('available', [
        z.object({ available: z.literal(true) }).strict(),
        z
          .object({
            available: z.literal(false),
            reason: captureBlockedReasonSchema,
          })
          .strict(),
      ]),
      wait: z.object({ available: z.literal(true) }).strict(),
    })
    .strict()
    .optional(),
  adjacentCells: z.array(cellObservationSchema).min(1).max(6),
  nearbyAgents: z
    .array(nearbyAgentObservationSchema)
    .max(WORLD_SCENARIO_LIMITS.maximumNearbyAgentObservations),
  recentEvents: z.array(publicEventObservationSchema).max(8),
  patientZero: z
    .object({
      agentId: agentIdSchema.nullable(),
      agentName: z.string().trim().min(1).max(80).nullable(),
      isPatientZero: z.boolean(),
      directRangeBypass: z.boolean(),
    })
    .default({
      agentId: null,
      agentName: null,
      isPatientZero: false,
      directRangeBypass: false,
    }),
  patientZeroGlobalView: patientZeroGlobalViewSchema.nullable().default(null),
  territoryScoreboard: territoryScoreboardSchema,
  recentControlChanges: z
    .array(observedControlChangeSchema)
    .max(RECENT_CONTROL_CHANGE_LIMIT),
  playerPressure: z
    .object({
      enabled: z.boolean(),
      recentThreats: z.array(observedPlayerThreatSchema).max(6),
    })
    .strict()
    .default({ enabled: false, recentThreats: [] }),
  captureAlerts: z.array(captureAlertSchema).max(4).optional(),
  recentMovements: z
    .array(
      z.object({
        fromCell: h3CellSchema,
        toCell: h3CellSchema,
        occurredAt: z.iso.datetime(),
      }),
    )
    .max(6)
    .default([]),
});

export const agentObservationSchema = agentObservationObjectSchema.transform(
  (observation, context) => {
    if (
      observation.patientZeroGlobalView !== null &&
      !observation.patientZero.isPatientZero
    )
      context.addIssue({
        code: 'custom',
        path: ['patientZeroGlobalView'],
        message: 'Only Patient Zero may receive the global view.',
      });
    if (
      observation.patientZeroGlobalView?.playerThreatFeed !== null &&
      observation.patientZeroGlobalView?.playerThreatFeed !== undefined &&
      !observation.playerPressure.enabled
    )
      context.addIssue({
        code: 'custom',
        path: ['patientZeroGlobalView', 'playerThreatFeed'],
        message: 'Cleaner pressure must be enabled for its global feed.',
      });
    return {
      ...observation,
      actionAvailability: observation.actionAvailability ?? {
        moveTargetCellIds: observation.adjacentCells.map(({ cell }) => cell),
        moveOptions: [],
        infect:
          observation.currentCell.state === 'open'
            ? { available: true as const }
            : {
                available: false as const,
                reason: 'current-cell-already-infected' as const,
              },
        capture: observation.captureEligibility.eligible
          ? { available: true as const }
          : {
              available: false as const,
              reason: observation.captureEligibility.blockedReason,
            },
        wait: { available: true as const },
      },
    };
  },
);
export type AgentObservation = z.infer<typeof agentObservationSchema>;

export const providerModeSchema = z.enum([
  'openrouter',
  'typesafe',
  'scripted-test',
]);
export type ProviderMode = z.infer<typeof providerModeSchema>;

export const modelIdSchema = z.string().trim().min(1).max(200);
export type ModelId = z.infer<typeof modelIdSchema>;

export const reflexDecisionSchema = z
  .object({
    chosenCandidateId: z
      .string()
      .regex(/^action_[0-9]+$/)
      .max(32),
    confidence: z.number().finite().min(0).max(1),
    probabilities: z
      .record(
        z
          .string()
          .regex(/^action_[0-9]+$/)
          .max(32),
        z.number().finite().min(0).max(1),
      )
      .refine((probabilities) => Object.keys(probabilities).length <= 9, {
        message:
          'Reflex probability telemetry may include at most 9 candidates.',
      }),
    /** Probability that the worker should request a new directive. */
    replanProbability: z.number().finite().min(0).max(1).optional(),
    model: modelIdSchema,
    latencyMs: z.number().finite().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    directiveId: z.string().trim().min(1).max(80),
    cognitionSource: cognitionSourceSchema,
  })
  .strict();
export type ReflexDecision = z.infer<typeof reflexDecisionSchema>;

const priceStringSchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+)?$/)
  .max(80);

export const reasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const reasoningProfileSchema = z.enum([
  'provider-default',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ReasoningProfile = z.infer<typeof reasoningProfileSchema>;

export const compatibleModelReasoningSchema = z.object({
  supportedEfforts: z.array(reasoningEffortSchema).nullable().optional(),
  defaultEffort: reasoningEffortSchema.optional(),
  defaultEnabled: z.boolean().optional(),
  supportsMaxTokens: z.boolean().optional(),
  mandatory: z.boolean(),
});

export const compatibleModelSchema = z.object({
  id: modelIdSchema,
  name: z.string().trim().min(1).max(160),
  author: z.string().trim().min(1).max(100),
  contextLength: z.number().int().min(OPENROUTER_MODEL_CONTEXT_MINIMUM),
  inputPricePerToken: priceStringSchema,
  outputPricePerToken: priceStringSchema,
  requestPrice: priceStringSchema.optional(),
  supportedParameters: z.array(z.string().trim().min(1).max(80)).max(80),
  createdAt: z.iso.datetime().optional(),
  expirationDate: z.iso.date().nullable().optional(),
  isFree: z.boolean(),
  reasoning: compatibleModelReasoningSchema.optional(),
});
export type CompatibleModel = z.infer<typeof compatibleModelSchema>;

const reasoningProfileOrder: Exclude<
  ReasoningProfile,
  'provider-default' | 'off'
>[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function reasoningProfilesForModel(
  model: CompatibleModel | undefined,
): ReasoningProfile[] {
  if (!model?.reasoning) return ['provider-default'];
  const advertised = new Set(model.reasoning.supportedEfforts ?? []);
  return [
    'provider-default',
    ...(model.reasoning.mandatory ? [] : (['off'] as const)),
    ...reasoningProfileOrder.filter((profile) => advertised.has(profile)),
  ];
}

export function modelSupportsReasoningProfile(
  model: CompatibleModel | undefined,
  profile: ReasoningProfile,
): boolean {
  return reasoningProfilesForModel(model).includes(profile);
}

export const modelOverrideSchema = z.object({
  agentId: agentIdSchema,
  modelId: modelIdSchema,
  reasoningProfile: reasoningProfileSchema.default('provider-default'),
});
export const experimentModelConfigurationSchema = z
  .object({
    globalModelId: modelIdSchema.nullable(),
    globalReasoningProfile: reasoningProfileSchema.default('provider-default'),
    overrides: z
      .array(modelOverrideSchema)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    /** Retained for version-6 import compatibility; runtime selection is never turn-locked. */
    locked: z.boolean().default(false),
  })
  .strict()
  .refine(
    ({ overrides }) =>
      new Set(overrides.map(({ agentId }) => agentId)).size ===
      overrides.length,
    { message: 'Each agent may have at most one model override.' },
  );
export type ExperimentModelConfiguration = z.infer<
  typeof experimentModelConfigurationSchema
>;

export const resolvedAgentModelSchema = z.object({
  agentId: agentIdSchema,
  modelId: modelIdSchema.nullable(),
  reasoningProfile: reasoningProfileSchema.default('provider-default'),
  source: z.enum(['global', 'override', 'missing']),
  available: z.boolean(),
  issue: z.enum(['missing', 'unavailable', 'reasoning-unavailable']).optional(),
});
export type ResolvedAgentModel = z.infer<typeof resolvedAgentModelSchema>;

export const modelCatalogErrorSchema = z.object({
  code: z.enum([
    'configuration',
    'timeout',
    'network',
    'provider-http',
    'invalid-response',
  ]),
  message: z.string().trim().min(1).max(240),
});
export const modelCatalogResponseSchema = z.object({
  models: z.array(compatibleModelSchema),
  filteredOutCount: z.number().int().nonnegative(),
  fetchedAt: z.iso.datetime().optional(),
  expiresAt: z.iso.datetime().optional(),
  stale: z.boolean(),
  error: modelCatalogErrorSchema.optional(),
  requirements: z.object({
    input: z.literal('text'),
    output: z.literal('text'),
    endpoint: z.literal('chat-completions'),
    requiredParameters: z
      .array(z.enum(OPENROUTER_REQUIRED_PARAMETERS))
      .length(OPENROUTER_REQUIRED_PARAMETERS.length),
    minimumContextLength: z.literal(OPENROUTER_MODEL_CONTEXT_MINIMUM),
    streaming: z.literal(false),
  }),
});
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>;

export const updateExperimentModelsRequestSchema = z
  .object({
    globalModelId: modelIdSchema.nullable(),
    globalReasoningProfile: reasoningProfileSchema.default('provider-default'),
    overrides: z
      .array(modelOverrideSchema)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
  })
  .strict();
export const updateExperimentModelsResponseSchema = z.object({
  snapshot: z.lazy(() => simulationSnapshotSchema),
});
export const modelVerificationStatusSchema = z.enum([
  'untested',
  'verified',
  'failed',
]);
export const modelVerificationSchema = z.object({
  modelId: modelIdSchema,
  reasoningProfile: reasoningProfileSchema.default('provider-default'),
  contractVersion: swarmPlannerContractVersionSchema,
  status: modelVerificationStatusSchema,
  testedAt: z.iso.datetime().optional(),
  failure: z
    .object({
      code: z.string().trim().min(1).max(80),
      message: z.string().trim().min(1).max(PROVIDER_ERROR_MAX_LENGTH),
    })
    .optional(),
  provider: z.lazy(() => providerMetadataSchema).optional(),
});
export type ModelVerification = z.infer<typeof modelVerificationSchema>;

export const verifyModelRequestSchema = z
  .object({
    modelId: modelIdSchema,
    reasoningProfile: reasoningProfileSchema.default('provider-default'),
    force: z.boolean().optional(),
  })
  .strict();
export const verifyModelResponseSchema = z.object({
  verification: modelVerificationSchema,
});

export const providerMetadataSchema = z.object({
  provider: providerModeSchema,
  model: modelIdSchema,
  selectedModel: modelIdSchema.optional(),
  resolvedModel: modelIdSchema.optional(),
  requestId: z.string().trim().min(1).max(160).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  finishReason: z.string().trim().min(1).max(80).optional(),
  nativeFinishReason: z.string().trim().min(1).max(120).optional(),
  latencyMs: z.number().int().nonnegative().max(300_000),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  costCredits: z.number().nonnegative().finite().optional(),
});
export type ProviderMetadata = z.infer<typeof providerMetadataSchema>;

export const providerFailureSchema = z.object({
  code: z.enum([
    'configuration',
    'timeout',
    'network',
    'model-unavailable',
    'provider-http',
    'cancelled',
    'malformed-response',
    'unsupported-response',
    'output-length',
    'missing-text-output',
    'invalid-json',
    // Retained so schema-v6 exports produced by the superseded tool contract
    // remain importable. The text contract never emits these codes.
    'missing-tool-call',
    'multiple-tool-calls',
    'wrong-tool',
    'invalid-tool-arguments',
    'invalid-decision',
    'simulation-validation',
    'budget-exhausted',
  ]),
  message: z.string().trim().min(1).max(PROVIDER_ERROR_MAX_LENGTH),
  retryable: z.boolean(),
  latencyMs: z.number().int().nonnegative().max(300_000).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  providerCode: z.string().trim().min(1).max(80).optional(),
  providerMessage: z
    .string()
    .trim()
    .min(1)
    .max(PROVIDER_ERROR_MAX_LENGTH)
    .optional(),
  requestId: z.string().trim().min(1).max(160).optional(),
  model: modelIdSchema.optional(),
  finishReason: z.string().trim().min(1).max(80).optional(),
  nativeFinishReason: z.string().trim().min(1).max(120).optional(),
  validationCodes: z
    .array(
      z.enum([
        'missing-json-object',
        'multiple-json-objects',
        'invalid-json',
        'missing-required-field',
        'invalid-field-type',
        'invalid-enum-value',
        'contradictory-fields',
        'invalid-recipient-sentinel',
        'invalid-action-fields',
        'missing-move-target',
        'unexpected-world-target',
        'contradictory-world-action-fields',
        'summary-too-long',
      ]),
    )
    .max(8)
    .optional(),
  retryAfterMs: z.number().int().nonnegative().max(75_000).optional(),
});
export type ProviderFailure = z.infer<typeof providerFailureSchema>;

export const modelAttemptSchema = z.object({
  attemptNumber: z.number().int().positive(),
  kind: z.enum([
    'initial',
    'automatic-repair',
    'automatic-transport-retry',
    'manual-retry',
    'unattended-retry',
  ]),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  modelId: modelIdSchema,
  reasoningProfile: reasoningProfileSchema.default('provider-default'),
  failure: providerFailureSchema.optional(),
  provider: providerMetadataSchema.optional(),
});
export type ModelAttempt = z.infer<typeof modelAttemptSchema>;

export const providerAttemptIdSchema = z.uuid().brand<'ProviderAttemptId'>();
export type ProviderAttemptId = z.infer<typeof providerAttemptIdSchema>;

export const providerAttemptOutcomeSchema = z.enum([
  'completed',
  'provider-error',
  'cancelled',
  'timeout',
  'in-flight',
]);

function canonicalProviderCost(value: number): string {
  const raw = String(value).toLowerCase();
  if (!raw.includes('e')) {
    if (!raw.includes('.')) return raw;
    return raw.replace(/0+$/u, '').replace(/\.$/u, '');
  }
  const [mantissa, exponentText = '0'] = raw.split('e');
  const [whole, fraction = ''] = mantissa!.split('.');
  const exponent = Number(exponentText);
  const digits = `${whole}${fraction}`;
  const decimal = whole!.length + exponent;
  const expanded =
    decimal <= 0
      ? `0.${'0'.repeat(-decimal)}${digits}`
      : decimal >= digits.length
        ? `${digits}${'0'.repeat(decimal - digits.length)}`
        : `${digits.slice(0, decimal)}.${digits.slice(decimal)}`;
  if (!expanded.includes('.')) return expanded;
  const trimmed = expanded.replace(/0+$/u, '').replace(/\.$/u, '');
  return trimmed === '' ? '0' : trimmed;
}

export const providerAttemptRecordSchema = z
  .object({
    id: providerAttemptIdSchema,
    agentId: agentIdSchema,
    intendedTurnNumber: z.number().int().positive(),
    intendedTickNumber: z.number().int().positive().optional(),
    kind: modelAttemptSchema.shape.kind,
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    outcome: providerAttemptOutcomeSchema,
    modelId: modelIdSchema,
    reasoningProfile: reasoningProfileSchema.default('provider-default'),
    provider: providerMetadataSchema.optional(),
    failure: providerFailureSchema.optional(),
    reflexDecision: reflexDecisionSchema.optional(),
    swarmPlan: swarmPlanSchema.optional(),
    reservedCredits: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
    actualCostCredits: z
      .string()
      .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
      .optional(),
  })
  .strict()
  .superRefine((attempt, context) => {
    const finalized = attempt.outcome !== 'in-flight';
    if (finalized !== Boolean(attempt.completedAt))
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Only finalized provider attempts require a completion time.',
      });
    if (
      attempt.outcome === 'in-flight' &&
      (attempt.failure || attempt.actualCostCredits)
    )
      context.addIssue({
        code: 'custom',
        message: 'In-flight provider attempts cannot claim final results.',
      });
    if (attempt.outcome === 'completed' && attempt.failure)
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'Completed provider attempts cannot contain a failure.',
      });
    if (attempt.reflexDecision && attempt.outcome !== 'completed')
      context.addIssue({
        code: 'custom',
        path: ['reflexDecision'],
        message:
          'Reflex decision telemetry belongs only to completed attempts.',
      });
    if (attempt.swarmPlan && attempt.outcome !== 'completed')
      context.addIssue({
        code: 'custom',
        path: ['swarmPlan'],
        message: 'Swarm plan telemetry belongs only to completed attempts.',
      });
    if (
      ['provider-error', 'cancelled', 'timeout'].includes(attempt.outcome) &&
      !attempt.failure
    )
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'Unsuccessful provider attempts require a safe failure.',
      });
    if (
      attempt.outcome === 'cancelled' &&
      attempt.failure?.code !== 'cancelled'
    )
      context.addIssue({
        code: 'custom',
        path: ['failure', 'code'],
        message: 'Cancelled attempts require a cancelled failure.',
      });
    if (attempt.outcome === 'timeout' && attempt.failure?.code !== 'timeout')
      context.addIssue({
        code: 'custom',
        path: ['failure', 'code'],
        message: 'Timed-out attempts require a timeout failure.',
      });
    if (
      attempt.provider?.costCredits !== undefined &&
      attempt.actualCostCredits !==
        canonicalProviderCost(attempt.provider.costCredits)
    )
      context.addIssue({
        code: 'custom',
        path: ['actualCostCredits'],
        message: 'Actual cost must agree with safe provider metadata.',
      });
  });
export type ProviderAttemptRecord = z.infer<typeof providerAttemptRecordSchema>;

export const swarmWorkerTickRecordSchema = z
  .object({
    agentId: agentIdSchema,
    directive: swarmDirectiveSchema,
    situation: reflexObservationSchema.shape.currentSituation.optional(),
    action: worldActionSchema.optional(),
    actionResult: worldActionResultSchema.optional(),
    reflexDecision: reflexDecisionSchema.optional(),
    source: cognitionSourceSchema,
    failure: providerFailureSchema.optional(),
  })
  .strict();
export type SwarmWorkerTickRecord = z.infer<typeof swarmWorkerTickRecordSchema>;

/** Safe committed-tick telemetry for zero-swarm experiments. */
export const swarmTickRecordSchema = z
  .object({
    tickNumber: z.number().int().positive(),
    virtualTime: z.iso.datetime(),
    tickIntervalMinutes: z.number().int().positive(),
    plan: swarmPlanSchema,
    planSource: z.enum([
      'zero-llm',
      'deterministic-fallback',
      'directive-reuse',
    ]),
    replanReasons: z.array(swarmReplanReasonSchema).max(10).optional(),
    completedDirectives: z
      .array(completedSwarmDirectiveSchema)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents)
      .optional(),
    signals: z
      .array(swarmSignalSchema)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents)
      .optional(),
    plannerFailure: providerFailureSchema.optional(),
    plannerMetadata: providerMetadataSchema.optional(),
    zeroAction: worldActionSchema.optional(),
    zeroActionResult: worldActionResultSchema.optional(),
    workers: z
      .array(swarmWorkerTickRecordSchema)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
  })
  .strict()
  .superRefine((record, context) => {
    const agentIds = record.workers.map(({ agentId }) => agentId);
    if (new Set(agentIds).size !== agentIds.length)
      context.addIssue({
        code: 'custom',
        path: ['workers'],
        message: 'Each worker may have one swarm tick record.',
      });
    if (record.planSource === 'zero-llm' && record.plannerFailure)
      context.addIssue({
        code: 'custom',
        path: ['plannerFailure'],
        message: 'A successful Zero plan cannot include a planner failure.',
      });
    const signals = record.signals ?? [];
    if (
      new Set(signals.map(({ agentId }) => agentId)).size !== signals.length ||
      signals.some(
        (signal) =>
          !record.workers.some(
            (worker) =>
              worker.agentId === signal.agentId &&
              worker.directive.id === signal.directiveId,
          ),
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['signals'],
        message: 'Each replan signal must name one current worker directive.',
      });
  });
export type SwarmTickRecord = z.infer<typeof swarmTickRecordSchema>;

export const providerAttemptRetentionSchema = z
  .object({
    limit: z.number().int().positive(),
    totalStartedAttempts: z.number().int().nonnegative(),
    retainedAttempts: z.number().int().nonnegative(),
    droppedRecords: z.number().int().nonnegative(),
    complete: z.boolean(),
    requestedRangeExtendsBeyondRetention: z.boolean(),
  })
  .strict();
export type ProviderAttemptRetention = z.infer<
  typeof providerAttemptRetentionSchema
>;

export const scenarioContractVersionSchema = z.literal('world-scenario-v1');
export const setupIssueCodeSchema = z.enum([
  'invalid-coordinates',
  'unsupported-resolution',
  'invalid-radius',
  'cell-limit-exceeded',
  'invalid-roster',
  'duplicate-agent-id',
  'duplicate-agent-name',
  'invalid-color',
  'spawn-infeasible',
  'model-agent-mismatch',
  'high-agent-density',
  'geocoder-unavailable',
]);
export const setupIssueSchema = z.object({
  code: setupIssueCodeSchema,
  message: z.string().trim().min(1).max(240),
  field: z.string().trim().min(1).max(80).optional(),
});
export type SetupIssue = z.infer<typeof setupIssueSchema>;

export const scenarioRosterEntrySchema = z.object({
  id: agentIdSchema,
  name: z.string().trim().min(1).max(80),
  color: colorSchema,
});
export type ScenarioRosterEntry = z.infer<typeof scenarioRosterEntrySchema>;

const scenarioRosterSchema = z
  .array(scenarioRosterEntrySchema)
  .min(WORLD_SCENARIO_LIMITS.minimumAgents)
  .max(WORLD_SCENARIO_LIMITS.maximumAgents)
  .superRefine((roster, context) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    roster.forEach((entry, index) => {
      if (ids.has(entry.id))
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Agent IDs must be unique.',
        });
      ids.add(entry.id);
      const name = entry.name.toLocaleLowerCase();
      if (names.has(name))
        context.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: 'Agent names must be unique.',
        });
      names.add(name);
    });
  });

export const creditDecimalSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, 'Use a canonical decimal string.')
  .max(80);
export const positiveCreditDecimalSchema = creditDecimalSchema.refine(
  (value) => /[1-9]/.test(value),
  'Credit value must be positive.',
);

const archivedExperimentExecutionLimitsV1Schema = z
  .object({
    version: z.literal('execution-limits-v1').default('execution-limits-v1'),
    providerAttemptLimit: z
      .number()
      .int()
      .positive()
      .max(WORLD_SCENARIO_LIMITS.maximumProviderAttempts)
      .nullable(),
  })
  .strict();
export const experimentExecutionLimitsSchema = z
  .object({
    version: z.literal('execution-limits-v2').default('execution-limits-v2'),
    providerAttemptLimit: z
      .number()
      .int()
      .positive()
      .max(WORLD_SCENARIO_LIMITS.maximumProviderAttempts)
      .nullable(),
    creditLimit: positiveCreditDecimalSchema.nullable(),
    reservationCreditsPerAttempt: positiveCreditDecimalSchema,
  })
  .strict();
const defaultExperimentExecutionLimits = {
  version: 'execution-limits-v2',
  providerAttemptLimit: DEFAULT_PROVIDER_ATTEMPT_LIMIT,
  creditLimit: null,
  reservationCreditsPerAttempt: '0.01',
} as const;
const compatibleExperimentExecutionLimitsSchema = z.union([
  experimentExecutionLimitsSchema,
  archivedExperimentExecutionLimitsV1Schema,
]);
export type ExperimentExecutionLimits = z.infer<
  typeof experimentExecutionLimitsSchema
>;

const worldSetupRequestObjectSchema = z
  .object({
    scenarioVersion: scenarioContractVersionSchema.default('world-scenario-v1'),
    swarmArchitectureVersion:
      swarmArchitectureVersionSchema.default('zero-swarm-v1'),
    locationLabel: z.string().trim().min(1).max(120).optional(),
    center: z.object({
      latitude: z.number().finite().min(-90).max(90),
      longitude: z.number().finite().min(-180).max(180),
    }),
    resolution: z
      .number()
      .int()
      .min(WORLD_SCENARIO_LIMITS.minimumResolution)
      .max(WORLD_SCENARIO_LIMITS.maximumResolution),
    radius: z.number().int().min(0).max(WORLD_SCENARIO_LIMITS.maximumRadius),
    worldSeed: z.string().trim().min(1).max(80),
    rosterSeed: z.string().trim().min(1).max(80),
    spawnSeed: z.string().trim().min(1).max(80),
    minimumSpawnSeparation: z
      .number()
      .int()
      .min(0)
      .max(WORLD_SCENARIO_LIMITS.maximumRadius * 2),
    minimumTickIntervalMinutes: z
      .number()
      .int()
      .min(WORLD_SCENARIO_LIMITS.minimumTickIntervalMinutes)
      .max(WORLD_SCENARIO_LIMITS.maximumTickIntervalMinutes)
      .default(DEFAULT_MINIMUM_TICK_INTERVAL_MINUTES),
    maximumTickIntervalMinutes: z
      .number()
      .int()
      .min(WORLD_SCENARIO_LIMITS.minimumTickIntervalMinutes)
      .max(WORLD_SCENARIO_LIMITS.maximumTickIntervalMinutes)
      .default(DEFAULT_MAXIMUM_TICK_INTERVAL_MINUTES),
    executionLimits: compatibleExperimentExecutionLimitsSchema.default(
      defaultExperimentExecutionLimits,
    ),
    patientZeroAgentId: agentIdSchema,
    roster: scenarioRosterSchema,
    modelConfiguration: experimentModelConfigurationSchema,
    objectiveVersion: z
      .enum([
        'durable-influence-v1',
        'durable-influence-v2',
        OBJECTIVE_PROMPT_VERSION,
      ])
      .default('durable-influence-v2'),
    capabilities: z
      .object({
        simulatedPlayerPressure: z.boolean().default(false),
      })
      .strict(),
    simulatedPlayer: simulatedPlayerConfigurationSchema.default({
      enabled: false,
      profile: 'casual-cleaner',
      seed: 'casual-cleaner-v1',
    }),
  })
  .strict();

type WorldSetupValidationInput = Omit<
  z.infer<typeof worldSetupRequestObjectSchema>,
  'patientZeroAgentId'
> & { patientZeroAgentId: AgentId | null };

function validateWorldSetupRequest(
  request: WorldSetupValidationInput,
  context: z.RefinementCtx,
  allowArchivedDisabledV1 = false,
) {
  if (
    !allowArchivedDisabledV1 &&
    request.executionLimits.version !== 'execution-limits-v2'
  )
    context.addIssue({
      code: 'custom',
      path: ['executionLimits', 'version'],
      message: 'Active World Setup requires execution-limits-v2.',
    });
  const expectedObjective = request.simulatedPlayer.enabled
    ? OBJECTIVE_PROMPT_VERSION
    : 'durable-influence-v2';
  if (
    request.objectiveVersion !== expectedObjective &&
    !(
      allowArchivedDisabledV1 &&
      !request.simulatedPlayer.enabled &&
      request.objectiveVersion === 'durable-influence-v1'
    )
  )
    context.addIssue({
      code: 'custom',
      path: ['objectiveVersion'],
      message: `Objective attribution must be ${expectedObjective} for this simulated-player capability.`,
    });
  if (
    request.capabilities.simulatedPlayerPressure !==
    request.simulatedPlayer.enabled
  )
    context.addIssue({
      code: 'custom',
      path: ['capabilities', 'simulatedPlayerPressure'],
      message:
        'Simulated-player pressure capability must match the configured player.',
    });
  if (request.minimumTickIntervalMinutes > request.maximumTickIntervalMinutes)
    context.addIssue({
      code: 'custom',
      path: ['maximumTickIntervalMinutes'],
      message: 'Maximum tick interval must be at least the minimum.',
    });
  const ids = new Set(request.roster.map(({ id }) => id));
  if (
    request.modelConfiguration.overrides.some(
      ({ agentId }) => !ids.has(agentId),
    )
  )
    context.addIssue({
      code: 'custom',
      path: ['modelConfiguration', 'overrides'],
      message: 'Model overrides may reference only roster agents.',
    });
  if (
    request.patientZeroAgentId !== null &&
    !ids.has(request.patientZeroAgentId)
  )
    context.addIssue({
      code: 'custom',
      path: ['patientZeroAgentId'],
      message: 'Patient Zero must belong to the active roster.',
    });
}

export const worldSetupRequestSchema = worldSetupRequestObjectSchema
  .extend({
    executionLimits: experimentExecutionLimitsSchema.default(
      defaultExperimentExecutionLimits,
    ),
  })
  .superRefine(validateWorldSetupRequest);
export type WorldSetupRequest = z.infer<typeof worldSetupRequestSchema>;
export const defaultWorldSetupResponseSchema = z.object({
  request: worldSetupRequestSchema,
});

const appliedScenarioShape = {
  swarmPlannerContractVersion: swarmPlannerContractVersionSchema.default(
    SWARM_PLANNER_CONTRACT_VERSION,
  ),
  exactCellCount: z
    .number()
    .int()
    .min(1)
    .max(WORLD_SCENARIO_LIMITS.maximumGeneratedCells),
  areaSquareKilometers: z.number().finite().positive(),
  startingCells: z
    .array(h3CellSchema)
    .min(1)
    .max(WORLD_SCENARIO_LIMITS.maximumAgents),
  setupWarnings: z.array(setupIssueSchema),
};

function validateAppliedScenario(
  scenario: WorldSetupValidationInput & {
    startingCells: H3Cell[];
  },
  context: z.RefinementCtx,
  allowArchivedDisabledV1 = false,
) {
  validateWorldSetupRequest(scenario, context, allowArchivedDisabledV1);
  if (scenario.startingCells.length !== scenario.roster.length)
    context.addIssue({
      code: 'custom',
      path: ['startingCells'],
      message: 'Every roster agent requires one starting cell.',
    });
}

export const appliedScenarioSchema = worldSetupRequestObjectSchema
  .extend({
    executionLimits: experimentExecutionLimitsSchema.default(
      defaultExperimentExecutionLimits,
    ),
  })
  .extend(appliedScenarioShape)
  .superRefine(validateAppliedScenario);
export type AppliedScenario = z.infer<typeof appliedScenarioSchema>;
/**
 * Read-only translation for historical exports. Active setup never accepts
 * these retired fields; import normalizes them at the archive boundary.
 */
export const archivedAppliedScenarioSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      return input;
    const scenario = input as Record<string, unknown>;
    const { cognitionMode, decisionContractVersion, ...current } = scenario;
    return {
      ...current,
      historicalCognitionMode:
        scenario.historicalCognitionMode ?? cognitionMode,
      historicalDecisionContractVersion:
        scenario.historicalDecisionContractVersion ?? decisionContractVersion,
      swarmArchitectureVersion:
        scenario.swarmArchitectureVersion ?? 'zero-swarm-v1',
      swarmPlannerContractVersion:
        scenario.swarmPlannerContractVersion ?? SWARM_PLANNER_CONTRACT_VERSION,
    };
  },
  worldSetupRequestObjectSchema
    .extend({
      patientZeroAgentId: agentIdSchema.nullable(),
      historicalCognitionMode: z
        .enum(['legacy-multi-agent', 'zero-swarm-v1'])
        .optional(),
      historicalDecisionContractVersion: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .optional(),
      ...appliedScenarioShape,
    })
    .superRefine((scenario, context) =>
      validateAppliedScenario(scenario, context, true),
    ),
);

export const worldSetupPreviewResponseSchema = z.discriminatedUnion(
  'feasible',
  [
    z.object({
      feasible: z.literal(true),
      scenario: appliedScenarioSchema,
      world: worldSnapshotSchema,
    }),
    z.object({
      feasible: z.literal(false),
      errors: z.array(setupIssueSchema).min(1),
      warnings: z.array(setupIssueSchema).default([]),
    }),
  ],
);
export type WorldSetupPreviewResponse = z.infer<
  typeof worldSetupPreviewResponseSchema
>;
export const applyWorldSetupResponseSchema = z.object({
  snapshot: z.lazy(() => simulationSnapshotSchema),
});

export const generatedAgentRequestSchema = z.object({
  count: z
    .number()
    .int()
    .min(WORLD_SCENARIO_LIMITS.minimumAgents)
    .max(WORLD_SCENARIO_LIMITS.maximumAgents),
  seed: z.string().trim().min(1).max(80),
});
export const generatedAgentResponseSchema = z.object({
  roster: scenarioRosterSchema,
});
export const locationSearchRequestSchema = z
  .object({ query: z.string().trim().min(2).max(120) })
  .strict();
export const locationSearchResultSchema = z.object({
  label: z.string().trim().min(1).max(240),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});
export const locationSearchResponseSchema = z.object({
  results: z.array(locationSearchResultSchema).max(5),
  attribution: z.literal('© OpenStreetMap contributors'),
  warning: setupIssueSchema.optional(),
});
export type LocationSearchResponse = z.infer<
  typeof locationSearchResponseSchema
>;

export const simulationStatusSchema = z.enum([
  'paused',
  'running',
  'waiting-for-model',
  'resetting',
  'configuration-error',
  'provider-error',
  'budget-exhausted',
  'patient-zero-captured',
  'infection-eliminated',
]);
export type SimulationStatus = z.infer<typeof simulationStatusSchema>;

export const experimentAttemptAccountingSchema = z
  .object({
    providerAttemptLimit: z.number().int().positive().nullable(),
    reservedPermits: z.number().int().nonnegative(),
    attemptsStarted: z.number().int().nonnegative(),
    attemptsFinalized: z.number().int().nonnegative(),
    attemptsInFlight: z.number().int().nonnegative(),
    remainingAttempts: z.number().int().nonnegative().nullable(),
    creditLimit: positiveCreditDecimalSchema.nullable(),
    reservationCreditsPerAttempt: positiveCreditDecimalSchema,
    unstartedReservedCredits: creditDecimalSchema,
    committedCreditExposure: creditDecimalSchema,
    remainingAdmissionCredits: creditDecimalSchema.nullable(),
    knownFinalizedCostCredits: creditDecimalSchema,
    reservationOverageCredits: creditDecimalSchema,
    attemptsWithUnknownCost: z.number().int().nonnegative(),
    exhausted: z.boolean(),
    exhaustionReason: z
      .enum([
        'provider-attempt-limit',
        'credit-admission-limit',
        'credit-reservation-overrun',
      ])
      .nullable(),
  })
  .strict()
  .superRefine((accounting, context) => {
    if (
      accounting.attemptsFinalized > accounting.attemptsStarted ||
      accounting.attemptsInFlight !==
        accounting.attemptsStarted - accounting.attemptsFinalized
    )
      context.addIssue({
        code: 'custom',
        path: ['attemptsInFlight'],
        message: 'Attempt lifecycle totals must be internally consistent.',
      });
    if (
      (accounting.providerAttemptLimit === null) !==
      (accounting.remainingAttempts === null)
    )
      context.addIssue({
        code: 'custom',
        path: ['remainingAttempts'],
        message:
          'Unlimited attempt accounting must report null remaining attempts.',
      });
    if (
      (accounting.creditLimit === null) !==
      (accounting.remainingAdmissionCredits === null)
    )
      context.addIssue({
        code: 'custom',
        path: ['remainingAdmissionCredits'],
        message:
          'Unlimited credit admission must report null remaining credits.',
      });
    if (
      accounting.attemptsWithUnknownCost > accounting.attemptsFinalized ||
      accounting.exhausted !== (accounting.exhaustionReason !== null)
    )
      context.addIssue({
        code: 'custom',
        path: ['exhaustionReason'],
        message: 'Attempt cost and exhaustion summaries must be consistent.',
      });
  });
export type ExperimentAttemptAccounting = z.infer<
  typeof experimentAttemptAccountingSchema
>;

const defaultExperimentAttemptAccounting = {
  providerAttemptLimit: DEFAULT_PROVIDER_ATTEMPT_LIMIT,
  reservedPermits: 0,
  attemptsStarted: 0,
  attemptsFinalized: 0,
  attemptsInFlight: 0,
  remainingAttempts: DEFAULT_PROVIDER_ATTEMPT_LIMIT,
  creditLimit: null,
  reservationCreditsPerAttempt: '0.01',
  unstartedReservedCredits: '0',
  committedCreditExposure: '0',
  remainingAdmissionCredits: null,
  knownFinalizedCostCredits: '0',
  reservationOverageCredits: '0',
  attemptsWithUnknownCost: 0,
  exhausted: false,
  exhaustionReason: null,
} as const;

export const simulationSnapshotSchema = z
  .object({
    world: worldSnapshotSchema,
    scenario: appliedScenarioSchema,
    tickNumber: z.number().int().nonnegative().default(0),
    virtualTime: z.iso.datetime().default('2026-08-13T12:00:00.000Z'),
    lastTickIntervalMinutes: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null),
    resolutionOrder: z.array(agentIdSchema).default([]),
    activeAgentId: agentIdSchema.nullable(),
    cancellationRequested: z.boolean().default(false),
    status: simulationStatusSchema,
    providerMode: providerModeSchema,
    providerConfigured: z.boolean(),
    swarmProviderStatus: z
      .object({
        plannerMode: z.enum(['openrouter-swarm', 'scripted-swarm-test']),
        plannerConfigured: z.boolean(),
        reflexMode: z.enum(['typesafe-jev', 'scripted-reflex-test']),
        reflexConfigured: z.boolean(),
        reflexModel: z.string().trim().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
    modelConfiguration: experimentModelConfigurationSchema,
    resolvedModels: z
      .array(resolvedAgentModelSchema)
      .min(0)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    swarmTicks: z.array(swarmTickRecordSchema).max(120).optional(),
    experiment: z.object({
      id: z.uuid().brand<'ExperimentId'>(),
      startedAt: z.iso.datetime(),
      attemptAccounting: experimentAttemptAccountingSchema.default(
        defaultExperimentAttemptAccounting,
      ),
      metrics: z.lazy(() => experimentMetricsSchema),
      currentTerritory: territoryScoreboardSchema,
      simulatedPlayerMetrics: simulatedPlayerMetricsSchema.default({
        movements: 0,
        cellsDisinfected: 0,
        blockedDisinfections: 0,
      }),
    }),
  })
  .superRefine((snapshot, context) => {
    const rosterIds = new Set(snapshot.world.agents.map(({ id }) => id));
    const terminal =
      snapshot.status === 'patient-zero-captured' ||
      snapshot.status === 'infection-eliminated';
    if (rosterIds.size === 0 && snapshot.status !== 'infection-eliminated')
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'A world without active agents has an eliminated infection.',
      });
    if (
      snapshot.scenario.simulatedPlayer.enabled !==
        Boolean(snapshot.world.simulatedPlayer) ||
      snapshot.scenario.capabilities.simulatedPlayerPressure !==
        Boolean(snapshot.world.simulatedPlayer)
    )
      context.addIssue({
        code: 'custom',
        path: ['world', 'simulatedPlayer'],
        message:
          'World simulated-player state must match the applied scenario capability.',
      });
    if (
      JSON.stringify(snapshot.experiment.simulatedPlayerMetrics) !==
      JSON.stringify(
        snapshot.world.simulatedPlayer?.metrics ?? {
          movements: 0,
          cellsDisinfected: 0,
          blockedDisinfections: 0,
        },
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['experiment', 'simulatedPlayerMetrics'],
        message:
          'Experiment simulated-player metrics must match the authoritative world.',
      });
    if (snapshot.tickNumber === 0) {
      if (
        snapshot.resolutionOrder.length !== 0 ||
        snapshot.lastTickIntervalMinutes !== null
      )
        context.addIssue({
          code: 'custom',
          path: ['tickNumber'],
          message:
            'An unstarted simulation cannot have tick resolution metadata.',
        });
    } else if (
      terminal &&
      (snapshot.resolutionOrder.length !== 0 ||
        snapshot.lastTickIntervalMinutes === null)
    )
      context.addIssue({
        code: 'custom',
        path: ['resolutionOrder'],
        message:
          'A terminal player-only tick must not resolve agent actions and requires an interval.',
      });
    else if (
      !terminal &&
      (snapshot.resolutionOrder.length !== rosterIds.size ||
        new Set(snapshot.resolutionOrder).size !== rosterIds.size ||
        snapshot.resolutionOrder.some((id) => !rosterIds.has(id)) ||
        snapshot.lastTickIntervalMinutes === null)
    )
      context.addIssue({
        code: 'custom',
        path: ['resolutionOrder'],
        message:
          'A committed tick requires one ordered entry per active agent and an interval.',
      });
    if (
      snapshot.status === 'infection-eliminated' &&
      snapshot.world.agents.length !== 0
    )
      context.addIssue({
        code: 'custom',
        path: ['world', 'agents'],
        message: 'An eliminated infection cannot retain active agents.',
      });
    if (
      snapshot.status === 'patient-zero-captured' &&
      rosterIds.has(snapshot.scenario.patientZeroAgentId)
    )
      context.addIssue({
        code: 'custom',
        path: ['world', 'agents'],
        message: 'Patient Zero cannot remain active after capture.',
      });
    if (
      snapshot.experiment.currentTerritory.length !== rosterIds.size ||
      snapshot.experiment.currentTerritory.some(
        ({ agentId }) => !rosterIds.has(agentId),
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['experiment', 'currentTerritory'],
        message: 'Territory entries must cover the current roster exactly.',
      });
    if (
      snapshot.resolvedModels.length !== rosterIds.size ||
      snapshot.resolvedModels.some(({ agentId }) => !rosterIds.has(agentId))
    )
      context.addIssue({
        code: 'custom',
        path: ['resolvedModels'],
        message: 'Resolved models must cover the current roster exactly.',
      });
    const authoritative = new Map<AgentId, number>(
      snapshot.world.agents.map(({ id }) => [id, 0]),
    );
    for (const hex of snapshot.world.hexes) {
      if (hex.state === 'infected' && hex.controllerAgentId !== null)
        authoritative.set(
          hex.controllerAgentId,
          (authoritative.get(hex.controllerAgentId) ?? 0) + 1,
        );
    }
    for (const [
      index,
      entry,
    ] of snapshot.experiment.currentTerritory.entries()) {
      const agent = snapshot.world.agents.find(
        ({ id }) => id === entry.agentId,
      );
      if (!agent || agent.name !== entry.name || agent.color !== entry.color)
        context.addIssue({
          code: 'custom',
          path: ['experiment', 'currentTerritory', index],
          message: 'Current territory identity must match a world agent.',
        });
      if (authoritative.get(entry.agentId) !== entry.controlledCellCount)
        context.addIssue({
          code: 'custom',
          path: [
            'experiment',
            'currentTerritory',
            index,
            'controlledCellCount',
          ],
          message: 'Current territory must match authoritative world control.',
        });
    }
  });
export type SimulationSnapshot = z.infer<typeof simulationSnapshotSchema>;

export const singleTickResponseSchema = z
  .object({
    snapshot: simulationSnapshotSchema,
    tickNumber: z.number().int().positive(),
    swarmTick: swarmTickRecordSchema.nullable(),
  })
  .superRefine((response, context) => {
    const consistent =
      response.snapshot.tickNumber === response.tickNumber &&
      (response.swarmTick === null ||
        (response.swarmTick.tickNumber === response.tickNumber &&
          response.snapshot.virtualTime === response.swarmTick.virtualTime &&
          response.snapshot.lastTickIntervalMinutes ===
            response.swarmTick.tickIntervalMinutes));
    if (!consistent)
      context.addIssue({
        code: 'custom',
        message: 'Swarm tick telemetry must match the committed snapshot.',
      });
  });
export type SingleTickResponse = z.infer<typeof singleTickResponseSchema>;

export const cancelledTickResponseSchema = z.object({
  snapshot: simulationSnapshotSchema,
  cancelled: z.literal(true),
});
export type CancelledTickResponse = z.infer<typeof cancelledTickResponseSchema>;

export const resetSimulationResponseSchema = z.object({
  snapshot: simulationSnapshotSchema,
});
export type ResetSimulationResponse = z.infer<
  typeof resetSimulationResponseSchema
>;
export const cancelSimulationResponseSchema = z.object({
  snapshot: simulationSnapshotSchema,
});

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  checkedAt: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorCodeSchema = z.enum([
  'turn_conflict',
  'tick_conflict',
  'experiment_budget_exhausted',
  'reset_conflict',
  'invalid_agent_id',
  'unknown_agent',
  'invalid_request',
  'invalid_export',
  'invalid_artifact',
  'artifact_changed',
  'archive_rejected',
  'archive_persistence_failed',
  'export_conflict',
  'records_unavailable',
  'model_configuration_conflict',
  'invalid_model_configuration',
  'models_unavailable',
  'model_verification_conflict',
  'cancel_conflict',
  'not_found',
  'internal_error',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string().min(1).max(300),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const experimentIdSchema = z.uuid().brand<'ExperimentId'>();
export type ExperimentId = z.infer<typeof experimentIdSchema>;

export const modelConfigurationEventSchema = z
  .object({
    type: z.literal('model-assignment-changed'),
    timestamp: z.iso.datetime(),
    scope: z.enum(['global', 'agent']),
    agentId: agentIdSchema.optional(),
    previousModelId: modelIdSchema.nullable(),
    newModelId: modelIdSchema.nullable(),
    previousReasoningProfile:
      reasoningProfileSchema.default('provider-default'),
    newReasoningProfile: reasoningProfileSchema.default('provider-default'),
    effectiveTurn: z.number().int().positive(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.scope === 'agent' && event.agentId === undefined)
      context.addIssue({
        code: 'custom',
        path: ['agentId'],
        message: 'Agent-scoped model changes require an agent ID.',
      });
    if (event.scope === 'global' && event.agentId !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['agentId'],
        message: 'Global model changes must not include an agent ID.',
      });
  });
export type ModelConfigurationEvent = z.infer<
  typeof modelConfigurationEventSchema
>;
export const experimentConfigurationEventSchema = modelConfigurationEventSchema;
export type ExperimentConfigurationEvent = z.infer<
  typeof experimentConfigurationEventSchema
>;

export const experimentManifestSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      return input;
    const manifest = input as Record<string, unknown>;
    const resolvedVersion = SWARM_PLANNER_CONTRACT_VERSION;
    const scenario = manifest.scenario;
    const historicalDecisionContractVersion =
      manifest.historicalDecisionContractVersion ??
      manifest.decisionContractVersion;
    const archivedScenarioRecord =
      typeof scenario === 'object' &&
      scenario !== null &&
      !Array.isArray(scenario)
        ? (scenario as Record<string, unknown>)
        : null;
    const archivedScenario =
      archivedScenarioRecord !== null
        ? {
            ...archivedScenarioRecord,
            historicalDecisionContractVersion:
              archivedScenarioRecord.historicalDecisionContractVersion ??
              historicalDecisionContractVersion,
            swarmPlannerContractVersion:
              archivedScenarioRecord.swarmPlannerContractVersion ??
              resolvedVersion,
          }
        : scenario;
    return {
      ...manifest,
      historicalDecisionContractVersion,
      swarmPlannerContractVersion:
        manifest.swarmPlannerContractVersion ?? resolvedVersion,
      ...(archivedScenario === undefined ? {} : { scenario: archivedScenario }),
    };
  },
  z
    .object({
      id: experimentIdSchema,
      startedAt: z.iso.datetime(),
      generatedAt: z.iso.datetime().optional(),
      providerMode: providerModeSchema,
      historicalDecisionContractVersion: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .optional(),
      swarmPlannerContractVersion: swarmPlannerContractVersionSchema,
      modelConfiguration: experimentModelConfigurationSchema.optional(),
      scenario: archivedAppliedScenarioSchema.optional(),
      initialAgents: z
        .array(agentProfileSchema)
        .min(WORLD_SCENARIO_LIMITS.minimumAgents)
        .max(WORLD_SCENARIO_LIMITS.maximumAgents)
        .optional(),
    })
    .superRefine((manifest, context) => {
      if (
        manifest.scenario !== undefined &&
        manifest.scenario.swarmPlannerContractVersion !==
          manifest.swarmPlannerContractVersion
      )
        context.addIssue({
          code: 'custom',
          path: ['scenario', 'swarmPlannerContractVersion'],
          message:
            'Scenario decision-contract attribution must match the experiment manifest.',
        });
    }),
);
export type ExperimentManifest = z.infer<typeof experimentManifestSchema>;

export const experimentRetentionSchema = z.object({
  limit: z.number().int().positive(),
  totalCompletedTurns: z.number().int().nonnegative(),
  retainedTurns: z.number().int().nonnegative(),
  firstRetainedTurn: z.number().int().positive().optional(),
  lastRetainedTurn: z.number().int().positive().optional(),
  droppedRecords: z.number().int().nonnegative(),
  complete: z.boolean(),
  requestedRangeExtendsBeyondRetention: z.boolean(),
});
export type ExperimentRetention = z.infer<typeof experimentRetentionSchema>;

export const tokenTotalsSchema = z.object({
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
});

export const metricCountsSchema = z
  .object({
    totalTurns: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    providerErrors: z.number().int().nonnegative(),
    lostTicks: z.number().int().nonnegative().default(0),
    operatorSkipped: z.number().int().nonnegative().default(0),
    modelCalls: z.number().int().nonnegative().default(0),
    failedModelAttempts: z.number().int().nonnegative().default(0),
    automaticRepairAttempts: z.number().int().nonnegative().default(0),
    automaticTransportRetries: z.number().int().nonnegative().default(0),
    manualRetryAttempts: z.number().int().nonnegative().default(0),
    unattendedRetryAttempts: z.number().int().nonnegative().default(0),
    manualSkips: z.number().int().nonnegative().default(0),
    unattendedSkips: z.number().int().nonnegative().default(0),
    recoveredByUnattendedRetry: z.number().int().nonnegative().default(0),
    skippedAfterUnattendedRecovery: z.number().int().nonnegative().default(0),
    retriedTurns: z.number().int().nonnegative().default(0),
    recoveredAutomatically: z.number().int().nonnegative().default(0),
    recoveredManually: z.number().int().nonnegative().default(0),
    recoveredByRetry: z.number().int().nonnegative().default(0),
    requestedMoves: z.number().int().nonnegative(),
    requestedInfections: z.number().int().nonnegative(),
    requestedCaptures: z.number().int().nonnegative(),
    requestedWaits: z.number().int().nonnegative(),
    acceptedMovements: z.number().int().nonnegative(),
    successfullyInfectedCells: z.number().int().nonnegative(),
    successfulCaptures: z.number().int().nonnegative(),
    acceptedWaits: z.number().int().nonnegative().default(0),
    rejectedWorldActions: z.number().int().nonnegative().default(0),
    territoryGainedThroughInfection: z.number().int().nonnegative(),
    territoryGainedThroughCapture: z.number().int().nonnegative(),
    territoryLostThroughCapture: z.number().int().nonnegative(),
    movementDirectionDistribution: z
      .array(
        z.object({
          direction: z.enum(['N', 'NE', 'SE', 'S', 'SW', 'NW']),
          count: z.number().int().positive(),
        }),
      )
      .max(6)
      .default([]),
    longestRepeatedDirectionStreak: z.number().int().nonnegative().default(0),
    recentCellRevisits: z.number().int().nonnegative().default(0),
    uniqueVisitedCells: z.number().int().nonnegative(),
    averageLatencyMs: z.number().nonnegative().optional(),
    tokens: tokenTotalsSchema,
    tokenUsageComplete: z.boolean().default(true),
    attemptsWithUnknownTokenUsage: z.number().int().nonnegative().default(0),
    knownCostCredits: z.number().nonnegative().finite(),
    attemptsWithUnknownCost: z.number().int().nonnegative().default(0),
  })
  .superRefine((metrics, context) => {
    if (
      metrics.totalTurns !==
      metrics.accepted +
        metrics.rejected +
        metrics.providerErrors +
        metrics.lostTicks +
        metrics.operatorSkipped
    )
      context.addIssue({
        code: 'custom',
        message: 'Logical turn outcome totals do not reconcile.',
      });
  });
export type MetricCounts = z.infer<typeof metricCountsSchema>;

export const experimentMetricsSchema = z.object({
  aggregate: metricCountsSchema,
  byAgent: z.array(
    z.object({ agentId: agentIdSchema, metrics: metricCountsSchema }),
  ),
});
export type ExperimentMetrics = z.infer<typeof experimentMetricsSchema>;

export const exportOutcomeSchema = z.enum([
  'accepted',
  'rejected',
  'provider-error',
  'operator-skipped',
  'lost-tick',
]);
export const exportActionSchema = z.enum(['move', 'infect', 'capture', 'wait']);
export const exportLevelSchema = z.enum([
  'minimal',
  'standard',
  'full-safe',
  'custom',
]);
export const exportSerializationSchema = z.enum(['compact', 'pretty']);

export const customExportOptionsSchema = z
  .object({
    turnObservations: z.boolean(),
    nearbyAgents: z.boolean(),
    recentEvents: z.boolean(),
    recentControlChanges: z.boolean(),
    validationDetails: z.boolean(),
    resultingEvents: z.boolean(),
    providerUsageMetadata: z.boolean(),
    initialWorldState: z.boolean(),
    currentWorldState: z.boolean(),
    computedMetrics: z.boolean(),
    controlChanges: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !value.turnObservations &&
      (value.nearbyAgents || value.recentEvents || value.recentControlChanges)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Nearby agents, recent events, and recent control changes require turn observations.',
      });
    }
  });
export type CustomExportOptions = z.infer<typeof customExportOptionsSchema>;

const exportSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  z
    .object({
      mode: z.literal('selected'),
      agentIds: z
        .array(agentIdSchema)
        .min(1)
        .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    })
    .strict()
    .refine((value) => new Set(value.agentIds).size === value.agentIds.length, {
      message: 'Agent IDs must be unique.',
    }),
]);

const exportTurnSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('entire-retained') }).strict(),
  z
    .object({
      mode: z.literal('latest'),
      count: z.union([
        z.literal(10),
        z.literal(25),
        z.literal(50),
        z.literal(120),
      ]),
    })
    .strict(),
  z
    .object({
      mode: z.literal('range'),
      fromTurn: z.number().int().positive(),
      toTurn: z.number().int().positive(),
    })
    .strict()
    .refine((value) => value.fromTurn <= value.toTurn, {
      message: 'The first turn must not exceed the last turn.',
    }),
]);

export const experimentExportRequestSchema = z
  .object({
    agents: exportSelectionSchema,
    turns: exportTurnSelectionSchema,
    outcomes: z.array(exportOutcomeSchema).min(1).max(5),
    actions: z.array(exportActionSchema).min(1).max(4),
    level: exportLevelSchema,
    serialization: exportSerializationSchema.default('compact'),
    custom: customExportOptionsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.outcomes).size !== value.outcomes.length)
      context.addIssue({ code: 'custom', message: 'Outcomes must be unique.' });
    if (new Set(value.actions).size !== value.actions.length)
      context.addIssue({ code: 'custom', message: 'Actions must be unique.' });
    if (value.level === 'custom' && !value.custom)
      context.addIssue({
        code: 'custom',
        message: 'Custom options are required.',
      });
    if (value.level !== 'custom' && value.custom)
      context.addIssue({
        code: 'custom',
        message: 'Custom options are only valid for Custom exports.',
      });
  });
export type ExperimentExportRequest = z.infer<
  typeof experimentExportRequestSchema
>;

export const experimentExportPreviewSchema = z.object({
  experimentId: experimentIdSchema,
  matchingTickCount: z.number().int().nonnegative().optional(),
  matchingSwarmTickCount: z.number().int().nonnegative().optional(),
  matchingControlChangeCount: z.number().int().nonnegative(),
  matchingProviderAttemptCount: z.number().int().nonnegative().default(0),
  selectedAgentCount: z
    .number()
    .int()
    .positive()
    .max(WORLD_SCENARIO_LIMITS.maximumAgents),
  retention: experimentRetentionSchema,
  knownCostCredits: z.number().nonnegative().finite(),
  attemptsWithUnknownCost: z.number().int().nonnegative().default(0),
  serializedUtf8Bytes: z.number().int().nonnegative(),
  approximateAiInputTokens: z.number().int().nonnegative(),
  tokenEstimateMethod: z.literal('ceil(UTF-8 bytes / 4)'),
});
export type ExperimentExportPreview = z.infer<
  typeof experimentExportPreviewSchema
>;

export const experimentTickSummarySchema = z.object({
  tickNumber: z.number().int().positive(),
  virtualTime: z.iso.datetime(),
  intervalMinutes: z.number().int().positive(),
  agentRecordCount: z.number().int().positive(),
  lostTicks: z.number().int().nonnegative(),
  deadlineMisses: z.number().int().nonnegative(),
  providerCallCount: z.number().int().nonnegative(),
  aggregateDecisionLatencyMs: z.number().int().nonnegative(),
  maximumDecisionLatencyMs: z.number().int().nonnegative(),
  knownCostCredits: z.number().finite().nonnegative(),
  attemptsWithUnknownCost: z.number().int().nonnegative(),
});
export type ExperimentTickSummary = z.infer<typeof experimentTickSummarySchema>;

export const experimentExportWorldStateSchema = worldSnapshotObjectSchema
  .omit({ events: true })
  .superRefine(validateWorldControllers);

export const exportedControlChangeSchema = hexCapturedWorldEventSchema.extend({
  originatingTurn: z.number().int().positive(),
});
export type ExportedControlChange = z.infer<typeof exportedControlChangeSchema>;
export type ExperimentExportWorldState = z.infer<
  typeof experimentExportWorldStateSchema
>;

const experimentExportDocumentObjectSchema = z
  .object({
    schemaVersion: z.union([z.literal(9), z.literal(10), z.literal(11)]),
    generatedAt: z.iso.datetime(),
    experiment: experimentManifestSchema,
    retention: experimentRetentionSchema,
    filters: experimentExportRequestSchema,
    selection: z.object({
      selectedAgentIds: z
        .array(agentIdSchema)
        .min(1)
        .max(WORLD_SCENARIO_LIMITS.maximumAgents),
      matchingTickCount: z.number().int().nonnegative().optional(),
      matchingSwarmTickCount: z.number().int().nonnegative().optional(),
      matchingControlChangeCount: z.number().int().nonnegative(),
      matchingProviderAttemptCount: z.number().int().nonnegative().optional(),
      matchingSimulatedPlayerEventCount: z
        .number()
        .int()
        .nonnegative()
        .default(0),
    }),
    agents: z
      .array(agentProfileSchema)
      .min(1)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    configurationEvents: z.array(experimentConfigurationEventSchema).optional(),
    metrics: experimentMetricsSchema.optional(),
    currentTerritory: territoryScoreboardSchema.optional(),
    initialWorld: experimentExportWorldStateSchema.optional(),
    currentWorld: experimentExportWorldStateSchema.optional(),
    worldEvents: z.array(safeExperimentWorldEventSchema).optional(),
    simulatedPlayerMetrics: simulatedPlayerMetricsSchema.optional(),
    controlChanges: z.array(exportedControlChangeSchema).optional(),
    tickSummaries: z.array(experimentTickSummarySchema).optional(),
    swarmTicks: z.array(swarmTickRecordSchema).optional(),
    providerAttempts: z.array(providerAttemptRecordSchema).optional(),
    attemptRetention: providerAttemptRetentionSchema.optional(),
    attemptAccounting: experimentAttemptAccountingSchema.optional(),
  })
  .superRefine((document, context) => {
    if (document.swarmTicks !== undefined) {
      if (
        document.experiment.scenario?.swarmArchitectureVersion !==
        'zero-swarm-v1'
      )
        context.addIssue({
          code: 'custom',
          path: ['swarmTicks'],
          message:
            'Swarm tick telemetry requires zero-swarm-v1 cognition mode.',
        });
      const tickNumbers = document.swarmTicks.map(
        ({ tickNumber }) => tickNumber,
      );
      if (new Set(tickNumbers).size !== tickNumbers.length)
        context.addIssue({
          code: 'custom',
          path: ['swarmTicks'],
          message: 'Exported swarm tick numbers must be unique.',
        });
      if (
        document.selection.matchingSwarmTickCount !== document.swarmTicks.length
      )
        context.addIssue({
          code: 'custom',
          path: ['selection', 'matchingSwarmTickCount'],
          message: 'Swarm tick count must match exported swarm telemetry.',
        });
      if (
        document.selection.matchingTickCount !== undefined &&
        document.selection.matchingTickCount !== document.swarmTicks.length
      )
        context.addIssue({
          code: 'custom',
          path: ['selection', 'matchingTickCount'],
          message: 'Zero-swarm tick count must match exported swarm telemetry.',
        });
    }
    if (document.schemaVersion === 9 && document.tickSummaries !== undefined)
      context.addIssue({
        code: 'custom',
        message: 'Schema-v9 exports cannot contain tick summaries.',
      });
    if (document.schemaVersion === 11) {
      if (
        document.providerAttempts === undefined ||
        document.attemptRetention === undefined ||
        document.attemptAccounting === undefined ||
        document.selection.matchingProviderAttemptCount === undefined
      )
        context.addIssue({
          code: 'custom',
          message: 'Schema-v11 exports require independent attempt accounting.',
        });
      const attempts = document.providerAttempts ?? [];
      const selectedIds = new Set(document.selection.selectedAgentIds);
      const exportedIds = new Set(document.agents.map(({ id }) => id));
      if (new Set(attempts.map(({ id }) => id)).size !== attempts.length)
        context.addIssue({
          code: 'custom',
          path: ['providerAttempts'],
          message: 'Provider-attempt IDs must be unique.',
        });
      if (
        attempts.some(
          ({ agentId }) =>
            !selectedIds.has(agentId) || !exportedIds.has(agentId),
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['providerAttempts'],
          message: 'Provider attempts must belong to selected exported agents.',
        });
      if (document.selection.matchingProviderAttemptCount !== attempts.length)
        context.addIssue({
          code: 'custom',
          path: ['selection', 'matchingProviderAttemptCount'],
          message: 'Provider-attempt selection count must match the export.',
        });
      const retention = document.attemptRetention;
      const accounting = document.attemptAccounting;
      if (
        retention &&
        (retention.totalStartedAttempts !==
          retention.retainedAttempts + retention.droppedRecords ||
          retention.retainedAttempts > retention.limit ||
          retention.complete !== (retention.droppedRecords === 0))
      )
        context.addIssue({
          code: 'custom',
          path: ['attemptRetention'],
          message: 'Provider-attempt retention totals must be consistent.',
        });
      if (
        retention &&
        accounting &&
        retention.totalStartedAttempts !== accounting.attemptsStarted
      )
        context.addIssue({
          code: 'custom',
          path: ['attemptRetention', 'totalStartedAttempts'],
          message: 'Attempt retention and accounting totals must agree.',
        });
    } else if (
      document.providerAttempts !== undefined ||
      document.attemptRetention !== undefined ||
      document.attemptAccounting !== undefined
    )
      context.addIssue({
        code: 'custom',
        message: 'Legacy exports cannot claim schema-v11 attempt accounting.',
      });
    const level = document.filters.level;
    const custom = level === 'custom' ? document.filters.custom : undefined;
    const requiresMetrics = level !== 'custom' || custom?.computedMetrics;
    if (Boolean(document.metrics) !== Boolean(requiresMetrics))
      context.addIssue({
        code: 'custom',
        message: 'Metrics inclusion does not match the export level.',
      });
    if (Boolean(document.currentTerritory) !== Boolean(requiresMetrics))
      context.addIssue({
        code: 'custom',
        message: 'Current territory inclusion does not match the export level.',
      });
    if (Boolean(document.simulatedPlayerMetrics) !== Boolean(requiresMetrics))
      context.addIssue({
        code: 'custom',
        message:
          'Simulated-player metrics inclusion does not match the export level.',
      });
    const initialWorld = level === 'full-safe' || custom?.initialWorldState;
    const currentWorld = level === 'full-safe' || custom?.currentWorldState;
    if (
      Boolean(document.initialWorld) !== Boolean(initialWorld) ||
      Boolean(document.currentWorld) !== Boolean(currentWorld)
    )
      context.addIssue({
        code: 'custom',
        message: 'World-state inclusion does not match the export level.',
      });
    if (Boolean(document.worldEvents) !== (level === 'full-safe'))
      context.addIssue({
        code: 'custom',
        message: 'World event inclusion does not match the export level.',
      });
    const controlChanges = level !== 'custom' || custom?.controlChanges;
    if (Boolean(document.controlChanges) !== Boolean(controlChanges))
      context.addIssue({
        code: 'custom',
        message: 'Control-change inclusion does not match the export level.',
      });
  });
export const experimentExportDocumentSchema = z.preprocess((input) => {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return input;
  const document = input as Record<string, unknown>;
  const experiment =
    typeof document.experiment === 'object' && document.experiment !== null
      ? (document.experiment as Record<string, unknown>)
      : undefined;
  const scenario =
    typeof experiment?.scenario === 'object' && experiment.scenario !== null
      ? (experiment.scenario as Record<string, unknown>)
      : undefined;
  const simulatedPlayer =
    typeof scenario?.simulatedPlayer === 'object' &&
    scenario.simulatedPlayer !== null
      ? (scenario.simulatedPlayer as Record<string, unknown>)
      : undefined;
  const capabilities =
    typeof scenario?.capabilities === 'object' && scenario.capabilities !== null
      ? (scenario.capabilities as Record<string, unknown>)
      : undefined;
  const playerPressureEnabled =
    simulatedPlayer?.enabled === true ||
    capabilities?.simulatedPlayerPressure === true;
  if (
    (document.schemaVersion === 9 || document.schemaVersion === 10) &&
    !playerPressureEnabled &&
    document.metrics !== undefined &&
    document.simulatedPlayerMetrics === undefined
  )
    return {
      ...document,
      simulatedPlayerMetrics: {
        movements: 0,
        cellsDisinfected: 0,
        blockedDisinfections: 0,
      },
    };
  return input;
}, experimentExportDocumentObjectSchema);
export type ExperimentExportDocument = z.infer<
  typeof experimentExportDocumentSchema
>;

export const experimentExportResponseSchema = z.object({
  document: experimentExportDocumentSchema,
});
const generatedExperimentExportArchiveRequestSchema = z
  .object({ document: experimentExportDocumentSchema })
  .strict();
const compactExperimentExportArchiveRequestSchema = z
  .object({
    request: experimentExportRequestSchema,
    generatedAt: z.iso.datetime(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const archiveExperimentExportRequestSchema = z.union([
  generatedExperimentExportArchiveRequestSchema,
  compactExperimentExportArchiveRequestSchema,
]);
export const archiveExperimentExportResponseSchema = z
  .object({
    experimentId: experimentIdSchema,
    inserted: z.number().int().min(0).max(1_000_000),
    existing: z.number().int().min(0).max(1_000_000),
    skipped: z.number().int().min(0).max(1_000_000),
    rejected: z.number().int().min(0).max(1_000_000),
    idempotent: z.boolean(),
  })
  .strict();
export type ArchiveExperimentExportRequest = z.infer<
  typeof archiveExperimentExportRequestSchema
>;
export type ArchiveExperimentExportResponse = z.infer<
  typeof archiveExperimentExportResponseSchema
>;
