# Conductor

Conductor is a local Jira-shaped orchestration layer for approval-gated agent work. It keeps project work, immutable plans, approvals, runs, receipts, and Paperclip import history in a service-owned SQLite database.

## Run locally

Requirements: Node.js 24 or newer, npm, Git, and the `codex` and/or `claude` executable on `PATH` for whichever agent(s) you select per role (planner/worker/evaluator, configurable per project in Settings).

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. The API listens on <http://127.0.0.1:4317>.

For a production-style local run:

```bash
npm run build
npm start
```

Then open <http://127.0.0.1:4317>.

## Safety defaults

- Dispatch starts disabled for every project.
- A project needs an explicit repository root before execution can be approved.
- Moving a Story to To Do creates one read-only planning run.
- Only the hash of the approved immutable plan can authorize its execution.
- Successful worker runs stop in In Review; only user acceptance moves work to Done.
- Merge, deployment, publication, deletion, spending, and external messages require their own action-scope approval.
- Restarted services mark live runs Interrupted and never relaunch them automatically.
- Claude worker runs use `--dangerously-skip-permissions` and, like Codex, are confined to the isolated workspace Conductor prepares and gated behind plan-hash approval.

Configure repository roots, workspace policy, verification commands, and dispatch from Settings. Paperclip import is preview-first, idempotent by source ID, and never writes back to Paperclip.

## Verification

```bash
npm run check
npm run test:e2e
npm run build
```

The suite covers database constraints, plan/approval gates, queue limits, fake-Codex and fake-Claude failures and token capture, Paperclip import idempotency, REST behavior, keyboard focus, and the 200% layout.

## Local paths and overrides

- SQLite: `data/conductor.sqlite`
- Backups: `data/backups/`
- Worker logs and structured results: under `data/`
- `CONDUCTOR_DB_PATH`: alternate SQLite path
- `CONDUCTOR_HOST`: API bind host; defaults to `127.0.0.1`
- `CONDUCTOR_PORT`: API port; defaults to `4317`
- `CONDUCTOR_CODEX_BIN`: alternate Codex executable, used by the fake-worker tests and interactive Codex sessions
- `CONDUCTOR_CLAUDE_BIN`: alternate Claude Code executable, used by the fake-worker tests and interactive Claude Code sessions
- `CONDUCTOR_SESSION_CODEX_MODEL`: model for interactive Codex sessions; omitted by default so Codex uses its own configured default
- `CONDUCTOR_SESSION_CODEX_SANDBOX`: sandbox policy for interactive Codex sessions; defaults to `read-only`
- `CONDUCTOR_SESSION_CODEX_APPROVAL`: approval policy for interactive Codex sessions; defaults to `on-request`

SQLite runs in WAL mode. A timestamped backup is created at service start and hourly while Conductor is running.
