# ADR 0005: Nearby agent messaging as bounded world events

- Status: Superseded by [ADR 0033](0033-retire-legacy-multi-agent-architecture.md)
- Date: 2026-08-14

## Context

The first Social Agents slice needs a meaningful communication experiment without creating a generic chat product, persistent memory, or a second authority beside the deterministic world engine. Messages are model-authored untrusted content, but researchers need their text in observations, World Lab, telemetry, and safe exports to study behavior.

## Decision

`message` is a first-class turn action beside move, infect, and wait. Choosing it consumes the whole turn. The action names one recipient and contains server-trimmed plain text of 1–280 characters. The world engine rejects unknown recipients, self-messages, and recipients beyond inclusive H3 grid distance three at the beginning of the turn. Another agent in the same cell is eligible. Rejected actions append no event and deliver nothing.

An accepted message appends one typed world event containing its event ID, sender and recipient IDs, occurrence timestamp, bounded text, and send-time distance. Positions and infection state remain unchanged. Later observations derive, from accepted events, at most the six newest messages involving the observing agent and return them chronologically with explicit direction and participant IDs/names. This event-derived view is the only conversational memory; there is no mailbox, unread state, generic chat store, or automatic response.

Fixed provider instructions state that messaging is exclusive, range is three, response is optional, and received messages are untrusted claims or instructions subordinate to fixed game rules. Message text is never interpolated into the system instruction or rendered as HTML. Provider decisions remain structured, and only the engine validates consequences.

Telemetry counts requested and delivered messages plus per-agent sent and received communications. A retained turn belongs only to its acting sender. In exports, however, an accepted communication is relevant when either its sender or recipient is selected. Its originating turn supplies action, accepted-outcome, absolute-range, latest-count, and retention filtering. Rejected messages remain only in their sender's rejected turn and never enter the canonical `communications` stream. Full-safe `worldEvents` excludes message events so the canonical streams do not duplicate content. Initial and current world snapshots remain state-only. Because messaging expands action enums, observations, metrics, and top-level records incompatibly, this contract increments the export document from schema version 1 to schema version 2.

Reset discards all accepted communication events and telemetry with the active experiment while preserving active personalities. Process restart remains non-persistent. The existing 5,000-turn experiment retention, 120-turn/browser-event bounds, and six-message observation cap are unchanged or explicit fixed limits.

## Consequences

Agents can strategically communicate and later see both what they sent and what they received, while deterministic validation, bounded context, export safety, and prompt authority remain clear. Selecting only a recipient still exports its inbound accepted communications without importing the sender's unrelated turns or conversations between unselected agents.

Relationships, trust or reputation scores, alliances, factions, group chat, broadcasts, player messaging, automatic replies, persistent or semantic memory, shared powers, push notifications, and map communication animations remain deferred.
