# Live swarm comparison

`compare:live` is a small, opt-in provider experiment. It compares the same Agent Zero planning configuration, scenario, roster, stable seeds, trail-hunter profile, and tick cap across two primary variants:

- `live-zero-jev`: OpenRouter Agent Zero planning plus live TypeSafe Jev worker cognition.
- `live-zero-deterministic-workers`: the same OpenRouter Agent Zero planning with the server's deterministic legal-candidate selector and no TypeSafe calls.

This is a Jev ablation, not a general claim that zero-swarm is better than the retired legacy multi-agent mode. Legacy mode was deliberately not included in the first live command because its provider-call pattern and cognition were different; it has since been removed entirely (see ADR 0033), and zero-swarm is now the only cognition architecture Hex Zero runs.

## Observe one swarm in World Lab

World Lab now always runs zero-swarm; there is no cognition-mode selector. To watch one zero-swarm experiment:

1. Set `OPENROUTER_API_KEY` and `TYPESAFE_API_KEY` for the Game API process, then run `pnpm dev`. The keys are server-only. `pnpm dev:test-provider` does not make real provider calls.
2. Open World Lab at `http://localhost:3000`. In the top-right **More World Lab actions** menu, open **World setup**. Enable simulated player pressure and select **Trail hunter v1** if you want capture pressure. Set bounded provider attempt and credit admission limits.
3. Select **Preview**, then **Apply / Create Experiment**. The header will say **Zero swarm v1 experiment**. In **Agents**, select an available model for Agent Zero.
4. Use **Single tick** to start. The **Scoreboard** tab shows Zero's strategy and worker directives; selecting a worker shows its chosen action, confidence, and probabilities. The **Swarm** activity tab shows the tick history. A provider fallback notice means the corresponding key or provider is unavailable.

If agents appear stationary, read the **Swarm** activity summary first: it separates moves, infections, waits, Zero/worker fallbacks, provider attempts, and simulated-player pressure. The player is disabled in the default World Setup; selecting a profile without enabling pressure does not start it. The Game API keeps the current experiment in process memory, so keep `pnpm dev` running while inspecting it. In a second terminal, `pnpm diagnose:swarm` prints a short safe JSON summary of the current local experiment. It makes no provider calls. If it reports that port 8787 is unavailable, start `pnpm dev` and leave it running; a restarted Game API has a new experiment.

This UI is for inspecting one run. The matched Jev-versus-deterministic comparison below runs separately and produces a JSON report; it does not appear as a new World Lab screen.

## Run a bounded experiment

Choose the Zero model explicitly and supply both keys in the invoking shell. The command does not load `.env` files. It makes no network call without `--confirm-provider-costs`.

```bash
OPENROUTER_API_KEY='…' TYPESAFE_API_KEY='…' \
pnpm --silent --filter @hexzero/game-api exec node --import tsx \
  src/live-swarm-comparison-cli.ts --confirm-provider-costs --model 'provider/model-id' \
  > /tmp/hexzero-live-swarm-comparison.json
```

The default is three stable seeds, a 20-tick cap, eight agents, and `trail-hunter-v1`, with 200 attempts, 3 credits admission, and 0.02 credits reserved per attempt. A roster must contain two to eight agents: Zero plus at least one worker. Inputs can be repeated with `--seeds seed-a,seed-b,seed-c`; this gives reproducible inputs, while provider output remains nondeterministic. Limits are deliberately bounded: at most five seeds, 30 ticks, eight agents, 300 provider attempts, 10 credits admission, and 0.5 credits reserved per attempt. The existing attempt and credit admission controls apply per run; they are not an upstream provider billing guarantee.

Use the saved report without credentials or acknowledgement:

```bash
pnpm --silent --filter @hexzero/game-api exec node --import tsx \
  src/live-swarm-comparison-cli.ts --summary-from /tmp/hexzero-live-swarm-comparison.json
```

The direct `pnpm exec` invocation writes JSON only to stdout and never archives or commits a result. The shorter `pnpm compare:live` script is also available for interactive use, but pnpm may prepend script output to redirected stdout. Reports exclude API keys, raw prompts, raw provider responses, private reasoning, and raw error bodies.

## Reading the report

Reports retain per-tick and aggregate active workers, captures including Patient Zero capture, terminal outcomes, controlled territory and territory retained/lost, disinfection, worker stalls, directive progress, worker replan signals, Zero replans and reasons, Zero planning attempts, Jev attempts/fallbacks/confidence/action and replan probabilities, token counts, latency, and provider accounting.

OpenRouter cost is provider-reported cost. Missing provider-cost fields remain explicitly unknown. TypeSafe responses provide input/output tokens but no authoritative monetary bill. If a deployment chooses to include `estimatedTypeSafeCost`, it must retain the Jev model, configured price per million input tokens, and `estimate: true`; it is never actual cost.

Do not reduce a run to final territory. Review these questions after the first baseline dataset, without threshold tuning beforehand:

1. Does Jev materially change worker behavior from deterministic workers, and is that useful under hunter pressure?
2. Does it improve survival or captures, including keeping Zero alive, while considering territory retained or sacrificed?
3. Does it reduce stalls and use worker replan signals appropriately? Inspect false signals and missed replanning opportunities.
4. How often does Zero need generative replanning, and why?
5. What are the measured OpenRouter costs, Jev token volume, clearly labeled TypeSafe estimate if configured, and unknown cost fields?
6. Inspect low-confidence choices, high-confidence bad-looking choices, repeated stalls, capture-alert response, and high trail-hunter-pressure response. Does the narrow Jev state/question keep deterministic work in code and confidence routing meaningful?
7. Is Jev worth its complexity against deterministic workers?

This experiment's results, together with earlier offline comparisons, informed the decision to retire the legacy multi-agent architecture (see ADR 0033).
