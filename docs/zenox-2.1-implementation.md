# Zenox 2.1.0 — implementation notes

## What changed

| Area | Change | Main files |
|---|---|---|
| SDK | `@opencode/plugin` 2.0.27 → 2.3.2, OpenTUI 0.9.2, `engines.opencode >= 2.3.0` | `package.json` |
| Model override | `background_task` takes an optional `model`, validated against `ctx.model.list` (exists, chat model, valid variant) and passed to `session.create`. Agents use their default model unless the user asks. | `src/host/v2.ts`, `src/background/*` |
| Prompt | OpenCode 2.3 removed foreground subagents, so the prompt is "Subagent First" and adds "Choosing a Model (Only When the User Asks)" | `src/orchestration/prompt.ts`, `src/hooks/keyword-detector/contexts.ts` |
| Notices | Background notices use `session.synthetic` (no fake user messages). The new `experimental.idle` hook detects child completion first; `session.wait` and the `session.idle` event stay as fallbacks. The event stream is filtered by type. | `src/plugin.ts` |
| Todo continuation | Reads the latest `todowrite` input and injects a reminder from `experimental.idle`. It has these guards: main sessions only, waits for its own background work, never after a question, stops on a stall, has a max count, and uses budget only after the reminder is delivered. | `src/features/todo-continuation/` |
| Session tools | `session_search` (scoped to the project directory) and `session_read` (refuses sessions from other projects) | `src/tools/session-search/` |
| CLI | Default models are derived from the agent definitions (they had drifted: haiku-4-5 vs 5-5) | `src/cli/constants.ts` |
| CI / release | Instabox CI and npm staged release with trusted publishing | `.github/workflows/` |

## Findings from the real engine

- On OpenCode 2.3, every child session, including Zenox background tasks, also gets OpenCode's own `<subagent>` report in the parent. It arrives together with Zenox's notice, and the parent runs one turn.
- Zenox tools are reached through Code Mode (`execute`); `subagent` and `todowrite` are direct tools.
- `agent.list` can return before plugins finish loading (2.2.7+). A Linux run on Instabox exposed this race in a test.
- Duplicate nested `effect` copies after the bump broke the embedded engine. Reinstalling `node_modules` fixed it.

## Tests

- 177 unit tests (`bun test`) and 11 real-engine e2e tests (`bun run test:e2e`, plus `test:e2e:dist` against the built bundle).
- Each new e2e guarantee was checked by deliberately breaking the code: model override, todo injection, stall guard and cross-project read.
- The full CI sequence passed on a fresh Instabox `ci` machine.
- Oracle review: one High finding (`session_read` scope), fixed and covered by tests.

## One-time setup to turn on CI and release

1. Instabox dashboard → **CI** → make sure the instabox GitHub App can access `CyberBoyAyush/zenox`.
2. GitHub repo → **Settings → Environments** → create `npm`. Optionally add yourself as a required reviewer.
3. npmjs.com → package `zenox` → **Settings → Trusted publishing** → GitHub Actions, owner `CyberBoyAyush`, repo `zenox`, workflow `release.yml`, environment `npm`.
4. Push to `main` with a new `version` → CI → Release stages it → approve with `npm stage approve <id>` (or on npmjs.com).
