# ADR 0033: Retire the legacy multi-agent architecture

## Status

Accepted.

## Context

Hex Zero shipped two cognition architectures side by side for several PRs:
`legacy-multi-agent`, in which every roster agent made its own per-turn
provider call carrying personality, strategy, chat, diplomacy, alliance,
goal, and prose-memory state; and `zero-swarm-v1`, in which one OpenRouter
generative planner (Agent Zero) issues structured directives to worker nodes
that resolve them with TypeSafe Jev reflex cognition over the deterministic
H3 world engine.

The decisive argument is structural rather than measured. The legacy per-agent
path made one full generative provider call per active agent per tick, so
provider attempts, cost, and tick latency all scaled linearly with roster size,
and every agent's behavior was only as reliable as that call's JSON contract.
The zero-swarm path makes one generative planning call per tick regardless of
roster size and lets workers resolve directives through a bounded,
schema-validated reflex contract. That difference follows from the call
pattern itself and does not depend on a particular model or price.

The evidence base should be read with care, because it is narrower than the
decision it supports. The offline comparison (`docs/ZERO_SWARM_COMPARISON.md`)
ran scripted decisions against a fixture that reports provider latency as zero
by construction and deliberately omits monetary cost; it recorded attempt
counts and world outcomes, not real-model quality, production latency, or
provider cost, and its own retirement recommendation at the time was to
_retain_ `legacy-multi-agent` pending real-provider evidence. The live
comparison (`docs/LIVE_SWARM_COMPARISON.md`) is a Jev ablation that measures
Zero+Jev against a Zero+deterministic-worker baseline; legacy mode was
deliberately excluded from it. No run in this repository has measured legacy
cognition against zero-swarm cognition on real providers for cost, latency, or
quality, and this ADR does not claim one has.

Personalities, agent-to-agent communication, formal alliances
and diplomacy, individual worker goals, and prose memories were specific to
the legacy per-agent decision contract and had no equivalent in the swarm
architecture; they existed to give each independently-prompted agent a voice
and a reason to negotiate, which a single planner with directive-following
workers does not need.

PR 1 and PR 2 of this migration already made zero-swarm the sole cognition
architecture and deleted the legacy per-agent decision contract, personalities,
agent-to-agent communication, alliances/diplomacy, worker goals, prose
memories, and the legacy experiment-import route. This ADR is the record of
that product decision, since none of the ADRs that introduced those features
were updated at the time, and it also completes the removal at the telemetry
boundary: the experiment export schema no longer carries version-conditional
branches for schema versions 9–11 (the versions that predate independent
attempt accounting and, before that, tick summaries) and now requires exactly
schema version 12, with `swarmArchitectureVersion` always `zero-swarm-v1` and
attempt accounting always present. The archive importer accepts only version
12 and rejects anything else outright rather than migrating it.

## Decision

Zero-swarm (Agent Zero planning over TypeSafe Jev reflex workers) is the only
cognition architecture Hex Zero runs or reads telemetry for. There is no
legacy compatibility support of any kind: reading a pre-swarm scenario,
snapshot, or experiment export requires checking out an older Git revision.
The historical `legacy-multi-agent` implementation, its ADRs, and its
telemetry schema versions remain in Git history and are not deleted or
rewritten; ADRs whose core decision was specific to the legacy architecture
are marked superseded by this one (see Consequences) rather than removed.

The deterministic-worker cognition baseline (workers that resolve directives
without a model call) is retained alongside Jev, not because it is a second
production architecture, but because it is the ablation control that isolates
what Jev's reflex calls contribute versus the deterministic floor. Both
`swarm-comparison.ts`/`swarm-comparison-cli.ts` (offline) and
`live-swarm-comparison.ts`/`live-swarm-comparison-cli.ts` (live) compare only
these two variants.

## Consequences

- Pre-swarm experiment exports (schema versions 9, 10, and 11) can no longer
  be read by current code; the shared schema, the archive importer, and the
  game-api exporter all assume schema version 12 unconditionally.
- The `archivedAppliedScenarioSchema` scenario-import shim that translated
  `cognitionMode`/`decisionContractVersion` into `historicalCognitionMode`/
  `historicalDecisionContractVersion` is removed, and so is the
  `'legacy-multi-agent'` string literal it carried. The schema is retained
  under its existing name because it still serves a distinct purpose:
  tolerating archived scenarios written under relaxed pre-`execution-limits-v2`
  and pre-`durable-influence-v2` defaults, which is unrelated to cognition
  architecture and not part of this retirement.
- ADRs 0003 (session personality configuration), 0007 (decoupled world
  communication), 0008 (formal alliances experiment), 0009 (capability-driven
  model catalog, for its personality/message observation), 0010 (versioned
  agent behavior and seeded assignment), 0015 (selective agent communication),
  0016 (fluid alliances and diplomacy affordances), 0018 (bounded agent goal
  state), 0019 (bounded agent compact memory), 0028 (zero-swarm reflex seam,
  for its `legacy-multi-agent` compatibility default), and 0030 (zero-swarm
  World Lab presentation, for its dual-mode UI) are marked superseded by this
  ADR in their existing status fields. None of them are deleted; their
  decisions and rationale remain readable as history.
- Anyone who needs to inspect or replay a pre-swarm export must check out the
  Git revision immediately before PR 1 of this migration (or earlier) and run
  the importer from that revision; there is no migration path forward.
