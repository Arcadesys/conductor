import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { IssueRow, PlanPayload, ProjectRow } from "./types.ts";

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);

export interface ConductorDb {
  raw: DatabaseSync;
  path: string;
  close(): void;
  backup(): string | null;
}

function sqlQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createDatabase(path = process.env.CONDUCTOR_DB_PATH ?? resolve("data/conductor.sqlite")): ConductorDb {
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  migrate(raw);
  recoverInterruptedRuns(raw);
  seed(raw);

  return {
    raw,
    path,
    close: () => raw.close(),
    backup: () => backupDatabase(raw, path)
  };
}

function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      repo_root TEXT,
      workspace_policy TEXT NOT NULL DEFAULT 'worktree' CHECK(workspace_policy IN ('shared','worktree')),
      worktree_parent TEXT,
      verification_commands TEXT NOT NULL DEFAULT '[]',
      risk_class TEXT NOT NULL DEFAULT 'normal' CHECK(risk_class IN ('normal','high')),
      planner_model TEXT NOT NULL DEFAULT 'gpt-5.6-terra',
      planner_agent TEXT NOT NULL DEFAULT 'codex' CHECK(planner_agent IN ('codex','claude')),
      worker_model TEXT NOT NULL DEFAULT 'gpt-5.6-sol',
      worker_agent TEXT NOT NULL DEFAULT 'codex' CHECK(worker_agent IN ('codex','claude')),
      evaluator_model TEXT NOT NULL DEFAULT 'gpt-5.6-sol',
      evaluator_agent TEXT NOT NULL DEFAULT 'codex' CHECK(evaluator_agent IN ('codex','claude')),
      dispatch_enabled INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_enabled IN (0,1)),
      next_issue_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sprints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'future' CHECK(state IN ('future','active','closed')),
      starts_at TEXT,
      ends_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_sprint_per_project
      ON sprints(project_id) WHERE state = 'active';

    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      issue_key TEXT NOT NULL UNIQUE COLLATE NOCASE,
      issue_number INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('epic','story','subtask')),
      parent_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
      sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog'
        CHECK(status IN ('backlog','todo','in_progress','in_review','blocked','done','cancelled')),
      agent_state TEXT NOT NULL DEFAULT 'not_started'
        CHECK(agent_state IN ('not_started','planning','plan_ready','approved_queued','running','evaluating','awaiting_acceptance')),
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('highest','high','medium','low')),
      estimate_hours REAL,
      rank REAL NOT NULL,
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      labels TEXT NOT NULL DEFAULT '[]',
      external_source TEXT,
      external_id TEXT,
      external_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, issue_number)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS unique_external_issue
      ON issues(external_source, external_id) WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS issues_project_rank ON issues(project_id, rank);

    CREATE TRIGGER IF NOT EXISTS issue_depth_insert
    BEFORE INSERT ON issues
    WHEN NEW.parent_id IS NOT NULL
    BEGIN
      SELECT CASE
        WHEN NEW.type = 'epic' THEN RAISE(ABORT, 'epics cannot have parents')
        WHEN NEW.type = 'story' AND (SELECT type FROM issues WHERE id = NEW.parent_id) != 'epic'
          THEN RAISE(ABORT, 'stories must belong to epics')
        WHEN NEW.type = 'subtask' AND (SELECT type FROM issues WHERE id = NEW.parent_id) != 'story'
          THEN RAISE(ABORT, 'subtasks must belong to stories')
      END;
    END;

    CREATE TRIGGER IF NOT EXISTS issue_depth_update
    BEFORE UPDATE OF type, parent_id ON issues
    WHEN NEW.parent_id IS NOT NULL
    BEGIN
      SELECT CASE
        WHEN NEW.type = 'epic' THEN RAISE(ABORT, 'epics cannot have parents')
        WHEN NEW.type = 'story' AND (SELECT type FROM issues WHERE id = NEW.parent_id) != 'epic'
          THEN RAISE(ABORT, 'stories must belong to epics')
        WHEN NEW.type = 'subtask' AND (SELECT type FROM issues WHERE id = NEW.parent_id) != 'story'
          THEN RAISE(ABORT, 'subtasks must belong to stories')
      END;
    END;

    CREATE TABLE IF NOT EXISTS issue_links (
      id TEXT PRIMARY KEY,
      source_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      target_issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('blocks','relates','duplicates')),
      created_at TEXT NOT NULL,
      UNIQUE(source_issue_id, target_issue_id, type),
      CHECK(source_issue_id != target_issue_id)
    );

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','changes_requested','approved','superseded')),
      body TEXT NOT NULL,
      hash TEXT NOT NULL,
      feedback TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(issue_id, version)
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      plan_hash TEXT NOT NULL,
      approved_by TEXT NOT NULL DEFAULT 'local-user',
      action_scope TEXT NOT NULL DEFAULT 'repo_write',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('planner','worker','evaluator')),
      agent TEXT NOT NULL DEFAULT 'codex' CHECK(agent IN ('codex','claude')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','blocked','timed_out','cancelled','interrupted')),
      session_id TEXT,
      workspace TEXT,
      model TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      process_pid INTEGER,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
      issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS issue_comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      external_source TEXT,
      external_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(external_source, external_id)
    );

    CREATE TABLE IF NOT EXISTS issue_documents (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      document_key TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      external_source TEXT,
      external_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(external_source, external_id)
    );

    CREATE TABLE IF NOT EXISTS activity_events (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      issue_id TEXT REFERENCES issues(id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS imports (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL UNIQUE,
      source_label TEXT NOT NULL,
      receipt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  addAgentColumns(db);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)").run(now());
}

function addAgentColumns(db: DatabaseSync) {
  const alter = (table: string, name: string, ddl: string) => {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  };
  alter("projects", "planner_agent", "TEXT NOT NULL DEFAULT 'codex' CHECK(planner_agent IN ('codex','claude'))");
  alter("projects", "worker_agent", "TEXT NOT NULL DEFAULT 'codex' CHECK(worker_agent IN ('codex','claude'))");
  alter("projects", "evaluator_agent", "TEXT NOT NULL DEFAULT 'codex' CHECK(evaluator_agent IN ('codex','claude'))");
  alter("runs", "agent", "TEXT NOT NULL DEFAULT 'codex' CHECK(agent IN ('codex','claude'))");
}

function recoverInterruptedRuns(db: DatabaseSync) {
  const timestamp = now();
  const runs = db
    .prepare("SELECT id, issue_id, project_id FROM runs WHERE status IN ('running','queued')")
    .all() as Array<{ id: string; issue_id: string; project_id: string }>;
  for (const run of runs) {
    db.prepare("UPDATE runs SET status='interrupted', error=?, finished_at=?, updated_at=? WHERE id=?")
      .run("Conductor restarted; run was not relaunched.", timestamp, timestamp, run.id);
    db.prepare("UPDATE issues SET status='blocked', agent_state='not_started', updated_at=? WHERE id=?")
      .run(timestamp, run.issue_id);
    addActivity(db, run.project_id, run.issue_id, "system", "run.interrupted", "Run interrupted by service restart.");
  }
}

function seed(db: DatabaseSync) {
  const count = Number((db.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count);
  if (count > 0) return;

  const created = now();
  const projectId = randomUUID();
  db.prepare(`
    INSERT INTO projects(
      id,key,name,description,repo_root,workspace_policy,verification_commands,risk_class,
      dispatch_enabled,next_issue_number,created_at,updated_at
    ) VALUES(?,?,?,?,NULL,'shared',?,'high',0,16,?,?)
  `).run(
    projectId,
    "FRE",
    "Free Play Publishing",
    "Controlled, reproducible releases without losing canonical work.",
    json([]),
    created,
    created
  );

  const epics = [
    ["EST", "Estelle’s Children"],
    ["ZOO", "It Takes a Zoo"],
    ["INK", "Ink and Paint Trilogy"]
  ] as const;
  const epicIds = new Map<string, string>();
  epics.forEach(([key, title], index) => {
    const id = randomUUID();
    epicIds.set(key, id);
    insertIssue(db, {
      id,
      projectId,
      issueKey: `FRE-E${index + 1}`,
      issueNumber: index + 1,
      type: "epic",
      parentId: null,
      title: `${key} — ${title}`,
      description: "",
      status: "backlog",
      agentState: "not_started",
      priority: "high",
      estimateHours: null,
      rank: index + 1,
      acceptanceCriteria: [],
      labels: ["publishing"]
    });
  });

  const stories = [
    {
      key: "FRE-12",
      number: 12,
      title: "Build the editorial readiness map",
      type: "story" as const,
      status: "in_review" as const,
      agent: "plan_ready" as const,
      priority: "high" as const,
      estimate: 5,
      rank: 10,
      criteria: [
        "All source folders inventoried and validated",
        "Readiness score calculated for each manuscript",
        "Gaps documented with specific recommendations",
        "Map exported and attached to this issue"
      ]
    },
    {
      key: "FRE-9",
      number: 9,
      title: "Validate archive metadata",
      type: "story" as const,
      status: "done" as const,
      agent: "not_started" as const,
      priority: "high" as const,
      estimate: 3,
      rank: 20,
      criteria: ["Metadata schema validated", "No canonical story records lost"]
    },
    {
      key: "FRE-11",
      number: 11,
      title: "Prepare the two-change review batch",
      type: "story" as const,
      status: "in_progress" as const,
      agent: "planning" as const,
      priority: "high" as const,
      estimate: 8,
      rank: 30,
      criteria: ["Exactly two proposed changes are shown as a diff"]
    },
    {
      key: "FRE-8",
      number: 8,
      title: "Package the approval handoff",
      type: "story" as const,
      status: "todo" as const,
      agent: "not_started" as const,
      priority: "medium" as const,
      estimate: 2,
      rank: 40,
      criteria: ["Handoff names current best, last verdict, and next action"]
    }
  ];

  const storyIds: string[] = [];
  for (const story of stories) {
    const id = randomUUID();
    storyIds.push(id);
    insertIssue(db, {
      id,
      projectId,
      issueKey: story.key,
      issueNumber: story.number,
      type: story.type,
      parentId: epicIds.get("EST")!,
      title: story.title,
      description:
        story.number === 12
          ? "Create a comprehensive map of editorial readiness across all Estelle’s Children manuscripts, assets, and ancillary materials to identify gaps and unblock final packaging."
          : "",
      status: story.status,
      agentState: story.agent,
      priority: story.priority,
      estimateHours: story.estimate,
      rank: story.rank,
      acceptanceCriteria: story.criteria,
      labels: ["publishing"]
    });
  }

  const secondaryStories = [
    [4, epicIds.get("ZOO")!, "Map the protected latest draft"],
    [5, epicIds.get("ZOO")!, "Prepare the author decision register"],
    [6, epicIds.get("ZOO")!, "Verify the manuscript compilation gate"],
    [7, epicIds.get("INK")!, "Reconcile trilogy continuity"],
    [10, epicIds.get("INK")!, "Refresh the Bait and Switch package"],
    [13, epicIds.get("INK")!, "Refresh The Painted Cat package"],
    [14, epicIds.get("INK")!, "Refresh The Two-Flat Cats package"],
    [15, epicIds.get("INK")!, "Run release accessibility QA"]
  ] as const;
  secondaryStories.forEach(([number, parentId, title], index) => {
    insertIssue(db, {
      id: randomUUID(),
      projectId,
      issueKey: `FRE-${number}`,
      issueNumber: number,
      type: "story",
      parentId,
      title,
      description: "",
      status: "backlog",
      agentState: "not_started",
      priority: "medium",
      estimateHours: null,
      rank: 100 + index * 10,
      acceptanceCriteria: [],
      labels: ["publishing"]
    });
  });

  const [selectedId, doneId, planningId] = storyIds;
  db.prepare(
    "INSERT INTO issue_links(id,source_issue_id,target_issue_id,type,created_at) VALUES(?,?,?,?,?)"
  ).run(randomUUID(), selectedId, doneId, "blocks", created);
  db.prepare(
    "INSERT INTO issue_links(id,source_issue_id,target_issue_id,type,created_at) VALUES(?,?,?,?,?)"
  ).run(randomUUID(), selectedId, planningId, "relates", created);

  const plan: PlanPayload = {
    summary: "Inventory the canonical sources, score readiness, document gaps, and export a reviewable map.",
    steps: [
      { text: "Inventory canonical manuscript and asset folders", doneState: "Every source has a recorded path and status" },
      { text: "Calculate readiness against the release checklist", doneState: "Every manuscript has an evidence-backed score" },
      { text: "Document gaps and export the map", doneState: "A reviewable artifact is attached to the Story" }
    ],
    affectedAreas: ["writing archive", "release metadata"],
    verification: ["Validate inventory count", "Check every acceptance criterion has evidence"],
    risks: ["Canonical work must remain untouched during analysis"],
    acceptanceMapping: [
      { criterion: "All source folders inventoried and validated", evidence: "Inventory table and validation output" }
    ],
    requiresRiskEvaluation: true
  };
  createPlan(db, selectedId, plan, "ready");
  addActivity(db, projectId, selectedId, "You", "issue.created", "Created issue.", "2025-05-20T10:12:00.000Z");
  addActivity(db, projectId, selectedId, "You", "criteria.updated", "Added acceptance criteria.", "2025-05-20T14:45:00.000Z");
}

function insertIssue(
  db: DatabaseSync,
  input: {
    id: string;
    projectId: string;
    issueKey: string;
    issueNumber: number;
    type: string;
    parentId: string | null;
    title: string;
    description: string;
    status: string;
    agentState: string;
    priority: string;
    estimateHours: number | null;
    rank: number;
    acceptanceCriteria: string[];
    labels: string[];
  }
) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO issues(
      id,project_id,issue_key,issue_number,type,parent_id,title,description,status,agent_state,
      priority,estimate_hours,rank,acceptance_criteria,labels,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    input.id,
    input.projectId,
    input.issueKey,
    input.issueNumber,
    input.type,
    input.parentId,
    input.title,
    input.description,
    input.status,
    input.agentState,
    input.priority,
    input.estimateHours,
    input.rank,
    json(input.acceptanceCriteria),
    json(input.labels),
    timestamp,
    timestamp
  );
}

export function createProject(
  db: DatabaseSync,
  input: Partial<ProjectRow> & Pick<ProjectRow, "key" | "name">
) {
  const id = randomUUID();
  const timestamp = now();
  db.prepare(`
    INSERT INTO projects(
      id,key,name,description,repo_root,workspace_policy,worktree_parent,verification_commands,
      risk_class,planner_model,planner_agent,worker_model,worker_agent,evaluator_model,evaluator_agent,
      dispatch_enabled,next_issue_number,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
  `).run(
    id,
    input.key.toUpperCase(),
    input.name,
    input.description ?? "",
    input.repo_root ?? null,
    input.workspace_policy ?? "worktree",
    input.worktree_parent ?? null,
    Array.isArray(input.verification_commands) ? json(input.verification_commands) : (input.verification_commands ?? "[]"),
    input.risk_class ?? "normal",
    input.planner_model ?? "gpt-5.6-terra",
    input.planner_agent ?? "codex",
    input.worker_model ?? "gpt-5.6-sol",
    input.worker_agent ?? "codex",
    input.evaluator_model ?? "gpt-5.6-sol",
    input.evaluator_agent ?? "codex",
    input.dispatch_enabled ?? 0,
    timestamp,
    timestamp
  );
  addActivity(db, id, null, "You", "project.created", `Created project ${input.key.toUpperCase()}.`);
  return db.prepare("SELECT * FROM projects WHERE id=?").get(id);
}

export function createIssue(
  db: DatabaseSync,
  input: {
    projectId: string;
    type: "epic" | "story" | "subtask";
    parentId?: string | null;
    sprintId?: string | null;
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    estimateHours?: number | null;
    acceptanceCriteria?: string[];
    labels?: string[];
  }
) {
  const project = db.prepare("SELECT * FROM projects WHERE id=?").get(input.projectId) as unknown as ProjectRow & {
    next_issue_number: number;
  };
  if (!project) throw new Error("Project not found.");
  const id = randomUUID();
  const number = project.next_issue_number;
  const rankRow = db.prepare("SELECT COALESCE(MAX(rank),0)+10 AS rank FROM issues WHERE project_id=?").get(input.projectId) as {
    rank: number;
  };
  insertIssue(db, {
    id,
    projectId: input.projectId,
    issueKey: `${project.key}-${number}`,
    issueNumber: number,
    type: input.type,
    parentId: input.parentId ?? null,
    title: input.title,
    description: input.description ?? "",
    status: input.status ?? "backlog",
    agentState: "not_started",
    priority: input.priority ?? "medium",
    estimateHours: input.estimateHours ?? null,
    rank: rankRow.rank,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    labels: input.labels ?? []
  });
  db.prepare("UPDATE issues SET sprint_id=? WHERE id=?").run(input.sprintId ?? null, id);
  db.prepare("UPDATE projects SET next_issue_number=next_issue_number+1, updated_at=? WHERE id=?")
    .run(now(), input.projectId);
  addActivity(db, input.projectId, id, "You", "issue.created", `Created ${project.key}-${number}.`);
  return db.prepare("SELECT * FROM issues WHERE id=?").get(id);
}

export function createPlan(db: DatabaseSync, issueId: string, body: PlanPayload, status = "ready") {
  const versionRow = db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM plans WHERE issue_id=?").get(issueId) as {
    version: number;
  };
  const timestamp = now();
  const serialized = json(body);
  const hash = createHash("sha256").update(serialized).digest("hex");
  db.prepare("UPDATE plans SET status='superseded', updated_at=? WHERE issue_id=? AND status IN ('draft','ready','approved')")
    .run(timestamp, issueId);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO plans(id,issue_id,version,status,body,hash,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(id, issueId, versionRow.version, status, serialized, hash, timestamp, timestamp);
  db.prepare("UPDATE issues SET agent_state='plan_ready', updated_at=? WHERE id=?").run(timestamp, issueId);
  const issue = db.prepare("SELECT project_id FROM issues WHERE id=?").get(issueId) as { project_id: string };
  addActivity(db, issue.project_id, issueId, "Agent Planner", "plan.ready", `Plan v${versionRow.version} is ready for review.`);
  return db.prepare("SELECT * FROM plans WHERE id=?").get(id);
}

export function addActivity(
  db: DatabaseSync,
  projectId: string | null,
  issueId: string | null,
  actor: string,
  kind: string,
  message: string,
  createdAt = now(),
  payload: unknown = {}
) {
  db.prepare(`
    INSERT INTO activity_events(id,project_id,issue_id,actor,kind,message,payload,created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(randomUUID(), projectId, issueId, actor, kind, message, json(payload), createdAt);
}

export function wouldCreateBlockCycle(db: DatabaseSync, sourceId: string, targetId: string) {
  const result = db.prepare(`
    WITH RECURSIVE reachable(id) AS (
      SELECT target_issue_id FROM issue_links WHERE source_issue_id = ? AND type = 'blocks'
      UNION
      SELECT l.target_issue_id
      FROM issue_links l JOIN reachable r ON l.source_issue_id = r.id
      WHERE l.type = 'blocks'
    )
    SELECT 1 AS found FROM reachable WHERE id = ? LIMIT 1
  `).get(targetId, sourceId);
  return Boolean(result);
}

export function getBootstrap(db: DatabaseSync) {
  const projects = db.prepare("SELECT * FROM projects ORDER BY name").all();
  const issues = db.prepare("SELECT * FROM issues ORDER BY project_id, rank, created_at").all();
  const sprints = db.prepare("SELECT * FROM sprints ORDER BY created_at DESC").all();
  const links = db.prepare("SELECT * FROM issue_links").all();
  const plans = db.prepare(`
    SELECT p.* FROM plans p
    JOIN (SELECT issue_id, MAX(version) version FROM plans GROUP BY issue_id) latest
      ON p.issue_id=latest.issue_id AND p.version=latest.version
  `).all();
  const approvals = db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all();
  const runs = db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT 100").all();
  const receipts = db.prepare("SELECT * FROM receipts ORDER BY created_at DESC LIMIT 100").all();
  const activity = db.prepare("SELECT * FROM activity_events ORDER BY created_at DESC LIMIT 250").all();
  return { projects, issues, sprints, links, plans, approvals, runs, receipts, activity };
}

function backupDatabase(db: DatabaseSync, path: string) {
  if (path === ":memory:") return null;
  const backupDir = join(dirname(path), "backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const target = join(backupDir, `conductor-${stamp}.sqlite`);
  db.exec(`VACUUM INTO ${sqlQuote(target)}`);
  const backups = readdirSync(backupDir)
    .map((name) => join(backupDir, name))
    .filter((file) => statSync(file).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const old of backups.slice(24)) unlinkSync(old);
  return target;
}

export function normalizeRow(row: Record<string, unknown>) {
  const parsed: Record<string, unknown> = { ...row };
  for (const key of ["verification_commands", "acceptance_criteria", "labels", "body", "payload"]) {
    if (typeof parsed[key] === "string") {
      try {
        parsed[key] = JSON.parse(parsed[key] as string);
      } catch {
        // Preserve raw text when an imported record is not JSON.
      }
    }
  }
  return parsed;
}

export function normalizeBootstrap(data: ReturnType<typeof getBootstrap>) {
  return Object.fromEntries(
    Object.entries(data).map(([key, rows]) => [
      key,
      (rows as Array<Record<string, unknown>>).map((row) => normalizeRow(row))
    ])
  );
}

export function getIssueContext(db: DatabaseSync, issueId: string) {
  const issue = db.prepare("SELECT * FROM issues WHERE id=?").get(issueId) as unknown as IssueRow;
  if (!issue) throw new Error("Issue not found.");
  const project = db.prepare("SELECT * FROM projects WHERE id=?").get(issue.project_id) as unknown as ProjectRow;
  const plan = db.prepare("SELECT * FROM plans WHERE issue_id=? ORDER BY version DESC LIMIT 1").get(issueId);
  const links = db.prepare(`
    SELECT l.*, i.issue_key, i.title, i.status
    FROM issue_links l
    JOIN issues i ON i.id = CASE WHEN l.source_issue_id=? THEN l.target_issue_id ELSE l.source_issue_id END
    WHERE l.source_issue_id=? OR l.target_issue_id=?
  `).all(issueId, issueId, issueId);
  const receipts = db.prepare("SELECT * FROM receipts WHERE issue_id=? ORDER BY created_at DESC LIMIT 5").all(issueId);
  return {
    issue: normalizeRow(issue as unknown as Record<string, unknown>) as unknown as IssueRow & {
      acceptance_criteria: string[];
      labels: string[];
    },
    project: normalizeRow(project as unknown as Record<string, unknown>) as unknown as ProjectRow & {
      verification_commands: string[];
    },
    plan: plan ? normalizeRow(plan as Record<string, unknown>) : null,
    links,
    receipts: receipts.map((row) => normalizeRow(row as Record<string, unknown>))
  };
}
