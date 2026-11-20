# TODO

Open work, roughly in priority order. Update this file as items close.
Last reviewed: 2026-11-20.

## Blocking the paid eval baseline (branch `eval-solo-tasks`)

- [ ] **Keep Claude thinking blocks across tool calls.** Claude Opus 5.5 always thinks, and the
      Anthropic adapter (`runtime/src/providers.ts`) currently discards `thinking` blocks. Anthropic's
      guidance: on the same model, pass thinking blocks back unchanged — "dropping or editing them
      breaks the turn". Store them on the message, replay them verbatim (with signatures), and test
      against the real API in the pilot. Untested whether today's code 400s or silently loses reasoning.
- [ ] **Set `effort` per teammate.** Opus 5.5 defaults to `medium`; agentic work usually wants
      `high`. Add an effort setting to the bot profile (Anthropic `output_config.effort`).
- [ ] **Handle refusals.** Check `stop_reason: "refusal"` and consider server-side `fallbacks` for
      Claude models, instead of treating a refusal as an empty answer.
- [ ] **Seed tasks from the user.** 3–5 real tasks plus what makes a task hard; then write ~20 cases
      and get the full set signed off.
- [ ] **Approve the runner** (`--approve-harness`, user's decision) and do the free mock-provider dry run.
- [ ] **API key.** Decide which key pays (see "Claude plan API credits" below), then save it through
      the session's secure credential form. Never in chat or the repo.
- [ ] **Docker running** in the session for container-isolated cases (it stops when the session restarts).
- [ ] **Grading sign-off.** Pilot a few cases, user reviews the judge's grades in `report.html`.
- [ ] **Cost estimate from the pilot**, user go-ahead, then the full baseline run.
- [ ] Open a PR for `eval-solo-tasks` and merge.

## Revisit later

- [ ] **Claude plan API credits** (announced 2026-10-07). Max $100/mo, Ultra $200/mo, Team $20–100 per
      seat (pooled, capped at $500); not Free, Pro or Enterprise. Spent via an API key from one linked
      Console organization; covers the Messages API; expires monthly, no rollover; 7 days on plan
      before claiming. To do: confirm the user's plan; if Max or above, link a Console org and use that
      key for evals. Re-check the terms: support pages show only relative "updated" dates, and the
      June 2026 "paused" Agent SDK change could resume.
      Sources: support.claude.com/en/articles/17154008, support.claude.com/en/articles/15036540
- [ ] **xAI subscriptions.** No official word found that SuperGrok includes API access or credits;
      subscription login works only inside specific partner tools (Grok Build, OpenClaw, Hermes, Pi),
      per third-party reports. Re-check docs.x.ai.
- [ ] **Do not** add "sign in with your Claude plan" to Crew unless Anthropic clearly permits
      third-party apps to do so. API keys work today.

## Repo housekeeping

- [ ] Delete the merged branch `harness-caching-images-compaction` on GitHub (this session's
      GitHub access refuses branch deletion; do it from the PR page or locally).
- [ ] Consider enabling "Automatically delete head branches" in repo settings.

## Harness gaps (not started)

- [ ] Run independent tool calls in parallel (currently sequential).
- [ ] Count tokens instead of estimating (~4 chars/token) for compaction.
- [ ] Optional 1-hour prompt-cache TTL for slow conversations.
- [ ] Planning/to-do tool for long tasks; delegation deeper than one level.
- [ ] Resume runs interrupted by a restart (today they are marked "stopped").

## Product features (not started)

- [ ] Slack connector (teammates present in Slack).
- [ ] Team memory sync between runtimes (laptop vs VM).
- [ ] Not built: Teams presence, joining meetings, learning routines by watching, OAuth app
      connectors, mobile app.

## Untested

- [ ] Installers (`npm run dist`), Podman, the default container image `node:22-bookworm`,
      non-root container mode, `deploy/Dockerfile`, `deploy/crew-runtime.service`.
- [ ] Browser tool with real Playwright; cron scheduler firing on its own.
- [ ] Everything against a real model provider (all tests use scripted mocks).
