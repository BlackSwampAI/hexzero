import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import {
  BrowserTestAgentProvider,
  AgentProviderError,
  OpenRouterModelCatalog,
  OpenRouterAgentProvider,
  type AgentProvider,
} from '@hexzero/agent-runtime';
import {
  archiveExperimentExportRequestSchema,
  archiveExperimentExportResponseSchema,
  apiErrorSchema,
  AGENT_DECISION_CONTRACT_VERSION,
  cancelSimulationResponseSchema,
  cancelledTurnResponseSchema,
  experimentExportRequestSchema,
  experimentExportPreviewSchema,
  experimentExportResponseSchema,
  experimentImportRequestSchema,
  experimentImportResponseSchema,
  healthResponseSchema,
  modelCatalogResponseSchema,
  modelVerificationSchema,
  PERSONALITY_MAX_LENGTH,
  resetSimulationResponseSchema,
  restoreDefaultPersonalitiesResponseSchema,
  simulationSnapshotSchema,
  singleTurnResponseSchema,
  singleTickResponseSchema,
  updateAgentPersonalityRequestSchema,
  updateAgentPersonalityResponseSchema,
  updateExperimentModelsRequestSchema,
  updateExperimentModelsResponseSchema,
  updateExperimentBehaviorRequestSchema,
  updateExperimentBehaviorResponseSchema,
  verifyModelRequestSchema,
  verifyModelResponseSchema,
  worldSnapshotSchema,
  worldSetupRequestSchema,
  worldSetupPreviewResponseSchema,
  applyWorldSetupResponseSchema,
  generatedAgentRequestSchema,
  generatedAgentResponseSchema,
  locationSearchRequestSchema,
  locationSearchResponseSchema,
  defaultWorldSetupResponseSchema,
  type ModelVerification,
  type ArchiveExperimentExportResponse,
  type ExperimentExportDocument,
} from '@hexzero/shared';
import {
  ArchiveDatabase,
  ArchivePersistenceError,
  ExperimentImportError,
  importExperimentExport,
} from '@hexzero/experiment-archive';
import {
  createDevelopmentWorld,
  generateDeterministicRoster,
} from '@hexzero/world-engine';
import {
  SimulationConflictError,
  SimulationService,
  SimulationTurnCancelledError,
  SimulationValidationError,
} from './simulation-service';
import { ExperimentExportValidationError } from './experiment-export';
import { NominatimGeocoder, type Geocoder } from './geocoder';

export { healthResponseSchema };

export interface AppOptions {
  service?: SimulationService;
  provider?: AgentProvider;
  catalog?: Pick<OpenRouterModelCatalog, 'getCatalog'>;
  geocoder?: Geocoder;
  archiveExperimentExport?: (
    document: ExperimentExportDocument,
  ) =>
    ArchiveExperimentExportResponse | Promise<ArchiveExperimentExportResponse>;
}

async function archiveExperimentExportDefault(
  document: ExperimentExportDocument,
): Promise<ArchiveExperimentExportResponse> {
  const archive = new ArchiveDatabase();
  try {
    const report = importExperimentExport(archive, document);
    return archiveExperimentExportResponseSchema.parse({
      experimentId: report.experimentId,
      inserted: report.inserted,
      existing: report.existing,
      skipped: report.skipped,
      rejected: report.rejected,
      idempotent: report.inserted === 0 && report.rejected === 0,
    });
  } finally {
    archive.close();
  }
}

export function resolveProviderModeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): string | undefined {
  if (environment.HEXZERO_PROVIDER !== undefined)
    return environment.HEXZERO_PROVIDER;
  if (environment.AGENTBORNE_PROVIDER !== undefined) {
    warn(
      'AGENTBORNE_PROVIDER is deprecated; use HEXZERO_PROVIDER. Continuing with the legacy setting.',
    );
    return environment.AGENTBORNE_PROVIDER;
  }
  return undefined;
}

export function providerFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): AgentProvider {
  if (resolveProviderModeFromEnvironment(environment, warn) === 'scripted') {
    return new BrowserTestAgentProvider();
  }
  return new OpenRouterAgentProvider({
    apiKey: environment.OPENROUTER_API_KEY,
  });
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono();
  const service =
    options.service ??
    new SimulationService({
      provider: options.provider ?? providerFromEnvironment(),
    });
  const catalog =
    options.catalog ??
    new OpenRouterModelCatalog({ apiKey: process.env.OPENROUTER_API_KEY });
  const modelVerifications = new Map<string, ModelVerification>();
  const geocoder = options.geocoder ?? new NominatimGeocoder();
  const archiveExperimentExport =
    options.archiveExperimentExport ?? archiveExperimentExportDefault;
  const turnMutations = new Map<string, Promise<unknown>>();
  const mutationPromise = <T>(
    context: Context,
    operation:
      | 'turn'
      | 'tick'
      | 'retry'
      | 'unattended-retry'
      | 'unattended-skip'
      | 'setup',
    execute: () => Promise<T>,
  ): Promise<T> => {
    const supplied =
      context.req.header('x-hexzero-mutation-id') ??
      context.req.query('mutationId');
    const mutationId =
      supplied && /^[A-Za-z0-9_-]{8,80}$/.test(supplied) ? supplied : undefined;
    if (!mutationId) return execute();
    const key = `${operation}:${mutationId}`;
    const existing = turnMutations.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const pending = execute();
    turnMutations.set(key, pending);
    if (turnMutations.size > 200)
      turnMutations.delete(turnMutations.keys().next().value!);
    pending.catch(() => turnMutations.delete(key));
    return pending;
  };

  app.use(
    '/api/*',
    cors({
      origin: (origin) =>
        ['http://localhost:3000', 'http://127.0.0.1:3000'].includes(origin)
          ? origin
          : null,
      allowMethods: ['GET', 'POST'],
      allowHeaders: ['Content-Type', 'X-Hexzero-Mutation-Id'],
    }),
  );

  app.get('/health', (context) =>
    context.json(
      healthResponseSchema.parse({
        status: 'ok',
        checkedAt: new Date().toISOString(),
      }),
    ),
  );

  app.get('/api/development-world', (context) =>
    context.json(worldSnapshotSchema.parse(createDevelopmentWorld())),
  );

  app.get('/api/simulation', (context) =>
    context.json(simulationSnapshotSchema.parse(service.getSnapshot())),
  );

  app.post('/api/simulation/experiment/setup/preview', async (context) => {
    return context.json(
      worldSetupPreviewResponseSchema.parse(
        service.previewWorldSetup(
          await context.req.json().catch(() => undefined),
        ),
      ),
    );
  });

  app.get('/api/simulation/experiment/setup/default', (context) =>
    context.json(
      defaultWorldSetupResponseSchema.parse({
        request: service.getDefaultWorldSetup(),
      }),
    ),
  );

  app.post('/api/simulation/experiment/setup', async (context) => {
    const request = worldSetupRequestSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!request.success)
      return context.json(
        apiErrorSchema.parse({
          error: {
            code: 'invalid_request',
            message: 'The scenario setup request is invalid.',
          },
        }),
        400,
      );
    try {
      const snapshot = await mutationPromise(context, 'setup', async () =>
        service.applyWorldSetup(request.data),
      );
      return context.json(applyWorldSetupResponseSchema.parse({ snapshot }));
    } catch (error) {
      if (error instanceof SimulationConflictError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: 'setup_conflict', message: error.message },
          }),
          409,
        );
      if (error instanceof SimulationValidationError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: 'invalid_request', message: error.message },
          }),
          400,
        );
      throw error;
    }
  });

  app.post(
    '/api/simulation/experiment/setup/roster/generate',
    async (context) => {
      const request = generatedAgentRequestSchema.safeParse(
        await context.req.json().catch(() => undefined),
      );
      if (!request.success)
        return context.json(
          apiErrorSchema.parse({
            error: {
              code: 'invalid_request',
              message: 'A valid roster count and seed are required.',
            },
          }),
          400,
        );
      return context.json(
        generatedAgentResponseSchema.parse({
          roster: generateDeterministicRoster(
            request.data.count,
            request.data.seed,
          ),
        }),
      );
    },
  );

  app.post(
    '/api/simulation/experiment/setup/location-search',
    async (context) => {
      const request = locationSearchRequestSchema.safeParse(
        await context.req.json().catch(() => undefined),
      );
      if (!request.success)
        return context.json(
          apiErrorSchema.parse({
            error: {
              code: 'invalid_request',
              message: 'Enter a location query between 2 and 120 characters.',
            },
          }),
          400,
        );
      return context.json(
        locationSearchResponseSchema.parse(
          await geocoder.search(request.data.query),
        ),
      );
    },
  );

  app.get('/api/simulation/models', async (context) => {
    const response = modelCatalogResponseSchema.parse(
      await catalog.getCatalog(false),
    );
    service.setCompatibleModels(response.models);
    return context.json(response);
  });

  app.post('/api/simulation/models/refresh', async (context) => {
    const response = modelCatalogResponseSchema.parse(
      await catalog.getCatalog(true),
    );
    service.setCompatibleModels(response.models);
    return context.json(response);
  });

  app.post('/api/simulation/models/verify', async (context) => {
    const request = verifyModelRequestSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!request.success)
      return context.json(
        apiErrorSchema.parse({
          error: {
            code: 'invalid_request',
            message: 'A valid model ID is required.',
          },
        }),
        400,
      );
    const cacheKey = `${request.data.modelId}:${request.data.reasoningProfile}:${AGENT_DECISION_CONTRACT_VERSION}`;
    const cached = modelVerifications.get(cacheKey);
    if (cached && !request.data.force)
      return context.json(
        verifyModelResponseSchema.parse({ verification: cached }),
      );
    const currentCatalog = modelCatalogResponseSchema.parse(
      await catalog.getCatalog(false),
    );
    service.setCompatibleModels(currentCatalog.models);
    try {
      const provider = await service.verifyModel(
        request.data.modelId,
        request.data.reasoningProfile,
      );
      const verification = modelVerificationSchema.parse({
        modelId: request.data.modelId,
        reasoningProfile: request.data.reasoningProfile,
        contractVersion: AGENT_DECISION_CONTRACT_VERSION,
        status: 'verified',
        testedAt: new Date().toISOString(),
        provider,
      });
      modelVerifications.set(cacheKey, verification);
      return context.json(verifyModelResponseSchema.parse({ verification }));
    } catch (error) {
      if (error instanceof AgentProviderError) {
        const verification = modelVerificationSchema.parse({
          modelId: request.data.modelId,
          reasoningProfile: request.data.reasoningProfile,
          contractVersion: AGENT_DECISION_CONTRACT_VERSION,
          status: 'failed',
          testedAt: new Date().toISOString(),
          failure: {
            code: error.failure.code,
            message: error.failure.providerMessage
              ? `${error.failure.message} ${error.failure.providerMessage}`.slice(
                  0,
                  240,
                )
              : error.failure.message,
          },
          provider: error.metadata,
        });
        modelVerifications.set(cacheKey, verification);
        return context.json(verifyModelResponseSchema.parse({ verification }));
      }
      if (error instanceof SimulationConflictError)
        return context.json(
          apiErrorSchema.parse({
            error: {
              code: 'model_verification_conflict',
              message: error.message,
            },
          }),
          409,
        );
      if (error instanceof SimulationValidationError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: error.code, message: error.message },
          }),
          400,
        );
      throw error;
    }
  });

  app.post('/api/simulation/experiment/models', async (context) => {
    const request = updateExperimentModelsRequestSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!request.success)
      return context.json(
        apiErrorSchema.parse({
          error: {
            code: 'invalid_model_configuration',
            message: 'The model assignment is invalid.',
          },
        }),
        400,
      );
    const currentCatalog = modelCatalogResponseSchema.parse(
      await catalog.getCatalog(false),
    );
    service.setCompatibleModels(currentCatalog.models);
    try {
      return context.json(
        updateExperimentModelsResponseSchema.parse({
          snapshot: service.updateModelConfiguration(request.data),
        }),
      );
    } catch (error) {
      if (error instanceof SimulationConflictError)
        return context.json(
          apiErrorSchema.parse({
            error: {
              code: 'model_configuration_conflict',
              message: error.message,
            },
          }),
          409,
        );
      if (error instanceof SimulationValidationError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: error.code, message: error.message },
          }),
          error.code === 'unknown_agent' ? 404 : 400,
        );
      throw error;
    }
  });

  app.post('/api/simulation/experiment/behavior', async (context) => {
    const request = updateExperimentBehaviorRequestSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!request.success)
      return context.json(
        apiErrorSchema.parse({
          error: {
            code: 'invalid_behavior_configuration',
            message: 'The behavior configuration is invalid.',
          },
        }),
        400,
      );
    try {
      return context.json(
        updateExperimentBehaviorResponseSchema.parse({
          snapshot: service.updateBehaviorConfiguration(request.data),
        }),
      );
    } catch (error) {
      if (error instanceof SimulationConflictError)
        return context.json(
          apiErrorSchema.parse({
            error: {
              code: 'behavior_configuration_conflict',
              message: error.message,
            },
          }),
          409,
        );
      if (error instanceof SimulationValidationError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: error.code, message: error.message },
          }),
          400,
        );
      throw error;
    }
  });

  app.post('/api/simulation/turn', async (context) => {
    try {
      const turn = await mutationPromise(context, 'turn', () =>
        service.executeNextTurn(),
      );
      return context.json(
        singleTurnResponseSchema.parse({
          snapshot: service.getSnapshot(),
          turn,
        }),
      );
    } catch (error) {
      if (error instanceof SimulationTurnCancelledError)
        return context.json(
          cancelledTurnResponseSchema.parse({
            snapshot: service.getSnapshot(),
            cancelled: true,
          }),
        );
      if (error instanceof SimulationConflictError) {
        return context.json(
          apiErrorSchema.parse({
            error: { code: 'turn_conflict', message: error.message },
          }),
          409,
        );
      }
      if (
        error instanceof SimulationValidationError &&
        error.code === 'models_unavailable'
      )
        return context.json(
          apiErrorSchema.parse({
            error: { code: error.code, message: error.message },
          }),
          409,
        );
      if (error instanceof SimulationValidationError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: 'invalid_request', message: error.message },
          }),
          400,
        );
      throw error;
    }
  });

  app.post('/api/simulation/tick', async (context) => {
    try {
      const response = await mutationPromise(context, 'tick', async () => {
        const records = await service.executeNextTick();
        return singleTickResponseSchema.parse({
          snapshot: service.getSnapshot(),
          tickNumber: records[0]!.tickNumber,
          records,
        });
      });
      return context.json(response);
    } catch (error) {
      if (error instanceof SimulationTurnCancelledError)
        return context.json(
          cancelledTurnResponseSchema.parse({
            snapshot: service.getSnapshot(),
            cancelled: true,
          }),
        );
      if (error instanceof SimulationConflictError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: 'tick_conflict', message: error.message },
          }),
          409,
        );
      if (error instanceof SimulationValidationError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: error.code, message: error.message },
          }),
          409,
        );
      throw error;
    }
  });

  app.post('/api/simulation/turn/cancel', (context) => {
    try {
      return context.json(
        cancelSimulationResponseSchema.parse({
          snapshot: service.cancelCurrentRequest(),
        }),
      );
    } catch (error) {
      if (error instanceof SimulationConflictError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: 'cancel_conflict', message: error.message },
          }),
          409,
        );
      throw error;
    }
  });
  app.post('/api/simulation/tick/cancel', (context) => {
    try {
      return context.json(
        cancelSimulationResponseSchema.parse({
          snapshot: service.cancelCurrentRequest(),
        }),
      );
    } catch (error) {
      if (error instanceof SimulationConflictError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: 'tick_cancel_conflict', message: error.message },
          }),
          409,
        );
      throw error;
    }
  });

  const respondToManualTurn = async (
    context: Context,
    operation: 'retry' | 'skip',
  ) => {
    try {
      const turn =
        operation === 'retry'
          ? await mutationPromise(context, 'retry', () =>
              service.retryFailedTurn(),
            )
          : service.skipFailedTurn();
      return context.json(
        singleTurnResponseSchema.parse({
          snapshot: service.getSnapshot(),
          turn,
        }),
      );
    } catch (error) {
      if (error instanceof SimulationTurnCancelledError)
        return context.json(
          cancelledTurnResponseSchema.parse({
            snapshot: service.getSnapshot(),
            cancelled: true,
          }),
        );
      if (error instanceof SimulationConflictError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: 'turn_conflict', message: error.message },
          }),
          409,
        );
      if (error instanceof SimulationValidationError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: error.code, message: error.message },
          }),
          409,
        );
      throw error;
    }
  };

  app.post('/api/simulation/turn/retry', (context) =>
    respondToManualTurn(context, 'retry'),
  );
  app.post('/api/simulation/turn/skip', (context) =>
    respondToManualTurn(context, 'skip'),
  );
  app.post('/api/simulation/turn/unattended-retry', async (context) => {
    try {
      const turn = await mutationPromise(context, 'unattended-retry', () =>
        service.retryFailedTurn('unattended-retry'),
      );
      return context.json(
        singleTurnResponseSchema.parse({
          snapshot: service.getSnapshot(),
          turn,
        }),
      );
    } catch (error) {
      if (error instanceof SimulationTurnCancelledError)
        return context.json(
          cancelledTurnResponseSchema.parse({
            snapshot: service.getSnapshot(),
            cancelled: true,
          }),
        );
      if (error instanceof SimulationConflictError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: 'turn_conflict', message: error.message },
          }),
          409,
        );
      throw error;
    }
  });
  app.post('/api/simulation/turn/unattended-skip', async (context) => {
    try {
      const turn = await mutationPromise(context, 'unattended-skip', async () =>
        service.skipFailedTurn('unattended'),
      );
      return context.json(
        singleTurnResponseSchema.parse({
          snapshot: service.getSnapshot(),
          turn,
        }),
      );
    } catch (error) {
      if (error instanceof SimulationConflictError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: 'turn_conflict', message: error.message },
          }),
          409,
        );
      throw error;
    }
  });

  app.post('/api/simulation/reset', (context) => {
    try {
      return context.json(
        resetSimulationResponseSchema.parse({ snapshot: service.reset() }),
      );
    } catch (error) {
      if (error instanceof SimulationConflictError) {
        return context.json(
          apiErrorSchema.parse({
            error: { code: 'reset_conflict', message: error.message },
          }),
          409,
        );
      }
      throw error;
    }
  });

  app.post('/api/simulation/agents/:agentId/personality', async (context) => {
    const request = updateAgentPersonalityRequestSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!request.success) {
      return context.json(
        apiErrorSchema.parse({
          error: {
            code: 'invalid_personality',
            message: `Personality must contain 1 to ${PERSONALITY_MAX_LENGTH} characters.`,
          },
        }),
        400,
      );
    }
    try {
      const agent = service.updateAgentPersonality(
        context.req.param('agentId'),
        request.data.personality,
      );
      return context.json(
        updateAgentPersonalityResponseSchema.parse({
          snapshot: service.getSnapshot(),
          agent,
        }),
      );
    } catch (error) {
      if (error instanceof SimulationConflictError) {
        return context.json(
          apiErrorSchema.parse({
            error: { code: 'personality_conflict', message: error.message },
          }),
          409,
        );
      }
      if (error instanceof SimulationValidationError) {
        return context.json(
          apiErrorSchema.parse({
            error: { code: error.code, message: error.message },
          }),
          error.code === 'unknown_agent' ? 404 : 400,
        );
      }
      throw error;
    }
  });

  app.post('/api/simulation/personalities/restore-defaults', (context) => {
    try {
      return context.json(
        restoreDefaultPersonalitiesResponseSchema.parse({
          snapshot: service.restoreDefaultPersonalities(),
        }),
      );
    } catch (error) {
      if (error instanceof SimulationConflictError) {
        return context.json(
          apiErrorSchema.parse({
            error: { code: 'personality_conflict', message: error.message },
          }),
          409,
        );
      }
      throw error;
    }
  });

  app.post('/api/simulation/experiment/export/preview', async (context) => {
    const request = experimentExportRequestSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!request.success)
      return context.json(
        apiErrorSchema.parse({
          error: {
            code: 'invalid_export',
            message: 'The export filters are invalid.',
          },
        }),
        400,
      );
    try {
      return context.json(
        experimentExportPreviewSchema.parse(
          service.previewExperimentExport(request.data),
        ),
      );
    } catch (error) {
      return exportErrorResponse(context, error);
    }
  });

  app.post('/api/simulation/experiment/export', async (context) => {
    const request = experimentExportRequestSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!request.success)
      return context.json(
        apiErrorSchema.parse({
          error: {
            code: 'invalid_export',
            message: 'The export filters are invalid.',
          },
        }),
        400,
      );
    try {
      return context.json(
        experimentExportResponseSchema.parse({
          document: service.generateExperimentExport(request.data),
        }),
      );
    } catch (error) {
      return exportErrorResponse(context, error);
    }
  });

  app.post('/api/simulation/experiment/export/archive', async (context) => {
    const request = archiveExperimentExportRequestSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!request.success)
      return context.json(
        apiErrorSchema.parse({
          error: {
            code: 'invalid_artifact',
            message: 'The generated experiment export artifact is invalid.',
          },
        }),
        400,
      );
    try {
      return context.json(
        archiveExperimentExportResponseSchema.parse(
          await archiveExperimentExport(request.data.document),
        ),
      );
    } catch (error) {
      const persistenceFailure =
        error instanceof ArchivePersistenceError ||
        (error instanceof ExperimentImportError &&
          error.cause instanceof ArchivePersistenceError);
      if (persistenceFailure)
        return context.json(
          apiErrorSchema.parse({
            error: {
              code: 'archive_persistence_failed',
              message: 'The local experiment archive could not be updated.',
            },
          }),
          500,
        );
      if (error instanceof ExperimentImportError)
        return context.json(
          apiErrorSchema.parse({
            error: {
              code: 'archive_rejected',
              message: 'The experiment archive rejected the export safely.',
            },
          }),
          422,
        );
      return context.json(
        apiErrorSchema.parse({
          error: {
            code: 'archive_persistence_failed',
            message: 'The local experiment archive could not be updated.',
          },
        }),
        500,
      );
    }
  });

  app.post('/api/simulation/experiment/import', async (context) => {
    const request = experimentImportRequestSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!request.success)
      return context.json(
        apiErrorSchema.parse({
          error: {
            code: 'invalid_import',
            message: 'The experiment import is invalid.',
          },
        }),
        400,
      );
    const currentCatalog = modelCatalogResponseSchema.parse(
      await catalog.getCatalog(false),
    );
    service.setCompatibleModels(currentCatalog.models);
    try {
      return context.json(
        experimentImportResponseSchema.parse(
          service.importModelConfiguration(request.data.document),
        ),
      );
    } catch (error) {
      if (error instanceof SimulationConflictError)
        return context.json(
          apiErrorSchema.parse({
            error: {
              code: 'model_configuration_conflict',
              message: error.message,
            },
          }),
          409,
        );
      if (error instanceof SimulationValidationError)
        return context.json(
          apiErrorSchema.parse({
            error: { code: 'invalid_import', message: error.message },
          }),
          400,
        );
      throw error;
    }
  });

  app.notFound((context) =>
    context.json(
      apiErrorSchema.parse({
        error: {
          code: 'not_found',
          message: 'The requested route does not exist.',
        },
      }),
      404,
    ),
  );

  app.onError((error, context) => {
    console.error(
      'Unhandled API error',
      error instanceof Error ? error.name : 'unknown',
    );
    return context.json(
      apiErrorSchema.parse({
        error: {
          code: 'internal_error',
          message: 'An unexpected error occurred.',
        },
      }),
      500,
    );
  });

  return app;
}

export type GameApi = ReturnType<typeof createApp>;

function exportErrorResponse(context: Context, error: unknown) {
  if (error instanceof SimulationConflictError)
    return context.json(
      apiErrorSchema.parse({
        error: { code: 'export_conflict', message: error.message },
      }),
      409,
    );
  if (error instanceof ExperimentExportValidationError)
    return context.json(
      apiErrorSchema.parse({
        error: { code: error.code, message: error.message },
      }),
      error.code === 'unknown_agent' ? 404 : 400,
    );
  throw error;
}
