# Decisions

Owner decisions that change how this repository is built, checked or released. Newest first.

## 20 November 2026: minimum Actions spend ($10/month organisation budget)

- **Decided by:** the owner (no clients yet; the organisation's Actions budget is a $10/month hard stop).
- **Scope:** `pr.yml` skips documentation-only pull requests (`**/*.md`, `docs/**`); no status check is required (branch protection is unavailable on the free plan), so skipped checks block nothing. `performance.yml` runs weekly (Sunday) and on demand, and a scheduled run exits early when `main` has no new commit since the last successful run. The k6 archive is cached and still verified against its pinned SHA-256 on every run. Every job has `timeout-minutes`.

## 18 November 2026: light pull request checks in GitHub Actions

- **Decided by:** the owner, choosing "Apply all six (Recommended)" for the cross-repo programme (recommendations 1 and 2).
- **Scope:** `.github/workflows/pr.yml` runs on every pull request to `main`: install, build, lint, typecheck and unit tests (a few minutes). The k6 performance suites (`npm run test:performance`, which needs k6 on PATH, installed from the pinned, checksum-verified official k6 linux-amd64 release binary) run only on demand (`workflow_dispatch`) and nightly, in `.github/workflows/performance.yml`. Both workflows run on GitHub-hosted `ubuntu-24.04` (20 Nov 2026; the macOS runner `rr-local` is reserved for macOS-only tests, none here); Draft pull requests skip the checks.
- **Replaces:** the 12 November 2026 decision that routine checks do not run in GitHub Actions (RRDPLAT-44), for this light set only. Everything else stays as that decision set it, including the manual code-quality scan workflow.
- **Tooling:** ESLint, Prettier, the tsconfig base and the Renovate preset come from the shared `@releaseready/config` package ([buildproveship/config](https://github.com/buildproveship/config)); local overrides carry a comment with their reason.
