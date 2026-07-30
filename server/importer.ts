import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { addActivity, createIssue, createProject } from "./db.ts";

type DumpRow = Record<string, string | null>;
type DumpTables = Record<string, DumpRow[]>;

export interface ImportGroup {
  proposedKey: string;
  name: string;
  repoRoot: string | null;
  workspacePolicy: "shared" | "worktree";
  existingProjectId?: string;
  sourceProjectIds: string[];
  sourceProjects: Array<{ id: string; name: string; description: string | null }>;
  issueCount: number;
}

export interface PaperclipPreview {
  id: string;
  fingerprint: string;
  sourceType: "backup" | "api";
  sourceLabel: string;
  counts: Record<string, number>;
  groups: ImportGroup[];
  warnings: string[];
}

interface StoredPreview {
  preview: PaperclipPreview;
  tables: DumpTables;
}

const previews = new Map<string, StoredPreview>();

function unescapeCopy(value: string): string | null {
  if (value === "\\N") return null;
  return value.replace(/\\([btnrfv\\])/g, (_, char: string) => {
    const values: Record<string, string> = {
      b: "\b",
      t: "\t",
      n: "\n",
      r: "\r",
      f: "\f",
      v: "\v",
      "\\": "\\"
    };
    return values[char] ?? char;
  });
}

export function parsePaperclipDump(content: Buffer): DumpTables {
  const text = content[0] === 0x1f && content[1] === 0x8b ? gunzipSync(content).toString("utf8") : content.toString("utf8");
  const lines = text.split("\n");
  const tables: DumpTables = {};
  let current: { name: string; columns: string[] } | null = null;
  for (const line of lines) {
    if (!current) {
      const match = line.match(/^COPY "public"\."([^"]+)" \((.+)\) FROM stdin;$/);
      if (!match) continue;
      const name = match[1];
      const columns = [...match[2].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
      current = { name, columns };
      tables[name] ??= [];
      continue;
    }
    if (line === "\\.") {
      current = null;
      continue;
    }
    const values = line.split("\t").map(unescapeCopy);
    const row: DumpRow = {};
    current.columns.forEach((column, index) => {
      row[column] = values[index] ?? null;
    });
    tables[current.name].push(row);
  }
  return tables;
}

function keyFromName(name: string, used: Set<string>) {
  const words = name.replace(/[^a-zA-Z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  const initial = (words.length > 1 ? words.map((word) => word[0]).join("") : words[0]?.slice(0, 4) ?? "PRJ")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6) || "PRJ";
  let key = initial;
  let suffix = 2;
  while (used.has(key)) key = `${initial.slice(0, 4)}${suffix++}`;
  used.add(key);
  return key;
}

function buildGroups(tables: DumpTables): ImportGroup[] {
  const projects = tables.projects ?? [];
  const workspaces = tables.project_workspaces ?? [];
  const issues = tables.issues ?? [];
  const companies = new Map((tables.companies ?? []).map((company) => [company.id, company]));
  const workspaceByProject = new Map<string, DumpRow>();
  for (const workspace of workspaces) {
    if (!workspace.project_id) continue;
    const existing = workspaceByProject.get(workspace.project_id);
    if (!existing || workspace.is_primary === "t") workspaceByProject.set(workspace.project_id, workspace);
  }
  const groups = new Map<string, DumpRow[]>();
  for (const project of projects) {
    const workspace = workspaceByProject.get(project.id ?? "");
    const key = workspace?.cwd ? `cwd:${workspace.cwd}` : workspace?.repo_url ? `repo:${workspace.repo_url}` : `project:${project.id}`;
    groups.set(key, [...(groups.get(key) ?? []), project]);
  }
  const used = new Set<string>();
  const result: ImportGroup[] = [...groups.entries()].map(([groupKey, sourceProjects]) => {
    const workspace = sourceProjects.map((project) => workspaceByProject.get(project.id ?? "")).find(Boolean);
    const names = sourceProjects.map((project) => project.name ?? "Imported project");
    const name =
      sourceProjects.length === 1
        ? names[0]
        : groupKey.includes("writing-archive")
          ? "Free Play Publishing"
          : names.sort((a, b) => a.length - b.length)[0];
    const projectIds = sourceProjects.map((project) => project.id ?? "").filter(Boolean);
    return {
      proposedKey: keyFromName(name, used),
      name,
      repoRoot: workspace?.cwd ?? null,
      workspacePolicy: groupKey.includes("writing-archive") ? "shared" : "worktree",
      sourceProjectIds: projectIds,
      sourceProjects: sourceProjects.map((project) => ({
        id: project.id ?? "",
        name: project.name ?? "Imported project",
        description: project.description
      })),
      issueCount: issues.filter((issue) => projectIds.includes(issue.project_id ?? "")).length
    };
  });
  const unprojectedByCompany = new Map<string, DumpRow[]>();
  for (const issue of issues) {
    if (issue.project_id || !issue.company_id) continue;
    unprojectedByCompany.set(issue.company_id, [...(unprojectedByCompany.get(issue.company_id) ?? []), issue]);
  }
  for (const [companyId, unprojected] of unprojectedByCompany) {
    const company = companies.get(companyId);
    const companyName = company?.name ?? company?.issue_prefix ?? "Paperclip";
    const name = `${companyName} Unprojected`;
    const pseudoProjectId = `__company__:${companyId}`;
    result.push({
      proposedKey: keyFromName(name, used),
      name,
      repoRoot: null,
      workspacePolicy: "worktree",
      sourceProjectIds: [pseudoProjectId],
      sourceProjects: [{
        id: pseudoProjectId,
        name,
        description: "Paperclip tasks that were not assigned to a source project."
      }],
      issueCount: unprojected.length
    });
  }
  return result;
}

export async function previewPaperclip(input: { sourceType: "backup" | "api"; path?: string; url?: string }) {
  let tables: DumpTables;
  let sourceLabel: string;
  let fingerprintInput: Buffer;
  const warnings: string[] = [];
  if (input.sourceType === "backup") {
    if (!input.path) throw new Error("Backup path is required.");
    const content = readFileSync(input.path);
    tables = parsePaperclipDump(content);
    sourceLabel = input.path;
    fingerprintInput = content;
  } else {
    const url = (input.url ?? "http://127.0.0.1:3100/api").replace(/\/$/, "");
    const companiesResponse = await fetch(`${url}/companies`);
    if (!companiesResponse.ok) throw new Error(`Paperclip API returned ${companiesResponse.status}.`);
    const companies = (await companiesResponse.json()) as DumpRow[];
    const projects: DumpRow[] = [];
    const issues: DumpRow[] = [];
    for (const company of companies) {
      const companyId = company.id;
      const [projectResponse, issueResponse] = await Promise.all([
        fetch(`${url}/companies/${companyId}/projects`),
        fetch(`${url}/companies/${companyId}/issues?limit=10000`)
      ]);
      if (projectResponse.ok) projects.push(...((await projectResponse.json()) as DumpRow[]));
      if (issueResponse.ok) issues.push(...((await issueResponse.json()) as DumpRow[]));
    }
    tables = { companies, projects, issues };
    sourceLabel = url;
    fingerprintInput = Buffer.from(JSON.stringify(tables));
    warnings.push("Live API preview imports core project and issue data; use a backup to include comments, documents, and usage summaries.");
  }
  const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex");
  const id = randomUUID();
  const preview: PaperclipPreview = {
    id,
    fingerprint,
    sourceType: input.sourceType,
    sourceLabel,
    counts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
    groups: buildGroups(tables),
    warnings
  };
  previews.set(id, { preview, tables });
  return preview;
}

function mapStatus(status: string | null) {
  const value = status?.toLowerCase();
  if (["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"].includes(value ?? "")) return value!;
  if (value === "completed") return "done";
  if (value === "canceled") return "cancelled";
  return "backlog";
}

function mapPriority(priority: string | null) {
  const value = priority?.toLowerCase();
  return ["highest", "high", "medium", "low"].includes(value ?? "") ? value! : "medium";
}

export function commitPaperclipImport(
  db: DatabaseSync,
  input: {
    previewId: string;
    groups?: ImportGroup[];
    reconcile?: boolean;
    removeEmptyDemoEpics?: boolean;
  }
) {
  const stored = previews.get(input.previewId);
  if (!stored) throw new Error("Import preview expired. Generate a new preview.");
  const existing = db.prepare("SELECT * FROM imports WHERE source_fingerprint=?").get(stored.preview.fingerprint) as
    | { id: string; receipt: string }
    | undefined;
  if (existing && !input.reconcile) {
    return { imported: false, reason: "already_imported", receipt: JSON.parse(existing.receipt) };
  }

  const groups = input.groups ?? stored.preview.groups;
  const { tables } = stored;
  const projects = tables.projects ?? [];
  const issues = tables.issues ?? [];
  const sourceIssueToLocal = new Map<string, string>();
  const sourceProjectToLocal = new Map<string, { projectId: string; epicId: string }>();
  const receipt = {
    projects: 0,
    reusedProjects: 0,
    epics: 0,
    reusedEpics: 0,
    stories: 0,
    reusedStories: 0,
    subtasks: 0,
    reusedSubtasks: 0,
    links: 0,
    comments: 0,
    documents: 0,
    activitySummaries: 0,
    removedEmptyDemoEpics: 0,
    skipped: [] as string[]
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const group of groups) {
      let projectId = group.existingProjectId;
      if (projectId) {
        const existingProject = db.prepare("SELECT id FROM projects WHERE id=?").get(projectId);
        if (!existingProject) throw new Error(`Existing Conductor project ${projectId} was not found.`);
        receipt.reusedProjects++;
      } else {
        const created = createProject(db, {
          key: group.proposedKey,
          name: group.name,
          description: `Imported read-only from Paperclip: ${group.sourceProjects.map((project) => project.name).join(", ")}`,
          repo_root: group.repoRoot,
          workspace_policy: group.workspacePolicy,
          worktree_parent: group.workspacePolicy === "worktree" && group.repoRoot ? `${group.repoRoot}-worktrees` : null,
          verification_commands: "[]",
          risk_class: group.repoRoot?.includes("writing-archive") ? "high" : "normal",
          dispatch_enabled: 0
        }) as { id: string };
        projectId = created.id;
        receipt.projects++;
      }
      for (const sourceProject of group.sourceProjects) {
        const externalEpic = db.prepare(`
          SELECT id,project_id FROM issues
          WHERE external_source='paperclip' AND external_id=?
        `).get(sourceProject.id) as { id: string; project_id: string } | undefined;
        if (externalEpic && externalEpic.project_id !== projectId) {
          throw new Error(`Paperclip project ${sourceProject.id} is already mapped to another Conductor project.`);
        }
        const titledEpic = externalEpic ?? db.prepare(`
          SELECT id,project_id FROM issues
          WHERE project_id=? AND type='epic' AND title=? COLLATE NOCASE
        `).get(projectId, sourceProject.name) as { id: string; project_id: string } | undefined;
        let epicId = titledEpic?.id;
        if (epicId) {
          db.prepare(`
            UPDATE issues
            SET description=?,external_source='paperclip',external_id=?,updated_at=?
            WHERE id=?
          `).run(sourceProject.description ?? "", sourceProject.id, new Date().toISOString(), epicId);
          receipt.reusedEpics++;
        } else {
          const epic = createIssue(db, {
            projectId,
            type: "epic",
            title: sourceProject.name,
            description: sourceProject.description ?? "",
            priority: "medium",
            labels: ["paperclip-import"]
          }) as { id: string };
          epicId = epic.id;
          db.prepare(`
            UPDATE issues SET external_source='paperclip',external_id=?,updated_at=? WHERE id=?
          `).run(sourceProject.id, new Date().toISOString(), epicId);
          receipt.epics++;
        }
        sourceProjectToLocal.set(sourceProject.id, { projectId, epicId });
        if (input.removeEmptyDemoEpics) {
          const emptyDemoEpics = db.prepare(`
            SELECT candidate.id
            FROM issues candidate
            WHERE candidate.project_id=?
              AND candidate.type='epic'
              AND candidate.external_source IS NULL
              AND candidate.id!=?
              AND candidate.title LIKE ('% — ' || ?) COLLATE NOCASE
              AND NOT EXISTS (SELECT 1 FROM issues child WHERE child.parent_id=candidate.id)
          `).all(projectId, epicId, sourceProject.name) as Array<{ id: string }>;
          for (const candidate of emptyDemoEpics) {
            const removed = db.prepare("DELETE FROM issues WHERE id=?").run(candidate.id);
            receipt.removedEmptyDemoEpics += Number(removed.changes);
          }
        }
      }
    }

    const byId = new Map(issues.map((issue) => [issue.id, issue]));
    const depthOf = (issue: DumpRow) => {
      let depth = 0;
      let cursor = issue;
      const seen = new Set<string>();
      while (cursor.parent_id && byId.has(cursor.parent_id) && !seen.has(cursor.parent_id)) {
        seen.add(cursor.parent_id);
        cursor = byId.get(cursor.parent_id)!;
        depth++;
      }
      return depth;
    };
    const orderedIssues = [...issues].sort((a, b) => depthOf(a) - depthOf(b));
    for (const issue of orderedIssues) {
      if (!issue.id) {
        receipt.skipped.push("Issue without an ID");
        continue;
      }
      const sourceScopeId = issue.project_id ?? (issue.company_id ? `__company__:${issue.company_id}` : null);
      const target = sourceScopeId ? sourceProjectToLocal.get(sourceScopeId) : null;
      if (!target) {
        receipt.skipped.push(`Issue ${issue.identifier ?? issue.id}: project not mapped`);
        continue;
      }
      let rootSource = issue;
      while (rootSource.parent_id && byId.has(rootSource.parent_id)) rootSource = byId.get(rootSource.parent_id)!;
      const rootLocal = rootSource.id ? sourceIssueToLocal.get(rootSource.id) : null;
      const type = issue.id === rootSource.id ? "story" : "subtask";
      const parentId = type === "story" ? target.epicId : rootLocal;
      if (!parentId) {
        receipt.skipped.push(`Issue ${issue.identifier ?? issue.id}: parent was not mapped`);
        continue;
      }
      const externalIssue = db.prepare(`
        SELECT id FROM issues WHERE external_source='paperclip' AND external_id=?
      `).get(issue.id) as { id: string } | undefined;
      const keyedIssue = externalIssue ?? (issue.identifier
        ? db.prepare(`
            SELECT id FROM issues
            WHERE project_id=? AND issue_key=? COLLATE NOCASE AND type=? AND external_source IS NULL
          `)
            .get(target.projectId, issue.identifier, type) as { id: string } | undefined
        : undefined);
      let localId = keyedIssue?.id;
      if (localId) {
        db.prepare(`
          UPDATE issues
          SET parent_id=?,title=?,description=?,status=?,priority=?,
              external_source='paperclip',external_id=?,external_key=?,updated_at=?
          WHERE id=?
        `).run(
          parentId,
          issue.title ?? "Untitled imported issue",
          issue.description ?? "",
          mapStatus(issue.status),
          mapPriority(issue.priority),
          issue.id,
          issue.identifier,
          new Date().toISOString(),
          localId
        );
        if (type === "story") receipt.reusedStories++;
        else receipt.reusedSubtasks++;
      } else {
        const local = createIssue(db, {
          projectId: target.projectId,
          type,
          parentId,
          title: issue.title ?? "Untitled imported issue",
          description: issue.description ?? "",
          status: mapStatus(issue.status),
          priority: mapPriority(issue.priority),
          labels: ["paperclip-import"]
        }) as { id: string };
        localId = local.id;
        db.prepare(`
          UPDATE issues
          SET external_source='paperclip',external_id=?,external_key=?,updated_at=?
          WHERE id=?
        `).run(issue.id, issue.identifier, new Date().toISOString(), localId);
        if (type === "story") receipt.stories++;
        else receipt.subtasks++;
      }
      sourceIssueToLocal.set(issue.id, localId);
    }

    for (const relation of tables.issue_relations ?? []) {
      const source = relation.issue_id ? sourceIssueToLocal.get(relation.issue_id) : null;
      const target = relation.related_issue_id ? sourceIssueToLocal.get(relation.related_issue_id) : null;
      if (!source || !target || source === target) continue;
      const type = ["blocks", "relates", "duplicates"].includes(relation.type ?? "") ? relation.type : "relates";
      const result = db.prepare("INSERT OR IGNORE INTO issue_links(id,source_issue_id,target_issue_id,type,created_at) VALUES(?,?,?,?,?)")
        .run(randomUUID(), source, target, type, relation.created_at ?? new Date().toISOString());
      receipt.links += Number(result.changes);
    }

    for (const comment of tables.issue_comments ?? []) {
      const issueId = comment.issue_id ? sourceIssueToLocal.get(comment.issue_id) : null;
      if (!issueId || !comment.id) continue;
      const result = db.prepare(`
        INSERT OR IGNORE INTO issue_comments(
          id,issue_id,author,body,external_source,external_id,created_at
        ) VALUES(?,?,?,?,?,?,?)
      `).run(
        randomUUID(),
        issueId,
        comment.author_type === "agent" ? "Paperclip agent" : "Paperclip user",
        comment.body ?? "",
        "paperclip",
        comment.id,
        comment.created_at ?? new Date().toISOString()
      );
      receipt.comments += Number(result.changes);
    }

    const documentsById = new Map((tables.documents ?? []).map((document) => [document.id, document]));
    for (const link of tables.issue_documents ?? []) {
      const issueId = link.issue_id ? sourceIssueToLocal.get(link.issue_id) : null;
      const document = link.document_id ? documentsById.get(link.document_id) : null;
      if (!issueId || !link.id) continue;
      const result = db.prepare(`
        INSERT OR IGNORE INTO issue_documents(
          id,issue_id,document_key,title,body,external_source,external_id,created_at
        ) VALUES(?,?,?,?,?,?,?,?)
      `).run(
        randomUUID(),
        issueId,
        link.key ?? document?.key ?? "document",
        document?.title ?? link.key ?? "Imported document",
        document?.body ?? "",
        "paperclip",
        link.id,
        link.created_at ?? new Date().toISOString()
      );
      receipt.documents += Number(result.changes);
    }

    const costsByProject = new Map<string, { input: number; cached: number; output: number; runs: Set<string> }>();
    for (const event of tables.cost_events ?? []) {
      if (!event.project_id) continue;
      const summary = costsByProject.get(event.project_id) ?? { input: 0, cached: 0, output: 0, runs: new Set<string>() };
      summary.input += Number(event.input_tokens ?? 0);
      summary.cached += Number(event.cached_input_tokens ?? 0);
      summary.output += Number(event.output_tokens ?? 0);
      if (event.heartbeat_run_id) summary.runs.add(event.heartbeat_run_id);
      costsByProject.set(event.project_id, summary);
    }
    for (const [sourceProjectId, summary] of costsByProject) {
      const mapped = sourceProjectToLocal.get(sourceProjectId);
      if (!mapped) continue;
      const priorSummary = db.prepare(`
        SELECT id FROM activity_events
        WHERE issue_id=? AND actor='Paperclip importer' AND kind='import.usage_summary'
        LIMIT 1
      `).get(mapped.epicId);
      if (priorSummary) continue;
      addActivity(
        db,
        mapped.projectId,
        mapped.epicId,
        "Paperclip importer",
        "import.usage_summary",
        `Imported usage summary: ${summary.runs.size} runs, ${summary.input} input, ${summary.cached} cached input, ${summary.output} output tokens.`,
        new Date().toISOString(),
        { ...summary, runs: summary.runs.size }
      );
      receipt.activitySummaries++;
    }

    if (existing) {
      db.prepare("UPDATE imports SET receipt=?,created_at=? WHERE id=?")
        .run(JSON.stringify(receipt), new Date().toISOString(), existing.id);
    } else {
      db.prepare("INSERT INTO imports(id,source_type,source_fingerprint,source_label,receipt,created_at) VALUES(?,?,?,?,?,?)")
        .run(
          randomUUID(),
          stored.preview.sourceType,
          stored.preview.fingerprint,
          stored.preview.sourceLabel,
          JSON.stringify(receipt),
          new Date().toISOString()
        );
    }
    db.exec("COMMIT");
    previews.delete(input.previewId);
    return { imported: true, reconciled: Boolean(existing), receipt };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
