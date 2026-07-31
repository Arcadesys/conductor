import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { addActivity, getIssueContext } from "./db.ts";

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const agentDisplayName = { claude: "Claude Code", codex: "Codex" } as const;

function buildClaudeCommand(promptPath: string) {
  const claudeBin = process.env.CONDUCTOR_CLAUDE_BIN ?? "claude";
  const model = process.env.CONDUCTOR_SESSION_MODEL ?? "opus";
  // Auto mode by default: these sessions run unattended, so nothing should block on a
  // human clicking through permission prompts. Set CONDUCTOR_SESSION_PERMISSION_MODE to
  // override (e.g. back to "plan") for a supervised session.
  const permissionMode = process.env.CONDUCTOR_SESSION_PERMISSION_MODE ?? "bypassPermissions";
  return `${shellQuote(claudeBin)} --model ${shellQuote(model)} --permission-mode ${shellQuote(permissionMode)} "$(cat ${shellQuote(promptPath)})"`;
}

function buildCodexCommand(promptPath: string) {
  const codexBin = process.env.CONDUCTOR_CODEX_BIN ?? "codex";
  const model = process.env.CONDUCTOR_SESSION_CODEX_MODEL;
  // Auto mode by default, matching the Claude session default above.
  const sandbox = process.env.CONDUCTOR_SESSION_CODEX_SANDBOX ?? "workspace-write";
  const approval = process.env.CONDUCTOR_SESSION_CODEX_APPROVAL ?? "never";
  const modelFlag = model ? `--model ${shellQuote(model)} ` : "";
  return `${shellQuote(codexBin)} ${modelFlag}--sandbox ${shellQuote(sandbox)} --ask-for-approval ${shellQuote(approval)} "$(cat ${shellQuote(promptPath)})"`;
}

function buildReportScript(reportUrl: string, agent: "claude" | "codex") {
  return `#!/usr/bin/env node
// Tells Conductor this session is done so the ticket can move to In Review for human review.
const [outcome, ...rest] = process.argv.slice(2);
const summary = rest.join(" ");
if (!["success", "blocked", "failed"].includes(outcome)) {
  console.error("Usage: node report-done.mjs <success|blocked|failed> \\"<summary>\\"");
  process.exit(1);
}
const response = await fetch(${JSON.stringify(reportUrl)}, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ agent: ${JSON.stringify(agent)}, outcome, summary })
});
if (!response.ok) {
  console.error(\`Conductor did not accept the report: \${response.status} \${await response.text()}\`);
  process.exit(1);
}
console.log("Reported to Conductor.");
`;
}

export async function startInteractiveSession(
  db: DatabaseSync,
  dataDir: string,
  issueId: string,
  agent: "claude" | "codex" = "claude"
) {
  const context = getIssueContext(db, issueId);
  const { issue, project } = context;
  if (!project.repo_root) throw httpError(409, "Configure the project repository before starting a session.");
  if (process.platform !== "darwin") {
    throw httpError(409, "Starting a local terminal session is only supported on macOS.");
  }

  const sessionId = randomUUID();
  const workspace = project.repo_root;

  const sessionDir = join(dataDir, "sessions", sessionId);
  const promptPath = join(sessionDir, "prompt.txt");
  const launchPath = join(sessionDir, "launch.sh");
  const reportPath = join(sessionDir, "report-done.mjs");

  const reportHost = process.env.CONDUCTOR_HOST ?? "127.0.0.1";
  const reportPort = process.env.CONDUCTOR_PORT ?? "4317";
  const reportUrl = `http://${reportHost}:${reportPort}/api/issues/${issueId}/session/complete`;

  const criteria = issue.acceptance_criteria as string[];
  const prompt = [
    `Repository: ${workspace}`,
    `You're picking up ${issue.issue_key} — ${issue.title}.`,
    `Description:\n${issue.description || "(none)"}`,
    `Acceptance criteria:\n${criteria.map((item, index) => `${index + 1}. ${item}`).join("\n") || "(none)"}`,
    "This session runs unattended in auto mode — get oriented, make the change, and run the project's own checks without pausing to ask for plan confirmation.",
    [
      "When you finish — or if you get blocked and need to stop — report back to Conductor by running exactly one of:",
      `  node ${reportPath} success "<one-paragraph summary of what you changed>"`,
      `  node ${reportPath} blocked "<what's blocking you and what's needed to continue>"`,
      `  node ${reportPath} failed "<what went wrong>"`,
      `This is required: it's how Conductor learns you're done and moves ${issue.issue_key} into the In Review column for human review.`
    ].join("\n")
  ].join("\n\n");

  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(promptPath, prompt);
  writeFileSync(reportPath, buildReportScript(reportUrl, agent));
  chmodSync(reportPath, 0o755);

  const agentCommand = agent === "codex" ? buildCodexCommand(promptPath) : buildClaudeCommand(promptPath);
  const agentName = agentDisplayName[agent];
  // macOS hands GUI-launched apps (Ghostty included, via `open`) a bare-bones PATH from
  // launchd — none of the shell profile's Homebrew/npm/nvm additions. Re-export the PATH
  // this Conductor server process already has (inherited from whatever shell started it)
  // so the agent binary actually resolves instead of the window silently closing on "not found".
  const inheritedPath = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const script = [
    "#!/bin/sh",
    `export PATH=${shellQuote(inheritedPath)}`,
    `cd ${shellQuote(workspace)}`,
    agentCommand,
    "status=$?",
    'if [ "$status" -ne 0 ]; then',
    '  echo',
    `  echo "${agentName} exited with status $status. Press Enter to close this window."`,
    "  read _",
    "fi",
    "exit $status",
    ""
  ].join("\n");
  writeFileSync(launchPath, script);
  chmodSync(launchPath, 0o755);

  const openBin = process.env.CONDUCTOR_OPEN_BIN ?? "open";
  const result = await new Promise<{ code: number | null; stderr: string }>((resolvePromise) => {
    const child = spawn(openBin, ["-na", "Ghostty", "--args", "-e", launchPath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolvePromise({ code, stderr }));
    child.on("error", (error) => resolvePromise({ code: 1, stderr: error.message }));
  });
  if (result.code !== 0) {
    throw httpError(500, result.stderr.trim() || "Could not open Ghostty.");
  }

  addActivity(
    db,
    project.id,
    issueId,
    "You",
    "session.started",
    `Started an interactive ${agentName} session in ${workspace}.`
  );

  return { workspace, agent };
}
