export const ISSUE_TYPES = ["epic", "story", "subtask"] as const;
export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled"
] as const;
export const AGENT_STATES = [
  "not_started",
  "planning",
  "plan_ready",
  "approved_queued",
  "running",
  "evaluating",
  "awaiting_acceptance"
] as const;

export type IssueType = (typeof ISSUE_TYPES)[number];
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export type AgentState = (typeof AGENT_STATES)[number];

export interface ProjectRow {
  id: string;
  key: string;
  name: string;
  description: string;
  repo_root: string | null;
  workspace_policy: "shared" | "worktree";
  worktree_parent: string | null;
  verification_commands: string;
  risk_class: "normal" | "high";
  planner_model: string;
  planner_agent: "codex" | "claude";
  worker_model: string;
  worker_agent: "codex" | "claude";
  evaluator_model: string;
  evaluator_agent: "codex" | "claude";
  dispatch_enabled: number;
  created_at: string;
  updated_at: string;
}

export interface IssueRow {
  id: string;
  project_id: string;
  issue_key: string;
  issue_number: number;
  type: IssueType;
  parent_id: string | null;
  sprint_id: string | null;
  title: string;
  description: string;
  status: IssueStatus;
  agent_state: AgentState;
  priority: "highest" | "high" | "medium" | "low";
  estimate_hours: number | null;
  rank: number;
  acceptance_criteria: string;
  labels: string;
  external_source: string | null;
  external_id: string | null;
  external_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanPayload {
  summary: string;
  steps: Array<{ text: string; doneState: string }>;
  affectedAreas: string[];
  verification: string[];
  risks: string[];
  acceptanceMapping: Array<{ criterion: string; evidence: string }>;
  requiresRiskEvaluation: boolean;
}

export interface ReceiptPayload {
  outcome: "success" | "blocked" | "failed";
  summary: string;
  filesChanged: string[];
  commandsRun: string[];
  checks: Array<{ name: string; status: "passed" | "failed" | "not_run"; detail: string }>;
  unresolvedRisks: string[];
  finalMessage: string;
}
