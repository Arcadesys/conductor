export type IssueType = "epic" | "story" | "subtask";
export type IssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
export type AgentState =
  | "not_started"
  | "planning"
  | "plan_ready"
  | "approved_queued"
  | "running"
  | "evaluating"
  | "awaiting_acceptance";

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  repo_root: string | null;
  workspace_policy: "shared" | "worktree";
  worktree_parent: string | null;
  verification_commands: string[];
  risk_class: "normal" | "high";
  planner_model: string;
  planner_agent: "codex" | "claude";
  worker_model: string;
  worker_agent: "codex" | "claude";
  evaluator_model: string;
  evaluator_agent: "codex" | "claude";
  dispatch_enabled: number;
}

export interface Issue {
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
  acceptance_criteria: string[];
  labels: string[];
  external_key?: string | null;
}

export interface IssueLink {
  id: string;
  source_issue_id: string;
  target_issue_id: string;
  type: "blocks" | "relates" | "duplicates";
}

export interface Plan {
  id: string;
  issue_id: string;
  version: number;
  status: "draft" | "ready" | "changes_requested" | "approved" | "superseded";
  body: {
    summary: string;
    steps: Array<{ text: string; doneState: string }>;
    affectedAreas: string[];
    verification: string[];
    risks: string[];
    acceptanceMapping: Array<{ criterion: string; evidence: string }>;
    requiresRiskEvaluation: boolean;
  };
  hash: string;
  feedback?: string;
}

export interface Run {
  id: string;
  issue_id: string;
  plan_id: string | null;
  project_id: string;
  role: "planner" | "worker" | "evaluator";
  agent: "codex" | "claude";
  model: string;
  status: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  error: string | null;
  created_at: string;
}

export interface Activity {
  id: string;
  project_id: string | null;
  issue_id: string | null;
  actor: string;
  kind: string;
  message: string;
  created_at: string;
  payload: unknown;
}

export interface Sprint {
  id: string;
  project_id: string;
  name: string;
  state: "future" | "active" | "closed";
}

export interface Bootstrap {
  projects: Project[];
  issues: Issue[];
  sprints: Sprint[];
  links: IssueLink[];
  plans: Plan[];
  approvals: unknown[];
  runs: Run[];
  receipts: unknown[];
  activity: Activity[];
  queue: {
    active: Array<{ runId: string; projectId: string; role: string }>;
    queued: Array<{ runId: string; projectId: string; role: string }>;
  };
}
