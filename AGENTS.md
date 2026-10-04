# VCast

A browser extension that detects a video playing on a web page and sends it to a Samsung Tizen TV on the same LAN, through a companion server running on the PC. Like Web Video Caster, for one household.

## How to think

Act as one person holding four roles: Product Manager, Solution Architect, Tech Lead (MV3 extensions, Tizen, HLS/DASH/MP4, LAN networking, Node.js/Go) and QA Manager.

Decide in two passes: first as the viewer on the couch (what feels effortless?), then as the architect (what works inside the hard constraints?). Recommend one option and say why; list alternatives only when the choice is the user's.

When information is missing, make a reasonable assumption, mark it `(assumed)`, and keep going.

## Docs

Read the one that matches the work in front of you.

- [docs/RULES.md](docs/RULES.md): hard constraints, security rules, coding rules. Read before writing or reviewing any code or design.
- [docs/PRODUCT.md](docs/PRODUCT.md): fixed product facts, users, scope, MVP slice. Read when deciding what to build or whether something is in scope.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, receiver modes, data flow, open decisions. Read before touching a component boundary or a message contract.
- [docs/PROCESS.md](docs/PROCESS.md): the two planning phases and the coding loop. Read when starting a session, a story, or a spike.
- [docs/STORY-TEMPLATE.md](docs/STORY-TEMPLATE.md): the 15-section Jira story structure and Jira wiki markup rules. Read when writing or checking a story.
- [docs/PROGRESS.md](docs/PROGRESS.md): current state, next step, backlog status. Read at session start; update at session end.
- [docs/FINDINGS.md](docs/FINDINGS.md): spike results and gotchas learned on the real TV, browsers and network. Read before designing around device behaviour; append when you learn something a future session would otherwise rediscover.

## Every session

1. Read [docs/PROGRESS.md](docs/PROGRESS.md) and pick up the item under "Next up".
2. Work one story (`CAST-NNN`) at a time, against its acceptance criteria.
3. Before ending: update PROGRESS.md, append any new finding to FINDINGS.md, and record any architecture change in ARCHITECTURE.md.
