# Process

Planning runs in two phases, then each story is built in a coding loop. Planning output is Jira wiki markup (rules in [STORY-TEMPLATE.md](STORY-TEMPLATE.md)) and is saved under `docs/jira/` so coding sessions can read it.

## Phase 1: architecture and story map

Run once. Save the output to `docs/jira/phase-1.txt`, then stop and wait for the user.

Produce, in Jira wiki markup:

1. **Architecture decision.** Compare R1, R2 and a hybrid in a table with columns `||Option||Needs on TV||Needs on PC||Works with Referer-locked streams||Remote control quality||Effort||Risk||`. Recommend one for MVP and explain why in three lines or fewer. Include a component diagram described as text (Extension <-> Server <-> TV) and the message contract names.
2. **Spikes** needed before building, each timeboxed. At least:
   - Tizen browser codec and HLS support on the actual TV
   - DLNA renderer behaviour with HLS versus MP4
   - Native Messaging versus localhost WebSocket for extension-to-server communication
3. **Epics**, for example: Detection, Pairing, Server Core, Stream Proxy, TV Receiver, DLNA, Playback Control, Packaging & Install, Observability, Cross-browser.
4. **Backlog table** with columns `||ID||Epic||Title||Type||Priority (MoSCoW)||Size (S/M/L)||Depends on||Release||`, ordered in build sequence.
   - IDs: `CAST-001`, `CAST-002`, ...
   - Title: `[Module] Verb + Object`
   - Type: User / Technical / Infra / DevOps / Security / Spike
   - Release: MVP / v1.1 / Future, with MVP as defined in [PRODUCT.md](PRODUCT.md)
5. **User journeys**, three at most: first-time setup, everyday cast, failure and recovery.
6. **Assumptions**, each marked `(assumed)`, and up to five open questions. The open questions inform later work; they do not block it.

End Phase 1 with exactly:

> Reply with a story ID, 'next', or 'all MVP' to generate full stories.

Phase 1 is done when all six parts exist, every backlog row has all eight columns filled, the decisions are copied into [ARCHITECTURE.md](ARCHITECTURE.md), and the backlog is copied into [PROGRESS.md](PROGRESS.md).

## Phase 2: full Jira stories

One story per request, unless the user says batch (`all MVP`). `next` means the first backlog row without a story.

Write each story to `docs/jira/CAST-NNN.txt` following [STORY-TEMPLATE.md](STORY-TEMPLATE.md) exactly, and run its self-check silently before output. Fill gaps with assumptions marked `(assumed)` and keep going; Phase 2 never pauses to ask.

## Spikes

A spike is a timeboxed investigation that ends in a decision. When one finishes:

1. Append the result to [FINDINGS.md](FINDINGS.md) in its entry format.
2. Update the matching row under "Open decisions" in [ARCHITECTURE.md](ARCHITECTURE.md).
3. Adjust any backlog rows the result invalidates, and note the change in [PROGRESS.md](PROGRESS.md).

Spikes that need the real TV are run by the user; give them exact steps and the observations to report back.

## Coding loop

Every change follows these six steps, in order.

1. **Spec first.** Write or update [SPEC.md](../SPEC.md): requirements, the files it touches, expected behaviour, acceptance criteria, and test scenarios.
2. **Build it.** Implement from the spec, with tests. Run `npm run check` (lint, type check, tests with 90% coverage on lines, branches and functions) until it is clean.
3. **Two reviews, side by side.**
   - Code review agent: reads the code against the spec and reports bugs, missing requirements, security and logic problems, and regressions. It changes nothing.
   - Functional test agent: drives every changed UI flow in a real browser with Playwright (fields, buttons, validation, edge cases) and leaves its tests in `tests/e2e/`.
4. **One bug list.** Merge both reports into a single list, drop duplicates and anything that is not a real problem, and say why each dropped item was dropped.
5. **Fix.** Fix every valid item, adding a test that fails without the fix.
6. **Run it all again.** `npm run check` and `npm run test:e2e` must both pass before the work is called done.

Then list the checks that need the real TV as manual steps for the user, and update [PROGRESS.md](PROGRESS.md).

## Keeping the docs true

| When this happens | Update |
|---|---|
| A story changes status | PROGRESS.md |
| A device, browser or network behaviour is observed | FINDINGS.md |
| A boundary, contract, port or decision changes | ARCHITECTURE.md |
| A new constraint or standing rule is agreed with the user | RULES.md |
| Scope or release assignment changes | PRODUCT.md and the backlog in PROGRESS.md |
