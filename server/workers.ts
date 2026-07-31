import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { addActivity, createPlan, getIssueContext } from "./db.ts";
import { createWorktree } from "./git.ts";
import { planOutputSchema, receiptOutputSchema } from "./schemas.ts";
import type { PlanPayload, ReceiptPayload } from "./types.ts";

const timestamp = () => new Date().toISOString();

type Emit = (event: { type: string; data: unknown }) => void;
type QueueTask = { runId: string; projectId: string; role: "planner" | "worker" | "evaluator"; start: () => Promise<void> };

export class WorkerSupervisor {
  private readonly queue: QueueTask[] = [];
  private readonly active = new Map<string, { projectId: string; role: string; process: ReturnType<typeof spawn> }>();
  private readonly activeProjects = new Set<string>();
  private readonly maxWorkers = 2;

  constructor(
    private readonly db: DatabaseSync,
    private readonly dataDir: string,
    private readonly emit: Emit
  ) {
    mkdirSync(join(dataDir, "runs"), { recursive: true });
  }

  queuePlanner(issueId: string) {
    const context = getIssueContext(this.db, issueId);
    const runId = this.insertRun(
      issueId,
      context.project.id as string,
      null,
      "planner",
      context.project.planner_agent as "codex" | "claude",
      context.project.planner_model as string,
      "low"
    );
    this.queue.push({
      runId,
      projectId: context.project.id as string,
      role: "planner",
      start: () => this.runPlanner(runId, issueId)
    });
    this.db.prepare("UPDATE issues SET agent_state='planning', updated_at=? WHERE id=?").run(timestamp(), issueId);
    addActivity(
      this.db,
      context.project.id as string,
      issueId,
      "Conductor",
      "planning.queued",
      "Planning queued after Story moved to To Do."
    );
    this.emit({ type: "planning.queued", data: { issueId, runId } });
    this.pump();
    return runId;
  }

  queueWorker(issueId: string, planId: string) {
    const context = getIssueContext(this.db, issueId);
    const latest = context.plan as { id: string; hash: string } | null;
    if (!latest || latest.id !== planId) throw new Error("Only the current plan can be dispatched.");
    const approval = this.db
      .prepare("SELECT * FROM approvals WHERE plan_id=? AND plan_hash=? ORDER BY created_at DESC LIMIT 1")
      .get(planId, latest.hash);
    if (!approval) throw new Error("The exact plan version has not been approved.");

    const runId = this.insertRun(
      issueId,
      context.project.id as string,
      planId,
      "worker",
      context.project.worker_agent as "codex" | "claude",
      context.project.worker_model as string,
      "medium"
    );
    this.queue.push({
      runId,
      projectId: context.project.id as string,
      role: "worker",
      start: () => this.runWorker(runId, issueId, planId)
    });
    this.db.prepare("UPDATE issues SET agent_state='approved_queued', updated_at=? WHERE id=?").run(timestamp(), issueId);
    addActivity(this.db, context.project.id as string, issueId, "You", "worker.queued", "Approved plan queued for execution.");
    this.emit({ type: "worker.queued", data: { issueId, runId } });
    this.pump();
    return runId;
  }

  cancel(runId: string) {
    const live = this.active.get(runId);
    if (live) {
      this.finishRun(runId, "cancelled", "Cancelled by user.");
      live.process.kill("SIGTERM");
      return true;
    }
    const index = this.queue.findIndex((item) => item.runId === runId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.finishRun(runId, "cancelled", "Cancelled before launch.");
      return true;
    }
    return false;
  }

  resume(runId: string) {
    const old = this.db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as Record<string, unknown> | undefined;
    if (!old || !["blocked", "failed", "timed_out", "interrupted", "cancelled"].includes(String(old.status))) {
      throw new Error("Only terminal unsuccessful runs can be resumed.");
    }
    if (old.role === "planner") return this.queuePlanner(String(old.issue_id));
    if (old.role === "worker" && old.plan_id) return this.queueWorker(String(old.issue_id), String(old.plan_id));
    throw new Error("This run cannot be resumed.");
  }

  snapshot() {
    return {
      active: [...this.active.entries()].map(([runId, value]) => ({ runId, projectId: value.projectId, role: value.role })),
      queued: this.queue.map(({ runId, projectId, role }) => ({ runId, projectId, role }))
    };
  }

  private insertRun(
    issueId: string,
    projectId: string,
    planId: string | null,
    role: "planner" | "worker" | "evaluator",
    agent: "codex" | "claude",
    model: string,
    effort: string
  ) {
    const id = randomUUID();
    const created = timestamp();
    this.db.prepare(`
      INSERT INTO runs(
        id,issue_id,plan_id,project_id,role,agent,status,model,reasoning_effort,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,'queued',?,?,?,?)
    `).run(id, issueId, planId, projectId, role, agent, model, effort, created, created);
    return id;
  }

  private pump() {
    while (this.active.size < this.maxWorkers) {
      const index = this.queue.findIndex((item) => item.role === "planner" || !this.activeProjects.has(item.projectId));
      if (index < 0) break;
      const task = this.queue.splice(index, 1)[0];
      if (task.role !== "planner") this.activeProjects.add(task.projectId);
      task.start()
        .catch((error) => this.failRun(task.runId, error instanceof Error ? error.message : String(error)))
        .finally(() => {
          this.active.delete(task.runId);
          if (task.role !== "planner") this.activeProjects.delete(task.projectId);
          this.emit({ type: "queue.changed", data: this.snapshot() });
          this.pump();
        });
    }
    this.emit({ type: "queue.changed", data: this.snapshot() });
  }

  private async runPlanner(runId: string, issueId: string) {
    const context = getIssueContext(this.db, issueId);
    if (!context.project.repo_root) {
      throw new Error("Planning requires a configured project repository.");
    }
    const criteria = context.issue.acceptance_criteria as string[];
    const priorFeedback =
      context.plan && (context.plan as { status?: string }).status === "changes_requested"
        ? String((context.plan as { feedback?: string }).feedback ?? "")
        : "";
    const prompt = [
      "Create one bounded implementation plan. Do not edit files or perform the work.",
      "Return only the structured result required by the output schema.",
      `Project: ${context.project.name}`,
      `Repository: ${context.project.repo_root}`,
      `Story: ${context.issue.issue_key} — ${context.issue.title}`,
      `Description:\n${context.issue.description || "(none)"}`,
      `Acceptance criteria:\n${criteria.map((item, index) => `${index + 1}. ${item}`).join("\n") || "(none)"}`,
      priorFeedback ? `Requested changes to the previous plan:\n${priorFeedback}` : "",
      "The plan must name testable done states and preserve any approval or authority boundary in the Story."
    ].filter(Boolean).join("\n\n");
    const result = await this.runAgent(context.project.planner_agent as "codex" | "claude", {
      runId,
      issueId,
      projectId: context.project.id as string,
      role: "planner",
      cwd: context.project.repo_root as string,
      model: context.project.planner_model as string,
      effort: "low",
      sandbox: "read-only",
      timeoutMs: 5 * 60_000,
      prompt,
      schema: planOutputSchema
    });
    const plan = result.output as PlanPayload;
    createPlan(this.db, issueId, plan, "ready");
    this.finishRun(runId, "succeeded");
    this.emit({ type: "plan.ready", data: { issueId, runId } });
  }

  private async runWorker(runId: string, issueId: string, planId: string) {
    const context = getIssueContext(this.db, issueId);
    const project = context.project;
    if (!project.repo_root) throw new Error("Execution requires a configured project repository.");
    if (!project.dispatch_enabled) throw new Error("Dispatch is disabled for this project.");
    const plan = this.db.prepare("SELECT * FROM plans WHERE id=?").get(planId) as { body: string; hash: string };
    const current = this.db.prepare("SELECT id,hash FROM plans WHERE issue_id=? ORDER BY version DESC LIMIT 1").get(issueId) as {
      id: string;
      hash: string;
    };
    if (!current || current.id !== planId || current.hash !== plan.hash) throw new Error("Approved plan is no longer current.");

    const workspace = await this.prepareWorkspace(runId, context);
    const criteria = context.issue.acceptance_criteria as string[];
    const verification = context.project.verification_commands as string[];
    const prompt = [
      "Implement only the approved plan below in the provided workspace.",
      "You may edit repository files and run local verification. You may not merge, deploy, publish, delete material data, spend money, or send external messages.",
      "Return only the structured receipt required by the output schema.",
      `Story: ${context.issue.issue_key} — ${context.issue.title}`,
      `Description:\n${context.issue.description || "(none)"}`,
      `Approved plan hash: ${plan.hash}`,
      `Approved plan:\n${JSON.stringify(JSON.parse(plan.body), null, 2)}`,
      `Acceptance criteria:\n${criteria.map((item, index) => `${index + 1}. ${item}`).join("\n") || "(none)"}`,
      `Required project verification:\n${verification.join("\n") || "(use repository checks appropriate to the change)"}`
    ].join("\n\n");

    this.db.prepare("UPDATE issues SET status='in_progress',agent_state='running',updated_at=? WHERE id=?").run(timestamp(), issueId);
    const result = await this.runAgent(project.worker_agent as "codex" | "claude", {
      runId,
      issueId,
      projectId: project.id as string,
      role: "worker",
      cwd: workspace,
      model: project.worker_model as string,
      effort: "medium",
      sandbox: "workspace-write",
      timeoutMs: 25 * 60_000,
      prompt,
      schema: receiptOutputSchema
    });
    const receipt = result.output as ReceiptPayload;
    this.saveReceipt(runId, issueId, receipt);
    if (receipt.outcome !== "success") {
      this.db.prepare("UPDATE issues SET status='blocked',agent_state='not_started',updated_at=? WHERE id=?").run(timestamp(), issueId);
      this.finishRun(runId, receipt.outcome === "blocked" ? "blocked" : "failed", receipt.summary);
      return;
    }

    const body = JSON.parse(plan.body) as PlanPayload;
    const isRisky =
      project.risk_class === "high" ||
      body.requiresRiskEvaluation ||
      /deploy|publish|payment|auth|delet|migration/i.test(
        `${context.issue.title} ${context.issue.description} ${(context.issue.labels as string[]).join(" ")}`
      );
    this.finishRun(runId, "succeeded");
    if (isRisky) {
      await this.runEvaluator(issueId, planId, workspace, receipt);
    } else {
      this.markAwaitingAcceptance(issueId, project.id as string);
    }
  }

  private async runEvaluator(issueId: string, planId: string, workspace: string, workerReceipt: ReceiptPayload) {
    const context = getIssueContext(this.db, issueId);
    const runId = this.insertRun(
      issueId,
      context.project.id as string,
      planId,
      "evaluator",
      context.project.evaluator_agent as "codex" | "claude",
      context.project.evaluator_model as string,
      "high"
    );
    this.db.prepare("UPDATE issues SET agent_state='evaluating', updated_at=? WHERE id=?").run(timestamp(), issueId);
    const prompt = [
      "Independently evaluate this completed Story. Do not edit files.",
      "Inspect the workspace and verify the worker receipt against the approved plan and acceptance criteria.",
      "Return a structured receipt. Use outcome=success only when the evidence supports the claims.",
      `Story: ${context.issue.issue_key} — ${context.issue.title}`,
      `Approved plan:\n${JSON.stringify((context.plan as { body: unknown }).body, null, 2)}`,
      `Worker receipt:\n${JSON.stringify(workerReceipt, null, 2)}`
    ].join("\n\n");
    const result = await this.runAgent(context.project.evaluator_agent as "codex" | "claude", {
      runId,
      issueId,
      projectId: context.project.id as string,
      role: "evaluator",
      cwd: workspace,
      model: context.project.evaluator_model as string,
      effort: "high",
      sandbox: "read-only",
      timeoutMs: 10 * 60_000,
      prompt,
      schema: receiptOutputSchema
    });
    const receipt = result.output as ReceiptPayload;
    this.saveReceipt(runId, issueId, receipt);
    if (receipt.outcome === "success") {
      this.finishRun(runId, "succeeded");
      this.markAwaitingAcceptance(issueId, context.project.id as string);
    } else {
      this.finishRun(runId, "blocked", receipt.summary);
      this.db.prepare("UPDATE issues SET status='blocked',agent_state='not_started',updated_at=? WHERE id=?").run(timestamp(), issueId);
    }
  }

  private markAwaitingAcceptance(issueId: string, projectId: string) {
    this.db.prepare("UPDATE issues SET status='in_review',agent_state='awaiting_acceptance',updated_at=? WHERE id=?")
      .run(timestamp(), issueId);
    addActivity(this.db, projectId, issueId, "Conductor", "run.review_ready", "Execution completed and awaits your acceptance.");
    this.emit({ type: "run.review_ready", data: { issueId } });
  }

  private async prepareWorkspace(runId: string, context: ReturnType<typeof getIssueContext>) {
    const project = context.project;
    if (project.workspace_policy === "shared") return project.repo_root as string;
    const issueKey = String(context.issue.issue_key).toLowerCase();
    const dirName = `${issueKey}-${runId.slice(0, 8)}`;
    const workspace = await createWorktree(
      project.repo_root as string,
      project.worktree_parent as string | null,
      dirName,
      `conductor/${dirName}`
    );
    this.db.prepare("UPDATE runs SET workspace=?,updated_at=? WHERE id=?").run(workspace, timestamp(), runId);
    return workspace;
  }

  private async runAgent(
    agent: "codex" | "claude",
    input: {
      runId: string;
      issueId: string;
      projectId: string;
      role: string;
      cwd: string;
      model: string;
      effort: string;
      sandbox: "read-only" | "workspace-write";
      timeoutMs: number;
      prompt: string;
      schema: object;
    }
  ): Promise<{ output: unknown }> {
    return agent === "claude" ? this.runClaude(input) : this.runCodex(input);
  }

  private async runCodex(input: {
    runId: string;
    issueId: string;
    projectId: string;
    role: string;
    cwd: string;
    model: string;
    effort: string;
    sandbox: "read-only" | "workspace-write";
    timeoutMs: number;
    prompt: string;
    schema: object;
  }): Promise<{ output: unknown }> {
    const runDir = join(this.dataDir, "runs", input.runId);
    mkdirSync(runDir, { recursive: true });
    const schemaPath = join(runDir, "output-schema.json");
    const outputPath = join(runDir, "last-message.json");
    writeFileSync(schemaPath, JSON.stringify(input.schema, null, 2));
    const args = [
      "exec",
      "--json",
      "--model",
      input.model,
      "-c",
      `model_reasoning_effort="${input.effort}"`,
      "--sandbox",
      input.sandbox,
      "--cd",
      input.cwd,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-"
    ];
    const command = process.env.CONDUCTOR_CODEX_BIN ?? "codex";
    const result = await this.spawnAndWait({
      runId: input.runId,
      issueId: input.issueId,
      projectId: input.projectId,
      role: input.role,
      cwd: input.cwd,
      command,
      args,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs,
      onLine: (line) => this.captureLine(input.runId, line)
    });
    return this.finishCliResult(input.runId, input.timeoutMs, result, "Codex", () =>
      JSON.parse(readFileSync(outputPath, "utf8"))
    );
  }

  private async runClaude(input: {
    runId: string;
    issueId: string;
    projectId: string;
    role: string;
    cwd: string;
    model: string;
    sandbox: "read-only" | "workspace-write";
    timeoutMs: number;
    prompt: string;
    schema: object;
  }): Promise<{ output: unknown }> {
    const runDir = join(this.dataDir, "runs", input.runId);
    mkdirSync(runDir, { recursive: true });
    const outputPath = join(runDir, "last-message.json");
    const args = [
      "--model",
      input.model,
      "--output-format",
      "stream-json",
      "--verbose",
      ...(input.sandbox === "workspace-write" ? ["--dangerously-skip-permissions"] : ["--permission-mode", "plan"])
    ];
    const command = process.env.CONDUCTOR_CLAUDE_BIN ?? "claude";
    let finalResult: string | null = null;
    const result = await this.spawnAndWait({
      runId: input.runId,
      issueId: input.issueId,
      projectId: input.projectId,
      role: input.role,
      cwd: input.cwd,
      command,
      args,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs,
      onLine: (line) => {
        const event = this.captureLine(input.runId, line);
        if (event && event.type === "result" && event.subtype === "success" && typeof event.result === "string") {
          finalResult = event.result;
        }
      }
    });
    // Claude has no --output-schema/--output-last-message equivalent: the prompt itself instructs
    // the model to return only the schema-shaped JSON as its final message, captured here from the
    // terminal `result` NDJSON event and written to the same last-message.json filename Codex uses,
    // so downstream code (createPlan/saveReceipt) stays agent-agnostic.
    return this.finishCliResult(input.runId, input.timeoutMs, result, "Claude", () => {
      if (finalResult === null) throw new Error("No result event captured.");
      writeFileSync(outputPath, finalResult);
      return JSON.parse(finalResult);
    });
  }

  private async spawnAndWait(input: {
    runId: string;
    issueId: string;
    projectId: string;
    role: string;
    cwd: string;
    command: string;
    args: string[];
    prompt: string;
    timeoutMs: number;
    onLine: (line: string) => void;
  }): Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string }> {
    const child = spawn(input.command, input.args, { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.active.set(input.runId, { projectId: input.projectId, role: input.role, process: child });
    const started = timestamp();
    this.db.prepare(
      "UPDATE runs SET status='running',process_pid=?,workspace=?,started_at=?,updated_at=? WHERE id=?"
    ).run(child.pid ?? null, input.cwd, started, started, input.runId);
    this.emit({ type: "run.started", data: { runId: input.runId, issueId: input.issueId, role: input.role } });

    let stdout = "";
    let stderr = "";
    let jsonlBuffer = "";
    const drainLines = (flushRemainder: boolean) => {
      let newline = jsonlBuffer.indexOf("\n");
      while (newline >= 0) {
        input.onLine(jsonlBuffer.slice(0, newline));
        jsonlBuffer = jsonlBuffer.slice(newline + 1);
        newline = jsonlBuffer.indexOf("\n");
      }
      if (flushRemainder && jsonlBuffer) input.onLine(jsonlBuffer);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      jsonlBuffer += text;
      drainLines(false);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.end(input.prompt);

    const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolvePromise) => {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }, input.timeoutMs);
      child.on("close", (code) => {
        clearTimeout(timeout);
        drainLines(true);
        resolvePromise({ code, timedOut });
      });
      child.on("error", () => {
        clearTimeout(timeout);
        resolvePromise({ code: 1, timedOut: false });
      });
    });

    return { ...result, stdout, stderr };
  }

  private finishCliResult(
    runId: string,
    timeoutMs: number,
    result: { code: number | null; timedOut: boolean; stdout: string; stderr: string },
    label: string,
    getOutput: () => unknown
  ): { output: unknown } {
    if (result.timedOut) {
      this.finishRun(runId, "timed_out", `Timed out after ${Math.round(timeoutMs / 60_000)} minutes.`);
      throw new Error(`Run timed out after ${Math.round(timeoutMs / 60_000)} minutes.`);
    }
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `${label} exited with code ${result.code}.`);
    }
    try {
      return { output: getOutput() };
    } catch {
      throw new Error(
        `${label} did not return valid structured output. Output digest: ${createHash("sha256").update(result.stdout).digest("hex").slice(0, 12)}`
      );
    }
  }

  private captureLine(runId: string, line: string): Record<string, unknown> | null {
    if (!line.trim()) return null;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      this.captureUsageAndSession(runId, event);
      return event;
    } catch {
      // Non-JSON diagnostics and malformed events are preserved in stdout but never trusted as receipts.
      return null;
    }
  }

  private captureUsageAndSession(runId: string, event: Record<string, unknown>) {
    const sessionId =
      event.type === "thread.started" && typeof event.thread_id === "string"
        ? event.thread_id
        : typeof event.session_id === "string"
          ? event.session_id
          : null;
    const usage = (event.usage ?? event.token_usage) as Record<string, unknown> | undefined;
    if (sessionId) this.db.prepare("UPDATE runs SET session_id=?,updated_at=? WHERE id=?").run(sessionId, timestamp(), runId);
    if (usage) {
      this.db.prepare(`
        UPDATE runs SET
          input_tokens=MAX(input_tokens,?),
          cached_input_tokens=MAX(cached_input_tokens,?),
          output_tokens=MAX(output_tokens,?),
          updated_at=?
        WHERE id=?
      `).run(
        Number(usage.input_tokens ?? usage.inputTokens ?? 0),
        Number(usage.cached_input_tokens ?? usage.cachedInputTokens ?? usage.cache_read_input_tokens ?? 0),
        Number(usage.output_tokens ?? usage.outputTokens ?? 0),
        timestamp(),
        runId
      );
    }
  }

  private saveReceipt(runId: string, issueId: string, receipt: ReceiptPayload) {
    this.db.prepare("INSERT OR REPLACE INTO receipts(id,run_id,issue_id,payload,created_at) VALUES(?,?,?,?,?)")
      .run(randomUUID(), runId, issueId, JSON.stringify(receipt), timestamp());
  }

  private finishRun(runId: string, status: string, error: string | null = null) {
    const finished = timestamp();
    this.db.prepare("UPDATE runs SET status=?,error=?,finished_at=?,updated_at=? WHERE id=?")
      .run(status, error, finished, finished, runId);
    this.emit({ type: "run.finished", data: { runId, status, error } });
  }

  private failRun(runId: string, message: string) {
    const run = this.db.prepare("SELECT issue_id,project_id,status FROM runs WHERE id=?").get(runId) as
      | { issue_id: string; project_id: string; status: string }
      | undefined;
    if (run && ["cancelled", "timed_out", "blocked", "succeeded"].includes(run.status)) return;
    this.finishRun(runId, "failed", message);
    if (run) {
      this.db.prepare("UPDATE issues SET status='blocked',agent_state='not_started',updated_at=? WHERE id=?")
        .run(timestamp(), run.issue_id);
      addActivity(this.db, run.project_id, run.issue_id, "Conductor", "run.failed", message);
    }
  }
}
