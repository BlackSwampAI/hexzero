# ADR 0017: Mandatory Patient Zero and bounded coordinator context

## Status

The mandatory Agent Zero roster designation remains current. Superseded by
[ADR 0033](0033-retire-legacy-multi-agent-architecture.md) for the legacy
global diplomacy summary and coordinator powers.

## Context

Patient Zero has demonstrated enough strategic value that coordinator-free live
runs are no longer a supported experiment mode. The existing global diplomacy
view also expanded once per roster agent, increasing coordinator input with the
maximum 32-agent setup even though recommendations need only a small set of
authoritative options.

## Decision

Every new and live simulation must designate exactly one active roster agent as
Patient Zero. Deterministic defaults select the first default-roster agent.
World Setup never offers a None option and selects the first remaining roster
agent when roster replacement removes the current coordinator. Setup and API
boundaries reject a missing, null, or unknown designation.

Historical export and archive reads remain distinct from current setup
validation. Older experiments with a null designation remain readable and keep
that null attribution; importing historical model configuration never converts
the active live scenario into a coordinator-free run.

Patient Zero receives one fixed-cap sparse global diplomacy summary containing
at most 12 displayed eligible proposer/recipient pairs, eight acceptable
proposal IDs, eight agents currently able to leave, five aggregate stable
blocker counts, and eight prioritized blocker examples. Total counts and
explicit truncation flags describe omitted entries. Eligible pairs are sampled
round-robin across sorted proposer buckets with deterministic tick rotation,
preventing the fixed cap from permanently favoring the lowest IDs. All displayed
IDs are service-authored from engine eligibility, and Patient Zero may recommend
only displayed IDs. The world engine remains authoritative during simultaneous
resolution.

The provider boundary remains one text request and one flat response without
tools. The immutable guidance advances to `text-flat-json-v6`; v3, v4, and v5
attribution and the unchanged flat wire fields remain readable.

## Consequences and deferrals

Worst-case 32-agent deterministic coverage budgets the serialized diplomacy
summary at no more than 4,096 UTF-8 bytes. This is a structural budget, not a
claim of measured token or cost savings.

Proposal-outcome memory, Patient Zero archive analytics corrections, additional
communication tuning, capture succession, and new coordinator powers remain
out of scope.
