# Story template

Every Phase 2 story uses these 15 sections, in this order, in Jira wiki markup.

## Structure

1. **TITLE**: `[Module] Verb + Object`, then a line: `Type | Priority | Story points (Fibonacci) | Labels | Epic`
2. **SUMMARY**: one to three sentences on what this delivers and why.
3. **USER STORY**: "As a [role], I want [capability], so that [value]." Non-user-facing stories use the matching form:
   - Technical: "In order to [outcome], we will [change], measured by [metric]."
   - Infra: "To support [capability], provision/change [component] so that [SLO] is met."
   - DevOps: "As the delivery team, we need [pipeline change] so that [improvement]."
   - Security: "As a [system/data owner], I need [control] so that [threat] is mitigated."
   - Spike: "Investigate [question] within [timebox] to produce [decision/output]."
4. **IN SCOPE / OUT OF SCOPE**: explicit bullets. If nothing applies, write "N/A" plus the reason.
5. **FUNCTIONAL REQUIREMENTS**: `FR-1`, `FR-2`, ...
6. **NON-FUNCTIONAL REQUIREMENTS**: concrete targets where relevant: time-to-first-frame on the TV, pairing time, control latency, server CPU/RAM, extension memory, reconnection after a Wi-Fi drop, D-pad accessibility on the TV. If none apply, say so.
7. **ACCEPTANCE CRITERIA**: Gherkin, `AC-1`, `AC-2`, ... Each one is testable by someone who did not write the code and states an observable result. At minimum:
   - one happy path;
   - one negative or invalid input (wrong or expired code, DRM page, dead URL);
   - one "role" scenario: a second sender or a second TV trying to join an active session, since there are no auth roles;
   - one edge case (server not running, PC IP changed, TV asleep, multiple videos on a page, iframe video, signed URL expired, ad pre-roll before the main video).
8. **API / CONTRACTS / STORAGE**: message contracts (JSON schemas with examples) for Extension<->Server and Server<->TV, HTTP/WebSocket endpoints, DLNA SOAP actions used, `chrome.storage` keys, the server config file schema, plus versioning, migration and rollback. "N/A" only if there are none.
9. **SECURITY & PRIVACY**: no auth by design, so cover pairing code length, expiry and reuse; LAN-only binding; the proxy allow-list; each extension permission requested and why; what is never logged (cookies, headers, full URLs, sensitive page titles). "N/A" only if there is no surface.
10. **ERROR HANDLING & LOGGING**: a table of expected errors, each with the exact user-facing message (short, non-technical, with a next step) and the log entry (level, event name, safe fields only).
11. **DEPENDENCIES**: story IDs from the backlog, external libraries with their licence, or "None".
12. **RISKS & ASSUMPTIONS**: each risk paired with its mitigation; assumptions stated plainly and marked "(assumed)".
13. **TEST NOTES FOR QA**:
    - Test data: a direct-MP4 page, a plain-HLS page, a Referer-locked HLS page, a DRM page, a page with multiple videos, a page with the video in an iframe.
    - Matrix: Chrome / Brave / Edge x receiver R1 / R2 x Wi-Fi conditions (normal, drop and reconnect, PC sleep/wake).
    - Regression-risk areas; what to automate (unit, contract, Playwright for the extension, a mock DLNA renderer) versus what stays manual on the real TV.
14. **DEPLOYMENT NOTES**: feature flag (name and default), extension version bump and store/unpacked distribution, server installer and auto-start, Windows firewall prompt handling, rollback plan, and what to watch after release (local logs only, no telemetry unless the user opts in).
15. Closing line, exactly: `DoR checked: [ ]   DoD checked at close: [ ]`

## Self-check (silent; never printed in the story)

- Every hard constraint in [RULES.md](RULES.md) respected: no sockets in the extension, no cloud, no TV install, DRM excluded?
- All ACs testable, covering happy, negative, role and edge?
- Dependencies reference real IDs from the Phase 1 backlog?
- Consistent with the architecture chosen in Phase 1 and with earlier stories?
- Assumptions marked "(assumed)"?

## Formatting

- Jira wiki markup only: `h2.` headings, `*` bullets, `#` numbered lists, `||` table headers, `{code:json}` blocks. Markdown syntax does not render in Jira.
- Concise and complete. The story contains only story content: no filler, no restated instructions, no commentary about the story.
