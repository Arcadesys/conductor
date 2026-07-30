import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { createDatabase, type ConductorDb } from "../server/db.ts";

let database: ConductorDb | undefined;
afterEach(() => {
  database?.close();
  delete process.env.CONDUCTOR_CODEX_BIN;
  delete process.env.CONDUCTOR_CLAUDE_BIN;
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for state.");
}

function createFakeCodex(directory: string) {
  const path = join(directory, "fake-codex.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("--output-last-message") + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const planning = prompt.includes("Create one bounded implementation plan");
const output = planning ? {
  summary: "One bounded plan",
  steps: [{ text: "Make the change", doneState: "The check passes" }],
  affectedAreas: ["fixture"],
  verification: ["npm test"],
  risks: [],
  acceptanceMapping: [{ criterion: "A criterion", evidence: "Test output" }],
  requiresRiskEvaluation: false
} : {
  outcome: "success",
  summary: "Implemented and checked",
  filesChanged: ["fixture.txt"],
  commandsRun: ["npm test"],
  checks: [{ name: "fixture", status: "passed", detail: "ok" }],
  unresolvedRisks: [],
  finalMessage: "Ready for acceptance"
};
writeFileSync(outputPath, JSON.stringify(output));
console.log(JSON.stringify({ type: "thread.started", thread_id: "11111111-1111-1111-1111-111111111111" }));
const usage = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 25 } });
process.stdout.write(usage.slice(0, 34));
await new Promise((resolve) => setTimeout(resolve, 10));
process.stdout.write(usage.slice(34) + "\\n");
`
  );
  chmodSync(path, 0o755);
  return path;
}

function createFakeClaude(directory: string) {
  const path = join(directory, "fake-claude.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const planning = prompt.includes("Create one bounded implementation plan");
const output = planning ? {
  summary: "One bounded plan",
  steps: [{ text: "Make the change", doneState: "The check passes" }],
  affectedAreas: ["fixture"],
  verification: ["npm test"],
  risks: [],
  acceptanceMapping: [{ criterion: "A criterion", evidence: "Test output" }],
  requiresRiskEvaluation: false
} : {
  outcome: "success",
  summary: "Implemented and checked",
  filesChanged: ["fixture.txt"],
  commandsRun: ["npm test"],
  checks: [{ name: "fixture", status: "passed", detail: "ok" }],
  unresolvedRisks: [],
  finalMessage: "Ready for acceptance"
};
const resultEvent = JSON.stringify({
  type: "result",
  subtype: "success",
  result: JSON.stringify(output),
  session_id: "22222222-2222-2222-2222-222222222222",
  usage: { input_tokens: 120, output_tokens: 25, cache_read_input_tokens: 40 }
});
process.stdout.write(resultEvent.slice(0, 60));
await new Promise((resolve) => setTimeout(resolve, 10));
process.stdout.write(resultEvent.slice(60) + "\\n");
`
  );
  chmodSync(path, 0o755);
  return path;
}

describe("approval-gated workflow", () => {
  it("plans on To Do, executes only after exact approval, and requires acceptance", async () => {
    const root = mkdtempSync(join(tmpdir(), "conductor-api-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    const fakeCodex = createFakeCodex(root);
    process.env.CONDUCTOR_CODEX_BIN = fakeCodex;
    database = createDatabase(join(root, "test.sqlite"));
    const { app } = createApp(database);

    const projectResponse = await request(app).post("/api/projects").send({
      key: "APP",
      name: "App project",
      repo_root: repo,
      workspace_policy: "shared",
      dispatch_enabled: 1,
      risk_class: "normal",
      verification_commands: ["npm test"]
    });
    expect(projectResponse.status).toBe(201);
    const projectId = projectResponse.body.id;

    const epic = await request(app).post("/api/issues").send({ projectId, type: "epic", title: "Release" });
    const story = await request(app).post("/api/issues").send({
      projectId,
      type: "story",
      parentId: epic.body.id,
      title: "Implement fixture",
      acceptanceCriteria: ["A criterion"]
    });
    const storyId = story.body.id;

    let bootstrap = await request(app).get("/api/bootstrap");
    expect(bootstrap.body.plans.find((plan: any) => plan.issue_id === storyId)).toBeUndefined();

    expect((await request(app).patch(`/api/issues/${storyId}`).send({ status: "todo" })).status).toBe(200);
    await waitFor(async () => {
      bootstrap = await request(app).get("/api/bootstrap");
      return bootstrap.body.issues.find((issue: any) => issue.id === storyId)?.agent_state === "plan_ready";
    });
    const plan = bootstrap.body.plans.find((item: any) => item.issue_id === storyId);
    expect(plan.status).toBe("ready");

    const approval = await request(app).post(`/api/plans/${plan.id}/approve`).send({ actionScope: "repo_write" });
    expect(approval.status).toBe(202);
    await waitFor(async () => {
      bootstrap = await request(app).get("/api/bootstrap");
      return bootstrap.body.issues.find((issue: any) => issue.id === storyId)?.agent_state === "awaiting_acceptance";
    });
    const workerRun = bootstrap.body.runs.find((run: any) => run.issue_id === storyId && run.role === "worker");
    expect(workerRun.status).toBe("succeeded");
    expect(workerRun.input_tokens).toBe(120);

    const accept = await request(app).post(`/api/runs/${workerRun.id}/accept`).send();
    expect(accept.status).toBe(200);
    bootstrap = await request(app).get("/api/bootstrap");
    expect(bootstrap.body.issues.find((issue: any) => issue.id === storyId)?.status).toBe("done");
  });

  it("dispatches worker runs to Claude when worker_agent is claude", async () => {
    const root = mkdtempSync(join(tmpdir(), "conductor-api-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    const fakeCodex = createFakeCodex(root);
    const fakeClaude = createFakeClaude(root);
    process.env.CONDUCTOR_CODEX_BIN = fakeCodex;
    process.env.CONDUCTOR_CLAUDE_BIN = fakeClaude;
    database = createDatabase(join(root, "test.sqlite"));
    const { app } = createApp(database);

    const projectResponse = await request(app).post("/api/projects").send({
      key: "CLA",
      name: "Claude project",
      repo_root: repo,
      workspace_policy: "shared",
      dispatch_enabled: 1,
      risk_class: "normal",
      verification_commands: ["npm test"],
      worker_agent: "claude"
    });
    expect(projectResponse.status).toBe(201);
    const projectId = projectResponse.body.id;
    expect(projectResponse.body.worker_agent).toBe("claude");
    expect(projectResponse.body.planner_agent).toBe("codex");

    const epic = await request(app).post("/api/issues").send({ projectId, type: "epic", title: "Release" });
    const story = await request(app).post("/api/issues").send({
      projectId,
      type: "story",
      parentId: epic.body.id,
      title: "Implement fixture",
      acceptanceCriteria: ["A criterion"]
    });
    const storyId = story.body.id;

    expect((await request(app).patch(`/api/issues/${storyId}`).send({ status: "todo" })).status).toBe(200);
    let bootstrap = await request(app).get("/api/bootstrap");
    await waitFor(async () => {
      bootstrap = await request(app).get("/api/bootstrap");
      return bootstrap.body.issues.find((issue: any) => issue.id === storyId)?.agent_state === "plan_ready";
    });
    const plan = bootstrap.body.plans.find((item: any) => item.issue_id === storyId);
    const plannerRun = bootstrap.body.runs.find((run: any) => run.issue_id === storyId && run.role === "planner");
    expect(plannerRun.agent).toBe("codex");

    const approval = await request(app).post(`/api/plans/${plan.id}/approve`).send({ actionScope: "repo_write" });
    expect(approval.status).toBe(202);
    await waitFor(async () => {
      bootstrap = await request(app).get("/api/bootstrap");
      return bootstrap.body.issues.find((issue: any) => issue.id === storyId)?.agent_state === "awaiting_acceptance";
    });
    const workerRun = bootstrap.body.runs.find((run: any) => run.issue_id === storyId && run.role === "worker");
    expect(workerRun.status).toBe("succeeded");
    expect(workerRun.agent).toBe("claude");
    expect(workerRun.input_tokens).toBe(120);
    expect(workerRun.cached_input_tokens).toBe(40);

    const accept = await request(app).post(`/api/runs/${workerRun.id}/accept`).send();
    expect(accept.status).toBe(200);
    bootstrap = await request(app).get("/api/bootstrap");
    expect(bootstrap.body.issues.find((issue: any) => issue.id === storyId)?.status).toBe("done");
  });

  it("blocks approval when project dispatch is disabled", async () => {
    database = createDatabase(":memory:");
    const { app } = createApp(database);
    const bootstrap = await request(app).get("/api/bootstrap");
    const ready = bootstrap.body.plans.find((plan: any) => plan.status === "ready");
    const response = await request(app).post(`/api/plans/${ready.id}/approve`).send();
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/repository|dispatch/i);
  });
});
