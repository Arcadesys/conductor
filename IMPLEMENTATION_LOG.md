# Conductor v1 implementation log

## Win condition

A local Jira-shaped React, Node, and SQLite application that performs no idle agent work, blocks workspace writes until the exact immutable plan is approved, supervises bounded Codex workers, and imports Paperclip data without writing back.

## Iteration record

1. **Core service and data model — kept**
   - Added WAL-mode SQLite migrations, backups, audit events, projects, issues, links, sprints, plans, approvals, runs, receipts, imports, and settings.
   - Verdict: schema, hierarchy, cycle, hash, approval, and recovery checks pass.

2. **Worker supervisor — kept**
   - Added event-driven planning, execution, evaluation, queue limits, timeouts, cancellation, structured JSONL capture, worktrees, and restart interruption.
   - Verdict: fake-Codex integration proves no execution before exact approval and captures usage/receipts.

3. **Jira-shaped interface — kept**
   - Added the dark backlog, project sidebar, Epic rail, ranked Stories, issue inspector, Board, All work, Activity, settings, sprints, bulk actions, drag ranking, and Paperclip preview.
   - Verdict: browser comparison matches the approved visual structure and palette without copying Atlassian branding.

4. **Responsive repair — kept**
   - Initial 200% check found the navigation open over the backlog.
   - Changed initial navigation state to follow the same zoom breakpoint as CSS.
   - Verdict: navigation is off-canvas, issue detail is full width, and horizontal overflow is zero.

5. **Focus repair — kept**
   - Automated browser verification found the skip link still used a 1px browser-default outline.
   - Added the shared 3px focus treatment to links.
   - Verdict: keyboard test now passes.

## Final verification

- `npm run check`: 3 files, 6 tests passed.
- `npm run test:e2e`: 2 browser tests passed.
- `npm run build`: production bundle completed.
- Production smoke: `/api/health` returned an empty active/queued worker state and `/` served the built application.
- Browser console: zero warnings or errors in the final accepted layout.

## Current best

The implementation in this folder is the verified v1 baseline. Dispatch remains disabled and repository roots remain unset until the user explicitly configures a project.
