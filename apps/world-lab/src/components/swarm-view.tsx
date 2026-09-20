import type {
  AgentId,
  H3Cell,
  SimulationSnapshot,
  WorldAction,
} from '@hexzero/shared';

type Agent = SimulationSnapshot['world']['agents'][number];
type Tick = NonNullable<SimulationSnapshot['swarmTicks']>[number];

function latestTick(snapshot: SimulationSnapshot): Tick | undefined {
  return snapshot.swarmTicks?.at(-1);
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function actionLabel(action?: WorldAction): string {
  if (!action) return 'No physical action recorded';
  return action.type === 'move'
    ? `Move to ${action.targetCell}`
    : action.type[0]!.toUpperCase() + action.type.slice(1);
}

function resultLabel(result?: { accepted: boolean; reason?: string }): string {
  if (!result) return 'No validation result recorded';
  return result.accepted
    ? 'Accepted'
    : `Rejected${result.reason ? ` · ${result.reason}` : ''}`;
}

function agentName(snapshot: SimulationSnapshot, id: AgentId): string {
  return snapshot.world.agents.find((agent) => agent.id === id)?.name ?? id;
}

function planSourceLabel(source: Tick['planSource']): string {
  return source === 'zero-llm'
    ? 'Zero provider plan'
    : source === 'directive-reuse'
      ? 'Active directives reused'
      : 'Deterministic fallback';
}

function EmptyTelemetry() {
  return <p className="swarm-empty">No committed swarm tick telemetry yet.</p>;
}

export function SwarmStrategyPanel({
  snapshot,
  onSelectAgent,
}: {
  snapshot: SimulationSnapshot;
  onSelectAgent?: (agentId: AgentId) => void;
}) {
  const tick = latestTick(snapshot);
  if (!tick)
    return (
      <section className="panel swarm-panel" aria-label="Swarm strategy">
        <p className="panel-kicker">Swarm strategy</p>
        <h2>Agent Zero</h2>
        <EmptyTelemetry />
      </section>
    );
  return (
    <section className="panel swarm-panel" aria-label="Swarm strategy">
      <p className="panel-kicker">
        Swarm strategy · committed tick {tick.tickNumber}
      </p>
      <h2>Agent Zero</h2>
      <p className="swarm-summary">{tick.plan.strategySummary}</p>
      <dl className="swarm-facts">
        <div>
          <dt>Plan source</dt>
          <dd>{planSourceLabel(tick.planSource)}</dd>
        </div>
        <div>
          <dt>Review triggers</dt>
          <dd>{tick.replanReasons?.join(', ') || 'None this tick'}</dd>
        </div>
        <div>
          <dt>Planner failure</dt>
          <dd>
            {tick.plannerFailure
              ? `${tick.plannerFailure.code}: ${tick.plannerFailure.message}`
              : 'None recorded'}
          </dd>
        </div>
        <div>
          <dt>Zero physical action</dt>
          <dd>
            {actionLabel(tick.zeroAction)} ·{' '}
            {resultLabel(tick.zeroActionResult)}
          </dd>
        </div>
      </dl>
      <h3>Worker directives</h3>
      <ul className="swarm-directives" aria-label="Worker directives">
        {tick.plan.directives.map((directive) => (
          <li key={directive.id}>
            {onSelectAgent ? (
              <button
                type="button"
                onClick={() => onSelectAgent(directive.agentId)}
                aria-label={`Inspect ${agentName(snapshot, directive.agentId)}`}
              >
                {agentName(snapshot, directive.agentId)}
              </button>
            ) : (
              <strong>{agentName(snapshot, directive.agentId)}</strong>
            )}
            <span>
              {directive.mission} · {directive.targetCell ?? 'no target'} ·{' '}
              {directive.priority} priority · {directive.riskTolerance} risk ·
              expires tick {directive.expiresAtTick}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function derivedProgress(ticks: readonly Tick[], agentId: AgentId): string {
  const outcomes = ticks.slice(-3).flatMap((tick) =>
    tick.workers
      .filter((worker) => worker.agentId === agentId)
      .map((worker) => ({
        action: worker.action,
        result: worker.actionResult,
      })),
  );
  if (!outcomes.length) return 'Unknown · no recent committed action outcome';
  if (outcomes.every(({ result }) => result?.accepted === false))
    return 'Stalled · derived from recent rejected committed actions';
  if (
    outcomes.some(
      ({ action, result }) => result?.accepted && action?.type !== 'wait',
    )
  )
    return 'Advancing · derived from a recent accepted non-wait committed action';
  return 'Unknown · recent committed action outcomes unavailable';
}

function workerSituation(
  worker: Tick['workers'][number] | undefined,
  ticks: readonly Tick[],
  agentId: AgentId,
): string {
  if (worker?.situation)
    return `${worker.situation.directiveProgress} · pressure ${worker.situation.nearbyPressure} · territory ${worker.situation.recentTerritoryTrend} · recent outcome ${worker.situation.recentActionOutcome}`;
  return derivedProgress(ticks, agentId);
}

export function SwarmAgentInspector({
  snapshot,
  agent,
  cellState,
  controlledCellCount,
  onHighlightCell,
}: {
  snapshot: SimulationSnapshot;
  agent: Agent;
  cellState: 'open' | 'infected';
  controlledCellCount: number;
  onHighlightCell?: (cell: H3Cell) => void;
}) {
  const tick = latestTick(snapshot);
  const isZero = agent.id === snapshot.scenario.patientZeroAgentId;
  const worker = tick?.workers.find((entry) => entry.agentId === agent.id);
  const replanSignal = tick?.signals?.find(
    (signal) => signal.agentId === agent.id,
  );
  const directive =
    worker?.directive ??
    tick?.plan.directives.find((entry) => entry.agentId === agent.id);
  return (
    <section
      className="panel swarm-panel swarm-agent-inspector"
      aria-label="Swarm agent inspector"
    >
      <p className="panel-kicker">
        {isZero ? 'Agent Zero inspector' : 'Worker inspector'}
      </p>
      <h2>{agent.name}</h2>
      <dl className="swarm-facts">
        <div>
          <dt>Cell</dt>
          <dd>
            {agent.currentCell} · {cellState}
          </dd>
        </div>
        <div>
          <dt>Controlled cells</dt>
          <dd>{controlledCellCount}</dd>
        </div>
      </dl>
      {!tick ? (
        <EmptyTelemetry />
      ) : isZero ? (
        <>
          <h3>Zero action</h3>
          <p>
            {actionLabel(tick.zeroAction)} ·{' '}
            {resultLabel(tick.zeroActionResult)}
          </p>
          <p className="swarm-muted">
            Strategy and provider telemetry appear in the swarm strategy and run
            panels.
          </p>
        </>
      ) : (
        <>
          <h3>Directive</h3>
          {directive ? (
            <dl className="swarm-facts">
              <div>
                <dt>Mission</dt>
                <dd>{directive.mission}</dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd>
                  {directive.targetCell ? (
                    onHighlightCell ? (
                      <button
                        type="button"
                        className="swarm-cell-link"
                        onClick={() => onHighlightCell(directive.targetCell!)}
                      >
                        {directive.targetCell}
                      </button>
                    ) : (
                      directive.targetCell
                    )
                  ) : (
                    'None'
                  )}
                </dd>
              </div>
              <div>
                <dt>Priority / risk</dt>
                <dd>
                  {directive.priority} / {directive.riskTolerance}
                </dd>
              </div>
              <div>
                <dt>Expiry</dt>
                <dd>Tick {directive.expiresAtTick}</dd>
              </div>
            </dl>
          ) : (
            <p>No worker directive retained.</p>
          )}
          <h3>
            {worker?.source === 'deterministic-fallback'
              ? 'Fallback action'
              : 'Jev reflex'}
          </h3>
          {worker ? (
            <>
              <dl className="swarm-facts">
                <div>
                  <dt>Selected physical action</dt>
                  <dd>
                    {actionLabel(worker.action)} ·{' '}
                    {resultLabel(worker.actionResult)}
                  </dd>
                </div>
                <div>
                  <dt>Decision source</dt>
                  <dd>{worker.source}</dd>
                </div>
                {worker.failure && (
                  <div>
                    <dt>Failure</dt>
                    <dd>
                      {worker.failure.code}: {worker.failure.message}
                    </dd>
                  </div>
                )}
                {worker.reflexDecision && (
                  <>
                    <div>
                      <dt>Chosen candidate</dt>
                      <dd>{worker.reflexDecision.chosenCandidateId}</dd>
                    </div>
                    <div>
                      <dt>Confidence</dt>
                      <dd>
                        {Math.round(worker.reflexDecision.confidence * 100)}%
                      </dd>
                    </div>
                    {worker.reflexDecision.replanProbability !== undefined && (
                      <div>
                        <dt>Replan probability</dt>
                        <dd>
                          {Math.round(
                            worker.reflexDecision.replanProbability * 100,
                          )}
                          %{replanSignal ? ' · request sent to Zero' : ''}
                        </dd>
                      </div>
                    )}
                  </>
                )}
              </dl>
              <p className="swarm-progress">
                {workerSituation(worker, snapshot.swarmTicks ?? [], agent.id)}
              </p>
              {worker.reflexDecision ? (
                <>
                  <h4>Bounded candidate probabilities</h4>
                  <ul
                    className="swarm-probabilities"
                    aria-label="Bounded candidate probabilities"
                  >
                    {Object.entries(worker.reflexDecision.probabilities).map(
                      ([id, probability]) => (
                        <li key={id}>
                          <code>{id}</code>
                          <span>{Math.round(probability * 100)}%</span>
                        </li>
                      ),
                    )}
                  </ul>
                </>
              ) : (
                <p>
                  No Jev probability telemetry retained for this fallback
                  action.
                </p>
              )}
            </>
          ) : (
            <p>No worker telemetry retained.</p>
          )}
        </>
      )}
    </section>
  );
}

export function SwarmActivityPanel({
  snapshot,
}: {
  snapshot: SimulationSnapshot;
}) {
  const ticks = snapshot.swarmTicks ?? [];
  const latest = ticks.at(-1);
  return (
    <section
      className="panel swarm-panel swarm-activity"
      aria-label="Swarm activity"
    >
      <p className="panel-kicker">Swarm activity</p>
      <h2>Agent Zero strategy</h2>
      {!latest ? (
        <EmptyTelemetry />
      ) : (
        <>
          <p className="swarm-summary">{latest.plan.strategySummary}</p>
          <p className="swarm-muted">{planSourceLabel(latest.planSource)}</p>
          <h3>Committed ticks</h3>
          <ol>
            {ticks
              .slice()
              .reverse()
              .map((tick) => (
                <li key={tick.tickNumber}>
                  <strong>Tick {tick.tickNumber}</strong>
                  <span>
                    {planSourceLabel(tick.planSource)} · {tick.workers.length}{' '}
                    worker actions · Zero: {resultLabel(tick.zeroActionResult)}
                    {tick.signals?.length
                      ? ` · ${tick.signals.length} worker replan request${tick.signals.length === 1 ? '' : 's'}`
                      : ''}
                  </span>
                </li>
              ))}
          </ol>
        </>
      )}
    </section>
  );
}

export function SwarmRunPanel({
  snapshot,
  status,
  runTarget,
}: {
  snapshot: SimulationSnapshot;
  status: string;
  runTarget: number | null;
}) {
  const tick = latestTick(snapshot);
  const accounting = snapshot.experiment.attemptAccounting;
  const jev = (snapshot.swarmTicks ?? []).flatMap((entry) =>
    entry.workers.map((worker) => worker.reflexDecision).filter(isPresent),
  );
  const zeroMetadata = (snapshot.swarmTicks ?? [])
    .map((entry) => entry.plannerMetadata)
    .filter(isPresent);
  const total = (
    items: Array<{
      inputTokens?: number;
      outputTokens?: number;
      promptTokens?: number;
      completionTokens?: number;
      latencyMs: number;
    }>,
  ) =>
    items.reduce(
      (sum, item) =>
        sum +
        (item.inputTokens ?? item.promptTokens ?? 0) +
        (item.outputTokens ?? item.completionTokens ?? 0),
      0,
    );
  const providers = snapshot.swarmProviderStatus;
  const retainedTicks = snapshot.swarmTicks ?? [];
  const zeroPlans = retainedTicks.filter(
    ({ planSource }) => planSource === 'zero-llm',
  ).length;
  const reusedTicks = retainedTicks.filter(
    ({ planSource }) => planSource === 'directive-reuse',
  ).length;
  const replanRequests = retainedTicks.reduce(
    (count, entry) => count + (entry.signals?.length ?? 0),
    0,
  );
  return (
    <section className="panel swarm-panel" aria-label="Swarm run">
      <p className="panel-kicker">Swarm run</p>
      <h2>Execution</h2>
      <dl className="swarm-facts">
        <div>
          <dt>Status</dt>
          <dd>{status.replaceAll('-', ' ')}</dd>
        </div>
        <div>
          <dt>Run target</dt>
          <dd>{runTarget ?? 'No bounded target'}</dd>
        </div>
        <div>
          <dt>Committed swarm tick</dt>
          <dd>{tick?.tickNumber ?? 'None'}</dd>
        </div>
        <div>
          <dt>Retained Zero plans / reused ticks</dt>
          <dd>
            {zeroPlans} / {reusedTicks}
          </dd>
        </div>
        <div>
          <dt>Retained worker replan requests</dt>
          <dd>{replanRequests}</dd>
        </div>
        <div>
          <dt>Planner provider</dt>
          <dd>
            {providers
              ? `${providers.plannerMode} · ${providers.plannerConfigured ? 'configured' : 'unavailable'}`
              : 'Not reported'}
          </dd>
        </div>
        <div>
          <dt>Jev provider</dt>
          <dd>
            {providers
              ? `${providers.reflexMode} · ${providers.reflexConfigured ? 'configured' : 'unavailable'}${providers.reflexModel ? ` · ${providers.reflexModel}` : ''}`
              : 'Not reported'}
          </dd>
        </div>
        <div>
          <dt>Provider attempts</dt>
          <dd>
            {accounting.attemptsStarted} started ·{' '}
            {accounting.attemptsFinalized} finalized
          </dd>
        </div>
        <div>
          <dt>Known finalized cost</dt>
          <dd>{accounting.knownFinalizedCostCredits} credits</dd>
        </div>
        <div>
          <dt>Unknown provider costs</dt>
          <dd>{accounting.attemptsWithUnknownCost} · TypeSafe cost unknown</dd>
        </div>
        <div>
          <dt>Zero retained reported usage</dt>
          <dd>
            {total(zeroMetadata)} tokens ·{' '}
            {zeroMetadata.reduce((sum, item) => sum + item.latencyMs, 0)} ms
          </dd>
        </div>
        <div>
          <dt>Jev retained reported usage</dt>
          <dd>
            {total(jev)} tokens ·{' '}
            {jev.reduce((sum, item) => sum + item.latencyMs, 0)} ms
          </dd>
        </div>
      </dl>
    </section>
  );
}
