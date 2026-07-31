import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createWorktree(repoRoot: string, worktreeParent: string | null, dirName: string, branch: string) {
  const parent = worktreeParent ?? join(dirname(repoRoot), "conductor-worktrees");
  mkdirSync(parent, { recursive: true });
  const workspace = join(parent, dirName);
  await execFileAsync("git", ["-C", repoRoot, "worktree", "add", "-b", branch, workspace, "HEAD"]);
  return workspace;
}
