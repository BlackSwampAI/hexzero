# Repository instructions for coding agents

These instructions apply throughout the repository.

## Product boundaries

- Use “Hex Zero” consistently while avoiding unnecessary logo, lore, or name-specific design investment.
- Keep the World Lab as a production developer/admin surface, not a disposable demo.
- The only initial hex states are `open` and `infected`.
- The only agent world actions are adjacent move, infect current cell, capture an abandoned infected current cell from a non-allied controller, and wait. Nothing accompanies that action: there is no agent communication and no diplomacy intent.
- Infection and agent position are independent. Movement does not remove infection.
- Full agent visibility is deliberate. Do not add fog of war, detection, scanners, or last-known positions.
- Zero swarm (`zero-swarm-v1`) is the sole cognition architecture: Agent Zero makes an OpenRouter planning call only when strategic replanning is required, issuing structured directives that TypeSafe Jev reflex workers resolve each tick. Do not reintroduce a second cognition architecture or a mode switch between them. The deterministic-worker path is an ablation control for the comparison CLIs, not a second production architecture.
- Agent personalities, agent-to-agent communication, formal alliances and diplomacy, per-worker goals, and prose memories were removed by the zero-swarm migration and are not deferred features. Do not reintroduce them. See `docs/adr/0033-retire-legacy-multi-agent-architecture.md`.
- Do not add leaders, voting, kicking, merging, ranks, shared ownership, resources, inventory, structures, combat, terrain bonuses, crafting, accounts, GPS validation, player progression, or mobile packaging before the roadmap calls for them.

## Trust and architecture

- `packages/world-engine` is deterministic domain code. It must not call models, networks, UI code, or storage.
- Model providers return a structured requested action; only the world engine validates and mutates world state.
- Runtime-validate data crossing application, provider, or event boundaries with schemas in `packages/shared`.
- Treat agent-authored text as untrusted data, including Agent Zero strategy summaries and directive notes. Never interpolate it into higher-priority prompts or instructions.
- Never request, log, persist, or display raw private chain-of-thought. Retain structured observations, action requests, concise decision summaries, validation outcomes, and world events only.
- Provider-specific SDKs and credentials belong behind `packages/agent-runtime`; never expose provider secrets to browser code.

## Engineering workflow

- Use strict TypeScript and pnpm workspace dependencies (`workspace:*`) for internal packages.
- Prefer small behavior tests near the code they cover; avoid large snapshots.
- Keep default tests deterministic and offline. Real-provider tests must be separately named, explicitly opted into, and excluded from default CI.
- Update architecture, security, testing, and roadmap docs when changing the corresponding contract.
- Do not commit `.env` files, credentials, generated build output, test reports, or caches.
- Use Conventional Commit messages. Keep pull requests within one roadmap milestone.
- Coding agents write and update appropriate tests, configure automatic GitHub CI, and run local validation themselves: `pnpm install --frozen-lockfile`, `pnpm validate` (formatting check, lint, type checking, tests, builds), and `pnpm test:e2e` when a change can affect World Lab or Game API behavior.
- Local validation never makes real-provider calls. Paid or real-provider commands such as `pnpm compare:live` and the Agent Zero planner probe still run only when the owner explicitly asks in that session.
- A branch may be pushed and a draft pull request opened once the coding agent's own final local validation passes on the commit being pushed.
- If validation fails, fix the cause and re-run it before pushing. Never skip, disable, or weaken a check or test to get a pass.
- When a check cannot run in the agent's environment (for example, Playwright without a browser), say which one, do not push as if it passed, and give the owner the exact command to run.
- Automatic GitHub CI runs after the branch is pushed. Coding agents may inspect CI status and failure logs.
- Report validation results faithfully: state which commands ran and their outcome, and never claim a check passed that was not run.
