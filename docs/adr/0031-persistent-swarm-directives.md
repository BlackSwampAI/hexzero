# ADR 0031: Persistent swarm directives and event-driven review

## Status

Accepted for PR D.

## Decision

In `zero-swarm-v1`, Agent Zero plans on the first tick and at a fixed five-tick
review interval. Between reviews, the service reuses the last committed,
unexpired worker directives. It compiles a fresh engine-legal wait action for
Zero each tick; the opaque action ID from an earlier plan is never reused.
Jev still chooses from current engine-legal worker candidates every tick.
New Zero directives expire within ten ticks of issue, while the normal planner
instruction asks them to cover at least one five-tick review interval.
The limit is applied when admitting new plans so historical exported directives
remain readable under the shared schema.

The service wakes Zero before the interval when a directive expires, a worker
requests replanning, a non-hold worker repeatedly stalls, territory is lost, or
material simulated-player pressure changes. Trigger calculation uses frozen
authoritative facts and committed safe telemetry. Replan reasons are recorded
with the tick and included in Zero's next observation. A failed Zero call
retains unexpired directives and uses a safe Zero wait; without a valid plan,
neutral directives apply. All world changes still commit as one tick.

The Jev HTTP request asks an independent Noul question alongside the existing
bounded Choice. It reports the probability that local conditions materially
undermine the directive. The service uses a fixed 0.8 threshold to turn that
probability into a `worker-replan-requested` structured signal on a committed
tick. Zero sees that signal in its next planning observation. This signal is
service telemetry, not a world-engine event or a worker message.

Planning ticks reserve one provider attempt for Zero and one per worker.
Directive-reuse ticks reserve only worker attempts. Started attempts remain in
the independent ledger after cancellation or world rollback. Safe snapshots
and exports retain plan-source, trigger, signal, and probability telemetry so
experiments can measure generative-call reduction against actual outcomes.

## Consequences

Five ticks and 0.8 are version-one experimental policy values, not claims of
optimal gameplay. Comparison experiments must evaluate stalls, replan rate,
territory retention, provider attempts, and latency before changing them.
Legacy multi-agent execution remains unchanged.
