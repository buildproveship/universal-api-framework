# Ticket status (moved from README, 18 November 2026)

Recorded as it stood in the README on 18 November 2026. Check Jira for the
current state of each ticket.

## RRDAPI-8 (API smoke scaffold)

RRDAPI-8 remains post-MVP; **the full ticket is not complete** and still depends on
[RRDSCRUM-53](https://noisegatemusicstudios.atlassian.net/browse/RRDSCRUM-53).

## RRDAPI-14 (OpenAPI intake preflight)

Still required for RRDAPI-14: broader OpenAPI validation and resolved
source-located inventory; immutable scoped persistence, original/normalized hashes,
idempotency and version differences; authenticated access/provenance contracts;
approved encryption, retention/deletion and redaction policies; product limits and
supported-version decisions. None is inferred from preflight success. Review
approval remains separate from execution permission.

RRDAPI-13's selected Contract Intake visual remains a separate Copilot-owned gate.
Its selection does not settle the outstanding product/security policies. This
slice adds no UI and makes no visual fidelity claim.

## Section names before the 19 November 2026 guardrails change

The README section "Local k6 performance harness" was titled "(RRDAPI-10)", the README section "Inactive OpenAPI
intake preflight" was titled "(RRDAPI-14)", and `performance/README.md` was titled "Local k6 performance harness
(RRDAPI-10)". The ticket keys are dropped from README headings because READMEs describe today's code, not ticket history.
