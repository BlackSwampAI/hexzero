import { z } from 'zod';
export * from './behavior';
export * from './limits';
import {
  PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS,
  WORLD_SCENARIO_LIMITS,
} from './limits';
import {
  assignBehavior,
  behaviorAssignmentSchema,
  behaviorConfigurationSchema,
  personalityProfileIdSchema,
  strategyProfileIdSchema,
} from './behavior';

export const MODEL_SUMMARY_MAX_LENGTH = 240;
export const GOAL_TEXT_MAX_LENGTH = 160;
export const GOAL_REVISION_REASON_MAX_LENGTH = 160;
export const MEMORY_TEXT_MAX_LENGTH = 160;
export const MEMORY_ENTRY_LIMIT = 8;
export const MESSAGE_MAX_LENGTH = 280;
/** Legacy H3-ring range retained only for schema-v5-v9 import compatibility. */
export const MESSAGE_RANGE = 3;
export const DEFAULT_COMMUNICATION_RANGE_KM = 12;
export const DEFAULT_MINIMUM_TICK_INTERVAL_MINUTES = 5;
export const DEFAULT_MAXIMUM_TICK_INTERVAL_MINUTES = 10;
export const NEUTRAL_AGENT_COLOR = '#b2d3a8';
export const RECENT_PUBLIC_MESSAGE_LIMIT = 12;
export const RECENT_DIRECT_MESSAGE_LIMIT = 6;
export const RECENT_CONTROL_CHANGE_LIMIT = 6;
export const RECENT_ALLIANCE_EVENT_LIMIT = 8;
export const RECENT_ZERO_MESSAGE_LIMIT = 6;
export const RECENT_ZERO_STRATEGIC_EVENT_LIMIT = 12;
export const PERSONALITY_MAX_LENGTH = 600;
export const PROVIDER_ERROR_MAX_LENGTH = 240;
export const OPENROUTER_MODEL_CONTEXT_MINIMUM = 16_384;
export const OPENROUTER_MAX_OUTPUT_TOKENS = 4_096;
export const OPENROUTER_PROVIDER_TIMEOUT_MS = 75_000;
export const OPENROUTER_429_FALLBACK_BACKOFF_MS = 1_500;
export const LEGACY_AGENT_DECISION_CONTRACT_VERSION = 'text-flat-json-v3';
export const PREVIOUS_AGENT_DECISION_CONTRACT_VERSION = 'text-flat-json-v4';
export const FLUID_ALLIANCE_AGENT_DECISION_CONTRACT_VERSION =
  'text-flat-json-v5';
export const PATIENT_ZERO_AGENT_DECISION_CONTRACT_VERSION = 'text-flat-json-v6';
export const GOAL_AGENT_DECISION_CONTRACT_VERSION = 'text-flat-json-v7';
export const AGENT_DECISION_CONTRACT_VERSION = 'text-flat-json-v8';
export const agentDecisionContractVersionSchema = z.enum([
  LEGACY_AGENT_DECISION_CONTRACT_VERSION,
  PREVIOUS_AGENT_DECISION_CONTRACT_VERSION,
  FLUID_ALLIANCE_AGENT_DECISION_CONTRACT_VERSION,
  PATIENT_ZERO_AGENT_DECISION_CONTRACT_VERSION,
  GOAL_AGENT_DECISION_CONTRACT_VERSION,
  AGENT_DECISION_CONTRACT_VERSION,
]);
export const OBJECTIVE_PROMPT_VERSION = 'durable-influence-v2';
export const OPENROUTER_REQUIRED_PARAMETERS = ['max_tokens'] as const;
export const DEVELOPMENT_WORLD_CONFIG = {
  latitude: 41.6528,
  longitude: -83.5379,
  resolution: 9,
  radius: 6,
  cellCount: 127,
  agentCount: 8,
} as const;
export const ALLIANCE_COLOR_PALETTE = [
  '#0072B2',
  '#D55E00',
  '#009E73',
  '#CC79A7',
] as const;

export const agentIdSchema = z.uuid().brand<'AgentId'>();
export type AgentId = z.infer<typeof agentIdSchema>;

export const eventIdSchema = z.uuid().brand<'EventId'>();
export type EventId = z.infer<typeof eventIdSchema>;

export const allianceIdSchema = z.uuid().brand<'AllianceId'>();
export type AllianceId = z.infer<typeof allianceIdSchema>;
export const allianceProposalIdSchema = z.uuid().brand<'AllianceProposalId'>();
export type AllianceProposalId = z.infer<typeof allianceProposalIdSchema>;
export const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

export const h3CellSchema = z
  .string()
  .regex(/^[0-9a-f]{15}$/i, 'Expected an H3 cell index')
  .brand<'H3Cell'>();
export type H3Cell = z.infer<typeof h3CellSchema>;

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
    controllerAgentId: agentIdSchema,
  }),
]);
export type Hex = z.infer<typeof hexSchema>;

export const personalitySchema = z
  .string()
  .trim()
  .min(1, 'Personality must not be empty.')
  .max(PERSONALITY_MAX_LENGTH);

export const agentProfileSchema = z.object({
  id: agentIdSchema,
  name: z.string().trim().min(1).max(80),
  color: colorSchema,
  personality: personalitySchema,
  currentCell: h3CellSchema,
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const agentSchema = agentProfileSchema;
export type Agent = z.infer<typeof agentSchema>;

const goalTextSchema = z.string().trim().min(1).max(GOAL_TEXT_MAX_LENGTH);
const goalRevisionReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(GOAL_REVISION_REASON_MAX_LENGTH);
export const agentGoalStateSchema = z
  .object({
    longTermGoal: goalTextSchema,
    shortTermGoal: goalTextSchema,
    planSummary: goalTextSchema,
    establishedAtTick: z.number().int().positive(),
    revisedAtTick: z.number().int().positive(),
  })
  .strict()
  .refine((goal) => goal.revisedAtTick >= goal.establishedAtTick, {
    message: 'Goal revision tick cannot precede establishment.',
  });
export type AgentGoalState = z.infer<typeof agentGoalStateSchema>;

const suppliedGoalFields = {
  longTermGoal: goalTextSchema,
  shortTermGoal: goalTextSchema,
  planSummary: goalTextSchema,
};
export const requestedGoalRevisionSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('establish'),
      ...suppliedGoalFields,
      reason: goalRevisionReasonSchema,
    })
    .strict(),
  z.object({ operation: z.literal('keep') }).strict(),
  z
    .object({
      operation: z.literal('revise'),
      ...suppliedGoalFields,
      reason: goalRevisionReasonSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('complete'),
      reason: goalRevisionReasonSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('abandon'),
      reason: goalRevisionReasonSchema,
    })
    .strict(),
]);
export type RequestedGoalRevision = z.infer<typeof requestedGoalRevisionSchema>;
export const goalRevisionOperationSchema = z.enum([
  'establish',
  'keep',
  'revise',
  'complete',
  'abandon',
]);
export const goalRevisionRejectionCodeSchema = z.enum([
  'goal-already-active',
  'goal-not-active',
]);
export const goalRevisionResultSchema = z.union([
  z.object({ requested: z.literal(false) }).strict(),
  z
    .object({
      requested: z.literal(true),
      accepted: z.literal(true),
      operation: goalRevisionOperationSchema,
    })
    .strict(),
  z
    .object({
      requested: z.literal(true),
      accepted: z.literal(false),
      operation: goalRevisionOperationSchema,
      reason: goalRevisionRejectionCodeSchema,
    })
    .strict(),
]);
export type GoalRevisionResult = z.infer<typeof goalRevisionResultSchema>;

export const memoryIdSchema = z
  .string()
  .regex(/^memory:[0-9a-fA-F-]{36}:[1-9]\d*$/)
  .superRefine((value, context) => {
    const finalSeparator = value.lastIndexOf(':');
    const embeddedAgentId = value.slice('memory:'.length, finalSeparator);
    if (!agentIdSchema.safeParse(embeddedAgentId).success)
      context.addIssue({
        code: 'custom',
        message: 'Memory ID must embed a valid agent ID.',
      });
  })
  .brand<'MemoryId'>();
export type MemoryId = z.infer<typeof memoryIdSchema>;
export function createMemoryId(agentId: AgentId, tick: number): MemoryId {
  return memoryIdSchema.parse(`memory:${agentId}:${tick}`);
}

function memoryIdParts(id: MemoryId) {
  const finalSeparator = id.lastIndexOf(':');
  return {
    agentId: id.slice('memory:'.length, finalSeparator),
    tick: Number(id.slice(finalSeparator + 1)),
  };
}
export const memoryEntrySchema = z
  .object({
    id: memoryIdSchema,
    text: z.string().trim().min(1).max(MEMORY_TEXT_MAX_LENGTH),
    createdAtTick: z.number().int().positive(),
    revisedAtTick: z.number().int().positive(),
  })
  .strict()
  .refine((entry) => entry.revisedAtTick >= entry.createdAtTick, {
    message: 'Memory revision tick cannot precede creation.',
  });
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export const memoryLedgerSchema = z
  .array(memoryEntrySchema)
  .max(MEMORY_ENTRY_LIMIT)
  .superRefine((entries, context) => {
    if (new Set(entries.map(({ id }) => id)).size !== entries.length)
      context.addIssue({
        code: 'custom',
        message: 'Memory IDs must be unique.',
      });
    entries.forEach((entry, index) => {
      if (memoryIdParts(entry.id).tick !== entry.createdAtTick)
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Memory ID tick must match its creation tick.',
        });
      if (index > 0 && entries[index - 1]!.createdAtTick >= entry.createdAtTick)
        context.addIssue({
          code: 'custom',
          path: [index, 'createdAtTick'],
          message: 'Memory entries must be in strict creation order.',
        });
    });
  });
export function memoryLedgerForAgentSchema(agentId: AgentId) {
  return memoryLedgerSchema.superRefine((entries, context) => {
    entries.forEach((entry, index) => {
      if (memoryIdParts(entry.id).agentId !== agentId)
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Memory ID must belong to the owning agent.',
        });
    });
  });
}
export const memoryOperationSchema = z.enum([
  'keep',
  'remember',
  'revise',
  'forget',
]);
export const requestedMemoryOperationSchema = z.discriminatedUnion(
  'operation',
  [
    z.object({ operation: z.literal('keep') }).strict(),
    z
      .object({
        operation: z.literal('remember'),
        text: z.string().trim().min(1).max(MEMORY_TEXT_MAX_LENGTH),
      })
      .strict(),
    z
      .object({
        operation: z.literal('revise'),
        memoryId: memoryIdSchema,
        text: z.string().trim().min(1).max(MEMORY_TEXT_MAX_LENGTH),
      })
      .strict(),
    z
      .object({ operation: z.literal('forget'), memoryId: memoryIdSchema })
      .strict(),
  ],
);
export type RequestedMemoryOperation = z.infer<
  typeof requestedMemoryOperationSchema
>;
export const memoryOperationResultSchema = z.union([
  z.object({ requested: z.literal(false) }).strict(),
  z
    .object({
      requested: z.literal(true),
      accepted: z.literal(true),
      operation: z.literal('keep'),
    })
    .strict(),
  z
    .object({
      requested: z.literal(true),
      accepted: z.literal(true),
      operation: z.literal('remember'),
      memoryId: memoryIdSchema,
    })
    .strict(),
  z
    .object({
      requested: z.literal(true),
      accepted: z.literal(true),
      operation: z.literal('revise'),
      memoryId: memoryIdSchema,
    })
    .strict(),
  z
    .object({
      requested: z.literal(true),
      accepted: z.literal(true),
      operation: z.literal('forget'),
      memoryId: memoryIdSchema,
    })
    .strict(),
  z
    .object({
      requested: z.literal(true),
      accepted: z.literal(false),
      operation: z.literal('remember'),
      reason: z.literal('memory-full'),
    })
    .strict(),
  z
    .object({
      requested: z.literal(true),
      accepted: z.literal(false),
      operation: z.enum(['revise', 'forget']),
      reason: z.literal('memory-not-found'),
    })
    .strict(),
]);
export type MemoryOperationResult = z.infer<typeof memoryOperationResultSchema>;

export const moveActionSchema = z.object({
  type: z.literal('move'),
  targetCell: h3CellSchema,
});
export const infectActionSchema = z.object({ type: z.literal('infect') });
export const captureActionSchema = z
  .object({ type: z.literal('capture') })
  .strict();
export const messageContentSchema = z
  .string()
  .trim()
  .min(1)
  .max(MESSAGE_MAX_LENGTH);
export const publicCommunicationSchema = z
  .object({
    channel: z.literal('public'),
    message: messageContentSchema,
  })
  .strict();
export const directCommunicationSchema = z
  .object({
    channel: z.literal('direct'),
    recipientId: agentIdSchema,
    message: messageContentSchema,
  })
  .strict();
export const allianceCommunicationSchema = z
  .object({
    channel: z.literal('alliance'),
    message: messageContentSchema,
  })
  .strict();
export const zeroCommunicationSchema = z
  .object({
    channel: z.literal('zero'),
    message: messageContentSchema,
  })
  .strict();
export const communicationIntentSchema = z.discriminatedUnion('channel', [
  publicCommunicationSchema,
  directCommunicationSchema,
  allianceCommunicationSchema,
  zeroCommunicationSchema,
]);
export type CommunicationIntent = z.infer<typeof communicationIntentSchema>;

export const diplomacyIntentSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('propose-alliance'), recipientId: agentIdSchema })
    .strict(),
  z
    .object({
      type: z.literal('accept-alliance'),
      proposalId: allianceProposalIdSchema,
    })
    .strict(),
  z.object({ type: z.literal('leave-alliance') }).strict(),
]);
export type DiplomacyIntent = z.infer<typeof diplomacyIntentSchema>;

export const allianceSchema = z.object({
  id: allianceIdSchema,
  color: z.enum(ALLIANCE_COLOR_PALETTE),
  memberAgentIds: z
    .array(agentIdSchema)
    .min(2)
    .max(WORLD_SCENARIO_LIMITS.maximumAgents)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'Alliance members must be unique.',
    }),
});
export type Alliance = z.infer<typeof allianceSchema>;

export const allianceProposalSchema = z
  .object({
    id: allianceProposalIdSchema,
    proposerAgentId: agentIdSchema,
    recipientAgentId: agentIdSchema,
    proposerAllianceId: allianceIdSchema.nullable(),
    recipientAllianceId: allianceIdSchema.nullable().default(null),
    originatingTurn: z.number().int().positive(),
    expirationTurn: z.number().int().positive(),
    originatingTick: z.number().int().positive().optional(),
    expirationTick: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (proposal) => proposal.proposerAgentId !== proposal.recipientAgentId,
    {
      message: 'Alliance proposal participants must be distinct.',
    },
  )
  .superRefine((proposal, context) => {
    const hasOriginatingTick = proposal.originatingTick !== undefined;
    const hasExpirationTick = proposal.expirationTick !== undefined;
    if (hasOriginatingTick !== hasExpirationTick)
      context.addIssue({
        code: 'custom',
        message: 'Tick proposal attribution must be present together.',
      });
    else if (
      hasOriginatingTick &&
      proposal.expirationTick !== proposal.originatingTick! + 2
    )
      context.addIssue({
        code: 'custom',
        path: ['expirationTick'],
        message: 'Tick proposals must remain valid for exactly two ticks.',
      });
  });
export type AllianceProposal = z.infer<typeof allianceProposalSchema>;

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

const directMessageFields = {
  recipientId: agentIdSchema,
  message: messageContentSchema,
  distance: z.number().nonnegative().nullable(),
};

const worldEventBaseSchema = z.object({
  id: eventIdSchema,
  agentId: agentIdSchema,
  occurredAt: z.iso.datetime(),
});

export const publicMessageEventSchema = worldEventBaseSchema.extend({
  type: z.literal('public-message-sent'),
  channel: z.literal('public'),
  message: messageContentSchema,
  playerVisible: z.literal(true).default(true),
});
export const directMessageEventSchema = worldEventBaseSchema.extend({
  type: z.literal('direct-message-sent'),
  channel: z.literal('direct'),
  ...directMessageFields,
  distance: z.number().nonnegative(),
  playerVisible: z.literal(false).default(false),
});
export const allianceMessageEventSchema = worldEventBaseSchema.extend({
  type: z.literal('alliance-message-sent'),
  channel: z.literal('alliance'),
  allianceId: allianceIdSchema,
  recipientIds: z
    .array(agentIdSchema)
    .min(1)
    .max(WORLD_SCENARIO_LIMITS.maximumAgents - 1),
  message: messageContentSchema,
  playerVisible: z.literal(false).default(false),
});
export const zeroMessageEventSchema = worldEventBaseSchema.extend({
  type: z.literal('zero-message-sent'),
  channel: z.literal('zero'),
  recipientIds: z
    .array(agentIdSchema)
    .max(WORLD_SCENARIO_LIMITS.maximumAgents - 1),
  message: messageContentSchema,
  playerVisible: z.literal(false).default(false),
});
export const communicationEventSchema = z.discriminatedUnion('channel', [
  publicMessageEventSchema,
  directMessageEventSchema,
  allianceMessageEventSchema,
  zeroMessageEventSchema,
]);
export type CommunicationEvent = z.infer<typeof communicationEventSchema>;

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
  previousControllerAgentId: agentIdSchema,
});
export type HexCapturedWorldEvent = z.infer<typeof hexCapturedWorldEventSchema>;
const agentWaitedWorldEventSchema = worldEventBaseSchema.extend({
  type: z.literal('agent-waited'),
});

const allianceEventBaseSchema = worldEventBaseSchema.extend({
  turnNumber: z.number().int().positive(),
});
export const allianceProposedEventSchema = allianceEventBaseSchema.extend({
  type: z.literal('alliance-proposed'),
  proposalId: allianceProposalIdSchema,
  recipientAgentId: agentIdSchema,
  allianceId: allianceIdSchema.nullable(),
  expirationTurn: z.number().int().positive(),
});
export const allianceProposalClosedEventSchema = allianceEventBaseSchema.extend(
  {
    type: z.literal('alliance-proposal-closed'),
    proposalId: allianceProposalIdSchema,
    proposerAgentId: agentIdSchema,
    recipientAgentId: agentIdSchema,
    reason: z.enum(['expired', 'invalidated']),
  },
);
export const allianceFormedEventSchema = allianceEventBaseSchema.extend({
  type: z.literal('alliance-formed'),
  allianceId: allianceIdSchema,
  allianceColor: z.enum(ALLIANCE_COLOR_PALETTE),
  memberAgentIds: z.array(agentIdSchema).length(2),
});
export const agentJoinedAllianceEventSchema = allianceEventBaseSchema.extend({
  type: z.literal('agent-joined-alliance'),
  allianceId: allianceIdSchema,
  allianceColor: z.enum(ALLIANCE_COLOR_PALETTE),
  joinedAgentId: agentIdSchema,
  memberAgentIds: z
    .array(agentIdSchema)
    .min(2)
    .max(WORLD_SCENARIO_LIMITS.maximumAgents),
});
export const agentLeftAllianceEventSchema = allianceEventBaseSchema.extend({
  type: z.literal('agent-left-alliance'),
  allianceId: allianceIdSchema,
  allianceColor: z.enum(ALLIANCE_COLOR_PALETTE),
  leftAgentId: agentIdSchema,
  remainingMemberAgentIds: z
    .array(agentIdSchema)
    .max(WORLD_SCENARIO_LIMITS.maximumAgents),
});
export const allianceDissolvedEventSchema = allianceEventBaseSchema.extend({
  type: z.literal('alliance-dissolved'),
  allianceId: allianceIdSchema,
  allianceColor: z.enum(ALLIANCE_COLOR_PALETTE),
  formerMemberAgentIds: z
    .array(agentIdSchema)
    .min(1)
    .max(WORLD_SCENARIO_LIMITS.maximumAgents),
});
export const allianceEventSchema = z.discriminatedUnion('type', [
  allianceProposedEventSchema,
  allianceProposalClosedEventSchema,
  allianceFormedEventSchema,
  agentJoinedAllianceEventSchema,
  agentLeftAllianceEventSchema,
  allianceDissolvedEventSchema,
]);
export type AllianceEvent = z.infer<typeof allianceEventSchema>;

export const nonCommunicationWorldEventSchema = z.discriminatedUnion('type', [
  agentMovedWorldEventSchema,
  hexInfectedWorldEventSchema,
  hexCapturedWorldEventSchema,
  agentWaitedWorldEventSchema,
]);
export type NonCommunicationWorldEvent = z.infer<
  typeof nonCommunicationWorldEventSchema
>;

export const worldEventSchema = z.discriminatedUnion('type', [
  agentMovedWorldEventSchema,
  hexInfectedWorldEventSchema,
  hexCapturedWorldEventSchema,
  publicMessageEventSchema,
  directMessageEventSchema,
  allianceMessageEventSchema,
  zeroMessageEventSchema,
  agentWaitedWorldEventSchema,
  allianceProposedEventSchema,
  allianceProposalClosedEventSchema,
  allianceFormedEventSchema,
  agentJoinedAllianceEventSchema,
  agentLeftAllianceEventSchema,
  allianceDissolvedEventSchema,
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
  'allied-controller',
]);
export type InvalidActionReason = z.infer<typeof invalidActionReasonSchema>;

export const captureBlockedReasonSchema = z.enum([
  'capture-open-cell',
  'already-controller',
  'controller-present',
  'allied-controller',
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
    event: nonCommunicationWorldEventSchema,
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

export const communicationRejectionReasonSchema = z.enum([
  'invalid-communication',
  'unknown-recipient',
  'self-message',
  'out-of-range',
  'not-allied',
  'not-patient-zero',
]);
export type CommunicationRejectionReason = z.infer<
  typeof communicationRejectionReasonSchema
>;

const communicationAttemptBaseSchema = z.object({
  id: eventIdSchema,
  agentId: agentIdSchema,
  occurredAt: z.iso.datetime(),
  message: messageContentSchema,
});
export const communicationAttemptSchema = z.discriminatedUnion('channel', [
  communicationAttemptBaseSchema.extend({ channel: z.literal('public') }),
  communicationAttemptBaseSchema.extend({
    channel: z.literal('direct'),
    recipientId: agentIdSchema.nullable(),
    distance: z.number().nonnegative().nullable(),
  }),
  communicationAttemptBaseSchema.extend({ channel: z.literal('alliance') }),
  communicationAttemptBaseSchema.extend({ channel: z.literal('zero') }),
]);
export type CommunicationAttempt = z.infer<typeof communicationAttemptSchema>;

export const communicationResultSchema = z.union([
  z.object({ requested: z.literal(false) }).strict(),
  z.object({
    requested: z.literal(true),
    accepted: z.literal(true),
    event: communicationEventSchema,
  }),
  z.object({
    requested: z.literal(true),
    accepted: z.literal(false),
    attempt: communicationAttemptSchema,
    reason: communicationRejectionReasonSchema,
    details: z.string().min(1).max(300),
  }),
]);
export type CommunicationResult = z.infer<typeof communicationResultSchema>;

export const diplomacyRejectionReasonSchema = z.enum([
  'invalid-diplomacy',
  'unknown-recipient',
  'self-proposal',
  'recipient-allied',
  'current-ally',
  'recipient-out-of-range',
  'outgoing-proposal-exists',
  'incoming-proposal-exists',
  'unknown-proposal',
  'not-proposal-recipient',
  'stale-proposal',
  'not-allied',
  'alliance-capacity',
]);
export type DiplomacyRejectionReason = z.infer<
  typeof diplomacyRejectionReasonSchema
>;
export const diplomacyAttemptSchema = z.object({
  type: z.enum([
    'propose-alliance',
    'accept-alliance',
    'leave-alliance',
    'invalid',
  ]),
  recipientId: agentIdSchema.nullable().optional(),
  proposalId: allianceProposalIdSchema.nullable().optional(),
});
export const diplomacyResultSchema = z.union([
  z.object({ requested: z.literal(false) }).strict(),
  z.object({
    requested: z.literal(true),
    accepted: z.literal(true),
    intent: diplomacyIntentSchema,
    events: z.array(allianceEventSchema).min(1),
  }),
  z.object({
    requested: z.literal(true),
    accepted: z.literal(false),
    attempt: diplomacyAttemptSchema,
    reason: diplomacyRejectionReasonSchema,
    details: z.string().min(1).max(300),
  }),
]);
export type DiplomacyResult = z.infer<typeof diplomacyResultSchema>;

const worldSnapshotObjectSchema = z.object({
  generatedAt: z.iso.datetime(),
  hexes: z
    .array(hexSchema)
    .min(1)
    .max(WORLD_SCENARIO_LIMITS.maximumGeneratedCells),
  agents: z
    .array(agentSchema)
    .min(WORLD_SCENARIO_LIMITS.minimumAgents)
    .max(WORLD_SCENARIO_LIMITS.maximumAgents),
  events: z.array(worldEventSchema).max(120),
  alliances: z
    .array(allianceSchema)
    .max(WORLD_SCENARIO_LIMITS.maximumAgents)
    .default([]),
  pendingAllianceProposals: z
    .array(allianceProposalSchema)
    .max(WORLD_SCENARIO_LIMITS.maximumAgents)
    .default([]),
});

function validateWorldControllers(
  world: Pick<
    z.infer<typeof worldSnapshotObjectSchema>,
    'hexes' | 'agents' | 'alliances' | 'pendingAllianceProposals'
  >,
  context: z.RefinementCtx,
): void {
  const agentIds = new Set(world.agents.map(({ id }) => id));
  for (const [index, hex] of world.hexes.entries()) {
    if (hex.state === 'infected' && !agentIds.has(hex.controllerAgentId))
      context.addIssue({
        code: 'custom',
        path: ['hexes', index, 'controllerAgentId'],
        message: 'An infected hex controller must be a world agent.',
      });
  }
  const memberships = new Set<AgentId>();
  const allianceIds = new Set<AllianceId>();
  for (const [index, alliance] of world.alliances.entries()) {
    if (allianceIds.has(alliance.id))
      context.addIssue({
        code: 'custom',
        path: ['alliances', index, 'id'],
        message: 'Active alliance IDs must be unique.',
      });
    allianceIds.add(alliance.id);
    for (const memberId of alliance.memberAgentIds) {
      if (!agentIds.has(memberId))
        context.addIssue({
          code: 'custom',
          path: ['alliances', index, 'memberAgentIds'],
          message: 'Alliance members must be world agents.',
        });
      if (memberships.has(memberId))
        context.addIssue({
          code: 'custom',
          path: ['alliances', index, 'memberAgentIds'],
          message: 'An agent may belong to at most one alliance.',
        });
      memberships.add(memberId);
    }
  }
  const outgoing = new Set<AgentId>();
  const incoming = new Set<AgentId>();
  const proposalIds = new Set<AllianceProposalId>();
  for (const [index, proposal] of world.pendingAllianceProposals.entries()) {
    if (proposalIds.has(proposal.id))
      context.addIssue({
        code: 'custom',
        path: ['pendingAllianceProposals', index, 'id'],
        message: 'Proposal IDs must be unique.',
      });
    proposalIds.add(proposal.id);
    if (
      !agentIds.has(proposal.proposerAgentId) ||
      !agentIds.has(proposal.recipientAgentId)
    )
      context.addIssue({
        code: 'custom',
        path: ['pendingAllianceProposals', index],
        message: 'Proposal participants must be world agents.',
      });
    if (outgoing.has(proposal.proposerAgentId))
      context.addIssue({
        code: 'custom',
        path: ['pendingAllianceProposals', index, 'proposerAgentId'],
        message: 'A proposer may have at most one outgoing proposal.',
      });
    if (incoming.has(proposal.recipientAgentId))
      context.addIssue({
        code: 'custom',
        path: ['pendingAllianceProposals', index, 'recipientAgentId'],
        message: 'A recipient may have at most one incoming proposal.',
      });
    const hasOriginatingTick = proposal.originatingTick !== undefined;
    const hasExpirationTick = proposal.expirationTick !== undefined;
    const validLifetime =
      hasOriginatingTick === hasExpirationTick &&
      (hasOriginatingTick
        ? proposal.expirationTick === proposal.originatingTick! + 2
        : proposal.expirationTurn ===
          proposal.originatingTurn + world.agents.length * 2);
    if (!validLifetime)
      context.addIssue({
        code: 'custom',
        path: ['pendingAllianceProposals', index, 'expirationTurn'],
        message:
          'Proposal expiration must allow two ticks or two legacy roster rounds.',
      });
    const proposerAlliance = world.alliances.find(({ memberAgentIds }) =>
      memberAgentIds.includes(proposal.proposerAgentId),
    );
    const recipientAlliance = world.alliances.find(({ memberAgentIds }) =>
      memberAgentIds.includes(proposal.recipientAgentId),
    );
    if (
      proposal.proposerAllianceId !== (proposerAlliance?.id ?? null) ||
      proposal.recipientAllianceId !== (recipientAlliance?.id ?? null) ||
      (proposerAlliance !== undefined && recipientAlliance !== undefined)
    )
      context.addIssue({
        code: 'custom',
        path: ['pendingAllianceProposals', index, 'recipientAllianceId'],
        message:
          'Proposal alliance attribution must match current participant membership.',
      });
    outgoing.add(proposal.proposerAgentId);
    incoming.add(proposal.recipientAgentId);
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
    controllerAllianceId: z.null(),
    effectiveColor: z.null(),
  }),
  z.object({
    cell: h3CellSchema,
    state: z.literal('infected'),
    controllerAgentId: agentIdSchema,
    controllerAllianceId: allianceIdSchema.nullable(),
    effectiveColor: colorSchema,
  }),
]);
export type CellObservation = z.infer<typeof cellObservationSchema>;

export const nearbyAgentObservationSchema = z.object({
  id: agentIdSchema,
  name: z.string().trim().min(1).max(80),
  currentCell: h3CellSchema,
  distance: z.number().int().nonnegative().default(0),
  distanceKm: z.number().nonnegative().default(0),
  allianceId: allianceIdSchema.nullable(),
  allianceRelationship: z.enum(['allied', 'not-allied']).default('not-allied'),
  controlledCellCount: z.number().int().nonnegative().default(0),
  directMessageLegal: z.boolean().default(false),
});

export const publicEventObservationSchema = z.object({
  type: z.enum(['agent-moved', 'hex-infected', 'hex-captured', 'agent-waited']),
  agentId: agentIdSchema,
  occurredAt: z.iso.datetime(),
  summary: z.string().trim().min(1).max(180),
});

export const observedPublicMessageSchema = z.object({
  eventId: eventIdSchema,
  senderId: agentIdSchema,
  senderName: z.string().trim().min(1).max(80),
  message: messageContentSchema,
  occurredAt: z.iso.datetime(),
});
export type ObservedPublicMessage = z.infer<typeof observedPublicMessageSchema>;

export const observedDirectMessageSchema = z.object({
  eventId: eventIdSchema,
  senderId: agentIdSchema,
  senderName: z.string().trim().min(1).max(80),
  recipientId: agentIdSchema,
  recipientName: z.string().trim().min(1).max(80),
  direction: z.enum(['inbound', 'outbound']),
  message: messageContentSchema,
  occurredAt: z.iso.datetime(),
  distance: z.number().nonnegative(),
});
export type ObservedDirectMessage = z.infer<typeof observedDirectMessageSchema>;
export const observedAllianceMessageSchema = z.object({
  eventId: eventIdSchema,
  senderId: agentIdSchema,
  senderName: z.string().trim().min(1).max(80),
  allianceId: allianceIdSchema,
  message: messageContentSchema,
  occurredAt: z.iso.datetime(),
});
export const observedZeroMessageSchema = z.object({
  eventId: eventIdSchema,
  senderId: agentIdSchema,
  senderName: z.string().trim().min(1).max(80),
  recipientCount: z
    .number()
    .int()
    .nonnegative()
    .max(WORLD_SCENARIO_LIMITS.maximumAgents - 1),
  message: messageContentSchema,
  occurredAt: z.iso.datetime(),
});

export const territoryScoreboardEntrySchema = z.object({
  agentId: agentIdSchema,
  name: z.string().trim().min(1).max(80),
  color: colorSchema,
  allianceId: allianceIdSchema.nullable(),
  effectiveColor: colorSchema,
  controlledCellCount: z
    .number()
    .int()
    .nonnegative()
    .max(WORLD_SCENARIO_LIMITS.maximumGeneratedCells),
});
export const territoryScoreboardSchema = z
  .array(territoryScoreboardEntrySchema)
  .min(WORLD_SCENARIO_LIMITS.minimumAgents)
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

export const allianceTerritorySummarySchema = z
  .object({
    allianceId: allianceIdSchema,
    color: z.enum(ALLIANCE_COLOR_PALETTE),
    totalControlledCellCount: z
      .number()
      .int()
      .nonnegative()
      .max(WORLD_SCENARIO_LIMITS.maximumGeneratedCells),
    members: z
      .array(
        z.object({
          agentId: agentIdSchema,
          name: z.string().trim().min(1).max(80),
          controlledCellCount: z
            .number()
            .int()
            .nonnegative()
            .max(WORLD_SCENARIO_LIMITS.maximumGeneratedCells),
        }),
      )
      .min(2)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
  })
  .refine(
    ({ totalControlledCellCount, members }) =>
      totalControlledCellCount ===
      members.reduce((sum, member) => sum + member.controlledCellCount, 0),
    { message: 'Alliance territory must equal the sum of member control.' },
  );
export type AllianceTerritorySummary = z.infer<
  typeof allianceTerritorySummarySchema
>;

export const observedAllianceEventSchema = z.object({
  event: allianceEventSchema,
  summary: z.string().trim().min(1).max(240),
});

export const patientZeroGlobalAgentSchema = z.object({
  id: agentIdSchema,
  name: z.string().trim().min(1).max(80),
  currentCell: h3CellSchema,
  allianceId: allianceIdSchema.nullable(),
  controlledCellCount: z.number().int().nonnegative(),
  personality: personalitySchema,
  strategyId: strategyProfileIdSchema,
});
export const diplomacyProposalBlockReasonSchema = z.enum([
  'current-ally',
  'out-of-range',
  'outgoing-proposal-exists',
  'incoming-proposal-exists',
  'alliance-to-alliance-merge',
]);
export const diplomacyProposalBlockSchema = z
  .object({
    agentId: agentIdSchema,
    reason: diplomacyProposalBlockReasonSchema,
  })
  .strict();
export const patientZeroDiplomacyFeasibilitySchema = z
  .object({
    agentId: agentIdSchema,
    eligibleRecipientCount: z
      .number()
      .int()
      .nonnegative()
      .max(WORLD_SCENARIO_LIMITS.maximumAgents - 1),
    displayedEligibleRecipientAgentIds: z.array(agentIdSchema).max(4),
    eligibleRecipientsTruncated: z.boolean(),
    blockedCounts: z
      .array(
        z
          .object({
            reason: diplomacyProposalBlockReasonSchema,
            count: z
              .number()
              .int()
              .positive()
              .max(
                WORLD_SCENARIO_LIMITS.maximumAgents *
                  (WORLD_SCENARIO_LIMITS.maximumAgents - 1),
              ),
          })
          .strict(),
      )
      .max(diplomacyProposalBlockReasonSchema.options.length),
    blockerExamples: z.array(diplomacyProposalBlockSchema).max(4),
    acceptableProposalIds: z
      .array(allianceProposalIdSchema)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    leaveAvailable: z.boolean(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.displayedEligibleRecipientAgentIds.length >
        entry.eligibleRecipientCount ||
      entry.eligibleRecipientsTruncated !==
        entry.eligibleRecipientCount >
          entry.displayedEligibleRecipientAgentIds.length
    )
      context.addIssue({
        code: 'custom',
        message:
          'Patient Zero eligible-recipient truncation must match counts.',
      });
    if (
      new Set(entry.displayedEligibleRecipientAgentIds).size !==
        entry.displayedEligibleRecipientAgentIds.length ||
      new Set(entry.blockedCounts.map(({ reason }) => reason)).size !==
        entry.blockedCounts.length ||
      new Set(entry.blockerExamples.map(({ agentId }) => agentId)).size !==
        entry.blockerExamples.length ||
      entry.blockerExamples.some(
        ({ agentId, reason }) =>
          agentId === entry.agentId ||
          !entry.blockedCounts.some((count) => count.reason === reason),
      )
    )
      context.addIssue({
        code: 'custom',
        message:
          'Patient Zero diplomacy samples must be unique and attributed.',
      });
  });
export const patientZeroDiplomacySummarySchema = z
  .object({
    eligiblePairCount: z
      .number()
      .int()
      .nonnegative()
      .max(
        WORLD_SCENARIO_LIMITS.maximumAgents *
          (WORLD_SCENARIO_LIMITS.maximumAgents - 1),
      ),
    displayedEligiblePairs: z
      .array(
        z
          .object({
            proposerId: agentIdSchema,
            recipientId: agentIdSchema,
          })
          .strict(),
      )
      .max(PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.displayedEligiblePairs),
    eligiblePairsTruncated: z.boolean(),
    acceptableProposals: z
      .array(
        z
          .object({
            agentId: agentIdSchema,
            proposalId: allianceProposalIdSchema,
          })
          .strict(),
      )
      .max(PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.acceptableProposals),
    acceptableProposalCount: z
      .number()
      .int()
      .nonnegative()
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    acceptableProposalsTruncated: z.boolean(),
    leaveAvailableAgentIds: z
      .array(agentIdSchema)
      .max(PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.leaveAvailableAgentIds),
    leaveAvailableCount: z
      .number()
      .int()
      .nonnegative()
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    leaveAvailableTruncated: z.boolean(),
    blockedCounts: z
      .array(
        z
          .object({
            reason: diplomacyProposalBlockReasonSchema,
            count: z
              .number()
              .int()
              .positive()
              .max(
                WORLD_SCENARIO_LIMITS.maximumAgents *
                  (WORLD_SCENARIO_LIMITS.maximumAgents - 1),
              ),
          })
          .strict(),
      )
      .max(diplomacyProposalBlockReasonSchema.options.length),
    blockerExamples: z
      .array(
        z
          .object({
            proposerId: agentIdSchema,
            recipientId: agentIdSchema,
            reason: diplomacyProposalBlockReasonSchema,
          })
          .strict(),
      )
      .max(PATIENT_ZERO_DIPLOMACY_SUMMARY_LIMITS.blockerExamples),
  })
  .strict()
  .superRefine((summary, context) => {
    if (
      summary.eligiblePairsTruncated !==
        summary.eligiblePairCount > summary.displayedEligiblePairs.length ||
      summary.leaveAvailableTruncated !==
        summary.leaveAvailableCount > summary.leaveAvailableAgentIds.length ||
      summary.acceptableProposalsTruncated !==
        summary.acceptableProposalCount > summary.acceptableProposals.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Patient Zero diplomacy truncation must match counts.',
      });
    const pairKeys = summary.displayedEligiblePairs.map(
      ({ proposerId, recipientId }) => `${proposerId}:${recipientId}`,
    );
    const proposalKeys = summary.acceptableProposals.map(
      ({ proposalId }) => proposalId,
    );
    const blockerKeys = summary.blockerExamples.map(
      ({ proposerId, recipientId }) => `${proposerId}:${recipientId}`,
    );
    if (
      summary.displayedEligiblePairs.length > summary.eligiblePairCount ||
      summary.acceptableProposals.length > summary.acceptableProposalCount ||
      summary.leaveAvailableAgentIds.length > summary.leaveAvailableCount ||
      new Set(pairKeys).size !== pairKeys.length ||
      summary.displayedEligiblePairs.some(
        ({ proposerId, recipientId }) => proposerId === recipientId,
      ) ||
      new Set(proposalKeys).size !== proposalKeys.length ||
      new Set(summary.leaveAvailableAgentIds).size !==
        summary.leaveAvailableAgentIds.length ||
      new Set(summary.blockedCounts.map(({ reason }) => reason)).size !==
        summary.blockedCounts.length ||
      new Set(blockerKeys).size !== blockerKeys.length ||
      summary.blockerExamples.some(
        ({ proposerId, recipientId, reason }) =>
          proposerId === recipientId ||
          !summary.blockedCounts.some((entry) => entry.reason === reason),
      )
    )
      context.addIssue({
        code: 'custom',
        message:
          'Patient Zero diplomacy samples must be unique and attributed.',
      });
  });
export const patientZeroGlobalViewSchema = z
  .object({
    agents: z
      .array(patientZeroGlobalAgentSchema)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    individualTerritory: territoryScoreboardSchema,
    allianceTerritory: z
      .array(allianceTerritorySummarySchema)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    alliances: z.array(allianceSchema).max(WORLD_SCENARIO_LIMITS.maximumAgents),
    activeAllianceProposals: z
      .array(allianceProposalSchema)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    recentStrategicEvents: z
      .array(observedAllianceEventSchema)
      .max(RECENT_ZERO_STRATEGIC_EVENT_LIMIT),
    recentTerritoryChanges: z
      .array(hexCapturedWorldEventSchema)
      .max(RECENT_CONTROL_CHANGE_LIMIT),
    diplomacyFeasibility: z
      .array(patientZeroDiplomacyFeasibilitySchema)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents)
      .default([]),
    diplomacySummary: patientZeroDiplomacySummarySchema.optional(),
  })
  .superRefine((view, context) => {
    if (
      view.diplomacyFeasibility.length > 0 &&
      (view.diplomacyFeasibility.length !== view.agents.length ||
        view.diplomacyFeasibility.some(
          (entry) =>
            entry.eligibleRecipientCount +
              entry.blockedCounts.reduce(
                (sum, blocked) => sum + blocked.count,
                0,
              ) !==
            view.agents.length - 1,
        ))
    )
      context.addIssue({
        code: 'custom',
        path: ['diplomacyFeasibility'],
        message:
          'Patient Zero diplomacy counts must cover every other active agent.',
      });
  });

const agentObservationObjectSchema = z.object({
  agentId: agentIdSchema,
  agentName: z.string().trim().min(1).max(80),
  personality: z.string().trim().min(1).max(PERSONALITY_MAX_LENGTH),
  behavior: behaviorAssignmentSchema.optional(),
  currentGoal: agentGoalStateSchema.nullable().default(null),
  goalAvailability: z
    .object({
      active: z.boolean(),
      availableOperations: z.array(goalRevisionOperationSchema).min(1).max(4),
    })
    .strict()
    .default({ active: false, availableOperations: ['establish'] }),
  currentMemory: memoryLedgerSchema.default([]),
  memoryAvailability: z
    .object({
      remember: z.boolean(),
      revisableMemoryIds: z.array(memoryIdSchema).max(MEMORY_ENTRY_LIMIT),
      forgettableMemoryIds: z.array(memoryIdSchema).max(MEMORY_ENTRY_LIMIT),
    })
    .strict()
    .default({
      remember: true,
      revisableMemoryIds: [],
      forgettableMemoryIds: [],
    }),
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
              controllerRelationship: z.enum([
                'open',
                'self',
                'allied',
                'other',
              ]),
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
  diplomacyAvailability: z
    .object({
      neutral: z.object({ available: z.literal(true) }).strict(),
      propose: z.discriminatedUnion('available', [
        z
          .object({
            available: z.literal(true),
            eligibleRecipientAgentIds: z
              .array(agentIdSchema)
              .min(1)
              .max(WORLD_SCENARIO_LIMITS.maximumAgents - 1),
            blockedRecipients: z
              .array(diplomacyProposalBlockSchema)
              .max(WORLD_SCENARIO_LIMITS.maximumNearbyAgentObservations)
              .default([]),
          })
          .strict(),
        z
          .object({
            available: z.literal(false),
            eligibleRecipientAgentIds: z.array(agentIdSchema).length(0),
            blockedRecipients: z
              .array(diplomacyProposalBlockSchema)
              .max(WORLD_SCENARIO_LIMITS.maximumNearbyAgentObservations)
              .default([]),
            reason: z.string().trim().min(1).max(120),
          })
          .strict(),
      ]),
      accept: z.discriminatedUnion('available', [
        z
          .object({
            available: z.literal(true),
            acceptableProposalIds: z
              .array(allianceProposalIdSchema)
              .min(1)
              .max(WORLD_SCENARIO_LIMITS.maximumAgents),
          })
          .strict(),
        z
          .object({
            available: z.literal(false),
            acceptableProposalIds: z.array(allianceProposalIdSchema).length(0),
            reason: z.string().trim().min(1).max(120),
          })
          .strict(),
      ]),
      leave: z.discriminatedUnion('available', [
        z
          .object({ available: z.literal(true), allianceId: allianceIdSchema })
          .strict(),
        z
          .object({
            available: z.literal(false),
            allianceId: z.null(),
            reason: z.string().trim().min(1).max(120),
          })
          .strict(),
      ]),
    })
    .strict()
    .optional(),
  communicationAvailability: z
    .object({
      public: z
        .object({ available: z.literal(true), playerVisible: z.literal(true) })
        .strict(),
      direct: z
        .object({
          eligibleRecipientAgentIds: z
            .array(agentIdSchema)
            .max(WORLD_SCENARIO_LIMITS.maximumNearbyAgentObservations),
        })
        .strict(),
      alliance: z.discriminatedUnion('available', [
        z
          .object({ available: z.literal(true), allianceId: allianceIdSchema })
          .strict(),
        z
          .object({ available: z.literal(false), allianceId: z.null() })
          .strict(),
      ]),
      zero: z
        .object({ available: z.boolean() })
        .strict()
        .default({ available: false }),
    })
    .strict()
    .optional(),
  adjacentCells: z.array(cellObservationSchema).min(1).max(6),
  nearbyAgents: z
    .array(nearbyAgentObservationSchema)
    .max(WORLD_SCENARIO_LIMITS.maximumNearbyAgentObservations),
  recentEvents: z.array(publicEventObservationSchema).max(8),
  recentPublicMessages: z
    .array(observedPublicMessageSchema)
    .max(RECENT_PUBLIC_MESSAGE_LIMIT),
  recentDirectMessages: z
    .array(observedDirectMessageSchema)
    .max(RECENT_DIRECT_MESSAGE_LIMIT),
  recentAllianceMessages: z
    .array(observedAllianceMessageSchema)
    .max(RECENT_DIRECT_MESSAGE_LIMIT)
    .default([]),
  recentZeroMessages: z
    .array(observedZeroMessageSchema)
    .max(RECENT_ZERO_MESSAGE_LIMIT)
    .default([]),
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
  actingAllianceId: allianceIdSchema.nullable(),
  actingAlliance: allianceTerritorySummarySchema.nullable(),
  activeAlliances: z
    .array(allianceTerritorySummarySchema)
    .max(WORLD_SCENARIO_LIMITS.maximumAgents),
  inboundAllianceProposals: z.array(allianceProposalSchema).max(1),
  outboundAllianceProposals: z.array(allianceProposalSchema).max(1),
  recentAllianceEvents: z
    .array(observedAllianceEventSchema)
    .max(RECENT_ALLIANCE_EVENT_LIMIT),
  recentControlChanges: z
    .array(observedControlChangeSchema)
    .max(RECENT_CONTROL_CHANGE_LIMIT),
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
    const expectedGoalOperations = observation.currentGoal
      ? ['keep', 'revise', 'complete', 'abandon']
      : ['establish'];
    if (
      observation.goalAvailability.active !==
        Boolean(observation.currentGoal) ||
      new Set(observation.goalAvailability.availableOperations).size !==
        observation.goalAvailability.availableOperations.length ||
      observation.goalAvailability.availableOperations.length !==
        expectedGoalOperations.length ||
      observation.goalAvailability.availableOperations.some(
        (operation, index) => operation !== expectedGoalOperations[index],
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['goalAvailability'],
        message:
          'Goal availability must exactly match the current goal state in canonical order.',
      });
    const memoryIds = observation.currentMemory.map(({ id }) => id);
    const owningMemory = memoryLedgerForAgentSchema(
      observation.agentId,
    ).safeParse(observation.currentMemory);
    if (
      !owningMemory.success ||
      observation.memoryAvailability.remember !==
        observation.currentMemory.length < MEMORY_ENTRY_LIMIT ||
      observation.memoryAvailability.revisableMemoryIds.length !==
        memoryIds.length ||
      observation.memoryAvailability.forgettableMemoryIds.length !==
        memoryIds.length ||
      observation.memoryAvailability.revisableMemoryIds.some(
        (id, index) => id !== memoryIds[index],
      ) ||
      observation.memoryAvailability.forgettableMemoryIds.some(
        (id, index) => id !== memoryIds[index],
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['memoryAvailability'],
        message:
          'Memory availability must exactly match the canonical current ledger.',
      });
    return {
      ...observation,
      behavior: observation.behavior ?? {
        agentId: observation.agentId,
        personalityId: 'analytical',
        strategyId: 'adaptive',
        manual: false,
      },
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
      diplomacyAvailability: observation.diplomacyAvailability ?? {
        neutral: { available: true as const },
        propose: {
          available: false as const,
          eligibleRecipientAgentIds: [],
          blockedRecipients: [],
          reason: 'Authoritative recipient availability was not supplied.',
        },
        accept: observation.inboundAllianceProposals.length
          ? {
              available: true as const,
              acceptableProposalIds: observation.inboundAllianceProposals.map(
                ({ id }) => id,
              ),
            }
          : {
              available: false as const,
              acceptableProposalIds: [],
              reason: 'No acceptable inbound formal alliance proposal exists.',
            },
        leave: observation.actingAllianceId
          ? {
              available: true as const,
              allianceId: observation.actingAllianceId,
            }
          : {
              available: false as const,
              allianceId: null,
              reason: 'The agent is not currently in an alliance.',
            },
      },
      communicationAvailability: observation.communicationAvailability ?? {
        public: { available: true as const, playerVisible: true as const },
        direct: {
          eligibleRecipientAgentIds: observation.nearbyAgents
            .filter(({ directMessageLegal }) => directMessageLegal)
            .map(({ id }) => id),
        },
        alliance: observation.actingAllianceId
          ? {
              available: true as const,
              allianceId: observation.actingAllianceId,
            }
          : { available: false as const, allianceId: null },
        zero: { available: observation.patientZero.isPatientZero },
      },
    };
  },
);
export type AgentObservation = z.infer<typeof agentObservationSchema>;

export const agentDecisionSchema = z
  .object({
    worldAction: worldActionSchema,
    communication: communicationIntentSchema.nullish(),
    diplomacy: diplomacyIntentSchema.nullish(),
    goalRevision: requestedGoalRevisionSchema.optional(),
    memoryOperation: requestedMemoryOperationSchema.optional(),
    summary: z.string().trim().min(1).max(MODEL_SUMMARY_MAX_LENGTH),
  })
  .strict();
export type AgentDecision = z.infer<typeof agentDecisionSchema>;

export const providerDecisionEnvelopeSchema = z
  .object({
    worldAction: worldActionSchema,
    communication: z.unknown().optional(),
    diplomacy: z.unknown().optional(),
    goalRevision: requestedGoalRevisionSchema.optional(),
    memoryOperation: requestedMemoryOperationSchema.optional(),
    summary: z.string().trim().min(1).max(MODEL_SUMMARY_MAX_LENGTH),
  })
  .strict();
export type ProviderDecisionEnvelope = z.infer<
  typeof providerDecisionEnvelopeSchema
>;

export const providerModeSchema = z.enum(['openrouter', 'scripted-test']);
export type ProviderMode = z.infer<typeof providerModeSchema>;

export const modelIdSchema = z.string().trim().min(1).max(200);
export type ModelId = z.infer<typeof modelIdSchema>;

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
export const updateExperimentBehaviorRequestSchema = z
  .object({
    assignmentMode: z.enum(['balanced-random', 'fully-random', 'manual']),
    seed: z.string().trim().min(1).max(80),
    assignments: z
      .array(behaviorAssignmentSchema)
      .min(WORLD_SCENARIO_LIMITS.minimumAgents)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
  })
  .strict();
export const updateExperimentBehaviorResponseSchema = z.object({
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
  contractVersion: z.literal(AGENT_DECISION_CONTRACT_VERSION),
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
        'contradictory-diplomacy-fields',
        'missing-formal-proposal-id',
        'unexpected-formal-proposal-id',
        'invalid-formal-proposal-reference',
        'ineligible-alliance-recipient',
        'missing-alliance-recipient',
        'unexpected-alliance-recipient',
        'invalid-goal-fields',
        'goal-text-too-long',
        'goal-reason-too-long',
        'invalid-memory-fields',
        'invalid-memory-id',
        'memory-text-too-long',
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

const turnRecordBaseSchema = z.object({
  turnNumber: z.number().int().positive(),
  tickNumber: z.number().int().positive().optional(),
  tickPosition: z.number().int().positive().optional(),
  virtualTime: z.iso.datetime().optional(),
  tickIntervalMinutes: z.number().int().positive().optional(),
  agentId: agentIdSchema,
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  observation: agentObservationSchema,
  behavior: behaviorAssignmentSchema.optional(),
  allianceEvents: z.array(allianceEventSchema).default([]),
  modelAttempts: z.array(modelAttemptSchema).max(1_000).default([]),
});

const completedTurnFields = {
  worldAction: worldActionSchema,
  communication: communicationIntentSchema.optional(),
  diplomacy: diplomacyIntentSchema.optional(),
  summary: z.string().trim().min(1).max(MODEL_SUMMARY_MAX_LENGTH),
  provider: providerMetadataSchema,
  communicationResult: communicationResultSchema,
  diplomacyResult: diplomacyResultSchema,
  goalRevision: requestedGoalRevisionSchema.optional(),
  goalRevisionResult: goalRevisionResultSchema.default({ requested: false }),
  memoryOperation: requestedMemoryOperationSchema.optional(),
  memoryOperationResult: memoryOperationResultSchema.default({
    requested: false,
  }),
};

export const agentTurnRecordSchema = z
  .discriminatedUnion('outcome', [
    turnRecordBaseSchema.extend({
      outcome: z.literal('accepted'),
      ...completedTurnFields,
      worldActionResult: z.object({
        accepted: z.literal(true),
        event: nonCommunicationWorldEventSchema,
      }),
    }),
    turnRecordBaseSchema.extend({
      outcome: z.literal('rejected'),
      ...completedTurnFields,
      worldActionResult: z.object({
        accepted: z.literal(false),
        reason: invalidActionReasonSchema,
        details: z.string().min(1).max(300),
      }),
    }),
    turnRecordBaseSchema.extend({
      outcome: z.literal('provider-error'),
      failure: providerFailureSchema,
      provider: providerMetadataSchema.optional(),
    }),
    turnRecordBaseSchema.extend({
      outcome: z.literal('lost-tick'),
      failure: providerFailureSchema,
      provider: providerMetadataSchema.optional(),
    }),
    turnRecordBaseSchema.extend({
      outcome: z.literal('operator-skipped'),
      skipKind: z.enum(['manual', 'unattended']).default('manual'),
      failure: providerFailureSchema,
      provider: providerMetadataSchema.optional(),
    }),
  ])
  .superRefine((turn, context) => {
    const tickFields = [
      turn.tickNumber,
      turn.tickPosition,
      turn.virtualTime,
      turn.tickIntervalMinutes,
    ];
    if (
      tickFields.some((value) => value !== undefined) &&
      tickFields.some((value) => value === undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Tick metadata must be present together.',
      });
    if (
      turn.outcome === 'operator-skipped' &&
      turn.failure.model !== undefined &&
      turn.provider?.model !== turn.failure.model
    )
      context.addIssue({
        code: 'custom',
        message: 'Skipped-turn failure and provider models must match.',
      });
  });
export type AgentTurnRecord = z.infer<typeof agentTurnRecordSchema>;

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
  'behavior-coverage-mismatch',
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
  personality: personalitySchema,
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

const worldSetupRequestObjectSchema = z
  .object({
    scenarioVersion: scenarioContractVersionSchema.default('world-scenario-v1'),
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
    communicationRangeKm: z
      .number()
      .finite()
      .min(WORLD_SCENARIO_LIMITS.minimumCommunicationRangeKm)
      .max(WORLD_SCENARIO_LIMITS.maximumCommunicationRangeKm)
      .default(DEFAULT_COMMUNICATION_RANGE_KM),
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
    patientZeroAgentId: agentIdSchema,
    roster: scenarioRosterSchema,
    modelConfiguration: experimentModelConfigurationSchema,
    behaviorConfiguration: behaviorConfigurationSchema,
    objectiveVersion: z
      .enum(['durable-influence-v1', OBJECTIVE_PROMPT_VERSION])
      .default(OBJECTIVE_PROMPT_VERSION),
    capabilities: z
      .object({ communication: z.boolean(), diplomacy: z.boolean() })
      .strict(),
  })
  .strict();

type WorldSetupValidationInput = Omit<
  z.infer<typeof worldSetupRequestObjectSchema>,
  'patientZeroAgentId'
> & { patientZeroAgentId: AgentId | null };

function validateWorldSetupRequest(
  request: WorldSetupValidationInput,
  context: z.RefinementCtx,
) {
  if (request.minimumTickIntervalMinutes > request.maximumTickIntervalMinutes)
    context.addIssue({
      code: 'custom',
      path: ['maximumTickIntervalMinutes'],
      message: 'Maximum tick interval must be at least the minimum.',
    });
  const ids = new Set(request.roster.map(({ id }) => id));
  if (
    request.behaviorConfiguration.assignments.length !== ids.size ||
    request.behaviorConfiguration.assignments.some(
      ({ agentId }) => !ids.has(agentId),
    )
  )
    context.addIssue({
      code: 'custom',
      path: ['behaviorConfiguration', 'assignments'],
      message: 'Behavior assignments must cover the roster exactly.',
    });
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

export const worldSetupRequestSchema =
  worldSetupRequestObjectSchema.superRefine(validateWorldSetupRequest);
export type WorldSetupRequest = z.infer<typeof worldSetupRequestSchema>;
export const defaultWorldSetupResponseSchema = z.object({
  request: worldSetupRequestSchema,
});

const appliedScenarioShape = {
  decisionContractVersion: agentDecisionContractVersionSchema.default(
    AGENT_DECISION_CONTRACT_VERSION,
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
) {
  validateWorldSetupRequest(scenario, context);
  if (scenario.startingCells.length !== scenario.roster.length)
    context.addIssue({
      code: 'custom',
      path: ['startingCells'],
      message: 'Every roster agent requires one starting cell.',
    });
}

export const appliedScenarioSchema = worldSetupRequestObjectSchema
  .extend(appliedScenarioShape)
  .superRefine(validateAppliedScenario);
export type AppliedScenario = z.infer<typeof appliedScenarioSchema>;
/** Read-only compatibility for exports created before Patient Zero was required. */
export const archivedAppliedScenarioSchema = worldSetupRequestObjectSchema
  .extend({
    patientZeroAgentId: agentIdSchema.nullable(),
    ...appliedScenarioShape,
  })
  .superRefine(validateAppliedScenario);

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
]);
export type SimulationStatus = z.infer<typeof simulationStatusSchema>;

export const simulationSnapshotSchema = z
  .object({
    world: worldSnapshotSchema,
    scenario: appliedScenarioSchema,
    turnNumber: z.number().int().nonnegative(),
    tickNumber: z.number().int().nonnegative().default(0),
    virtualTime: z.iso.datetime().default('2026-08-13T12:00:00.000Z'),
    lastTickIntervalMinutes: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null),
    resolutionOrder: z.array(agentIdSchema).default([]),
    nextAgentId: agentIdSchema,
    activeAgentId: agentIdSchema.nullable(),
    cancellationRequested: z.boolean().default(false),
    pendingFailedTurn: z
      .object({
        turnNumber: z.number().int().positive(),
        agentId: agentIdSchema,
        failure: providerFailureSchema,
        attempts: z.array(modelAttemptSchema).min(1).max(1_000),
      })
      .nullable()
      .default(null),
    status: simulationStatusSchema,
    providerMode: providerModeSchema,
    providerConfigured: z.boolean(),
    modelConfiguration: experimentModelConfigurationSchema,
    behaviorConfiguration: behaviorConfigurationSchema.optional(),
    resolvedModels: z
      .array(resolvedAgentModelSchema)
      .min(WORLD_SCENARIO_LIMITS.minimumAgents)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    agentGoals: z
      .array(
        z
          .object({
            agentId: agentIdSchema,
            goal: agentGoalStateSchema.nullable(),
          })
          .strict(),
      )
      .default([]),
    agentMemories: z
      .array(
        z
          .object({ agentId: agentIdSchema, entries: memoryLedgerSchema })
          .strict(),
      )
      .default([]),
    turns: z.array(agentTurnRecordSchema).max(120),
    experiment: z.object({
      id: z.uuid().brand<'ExperimentId'>(),
      startedAt: z.iso.datetime(),
      totalCompletedTurns: z.number().int().nonnegative(),
      retainedTurns: z.number().int().nonnegative(),
      firstRetainedTurn: z.number().int().positive().optional(),
      lastRetainedTurn: z.number().int().positive().optional(),
      droppedRecords: z.number().int().nonnegative(),
      complete: z.boolean(),
      metrics: z.lazy(() => experimentMetricsSchema),
      currentTerritory: territoryScoreboardSchema,
      currentAlliances: z
        .array(allianceTerritorySummarySchema)
        .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    }),
  })
  .superRefine((snapshot, context) => {
    const rosterIds = new Set(snapshot.world.agents.map(({ id }) => id));
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
      snapshot.resolutionOrder.length !== rosterIds.size ||
      new Set(snapshot.resolutionOrder).size !== rosterIds.size ||
      snapshot.resolutionOrder.some((id) => !rosterIds.has(id)) ||
      snapshot.lastTickIntervalMinutes === null
    )
      context.addIssue({
        code: 'custom',
        path: ['resolutionOrder'],
        message:
          'A committed tick requires one ordered entry per active agent and an interval.',
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
    if (
      snapshot.agentGoals.length > 0 &&
      (snapshot.agentGoals.length !== rosterIds.size ||
        new Set(snapshot.agentGoals.map(({ agentId }) => agentId)).size !==
          rosterIds.size ||
        snapshot.agentGoals.some(({ agentId }) => !rosterIds.has(agentId)))
    )
      context.addIssue({
        code: 'custom',
        path: ['agentGoals'],
        message: 'Goal entries must cover the current roster exactly.',
      });
    if (
      snapshot.agentMemories.length > 0 &&
      (snapshot.agentMemories.length !== rosterIds.size ||
        new Set(snapshot.agentMemories.map(({ agentId }) => agentId)).size !==
          rosterIds.size ||
        snapshot.agentMemories.some(
          ({ agentId, entries }) =>
            !rosterIds.has(agentId) ||
            !memoryLedgerForAgentSchema(agentId).safeParse(entries).success,
        ))
    )
      context.addIssue({
        code: 'custom',
        path: ['agentMemories'],
        message: 'Memory ledgers must cover the current roster exactly.',
      });
    if (
      snapshot.behaviorConfiguration &&
      (snapshot.behaviorConfiguration.assignments.length !== rosterIds.size ||
        snapshot.behaviorConfiguration.assignments.some(
          ({ agentId }) => !rosterIds.has(agentId),
        ))
    )
      context.addIssue({
        code: 'custom',
        path: ['behaviorConfiguration'],
        message: 'Behavior assignments must cover the current roster exactly.',
      });
    const authoritative = new Map<AgentId, number>(
      snapshot.world.agents.map(({ id }) => [id, 0]),
    );
    for (const hex of snapshot.world.hexes) {
      if (hex.state === 'infected')
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
      const alliance = snapshot.world.alliances.find(({ memberAgentIds }) =>
        memberAgentIds.includes(entry.agentId),
      );
      if (
        entry.allianceId !== (alliance?.id ?? null) ||
        entry.effectiveColor !== (alliance?.color ?? NEUTRAL_AGENT_COLOR)
      )
        context.addIssue({
          code: 'custom',
          path: ['experiment', 'currentTerritory', index],
          message:
            'Current territory alliance and effective color must be authoritative.',
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
    for (const [
      index,
      summary,
    ] of snapshot.experiment.currentAlliances.entries()) {
      const alliance = snapshot.world.alliances.find(
        ({ id }) => id === summary.allianceId,
      );
      if (
        !alliance ||
        alliance.color !== summary.color ||
        alliance.memberAgentIds.length !== summary.members.length ||
        alliance.memberAgentIds.some(
          (id) => !summary.members.some(({ agentId }) => agentId === id),
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['experiment', 'currentAlliances', index],
          message:
            'Current alliance summary must match authoritative membership.',
        });
      for (const member of summary.members) {
        const territory = snapshot.experiment.currentTerritory.find(
          ({ agentId }) => agentId === member.agentId,
        );
        if (
          !territory ||
          territory.controlledCellCount !== member.controlledCellCount
        )
          context.addIssue({
            code: 'custom',
            path: ['experiment', 'currentAlliances', index, 'members'],
            message:
              'Alliance member territory must match current individual control.',
          });
      }
    }
    if (
      snapshot.experiment.currentAlliances.length !==
      snapshot.world.alliances.length
    )
      context.addIssue({
        code: 'custom',
        path: ['experiment', 'currentAlliances'],
        message: 'Every active alliance requires one current summary.',
      });
  })
  .transform((snapshot) => ({
    ...snapshot,
    agentGoals:
      snapshot.agentGoals.length > 0
        ? snapshot.agentGoals
        : snapshot.world.agents.map(({ id }) => ({ agentId: id, goal: null })),
    agentMemories:
      snapshot.agentMemories.length > 0
        ? snapshot.agentMemories
        : snapshot.world.agents.map(({ id }) => ({ agentId: id, entries: [] })),
    behaviorConfiguration: snapshot.behaviorConfiguration ?? {
      registryVersion: 1 as const,
      assignmentMode: 'balanced-random' as const,
      seed: 'legacy-default-v1',
      assignments: assignBehavior(
        snapshot.world.agents.map(({ id }) => id),
        'legacy-default-v1',
        'balanced-random',
      ),
      locked: snapshot.turnNumber > 0,
    },
  }));
export type SimulationSnapshot = z.infer<typeof simulationSnapshotSchema>;

export const singleTurnResponseSchema = z.object({
  snapshot: simulationSnapshotSchema,
  turn: agentTurnRecordSchema,
});
export type SingleTurnResponse = z.infer<typeof singleTurnResponseSchema>;

export const singleTickResponseSchema = z
  .object({
    snapshot: simulationSnapshotSchema,
    tickNumber: z.number().int().positive(),
    records: z.array(agentTurnRecordSchema).min(1),
  })
  .superRefine((response, context) => {
    const roster = response.snapshot.world.agents.map(({ id }) => id);
    const positions = response.records.map(({ tickPosition }) => tickPosition);
    const agents = response.records.map(({ agentId }) => agentId);
    const first = response.records[0];
    const consistent =
      response.snapshot.tickNumber === response.tickNumber &&
      response.records.length === roster.length &&
      new Set(agents).size === roster.length &&
      agents.every((id) => roster.includes(id)) &&
      positions.every((position, index) => position === index + 1) &&
      response.records.every(
        (record) =>
          record.tickNumber === response.tickNumber &&
          record.virtualTime === first?.virtualTime &&
          record.tickIntervalMinutes === first?.tickIntervalMinutes,
      ) &&
      agents.every(
        (id, index) => response.snapshot.resolutionOrder[index] === id,
      ) &&
      response.snapshot.virtualTime === first?.virtualTime &&
      response.snapshot.lastTickIntervalMinutes === first?.tickIntervalMinutes;
    if (!consistent)
      context.addIssue({
        code: 'custom',
        message:
          'Tick response records must exactly match the committed snapshot and roster.',
      });
  });
export type SingleTickResponse = z.infer<typeof singleTickResponseSchema>;

export const cancelledTurnResponseSchema = z.object({
  snapshot: simulationSnapshotSchema,
  cancelled: z.literal(true),
});
export type CancelledTurnResponse = z.infer<typeof cancelledTurnResponseSchema>;

export const resetSimulationResponseSchema = z.object({
  snapshot: simulationSnapshotSchema,
});
export type ResetSimulationResponse = z.infer<
  typeof resetSimulationResponseSchema
>;
export const cancelSimulationResponseSchema = z.object({
  snapshot: simulationSnapshotSchema,
});

export const updateAgentPersonalityRequestSchema = z
  .object({ personality: personalitySchema })
  .strict();
export type UpdateAgentPersonalityRequest = z.infer<
  typeof updateAgentPersonalityRequestSchema
>;

export const updateAgentPersonalityResponseSchema = z.object({
  snapshot: simulationSnapshotSchema,
  agent: agentSchema,
});
export type UpdateAgentPersonalityResponse = z.infer<
  typeof updateAgentPersonalityResponseSchema
>;

export const restoreDefaultPersonalitiesResponseSchema = z.object({
  snapshot: simulationSnapshotSchema,
});
export type RestoreDefaultPersonalitiesResponse = z.infer<
  typeof restoreDefaultPersonalitiesResponseSchema
>;

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  checkedAt: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorCodeSchema = z.enum([
  'turn_conflict',
  'reset_conflict',
  'personality_conflict',
  'invalid_agent_id',
  'unknown_agent',
  'invalid_personality',
  'invalid_request',
  'invalid_export',
  'invalid_artifact',
  'archive_rejected',
  'archive_persistence_failed',
  'export_conflict',
  'records_unavailable',
  'model_configuration_conflict',
  'invalid_model_configuration',
  'models_unavailable',
  'behavior_configuration_conflict',
  'invalid_behavior_configuration',
  'model_verification_conflict',
  'cancel_conflict',
  'invalid_import',
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

export const personalityConfigurationEventSchema = z.object({
  timestamp: z.iso.datetime(),
  agentId: agentIdSchema,
  previousPersonality: personalitySchema,
  newPersonality: personalitySchema,
  operation: z.enum(['custom-edit', 'restore-default']),
});
export type PersonalityConfigurationEvent = z.infer<
  typeof personalityConfigurationEventSchema
>;

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
export const experimentConfigurationEventSchema = z.union([
  personalityConfigurationEventSchema,
  modelConfigurationEventSchema,
]);
export type ExperimentConfigurationEvent = z.infer<
  typeof experimentConfigurationEventSchema
>;

export const experimentManifestSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      return input;
    const manifest = input as Record<string, unknown>;
    const parsedVersion = agentDecisionContractVersionSchema.safeParse(
      manifest.decisionContractVersion,
    );
    const resolvedVersion = parsedVersion.success
      ? parsedVersion.data
      : LEGACY_AGENT_DECISION_CONTRACT_VERSION;
    const scenario = manifest.scenario;
    return {
      ...manifest,
      decisionContractVersion:
        manifest.decisionContractVersion ?? resolvedVersion,
      ...(typeof scenario === 'object' &&
      scenario !== null &&
      !Array.isArray(scenario) &&
      !('decisionContractVersion' in scenario)
        ? {
            scenario: {
              ...scenario,
              decisionContractVersion: resolvedVersion,
            },
          }
        : {}),
    };
  },
  z
    .object({
      id: experimentIdSchema,
      startedAt: z.iso.datetime(),
      generatedAt: z.iso.datetime().optional(),
      providerMode: providerModeSchema,
      decisionContractVersion: agentDecisionContractVersionSchema,
      modelConfiguration: experimentModelConfigurationSchema.optional(),
      behaviorConfiguration: behaviorConfigurationSchema.optional(),
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
        manifest.scenario.decisionContractVersion !==
          manifest.decisionContractVersion
      )
        context.addIssue({
          code: 'custom',
          path: ['scenario', 'decisionContractVersion'],
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
    publicMessagesRequested: z.number().int().nonnegative().default(0),
    publicMessagesAccepted: z.number().int().nonnegative().default(0),
    publicMessagesRejected: z.number().int().nonnegative().default(0),
    directMessagesRequested: z.number().int().nonnegative().default(0),
    directMessagesDelivered: z.number().int().nonnegative().default(0),
    directMessagesRejected: z.number().int().nonnegative().default(0),
    allianceMessagesRequested: z.number().int().nonnegative().default(0),
    allianceMessagesDelivered: z.number().int().nonnegative().default(0),
    allianceMessagesRejected: z.number().int().nonnegative().default(0),
    zeroBroadcastsRequested: z.number().int().nonnegative().default(0),
    zeroBroadcastsDelivered: z.number().int().nonnegative().default(0),
    zeroBroadcastsRejected: z.number().int().nonnegative().default(0),
    zeroRecipientDeliveries: z.number().int().nonnegative().default(0),
    uniqueZeroDirectiveRecipients: z.number().int().nonnegative().default(0),
    directRepliesToPatientZero: z.number().int().nonnegative().default(0),
    uniquePatientZeroRepliers: z.number().int().nonnegative().default(0),
    firstZeroDirectiveTurn: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null),
    mostRecentZeroDirective: z
      .object({
        eventId: eventIdSchema,
        turnNumber: z.number().int().positive(),
        occurredAt: z.iso.datetime(),
        agentId: agentIdSchema,
        recipientCount: z.number().int().nonnegative(),
        modelId: modelIdSchema,
        reasoningProfile: reasoningProfileSchema,
        personalityId: personalityProfileIdSchema,
        strategyId: strategyProfileIdSchema,
      })
      .nullable()
      .default(null),
    publicMessagesSent: z.number().int().nonnegative().default(0),
    directMessagesSent: z.number().int().nonnegative().default(0),
    directMessagesReceived: z.number().int().nonnegative().default(0),
    uniqueDirectMessagePairs: z.number().int().nonnegative().default(0),
    directMessageDistanceTotalKm: z.number().nonnegative().default(0),
    directMessageDistanceAverageKm: z.number().nonnegative().default(0),
    directMessageDistanceMaximumKm: z.number().nonnegative().default(0),
    eligibleNearbyAgentObservations: z.number().int().nonnegative().default(0),
    firstAllianceTurn: z.number().int().positive().nullable().default(null),
    maximumAllianceSize: z.number().int().nonnegative().default(0),
    completedAllianceDurationTurnsTotal: z
      .number()
      .int()
      .nonnegative()
      .default(0),
    completedAllianceDurationTurnsAverage: z.number().nonnegative().default(0),
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
    directionChangesAfterCommunication: z
      .number()
      .int()
      .nonnegative()
      .default(0),
    diplomacyProposalsRequested: z.number().int().nonnegative().default(0),
    diplomacyAcceptancesRequested: z.number().int().nonnegative().default(0),
    diplomacyDeparturesRequested: z.number().int().nonnegative().default(0),
    diplomacyProposalsAccepted: z.number().int().nonnegative().default(0),
    diplomacyAcceptancesAccepted: z.number().int().nonnegative().default(0),
    diplomacyDeparturesAccepted: z.number().int().nonnegative().default(0),
    diplomacyRejected: z.number().int().nonnegative().default(0),
    diplomacyRejections: z
      .array(
        z.object({
          type: z.enum([
            'propose-alliance',
            'accept-alliance',
            'leave-alliance',
            'invalid',
          ]),
          reason: diplomacyRejectionReasonSchema,
          count: z.number().int().positive(),
        }),
      )
      .max(48)
      .default([]),
    proposalsCreated: z.number().int().nonnegative().default(0),
    proposalsSent: z.number().int().nonnegative().default(0),
    proposalsReceived: z.number().int().nonnegative().default(0),
    proposalsExpired: z.number().int().nonnegative().default(0),
    proposalsInvalidated: z.number().int().nonnegative().default(0),
    alliancesFormed: z.number().int().nonnegative().default(0),
    alliancesJoined: z.number().int().nonnegative().default(0),
    alliancesLeft: z.number().int().nonnegative().default(0),
    alliancesDissolved: z.number().int().nonnegative().default(0),
    alliedCaptureAttempts: z.number().int().nonnegative().default(0),
    alliedCaptureRejections: z.number().int().nonnegative().default(0),
    uniqueVisitedCells: z.number().int().nonnegative(),
    averageLatencyMs: z.number().nonnegative().optional(),
    tokens: tokenTotalsSchema,
    tokenUsageComplete: z.boolean().default(true),
    attemptsWithUnknownTokenUsage: z.number().int().nonnegative().default(0),
    knownCostCredits: z.number().nonnegative().finite(),
    attemptsWithUnknownCost: z.number().int().nonnegative().default(0),
    turnsWithUnknownCost: z.number().int().nonnegative(),
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
  byPersonality: z
    .array(
      z.object({
        personalityId: personalityProfileIdSchema,
        metrics: metricCountsSchema,
      }),
    )
    .default([]),
  byStrategy: z
    .array(
      z.object({
        strategyId: strategyProfileIdSchema,
        metrics: metricCountsSchema,
      }),
    )
    .default([]),
  byBehaviorCombination: z
    .array(
      z.object({
        personalityId: personalityProfileIdSchema,
        strategyId: strategyProfileIdSchema,
        metrics: metricCountsSchema,
      }),
    )
    .max(36)
    .default([]),
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
export const exportCommunicationChannelSchema = z.enum([
  'all',
  'public',
  'direct',
  'alliance',
  'zero',
]);
export const exportCommunicationStatusSchema = z.enum([
  'all',
  'accepted',
  'rejected',
]);
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
    personalityTextHistory: z.boolean(),
    nearbyAgents: z.boolean(),
    recentEvents: z.boolean(),
    recentPublicMessages: z.boolean(),
    recentDirectMessages: z.boolean(),
    recentControlChanges: z.boolean(),
    validationDetails: z.boolean(),
    resultingEvents: z.boolean(),
    providerUsageMetadata: z.boolean(),
    initialWorldState: z.boolean(),
    currentWorldState: z.boolean(),
    computedMetrics: z.boolean(),
    communications: z.boolean(),
    controlChanges: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !value.turnObservations &&
      (value.nearbyAgents ||
        value.recentEvents ||
        value.recentPublicMessages ||
        value.recentDirectMessages ||
        value.recentControlChanges)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Nearby agents, recent events, recent messages, and recent control changes require turn observations.',
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
    communications: z
      .object({
        channel: exportCommunicationChannelSchema,
        status: exportCommunicationStatusSchema,
      })
      .strict()
      .default({ channel: 'all', status: 'all' }),
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
  matchingTurnCount: z.number().int().nonnegative(),
  matchingTickCount: z.number().int().nonnegative().optional(),
  matchingCommunicationCount: z.number().int().nonnegative(),
  matchingControlChangeCount: z.number().int().nonnegative(),
  matchingDiplomacyEventCount: z.number().int().nonnegative(),
  selectedAgentCount: z
    .number()
    .int()
    .positive()
    .max(WORLD_SCENARIO_LIMITS.maximumAgents),
  firstMatchingTurn: z.number().int().positive().optional(),
  lastMatchingTurn: z.number().int().positive().optional(),
  retention: experimentRetentionSchema,
  knownCostCredits: z.number().nonnegative().finite(),
  attemptsWithUnknownCost: z.number().int().nonnegative().default(0),
  turnsWithUnknownCost: z.number().int().nonnegative(),
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

export const experimentExportTurnSchema = z
  .object({
    turnNumber: z.number().int().positive(),
    tickNumber: z.number().int().positive().optional(),
    tickPosition: z.number().int().positive().optional(),
    virtualTime: z.iso.datetime().optional(),
    tickIntervalMinutes: z.number().int().positive().optional(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    agentId: agentIdSchema,
    behavior: behaviorAssignmentSchema.optional(),
    outcome: exportOutcomeSchema,
    worldAction: worldActionSchema.optional(),
    communication: communicationIntentSchema.optional(),
    diplomacy: diplomacyIntentSchema.optional(),
    goalRevision: requestedGoalRevisionSchema.optional(),
    memoryOperation: requestedMemoryOperationSchema.optional(),
    summary: z.string().trim().min(1).max(MODEL_SUMMARY_MAX_LENGTH).optional(),
    worldActionSummary: z.string().trim().min(1).max(300).optional(),
    communicationSummary: z.string().trim().min(1).max(300).optional(),
    diplomacySummary: z.string().trim().min(1).max(300).optional(),
    personality: personalitySchema.optional(),
    observation: agentObservationObjectSchema.partial().optional(),
    worldActionResult: worldActionResultSchema.optional(),
    communicationResult: communicationResultSchema.optional(),
    diplomacyResult: diplomacyResultSchema.optional(),
    goalRevisionResult: goalRevisionResultSchema.optional(),
    memoryOperationResult: memoryOperationResultSchema.optional(),
    failure: providerFailureSchema.optional(),
    provider: providerMetadataSchema.optional(),
    modelAttempts: z.array(modelAttemptSchema).max(1_000).default([]),
  })
  .superRefine((turn, context) => {
    const fields = [
      turn.tickNumber,
      turn.tickPosition,
      turn.virtualTime,
      turn.tickIntervalMinutes,
    ];
    if (
      fields.some((value) => value !== undefined) &&
      fields.some((value) => value === undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Export tick metadata must be present together.',
      });
  });

export const experimentExportWorldStateSchema = worldSnapshotObjectSchema
  .omit({ events: true })
  .superRefine(validateWorldControllers);

export const exportedCommunicationSchema = z
  .object({
    id: eventIdSchema,
    agentId: agentIdSchema,
    channel: z.enum(['public', 'direct', 'alliance', 'zero']),
    recipientId: agentIdSchema.nullable().optional(),
    recipientIds: z.array(agentIdSchema).optional(),
    message: messageContentSchema,
    distance: z.number().nonnegative().nullable().optional(),
    occurredAt: z.iso.datetime(),
    originatingTurn: z.number().int().positive(),
    status: z.enum(['accepted', 'rejected']),
    rejectionReason: communicationRejectionReasonSchema.optional(),
    rejectionDetails: z.string().min(1).max(300).optional(),
  })
  .superRefine((communication, context) => {
    if (
      communication.channel === 'direct' &&
      (communication.recipientId === undefined ||
        communication.distance === undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Direct communication requires a recipient and distance.',
      });
    if (
      communication.channel === 'direct' &&
      communication.status === 'accepted' &&
      (communication.recipientId === null || communication.distance === null)
    )
      context.addIssue({
        code: 'custom',
        message: 'Accepted direct communication requires a valid recipient.',
      });
    if (
      communication.channel !== 'direct' &&
      (communication.recipientId !== undefined ||
        communication.distance !== undefined)
    )
      context.addIssue({
        code: 'custom',
        message:
          'Non-direct communication cannot have a recipient or distance.',
      });
    if (
      (communication.channel === 'public' ||
        communication.channel === 'direct') &&
      communication.recipientIds !== undefined
    )
      context.addIssue({
        code: 'custom',
        message: 'Public and direct communication cannot have recipient IDs.',
      });
    if (
      communication.channel === 'zero' &&
      communication.status === 'accepted' &&
      communication.recipientIds === undefined
    )
      context.addIssue({
        code: 'custom',
        message: 'Accepted Zero communication requires recipient IDs.',
      });
    if (
      communication.status === 'rejected' &&
      (!communication.rejectionReason || !communication.rejectionDetails)
    )
      context.addIssue({
        code: 'custom',
        message: 'Rejected communication requires a safe rejection reason.',
      });
  });
export const exportedControlChangeSchema = hexCapturedWorldEventSchema.extend({
  originatingTurn: z.number().int().positive(),
});
export type ExportedControlChange = z.infer<typeof exportedControlChangeSchema>;
export type ExportedCommunication = z.infer<typeof exportedCommunicationSchema>;
export type ExperimentExportWorldState = z.infer<
  typeof experimentExportWorldStateSchema
>;

export const experimentExportDocumentSchema = z
  .object({
    schemaVersion: z.union([z.literal(9), z.literal(10)]),
    generatedAt: z.iso.datetime(),
    experiment: experimentManifestSchema,
    retention: experimentRetentionSchema,
    filters: experimentExportRequestSchema,
    selection: z.object({
      selectedAgentIds: z
        .array(agentIdSchema)
        .min(1)
        .max(WORLD_SCENARIO_LIMITS.maximumAgents),
      matchingTurnCount: z.number().int().nonnegative(),
      matchingTickCount: z.number().int().nonnegative().optional(),
      matchingCommunicationCount: z.number().int().nonnegative(),
      matchingControlChangeCount: z.number().int().nonnegative(),
      matchingDiplomacyEventCount: z.number().int().nonnegative(),
      firstMatchingTurn: z.number().int().positive().optional(),
      lastMatchingTurn: z.number().int().positive().optional(),
    }),
    agents: z
      .array(
        agentProfileSchema.omit({ personality: true }).extend({
          personality: personalitySchema.optional(),
        }),
      )
      .min(1)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents),
    configurationEvents: z.array(experimentConfigurationEventSchema).optional(),
    metrics: experimentMetricsSchema.optional(),
    currentTerritory: territoryScoreboardSchema.optional(),
    currentAlliances: z
      .array(allianceTerritorySummarySchema)
      .max(WORLD_SCENARIO_LIMITS.maximumAgents)
      .optional(),
    currentGoals: z
      .array(
        z
          .object({
            agentId: agentIdSchema,
            goal: agentGoalStateSchema.nullable(),
          })
          .strict(),
      )
      .max(WORLD_SCENARIO_LIMITS.maximumAgents)
      .optional(),
    currentMemories: z
      .array(
        z
          .object({ agentId: agentIdSchema, entries: memoryLedgerSchema })
          .strict(),
      )
      .max(WORLD_SCENARIO_LIMITS.maximumAgents)
      .optional(),
    initialWorld: experimentExportWorldStateSchema.optional(),
    currentWorld: experimentExportWorldStateSchema.optional(),
    worldEvents: z.array(nonCommunicationWorldEventSchema).optional(),
    communications: z.array(exportedCommunicationSchema).optional(),
    controlChanges: z.array(exportedControlChangeSchema).optional(),
    allianceEvents: z.array(allianceEventSchema).optional(),
    tickSummaries: z.array(experimentTickSummarySchema).optional(),
    turns: z.array(experimentExportTurnSchema),
  })
  .superRefine((document, context) => {
    if (document.currentGoals) {
      const selectedIds = new Set(document.selection.selectedAgentIds);
      const agentIds = new Set(document.agents.map(({ id }) => id));
      if (
        new Set(document.currentGoals.map(({ agentId }) => agentId)).size !==
        document.currentGoals.length
      )
        context.addIssue({
          code: 'custom',
          path: ['currentGoals'],
          message: 'Current goal agent IDs must be unique.',
        });
      if (
        document.currentGoals.some(
          ({ agentId }) => !selectedIds.has(agentId) || !agentIds.has(agentId),
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['currentGoals'],
          message: 'Current goals must belong to selected exported agents.',
        });
      if (
        document.currentGoals.length !== document.agents.length ||
        document.agents.some(
          ({ id }) =>
            !document.currentGoals?.some(({ agentId }) => agentId === id),
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['currentGoals'],
          message:
            'Current goals must cover every exported agent exactly once.',
        });
    }
    if (document.currentMemories) {
      const exportedIds = new Set(document.agents.map(({ id }) => id));
      const selectedIds = new Set(document.selection.selectedAgentIds);
      if (
        document.currentMemories.length !== document.agents.length ||
        new Set(document.currentMemories.map(({ agentId }) => agentId)).size !==
          document.currentMemories.length ||
        document.currentMemories.some(
          ({ agentId, entries }) =>
            !exportedIds.has(agentId) ||
            !selectedIds.has(agentId) ||
            !memoryLedgerForAgentSchema(agentId).safeParse(entries).success,
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['currentMemories'],
          message:
            'Current memories must cover every exported agent exactly once.',
        });
    }
    const hasTickMetadata = (turn: (typeof document.turns)[number]) =>
      turn.tickNumber !== undefined &&
      turn.tickPosition !== undefined &&
      turn.virtualTime !== undefined &&
      turn.tickIntervalMinutes !== undefined;
    if (document.schemaVersion === 9 && document.turns.some(hasTickMetadata))
      context.addIssue({
        code: 'custom',
        message: 'Schema-v9 turns cannot claim simultaneous tick metadata.',
      });
    if (document.schemaVersion === 10) {
      if (document.tickSummaries === undefined)
        context.addIssue({
          code: 'custom',
          message: 'Schema-v10 exports require canonical tick summaries.',
        });
      if (document.selection.matchingTickCount === undefined)
        context.addIssue({
          code: 'custom',
          message: 'Schema-v10 exports require a matching tick count.',
        });
      if (document.turns.some((turn) => !hasTickMetadata(turn)))
        context.addIssue({
          code: 'custom',
          message: 'Every schema-v10 turn requires complete tick metadata.',
        });
      const groups = new Map<number, typeof document.turns>();
      for (const turn of document.turns) {
        if (turn.tickNumber === undefined) continue;
        groups.set(turn.tickNumber, [
          ...(groups.get(turn.tickNumber) ?? []),
          turn,
        ]);
      }
      for (const [tick, records] of groups) {
        const first = records[0];
        const summary = document.tickSummaries?.find(
          ({ tickNumber }) => tickNumber === tick,
        );
        if (
          new Set(records.map(({ agentId }) => agentId)).size !==
            records.length ||
          new Set(records.map(({ tickPosition }) => tickPosition)).size !==
            records.length ||
          records.some(
            (record) =>
              record.virtualTime !== first?.virtualTime ||
              record.tickIntervalMinutes !== first?.tickIntervalMinutes,
          )
        )
          context.addIssue({
            code: 'custom',
            message: `Schema-v10 tick ${tick} is internally inconsistent.`,
          });
        if (
          !summary ||
          summary.agentRecordCount !== records.length ||
          summary.virtualTime !== first?.virtualTime ||
          summary.intervalMinutes !== first?.tickIntervalMinutes
        )
          context.addIssue({
            code: 'custom',
            message: `Schema-v10 tick ${tick} summary does not match its records.`,
          });
      }
      if (
        document.tickSummaries !== undefined &&
        (new Set(document.tickSummaries.map(({ tickNumber }) => tickNumber))
          .size !== document.tickSummaries.length ||
          document.tickSummaries.length !== groups.size ||
          document.selection.matchingTickCount !== groups.size)
      )
        context.addIssue({
          code: 'custom',
          message:
            'Schema-v10 tick counts and summaries must match exported records.',
        });
    }
    if (document.schemaVersion === 9 && document.tickSummaries !== undefined)
      context.addIssue({
        code: 'custom',
        message: 'Schema-v9 exports cannot contain tick summaries.',
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
    if (Boolean(document.currentAlliances) !== Boolean(requiresMetrics))
      context.addIssue({
        code: 'custom',
        message: 'Current alliance inclusion does not match the export level.',
      });
    const personalityHistory =
      level === 'full-safe' || custom?.personalityTextHistory;
    if (personalityHistory && document.configurationEvents === undefined)
      context.addIssue({
        code: 'custom',
        message:
          'Personality history inclusion does not match the export level.',
      });
    if (
      !personalityHistory &&
      document.configurationEvents?.some((event) => !('type' in event))
    )
      context.addIssue({
        code: 'custom',
        message:
          'Personality history inclusion does not match the export level.',
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
    const communications = level !== 'custom' || custom?.communications;
    if (Boolean(document.communications) !== Boolean(communications))
      context.addIssue({
        code: 'custom',
        message: 'Communication inclusion does not match the export level.',
      });
    const controlChanges = level !== 'custom' || custom?.controlChanges;
    if (Boolean(document.controlChanges) !== Boolean(controlChanges))
      context.addIssue({
        code: 'custom',
        message: 'Control-change inclusion does not match the export level.',
      });
    for (const turn of document.turns) {
      const observation =
        level === 'standard' ||
        level === 'full-safe' ||
        custom?.turnObservations;
      const personality =
        level === 'standard' ||
        level === 'full-safe' ||
        custom?.personalityTextHistory;
      const validation =
        level === 'standard' ||
        level === 'full-safe' ||
        custom?.validationDetails;
      const event =
        level === 'standard' ||
        level === 'full-safe' ||
        custom?.resultingEvents;
      const provider = level !== 'custom' || custom?.providerUsageMetadata;
      const results = Boolean(validation || event);
      if (
        Boolean(turn.observation) !== Boolean(observation) ||
        Boolean(turn.personality) !== Boolean(personality)
      )
        context.addIssue({
          code: 'custom',
          message: 'Turn context inclusion does not match the export level.',
        });
      if (
        turn.outcome !== 'provider-error' &&
        turn.outcome !== 'lost-tick' &&
        turn.outcome !== 'operator-skipped' &&
        (Boolean(turn.worldActionResult) !== results ||
          Boolean(turn.communicationResult) !== results ||
          Boolean(turn.diplomacyResult) !== results)
      )
        context.addIssue({
          code: 'custom',
          message: 'Validation inclusion does not match the export level.',
        });
      if (!provider && turn.provider)
        context.addIssue({
          code: 'custom',
          message: 'Provider inclusion does not match the export level.',
        });
    }
  });
export type ExperimentExportDocument = z.infer<
  typeof experimentExportDocumentSchema
>;

export const experimentExportResponseSchema = z.object({
  document: experimentExportDocumentSchema,
});
export const archiveExperimentExportRequestSchema = z
  .object({ document: experimentExportDocumentSchema })
  .strict();
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
export const experimentImportRequestSchema = z
  .object({ document: z.unknown() })
  .strict();
export const experimentImportResponseSchema = z.object({
  snapshot: simulationSnapshotSchema,
  legacy: z.boolean(),
  message: z.string().trim().min(1).max(300),
});
