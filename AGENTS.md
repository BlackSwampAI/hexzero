# Repository instructions for coding agents

These instructions apply throughout the repository.

## Product boundaries

- Use “Hex Zero” consistently while avoiding unnecessary logo, lore, or name-specific design investment.
- Keep the World Lab as a production developer/admin surface, not a disposable demo.
- The only initial hex states are `open` and `infected`.
- The only agent world actions are adjacent move, infect current cell, capture an abandoned infected current cell from a non-allied controller, and wait. Nothing accompanies that action: there is no agent communication and no diplomacy intent.
- Infection and agent position are independent. Movement does not remove infection.
- Full agent visibility is deliberate. Do not add fog of war, detection, scanners, or last-known positions.
- Zero swarm (`zero-swarm-v1`) is the sole cognition architecture: one Agent Zero planning call per tick regardless of roster size, issuing structured directives that TypeSafe Jev reflex workers resolve. Do not reintroduce a second cognition architecture or a mode switch between them. The deterministic-worker path is an ablation control for the comparison CLIs, not a second production architecture.
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
- Coding agents write and update appropriate tests, configure automatic GitHub CI, and provide the exact local validation commands for the repository owner to run.
- The repository owner runs local formatting checks, lint, type checking, tests, builds, and Playwright. Coding agents must not run local validation unless the owner explicitly requests it in that session.
- After implementation and test authoring, coding agents must stop before pushing a branch or opening a pull request.
- The coding agent must provide the exact local validation commands and wait for the repository owner to run them.
- A branch may be pushed and a draft pull request may be opened only after the owner explicitly confirms in the same session that final local validation passed.
- If the owner reports a validation failure, fix it locally, provide the relevant commands, and pause again for owner retesting.
- Never infer validation approval from the original task prompt, completed implementation, local commits, or expected CI behavior.
- Automatic GitHub CI should begin only after the owner’s local validation gate has passed and the draft pull request is opened.
- Coding agents still must not run local validation unless explicitly authorized by the owner.
- Automatic GitHub CI may run after a branch is pushed. Coding agents may inspect CI status and failure logs.
- Coding agents must never claim local tests passed unless the repository owner supplied the results.
