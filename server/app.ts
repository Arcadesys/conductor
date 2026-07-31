import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import type { ConductorDb } from "./db.ts";
import {
  addActivity,
  createIssue,
  createProject,
  getBootstrap,
  normalizeBootstrap,
  wouldCreateBlockCycle
} from "./db.ts";
import { commitPaperclipImport, previewPaperclip } from "./importer.ts";
import { startInteractiveSession } from "./sessions.ts";
import { WorkerSupervisor } from "./workers.ts";

type EventPayload = { type: string; data: unknown };

export function createApp(database: ConductorDb) {
  const app = express();
  const clients = new Set<Response>();
  const emit = (event: EventPayload) => {
    for (const client of clients) client.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  };
  const supervisor = new WorkerSupervisor(database.raw, resolve(database.path, ".."), emit);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, sqlite: "saved", queue: supervisor.snapshot() });
  });

  app.get("/api/bootstrap", (_request, response) => {
    response.json({ ...normalizeBootstrap(getBootstrap(database.raw)), queue: supervisor.snapshot() });
  });

  app.get("/api/events", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    response.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
    clients.add(response);
    const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 25_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(response);
    });
  });

  app.get("/api/projects", (_request, response) => {
    response.json(database.raw.prepare("SELECT * FROM projects ORDER BY name").all());
  });

  app.post("/api/projects", (request, response) => {
    const { key, name } = request.body ?? {};
    if (!key || !/^[A-Za-z][A-Za-z0-9]{1,7}$/.test(key)) throw httpError(400, "Project key must be 2–8 letters or numbers.");
    if (!name?.trim()) throw httpError(400, "Project name is required.");
    const project = createProject(database.raw, request.body);
    emit({ type: "project.created", data: project });
    response.status(201).json(project);
  });

  app.patch("/api/projects/:id", (request, response) => {
    const allowed = [
      "name",
      "description",
      "repo_root",
      "workspace_policy",
      "worktree_parent",
      "verification_commands",
      "risk_class",
      "planner_model",
      "planner_agent",
      "worker_model",
      "worker_agent",
      "evaluator_model",
      "evaluator_agent",
      "dispatch_enabled"
    ];
    const entries = Object.entries(request.body ?? {}).filter(([key]) => allowed.includes(key));
    if (!entries.length) throw httpError(400, "No supported project fields supplied.");
    const values: SQLInputValue[] = entries.map(([, value]) => {
      if (Array.isArray(value)) return JSON.stringify(value);
      if (typeof value === "boolean") return value ? 1 : 0;
      return value as SQLInputValue;
    });
    const sql = `UPDATE projects SET ${entries.map(([key]) => `${key}=?`).join(",")},updated_at=? WHERE id=?`;
    database.raw.prepare(sql).run(...values, new Date().toISOString(), request.params.id);
    const project = database.raw.prepare("SELECT * FROM projects WHERE id=?").get(request.params.id);
    if (!project) throw httpError(404, "Project not found.");
    addActivity(database.raw, request.params.id, null, "You", "project.updated", "Updated project settings.");
    emit({ type: "project.updated", data: project });
    response.json(project);
  });

  app.delete("/api/projects/:id", (request, response) => {
    const project = database.raw.prepare("SELECT * FROM projects WHERE id=?").get(request.params.id);
    if (!project) throw httpError(404, "Project not found.");
    database.raw.prepare("DELETE FROM projects WHERE id=?").run(request.params.id);
    emit({ type: "project.deleted", data: { id: request.params.id } });
    response.json({ ok: true });
  });

  app.get("/api/issues", (request, response) => {
    const projectId = request.query.projectId;
    const rows = projectId
      ? database.raw.prepare("SELECT * FROM issues WHERE project_id=? ORDER BY rank").all(String(projectId))
      : database.raw.prepare("SELECT * FROM issues ORDER BY project_id,rank").all();
    response.json(rows);
  });

  app.post("/api/issues", (request, response) => {
    const { projectId, type, title } = request.body ?? {};
    if (!projectId || !["epic", "story", "subtask"].includes(type) || !title?.trim()) {
      throw httpError(400, "projectId, type, and title are required.");
    }
    const issue = createIssue(database.raw, request.body);
    emit({ type: "issue.created", data: issue });
    response.status(201).json(issue);
  });

  app.patch("/api/issues/:id", (request, response) => {
    const existing = database.raw.prepare("SELECT * FROM issues WHERE id=?").get(request.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) throw httpError(404, "Issue not found.");
    const allowed = [
      "title",
      "description",
      "status",
      "priority",
      "estimate_hours",
      "rank",
      "parent_id",
      "sprint_id",
      "acceptance_criteria",
      "labels"
    ];
    const entries = Object.entries(request.body ?? {}).filter(([key]) => allowed.includes(key));
    if (!entries.length) throw httpError(400, "No supported issue fields supplied.");
    const values: SQLInputValue[] = entries.map(([, value]) =>
      Array.isArray(value) ? JSON.stringify(value) : (value as SQLInputValue)
    );
    database.raw
      .prepare(`UPDATE issues SET ${entries.map(([key]) => `${key}=?`).join(",")},updated_at=? WHERE id=?`)
      .run(...values, new Date().toISOString(), request.params.id);
    const updated = database.raw.prepare("SELECT * FROM issues WHERE id=?").get(request.params.id) as Record<string, unknown>;
    addActivity(
      database.raw,
      String(updated.project_id),
      request.params.id,
      "You",
      "issue.updated",
      `Updated ${String(updated.issue_key)}.`
    );
    if (existing.status !== "todo" && updated.status === "todo" && updated.type === "story") {
      supervisor.queuePlanner(request.params.id);
    }
    emit({ type: "issue.updated", data: updated });
    response.json(updated);
  });

  app.post("/api/issues/bulk", (request, response) => {
    const { issueIds, changes } = request.body ?? {};
    if (!Array.isArray(issueIds) || !issueIds.length || !changes) throw httpError(400, "issueIds and changes are required.");
    const transitionedToTodo: string[] = [];
    database.raw.exec("BEGIN IMMEDIATE");
    try {
      for (const id of issueIds) {
        const entries = Object.entries(changes).filter(([key]) => ["status", "priority", "sprint_id"].includes(key));
        if (!entries.length) throw httpError(400, "No supported bulk fields supplied.");
        const before = database.raw.prepare("SELECT status,type FROM issues WHERE id=?").get(String(id)) as
          | { status: string; type: string }
          | undefined;
        database.raw
          .prepare(`UPDATE issues SET ${entries.map(([key]) => `${key}=?`).join(",")},updated_at=? WHERE id=?`)
          .run(...entries.map(([, value]) => value as SQLInputValue), new Date().toISOString(), String(id));
        if (before?.status !== "todo" && before?.type === "story" && changes.status === "todo") {
          transitionedToTodo.push(String(id));
        }
      }
      database.raw.exec("COMMIT");
    } catch (error) {
      database.raw.exec("ROLLBACK");
      throw error;
    }
    transitionedToTodo.forEach((id) => supervisor.queuePlanner(id));
    emit({ type: "issues.bulk_updated", data: { issueIds, changes } });
    response.json({ updated: issueIds.length });
  });

  app.post("/api/issues/:id/links", (request, response) => {
    const { targetIssueId, type } = request.body ?? {};
    if (!targetIssueId || !["blocks", "relates", "duplicates"].includes(type)) {
      throw httpError(400, "targetIssueId and valid link type are required.");
    }
    if (type === "blocks" && wouldCreateBlockCycle(database.raw, request.params.id, targetIssueId)) {
      throw httpError(409, "This dependency would create a cycle.");
    }
    const link = {
      id: randomUUID(),
      source_issue_id: request.params.id,
      target_issue_id: targetIssueId,
      type,
      created_at: new Date().toISOString()
    };
    database.raw
      .prepare("INSERT INTO issue_links(id,source_issue_id,target_issue_id,type,created_at) VALUES(?,?,?,?,?)")
      .run(link.id, link.source_issue_id, link.target_issue_id, link.type, link.created_at);
    emit({ type: "issue.linked", data: link });
    response.status(201).json(link);
  });

  app.post("/api/sprints", (request, response) => {
    const { projectId, name } = request.body ?? {};
    if (!projectId || !name?.trim()) throw httpError(400, "projectId and name are required.");
    const sprint = {
      id: randomUUID(),
      project_id: projectId,
      name: name.trim(),
      goal: request.body.goal ?? "",
      state: request.body.state ?? "future",
      starts_at: request.body.startsAt ?? null,
      ends_at: request.body.endsAt ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    database.raw.prepare(`
      INSERT INTO sprints(id,project_id,name,goal,state,starts_at,ends_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
    `).run(...Object.values(sprint));
    emit({ type: "sprint.created", data: sprint });
    response.status(201).json(sprint);
  });

  app.post("/api/issues/:id/plan", (_request, response) => {
    const issue = database.raw.prepare("SELECT type FROM issues WHERE id=?").get(_request.params.id) as { type: string } | undefined;
    if (!issue) throw httpError(404, "Issue not found.");
    if (issue.type !== "story") throw httpError(400, "Only Stories can be planned.");
    const runId = supervisor.queuePlanner(_request.params.id);
    response.status(202).json({ runId });
  });

  app.post("/api/plans/:id/request-changes", (request, response) => {
    const plan = database.raw.prepare("SELECT * FROM plans WHERE id=?").get(request.params.id) as
      | { id: string; issue_id: string; status: string }
      | undefined;
    if (!plan) throw httpError(404, "Plan not found.");
    database.raw
      .prepare("UPDATE plans SET status='changes_requested',feedback=?,updated_at=? WHERE id=?")
      .run(String(request.body?.feedback ?? ""), new Date().toISOString(), request.params.id);
    database.raw.prepare("UPDATE issues SET agent_state='not_started',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), plan.issue_id);
    const issue = database.raw.prepare("SELECT project_id FROM issues WHERE id=?").get(plan.issue_id) as { project_id: string };
    addActivity(database.raw, issue.project_id, plan.issue_id, "You", "plan.changes_requested", "Requested changes to the plan.");
    const runId = supervisor.queuePlanner(plan.issue_id);
    emit({ type: "plan.changes_requested", data: { planId: plan.id, issueId: plan.issue_id } });
    response.status(202).json({ ok: true, runId });
  });

  app.post("/api/plans/:id/approve", (request, response) => {
    const plan = database.raw.prepare("SELECT * FROM plans WHERE id=?").get(request.params.id) as
      | { id: string; issue_id: string; body: string; hash: string; status: string }
      | undefined;
    if (!plan) throw httpError(404, "Plan not found.");
    const latest = database.raw.prepare("SELECT id,hash FROM plans WHERE issue_id=? ORDER BY version DESC LIMIT 1")
      .get(plan.issue_id) as { id: string; hash: string };
    if (latest.id !== plan.id || latest.hash !== plan.hash) throw httpError(409, "This plan has been superseded.");
    const issue = database.raw.prepare(`
      SELECT i.project_id,p.dispatch_enabled,p.repo_root FROM issues i
      JOIN projects p ON p.id=i.project_id WHERE i.id=?
    `).get(plan.issue_id) as { project_id: string; dispatch_enabled: number; repo_root: string | null };
    if (!issue.repo_root) throw httpError(409, "Configure the project repository before dispatch.");
    if (!issue.dispatch_enabled) throw httpError(409, "Enable dispatch in project settings before approval.");
    const submittedHash = createHash("sha256").update(plan.body).digest("hex");
    if (submittedHash !== plan.hash) throw httpError(409, "Plan body no longer matches its approval hash.");
    const approval = {
      id: randomUUID(),
      plan_id: plan.id,
      plan_hash: plan.hash,
      approved_by: "local-user",
      action_scope: "repo_write",
      created_at: new Date().toISOString()
    };
    database.raw
      .prepare("INSERT INTO approvals(id,plan_id,plan_hash,approved_by,action_scope,created_at) VALUES(?,?,?,?,?,?)")
      .run(...Object.values(approval));
    database.raw.prepare("UPDATE plans SET status='approved',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), plan.id);
    const runId = supervisor.queueWorker(plan.issue_id, plan.id);
    emit({ type: "plan.approved", data: { ...approval, runId } });
    response.status(202).json({ approval, runId });
  });

  app.post("/api/issues/:id/session", async (request, response, next) => {
    try {
      const agent = request.body?.agent === "codex" ? "codex" : "claude";
      const result = await startInteractiveSession(database.raw, resolve(database.path, ".."), request.params.id, agent);
      emit({ type: "session.started", data: { issueId: request.params.id, ...result } });
      response.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/issues/:id/session/complete", (request, response) => {
    const issue = database.raw.prepare("SELECT project_id FROM issues WHERE id=?").get(request.params.id) as
      | { project_id: string }
      | undefined;
    if (!issue) throw httpError(404, "Issue not found.");
    const agent = request.body?.agent === "codex" ? "codex" : "claude";
    const outcome = ["success", "blocked", "failed"].includes(request.body?.outcome) ? request.body.outcome : "success";
    const summary = String(request.body?.summary ?? "").trim().slice(0, 4000);
    const agentName = agent === "codex" ? "Codex" : "Claude Code";
    const nextStatus = outcome === "success" ? "in_review" : "blocked";
    database.raw.prepare("UPDATE issues SET status=?,updated_at=? WHERE id=?")
      .run(nextStatus, new Date().toISOString(), request.params.id);
    addActivity(
      database.raw,
      issue.project_id,
      request.params.id,
      agentName,
      "session.completed",
      summary || `${agentName} session finished (${outcome}).`
    );
    const updated = database.raw.prepare("SELECT * FROM issues WHERE id=?").get(request.params.id);
    emit({ type: "issue.updated", data: updated });
    emit({ type: "session.completed", data: { issueId: request.params.id, agent, outcome, summary } });
    response.json({ ok: true, status: nextStatus });
  });

  app.post("/api/runs/:id/cancel", (request, response) => {
    if (!supervisor.cancel(request.params.id)) throw httpError(409, "Run is not active or queued.");
    response.json({ ok: true });
  });

  app.post("/api/runs/:id/resume", (request, response) => {
    const runId = supervisor.resume(request.params.id);
    response.status(202).json({ runId });
  });

  app.post("/api/runs/:id/accept", (request, response) => {
    const run = database.raw.prepare("SELECT * FROM runs WHERE id=?").get(request.params.id) as
      | { issue_id: string; project_id: string; status: string }
      | undefined;
    if (!run || run.status !== "succeeded") throw httpError(409, "Only a successful run can be accepted.");
    const issue = database.raw.prepare("SELECT agent_state FROM issues WHERE id=?").get(run.issue_id) as { agent_state: string };
    if (issue.agent_state !== "awaiting_acceptance") throw httpError(409, "Story is not awaiting acceptance.");
    database.raw.prepare("UPDATE issues SET status='done',agent_state='not_started',updated_at=? WHERE id=?")
      .run(new Date().toISOString(), run.issue_id);
    addActivity(database.raw, run.project_id, run.issue_id, "You", "run.accepted", "Accepted the verified handoff and moved Story to Done.");
    emit({ type: "run.accepted", data: { runId: request.params.id, issueId: run.issue_id } });
    response.json({ ok: true });
  });

  app.post("/api/imports/paperclip/preview", async (request, response) => {
    const preview = await previewPaperclip(request.body);
    response.json(preview);
  });

  app.post("/api/imports/paperclip/commit", (request, response) => {
    const result = commitPaperclipImport(database.raw, request.body);
    emit({ type: "import.committed", data: result });
    response.status(result.imported ? 201 : 200).json(result);
  });

  app.post("/api/backups", (_request, response) => {
    response.status(201).json({ path: database.backup() });
  });

  const clientDir = resolve("dist/client");
  if (process.env.NODE_ENV === "production" && existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get("*splat", (_request, response) => response.sendFile(resolve(clientDir, "index.html")));
  }

  app.use((error: Error & { status?: number }, _request: Request, response: Response, _next: NextFunction) => {
    const status = error.status ?? (error.message.includes("UNIQUE constraint") ? 409 : 500);
    response.status(status).json({ error: error.message });
  });

  return { app, supervisor, emit };
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}
