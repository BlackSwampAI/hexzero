# ADR 0013: Experimental Patient Zero coordinator

## Status

The Patient Zero designation remains the Agent Zero roster designation.
Superseded by [ADR 0033](0033-retire-legacy-multi-agent-architecture.md) for
legacy broadcasts, diplomacy, and coordinator behavior; the current role is
defined by the zero-swarm architecture.

Historical scenarios may designate one roster agent as Patient Zero, or `null`
for a legacy baseline. ADR 0017 requires the designation for all current/live
scenarios. Patient Zero remains a physical agent governed by the ordinary
move, infect, capture, wait, ownership, and diplomacy rules. It receives one
bounded authoritative global strategic summary and may attach one private
`zero` broadcast to its normal decision. The broadcast reaches every other
active agent, is player-hidden, and is advisory: it cannot force an action or
grant a numerical bonus. A direct message bypasses physical range only when
Patient Zero is one endpoint.

The global summary contains bounded roster identity, exact current agent
cells, behavior assignments, individual and alliance territory totals,
membership, proposals, and recent authoritative diplomacy and territory
changes. It excludes the complete hex map, raw reasoning/provider output,
pending decisions, future movement/timing, credentials, and player GPS.

The provider-neutral flat decision contract advances to
`text-flat-json-v3` by adding `zero` to `communicationType`; the universal
objective remains `durable-influence-v2`. Sequential committed-event ordering
is unchanged. A later simultaneous-tick engine must build all observations
from one frozen snapshot so same-tick messages cannot leak.

Patient Zero is experimental. Capture succession, election, respawning,
forced compliance, simulated players, extra movement/actions, numerical
bonuses, and simultaneous tick scheduling are deferred.
