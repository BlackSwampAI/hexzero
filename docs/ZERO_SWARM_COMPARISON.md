# Zero-swarm offline comparison

PR F compares three cognition variants with the same seeded scenario and the
same optional `trail-hunter-v1` pressure profile:

- `legacy-multi-agent`
- `zero-swarm-v1`
- `deterministic-worker-baseline`

Run the deterministic fixture suite with:

```bash
pnpm --silent compare:offline
pnpm --silent compare:offline --ticks 40 --seeds pressure-a,pressure-b,pressure-c
```

The command writes one JSON report to standard output. Redirect it only when a
saved artifact is useful for review:

```bash
pnpm --silent compare:offline --ticks 40 --seeds pressure-a,pressure-b > /tmp/hexzero-swarm-comparison.json
```

`--ticks` accepts an integer from 1 through 60. `--seeds` accepts up to 16
comma-separated stable seed identifiers and is sorted before execution. Omit
both options to use the harness defaults. The command has no network or archive
write path and never loads provider credentials.

## Report contents

Each variant retains per-tick samples and an aggregate. The report covers:

- provider attempts, generative attempts, and reflex input/output tokens;
- territory over time and retained territory under pressure;
- worker stalls, replan requests, Zero replans, and Jev confidence/distribution
  telemetry where the mode produces it;
- surviving/captured agents and terminal outcomes;
- deterministic virtual tick time and reported provider latency; and
- a provider-cost disclaimer.

Token fields report only factual values supplied by the deterministic fixture.
They are not billed usage. The report intentionally omits monetary cost because
neither fake providers nor TypeSafe usage metadata establish an authoritative
billed amount. Any future displayed estimate must name the model version and
pricing configuration and remain explicitly non-authoritative.

The fixture reports synthetic provider latency as zero. It does not measure
live provider or end-to-end production latency.

## Interpretation

The runner uses scripted legacy decisions, a scripted Zero planner, scripted
Jev choices, and a deterministic worker policy that selects from the same legal
candidate map without a reflex provider call. It proves experiment
reproducibility and exposes comparable telemetry; it does not demonstrate
real-model quality, production latency, or provider cost. Real-provider studies
remain explicitly opted in and should archive their safe exports separately.

The existing archive comparison command is currently legacy-turn-centric. It
can retain schema-v11 swarm tick records and independent provider attempts, but
it does not replace this same-scenario, per-tick swarm harness.

## Results

The fixed three-seed run uses eight agents and at most 12 ticks per variant:

```bash
pnpm --silent compare:offline --ticks 12 --seeds worker-capture-spawn,comparison-seed-b,comparison-seed-c
```

The JSON report was rerun byte-for-byte and has SHA-256
`43ee6680e2b88e679856bbf6b7d7577919da0fa5fce73b253da0bf5dd737965a`.
Its aggregate values are:

| Scripted variant              | Committed ticks | Provider attempts | Generative-equivalent attempts | Reflex decisions | Final controlled cells | Captures | Worker stalls | Terminal runs |
| ----------------------------- | --------------: | ----------------: | -----------------------------: | ---------------: | ---------------------: | -------: | ------------: | ------------: |
| Legacy multi-agent            |              36 |               215 |                            215 |                0 |                     13 |        9 |             0 |             0 |
| Zero-swarm v1                 |              28 |               157 |                             16 |              141 |                     53 |        8 |            38 |             2 |
| Deterministic worker baseline |              32 |                23 |                             23 |                0 |                     74 |        7 |             7 |             1 |

All synthetic input/output tokens and provider latency are zero by fixture
design. Zero-swarm ended early in two of three seeds because Patient Zero was
captured; the deterministic worker baseline ended early in one seed. The
zero-swarm scripted reflex produced more stalled worker actions than the greedy
baseline. The legacy fixture made every agent a
scripted generative-equivalent call, but its social policy differs from both
swarm worker policies; this table cannot rank real model quality. Per-tick
territory, confidence, probability distributions, capture events, and replan
counts remain in the JSON report. Across the three seeds, Zero made 13 reviews
after its initial plans in the scripted swarm and 20 in the greedy baseline;
the fake reflex policy raised no worker replan signal.

**Retirement decision:** retain `legacy-multi-agent` for now. The offline run
proves the accounting and comparison path, but it does not establish better
survival or cost for live Zero/Jev cognition. Revisit retirement after
reproducible real-provider trials, credible pressure outcomes, and authoritative
cost or clearly labeled pricing estimates.
