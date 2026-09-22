# ADR 0008: Formal alliances in the expanded autonomous-world experiment

- Status: Accepted
- Date: 2026-08-14
- Status: Superseded by ADR 0033

## Context

The next social experiment needs enough agents, space, time, and formal authority to observe coalition formation, recruitment, loyalty, departure, and later betrayal without inferring membership from untrusted prose or adding extra model calls.

## Decision

The fixed Toledo development world is an H3 resolution-nine radius-six disk: exactly 127 deterministically ordered open cells and eight stable agents with unique deterministic perimeter starts. Ember, Rook, Mingle, Solace, Verge, and Jinx retain their identities and base colors; Bastion (`78b6d86c-39b4-47d8-9d7a-0b92686ada71`, `#3b5ccc`) is the dependable defender and Cipher (`89ce9ddb-611f-4a46-8f7b-36e656494aa2`, `#9b4d3f`) is the information strategist. Development radius, cell count, and agent count are centralized shared constants.

Individual `controllerAgentId` remains the sole hex-ownership authority. World state separately owns runtime-validated active alliances and pending proposals with system-generated typed IDs. One agent may belong to one alliance. Alliances have two to eight unique members and receive the first free color from a deterministic four-color accessible palette. Personal colors never change; effective marker and territory color is derived from current membership and is not duplicated on hexes.

One inference returns a required world action, optional communication, and optional propose/accept/leave diplomacy. The engine validates and applies world action, communication, diplomacy, and automatic expiry in that order. Direct-message checks use the pre-decision snapshot. A rejected component does not cancel valid siblings; a malformed root applies none. This preserves exactly one provider call per agent turn and provider/model independence.

A free agent may propose to another free agent. An allied agent may invite a free agent into its existing alliance. Only the named recipient may accept. Acceptance either creates a two-agent alliance or adds the recipient to the unchanged recorded proposer alliance. Membership changes invalidate impossible proposals. A proposal created at completed turn `N` is eligible through turn `N + 8` and expires after that turn without inference. Departure is unilateral, transfers no territory, and dissolves an alliance below two members. Allies cannot capture one another's individually controlled territory; former allies become eligible under the ordinary abandoned-controller rules only after membership changes.

Successful formal changes create bounded typed events. Observations derive bounded public alliance context from authoritative state/events: individual and alliance scoreboards, member contributions, effective colors, relevant proposals, current/adjacent controller membership, capture eligibility, and at most eight chronological alliance events. Messages and alliance claims remain untrusted text.

Telemetry attributes alliance events to every directly affected agent rather than only the turn actor. Historical diplomacy metrics remain separate from current individual/alliance territory. Safe exports advance to schema version 5, include alliance/proposal state, diplomacy intents/results, events, observations, and metrics, and preserve state-only initial/current snapshots plus decoupled communication privacy semantics.

World Lab derives alliance colors for existing and new territory, retains textual ownership/membership labels, and exposes a bounded alliance panel. Its **Run to turn 200** control uses the existing sequential browser loop, runs only the remaining turns, and pauses immediately after total turn 200. Full infection can stop it earlier; reset returns progress to zero.

## Consequences

The in-memory developer simulation can run a reproducible eight-agent coalition experiment while keeping ownership, provider calls, validation, telemetry, and export semantics auditable. Reset clears alliance state and experiment history while preserving edited personalities; Restore Defaults changes all eight personalities without changing world progress.

Additional provider calls, independent social ticks, generic relationship or semantic memory, alliance leadership/voting/kicking/merging/ranks/custom names, shared ownership, private alliance channels, persistence, autonomous server scheduling, resources, bonuses, and combat remain deferred because they would add new authority, cost, or operational systems not needed for this experiment.
