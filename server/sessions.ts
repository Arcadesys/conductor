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

export async function startInteractiveSession(db: DatabaseSync, dataDir: string, issueId: string) {
  const context = getIssueContext(db, issueId);
  const { issue, project } = context;
  if (!project.repo_root) throw httpError(409, "Configure the project repository before starting a session.");
  if (process.platform !== "darwin") {
    throw httpError(409, "Starting a local terminal session is only supported on macOS.");
  }

  const sessionId = randomUUID();
  const workspace = project.repo_root;

  const criteria = issue.acceptance_criteria as string[];
  const prompt = [
    `Repository: ${workspace}`,
    `You're picking up ${issue.issue_key} — ${issue.title}.`,
    `Description:\n${issue.description || "(none)"}`,
    `Acceptance criteria:\n${criteria.map((item, index) => `${index + 1}. ${item}`).join("\n") || "(none)"}`,
    "Get oriented in this workspace and confirm your plan with me before making changes."
  ].join("\n\n");

  const sessionDir = join(dataDir, "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const promptPath = join(sessionDir, "prompt.txt");
  const launchPath = join(sessionDir, "launch.sh");
  writeFileSync(promptPath, prompt);

  const claudeBin = process.env.CONDUCTOR_CLAUDE_BIN ?? "claude";
  const model = process.env.CONDUCTOR_SESSION_MODEL ?? "opus";
  const permissionMode = process.env.CONDUCTOR_SESSION_PERMISSION_MODE ?? "plan";
  // macOS hands GUI-launched apps (Ghostty included, via `open`) a bare-bones PATH from
  // launchd — none of the shell profile's Homebrew/npm/nvm additions. Re-export the PATH
  // this Conductor server process already has (inherited from whatever shell started it)
  // so `claude` actually resolves instead of the window silently closing on "not found".
  const inheritedPath = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const script = [
    "#!/bin/sh",
    `export PATH=${shellQuote(inheritedPath)}`,
    `cd ${shellQuote(workspace)}`,
    `${shellQuote(claudeBin)} --model ${shellQuote(model)} --permission-mode ${shellQuote(permissionMode)} "$(cat ${shellQuote(promptPath)})"`,
    "status=$?",
    'if [ "$status" -ne 0 ]; then',
    '  echo',
    '  echo "Claude Code exited with status $status. Press Enter to close this window."',
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
    `Started an interactive Claude Code session in ${workspace}.`
  );

  return { workspace };
}
