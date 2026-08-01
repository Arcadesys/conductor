import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { createDatabase, type ConductorDb } from "../server/db.ts";

let database: ConductorDb | undefined;
afterEach(() => {
  database?.close();
  delete process.env.CONDUCTOR_OPEN_BIN;
  delete process.env.CONDUCTOR_SESSION_MODEL;
  delete process.env.CONDUCTOR_SESSION_PERMISSION_MODE;
  delete process.env.CONDUCTOR_SESSION_CODEX_MODEL;
  delete process.env.CONDUCTOR_SESSION_CODEX_SANDBOX;
  delete process.env.CONDUCTOR_SESSION_CODEX_APPROVAL;
  delete process.env.CONDUCTOR_CLAUDE_BIN;
  delete process.env.CONDUCTOR_PORT;
});

function createFakeOpen(directory: string, behavior: "succeed" | "fail") {
  const path = join(directory, "fake-open.mjs");
  const receivedArgsPath = join(directory, "received-args.json");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(receivedArgsPath)}, JSON.stringify(process.argv.slice(2)));
${behavior === "fail" ? 'process.stderr.write("Unable to find application named \\"Ghostty\\"\\n"); process.exit(1);' : "process.exit(0);"}
`
  );
  chmodSync(path, 0o755);
  return { path, receivedArgsPath };
}

function receiptPathFrom(reportScriptPath: string) {
  const reportScript = readFileSync(reportScriptPath, "utf8");
  const match = reportScript.match(/const receiptPath = (.+);/);
  if (!match) throw new Error("Generated report script has no receipt path.");
  return JSON.parse(match[1]) as string;
}

function runCommand(path: string) {
  return new Promise<number | null>((resolve) => {
    spawn(path, [], { stdio: "pipe" }).on("close", resolve);
  });
}

describe("interactive agent sessions", () => {
  it("runs directly in the project's repo root, seeds a prompt with the location up top, and launches Ghostty in Opus auto mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "conductor-sessions-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
    const { path: fakeOpen, receivedArgsPath } = createFakeOpen(root, "succeed");
    process.env.CONDUCTOR_OPEN_BIN = fakeOpen;
    database = createDatabase(join(root, "test.sqlite"));
    const { app } = createApp(database);

    // workspace_policy is still "worktree" here on purpose: this proves the session flow no
    // longer looks at it at all and never creates a worktree, regardless of project setting.
    const project = await request(app).post("/api/projects").send({
      key: "SES",
      name: "Session project",
      repo_root: repo,
      workspace_policy: "worktree"
    });
    const epic = await request(app).post("/api/issues").send({ projectId: project.body.id, type: "epic", title: "Epic" });
    const story = await request(app).post("/api/issues").send({
      projectId: project.body.id,
      type: "story",
      parentId: epic.body.id,
      title: "Fix the thing",
      description: "Some detail.",
      acceptanceCriteria: ["It works"]
    });

    const response = await request(app).post(`/api/issues/${story.body.id}/session`).send();
    expect(response.status).toBe(202);
    expect(response.body.workspace).toBe(repo);
    expect(response.body.branch).toBeUndefined();

    const args: string[] = JSON.parse(readFileSync(receivedArgsPath, "utf8"));
    expect(args).toEqual(["-na", "Ghostty", "--args", "-e", expect.stringContaining("launch.sh")]);
    const launchScript = readFileSync(args[4], "utf8");
    expect(launchScript).toContain("--model 'opus'");
    expect(launchScript).toContain("--permission-mode 'bypassPermissions'");
    expect(launchScript).toContain(repo);

    const promptPath = args[4].replace("launch.sh", "prompt.txt");
    const prompt = readFileSync(promptPath, "utf8");
    expect(prompt.startsWith(`Repository: ${repo}`)).toBe(true);
    expect(prompt).not.toContain("confirm your plan");
    expect(prompt).toContain("report-done.mjs");
    expect(prompt).toContain(story.body.issue_key);

    const reportScriptPath = args[4].replace("launch.sh", "report-done.mjs");
    const reportScript = readFileSync(reportScriptPath, "utf8");
    expect(reportScript).toContain("Wrote completion receipt");
    expect(reportScript).toContain('"claude"');
    expect(reportScript).not.toContain("fetch(");
    expect(reportScript).not.toContain("/api/issues/");
    expect(receiptPathFrom(reportScriptPath)).toContain(join(repo, ".conductor", "sessions"));
    const submitScript = readFileSync(args[4].replace("launch.sh", "submit-report.mjs"), "utf8");
    expect(submitScript).toContain(`/api/issues/${story.body.id}/session/complete`);
    expect(launchScript).toContain("submit-report.mjs");

    const worktrees = execFileSync("git", ["-C", repo, "worktree", "list"]).toString().trim().split("\n");
    expect(worktrees).toHaveLength(1);

    const bootstrap = await request(app).get("/api/bootstrap");
    const activity = bootstrap.body.activity.find((item: any) => item.kind === "session.started");
    expect(activity).toBeTruthy();
    expect(activity.message).toContain(repo);
  });

  it("launches an interactive Codex session with the same repo-root workflow, in workspace-write/never (auto) mode by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "conductor-sessions-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
    const { path: fakeOpen, receivedArgsPath } = createFakeOpen(root, "succeed");
    process.env.CONDUCTOR_OPEN_BIN = fakeOpen;
    database = createDatabase(join(root, "test.sqlite"));
    const { app } = createApp(database);

    const project = await request(app).post("/api/projects").send({
      key: "CDX",
      name: "Codex session project",
      repo_root: repo
    });
    const epic = await request(app).post("/api/issues").send({ projectId: project.body.id, type: "epic", title: "Epic" });
    const story = await request(app).post("/api/issues").send({
      projectId: project.body.id,
      type: "story",
      parentId: epic.body.id,
      title: "Fix the thing",
      description: "Some detail.",
      acceptanceCriteria: ["It works"]
    });

    const response = await request(app).post(`/api/issues/${story.body.id}/session`).send({ agent: "codex" });
    expect(response.status).toBe(202);
    expect(response.body.workspace).toBe(repo);
    expect(response.body.agent).toBe("codex");

    const args: string[] = JSON.parse(readFileSync(receivedArgsPath, "utf8"));
    const launchScript = readFileSync(args[4], "utf8");
    expect(launchScript).toContain("codex");
    expect(launchScript).toContain("--sandbox 'workspace-write'");
    expect(launchScript).toContain("--ask-for-approval 'never'");
    expect(launchScript).not.toContain("--model");
    expect(launchScript).toContain(repo);

    const reportScriptPath = args[4].replace("launch.sh", "report-done.mjs");
    const reportScript = readFileSync(reportScriptPath, "utf8");
    expect(reportScript).toContain('"codex"');
    expect(reportScript).not.toContain("fetch(");

    const bootstrap = await request(app).get("/api/bootstrap");
    const activity = bootstrap.body.activity.find((item: any) => item.kind === "session.started");
    expect(activity).toBeTruthy();
    expect(activity.message).toContain("Codex");
    expect(activity.message).toContain(repo);
  });

  it("honors Codex session overrides for model, sandbox, and approval policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "conductor-sessions-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
    const { path: fakeOpen, receivedArgsPath } = createFakeOpen(root, "succeed");
    process.env.CONDUCTOR_OPEN_BIN = fakeOpen;
    process.env.CONDUCTOR_SESSION_CODEX_MODEL = "o3";
    process.env.CONDUCTOR_SESSION_CODEX_SANDBOX = "read-only";
    process.env.CONDUCTOR_SESSION_CODEX_APPROVAL = "on-request";
    database = createDatabase(join(root, "test.sqlite"));
    const { app } = createApp(database);

    const project = await request(app).post("/api/projects").send({
      key: "CDX",
      name: "Codex session project",
      repo_root: repo
    });
    const epic = await request(app).post("/api/issues").send({ projectId: project.body.id, type: "epic", title: "Epic" });
    const story = await request(app).post("/api/issues").send({
      projectId: project.body.id,
      type: "story",
      parentId: epic.body.id,
      title: "Fix the thing"
    });

    const response = await request(app).post(`/api/issues/${story.body.id}/session`).send({ agent: "codex" });
    expect(response.status).toBe(202);

    const args: string[] = JSON.parse(readFileSync(receivedArgsPath, "utf8"));
    const launchScript = readFileSync(args[4], "utf8");
    expect(launchScript).toContain("--model 'o3'");
    expect(launchScript).toContain("--sandbox 'read-only'");
    expect(launchScript).toContain("--ask-for-approval 'on-request'");
  });

  it("rejects when the project has no repository configured", async () => {
    database = createDatabase(":memory:");
    const { app } = createApp(database);
    const project = await request(app).post("/api/projects").send({ key: "NOR", name: "No repo project" });
    const epic = await request(app).post("/api/issues").send({ projectId: project.body.id, type: "epic", title: "Epic" });
    const story = await request(app).post("/api/issues").send({
      projectId: project.body.id,
      type: "story",
      parentId: epic.body.id,
      title: "Fix the thing"
    });

    const response = await request(app).post(`/api/issues/${story.body.id}/session`).send();
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/repository/i);
  });

  it("surfaces a clear error when Ghostty cannot be launched", async () => {
    const root = mkdtempSync(join(tmpdir(), "conductor-sessions-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
    const { path: fakeOpen } = createFakeOpen(root, "fail");
    process.env.CONDUCTOR_OPEN_BIN = fakeOpen;
    database = createDatabase(join(root, "test.sqlite"));
    const { app } = createApp(database);

    const project = await request(app).post("/api/projects").send({
      key: "ERR",
      name: "Error project",
      repo_root: repo,
      workspace_policy: "shared"
    });
    const epic = await request(app).post("/api/issues").send({ projectId: project.body.id, type: "epic", title: "Epic" });
    const story = await request(app).post("/api/issues").send({
      projectId: project.body.id,
      type: "story",
      parentId: epic.body.id,
      title: "Fix the thing"
    });

    const response = await request(app).post(`/api/issues/${story.body.id}/session`).send();
    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/ghostty/i);
  });

  it("submits a sandbox-safe receipt after the agent exits and removes it on success", async () => {
    const root = mkdtempSync(join(tmpdir(), "conductor-sessions-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
    const { path: fakeOpen, receivedArgsPath } = createFakeOpen(root, "succeed");
    const fakeClaude = join(root, "fake-claude.mjs");
    writeFileSync(fakeClaude, `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
const prompt = process.argv.at(-1);
const reportPath = prompt.match(/node (.+report-done\\.mjs) success/)[1];
execFileSync(process.execPath, [reportPath, "success", "Completed safely."], { stdio: "inherit" });
`);
    chmodSync(fakeClaude, 0o755);
    process.env.CONDUCTOR_OPEN_BIN = fakeOpen;
    process.env.CONDUCTOR_CLAUDE_BIN = fakeClaude;
    database = createDatabase(join(root, "test.sqlite"));
    const { app } = createApp(database);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    process.env.CONDUCTOR_PORT = String((server.address() as { port: number }).port);
    try {
      const project = await request(app).post("/api/projects").send({ key: "RCP", name: "Receipt project", repo_root: repo });
      const epic = await request(app).post("/api/issues").send({ projectId: project.body.id, type: "epic", title: "Epic" });
      const story = await request(app).post("/api/issues").send({ projectId: project.body.id, type: "story", parentId: epic.body.id, title: "Fix the thing" });

      expect((await request(app).post(`/api/issues/${story.body.id}/session`).send()).status).toBe(202);
      const launchPath = (JSON.parse(readFileSync(receivedArgsPath, "utf8")) as string[])[4];
      const reportPath = launchPath.replace("launch.sh", "report-done.mjs");
      const receiptPath = receiptPathFrom(reportPath);
      expect(await runCommand(launchPath)).toBe(0);

      expect(existsSync(receiptPath)).toBe(false);
      const bootstrap = await request(app).get("/api/bootstrap");
      expect(bootstrap.body.issues.find((item: any) => item.id === story.body.id).status).toBe("in_review");
      expect(bootstrap.body.activity.find((item: any) => item.kind === "session.completed").message).toContain("Completed safely.");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("retains invalid or unsubmitted receipts without changing issue status", async () => {
    const root = mkdtempSync(join(tmpdir(), "conductor-sessions-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo]);
    execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-m", "init"]);
    const { path: fakeOpen, receivedArgsPath } = createFakeOpen(root, "succeed");
    process.env.CONDUCTOR_OPEN_BIN = fakeOpen;
    process.env.CONDUCTOR_PORT = "1";
    database = createDatabase(join(root, "test.sqlite"));
    const { app } = createApp(database);
    const project = await request(app).post("/api/projects").send({ key: "BAD", name: "Receipt project", repo_root: repo });
    const epic = await request(app).post("/api/issues").send({ projectId: project.body.id, type: "epic", title: "Epic" });
    const story = await request(app).post("/api/issues").send({ projectId: project.body.id, type: "story", parentId: epic.body.id, title: "Fix the thing" });
    expect((await request(app).post(`/api/issues/${story.body.id}/session`).send({ agent: "codex" })).status).toBe(202);
    const launchPath = (JSON.parse(readFileSync(receivedArgsPath, "utf8")) as string[])[4];
    const reportPath = launchPath.replace("launch.sh", "report-done.mjs");
    const submitPath = launchPath.replace("launch.sh", "submit-report.mjs");
    const receiptPath = receiptPathFrom(reportPath);

    expect(spawnSync(process.execPath, [submitPath]).status).toBe(0);
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, "not json");
    expect(spawnSync(process.execPath, [submitPath]).status).toBe(1);
    expect(existsSync(receiptPath)).toBe(true);
    writeFileSync(receiptPath, JSON.stringify({ sessionId: "wrong", agent: "codex", outcome: "success", summary: "Nope" }));
    expect(spawnSync(process.execPath, [submitPath]).status).toBe(1);
    expect(existsSync(receiptPath)).toBe(true);
    const sessionId = receiptPath.match(/\/([0-9a-f-]+)\.json$/)?.[1];
    writeFileSync(receiptPath, JSON.stringify({ sessionId, agent: "codex", outcome: "blocked", summary: "API is down" }));
    expect(spawnSync(process.execPath, [submitPath]).status).toBe(1);
    expect(existsSync(receiptPath)).toBe(true);
    expect((await request(app).get("/api/bootstrap")).body.issues.find((item: any) => item.id === story.body.id).status).toBe("backlog");
  });

  it("moves a Story to In Review when its session reports success", async () => {
    database = createDatabase(":memory:");
    const { app } = createApp(database);
    const project = await request(app).post("/api/projects").send({ key: "RPT", name: "Report project" });
    const epic = await request(app).post("/api/issues").send({ projectId: project.body.id, type: "epic", title: "Epic" });
    const story = await request(app).post("/api/issues").send({
      projectId: project.body.id,
      type: "story",
      parentId: epic.body.id,
      title: "Fix the thing"
    });

    const response = await request(app)
      .post(`/api/issues/${story.body.id}/session/complete`)
      .send({ agent: "claude", outcome: "success", summary: "Fixed the thing and ran the tests." });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("in_review");

    const bootstrap = await request(app).get("/api/bootstrap");
    const updated = bootstrap.body.issues.find((item: any) => item.id === story.body.id);
    expect(updated.status).toBe("in_review");
    const activity = bootstrap.body.activity.find((item: any) => item.kind === "session.completed");
    expect(activity).toBeTruthy();
    expect(activity.message).toContain("Fixed the thing");
  });

  it.each(["blocked", "failed"])("moves a Story to Blocked when its session reports %s", async (outcome) => {
    database = createDatabase(":memory:");
    const { app } = createApp(database);
    const project = await request(app).post("/api/projects").send({ key: "BLK", name: "Blocked project" });
    const epic = await request(app).post("/api/issues").send({ projectId: project.body.id, type: "epic", title: "Epic" });
    const story = await request(app).post("/api/issues").send({
      projectId: project.body.id,
      type: "story",
      parentId: epic.body.id,
      title: "Fix the thing"
    });

    const response = await request(app)
      .post(`/api/issues/${story.body.id}/session/complete`)
      .send({ agent: "codex", outcome, summary: "Needs a credential I don't have." });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("blocked");

    const bootstrap = await request(app).get("/api/bootstrap");
    const updated = bootstrap.body.issues.find((item: any) => item.id === story.body.id);
    expect(updated.status).toBe("blocked");
  });

  it("404s a session/complete report for an unknown issue", async () => {
    database = createDatabase(":memory:");
    const { app } = createApp(database);
    const response = await request(app)
      .post("/api/issues/does-not-exist/session/complete")
      .send({ outcome: "success" });
    expect(response.status).toBe(404);
  });
});
