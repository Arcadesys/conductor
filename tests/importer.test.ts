import { gzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitPaperclipImport, previewPaperclip } from "../server/importer.ts";
import { createDatabase, createIssue, createProject, type ConductorDb } from "../server/db.ts";

let database: ConductorDb | undefined;
afterEach(() => database?.close());

const dump = `
COPY "public"."projects" ("id", "company_id", "name", "description") FROM stdin;
p1\tc1\tToonTok\tAccessible image studio
\\.
COPY "public"."project_workspaces" ("id", "project_id", "cwd", "repo_url", "is_primary") FROM stdin;
w1\tp1\t/tmp/toontok\thttps://example.test/toontok.git\tt
\\.
COPY "public"."issues" ("id", "project_id", "parent_id", "title", "description", "status", "priority", "identifier") FROM stdin;
i1\tp1\t\\N\tBuild import wizard\tWizard description\tbacklog\thigh\tXLA-1
i2\tp1\ti1\tVerify import wizard\tVerification description\ttodo\tmedium\tXLA-2
\\.
COPY "public"."issue_comments" ("id", "issue_id", "author_type", "body", "created_at") FROM stdin;
c1\ti1\tuser\tKeep the flow accessible.\t2026-07-30T12:00:00Z
\\.
COPY "public"."documents" ("id", "key", "title", "body") FROM stdin;
d1\tplan\tPlan\tA bounded plan
\\.
COPY "public"."issue_documents" ("id", "issue_id", "document_id", "key", "created_at") FROM stdin;
id1\ti1\td1\tplan\t2026-07-30T12:00:00Z
\\.
`;

const unprojectedDump = `
COPY "public"."companies" ("id", "name", "issue_prefix") FROM stdin;
c1\tFree Play Publishing\tFRE
\\.
COPY "public"."projects" ("id", "company_id", "name", "description") FROM stdin;
p1\tc1\tBook\tA book
\\.
COPY "public"."issues" ("id", "company_id", "project_id", "parent_id", "title", "description", "status", "priority", "identifier") FROM stdin;
i1\tc1\tp1\t\\N\tProjected\tProjected description\tbacklog\thigh\tFRE-1
i2\tc1\t\\N\t\\N\tUnprojected\tUnprojected description\tdone\tmedium\tFRE-2
\\.
`;

describe("Paperclip backup import", () => {
  it("previews, commits, preserves external references, and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "conductor-import-"));
    const path = join(root, "paperclip.sql.gz");
    writeFileSync(path, gzipSync(dump));
    database = createDatabase(join(root, "conductor.sqlite"));
    const preview = await previewPaperclip({ sourceType: "backup", path });
    expect(preview.groups).toHaveLength(1);
    expect(preview.groups[0].issueCount).toBe(2);

    const first = commitPaperclipImport(database.raw, { previewId: preview.id });
    expect(first.imported).toBe(true);
    expect(first.receipt.stories).toBe(1);
    expect(first.receipt.subtasks).toBe(1);
    expect(first.receipt.comments).toBe(1);
    expect(first.receipt.documents).toBe(1);
    const imported = database.raw
      .prepare(`
        SELECT external_key FROM issues
        WHERE external_source='paperclip' AND external_key IS NOT NULL
        ORDER BY external_key
      `)
      .all() as Array<{ external_key: string }>;
    expect(imported.map((item) => item.external_key)).toEqual(["XLA-1", "XLA-2"]);

    const secondPreview = await previewPaperclip({ sourceType: "backup", path });
    const second = commitPaperclipImport(database.raw, { previewId: secondPreview.id });
    expect(second.imported).toBe(false);
    expect(second.reason).toBe("already_imported");
  });

  it("merges source projects and matching issue keys into an existing Conductor project", async () => {
    const root = mkdtempSync(join(tmpdir(), "conductor-import-merge-"));
    const path = join(root, "paperclip.sql.gz");
    writeFileSync(path, gzipSync(dump));
    database = createDatabase(join(root, "conductor.sqlite"));
    const existingProject = createProject(database.raw, { key: "XLA", name: "Existing project" }) as { id: string };
    const existingEpic = createIssue(database.raw, {
      projectId: existingProject.id,
      type: "epic",
      title: "ToonTok"
    }) as { id: string };
    const existingStory = createIssue(database.raw, {
      projectId: existingProject.id,
      type: "story",
      parentId: existingEpic.id,
      title: "Old title"
    }) as { id: string; issue_key: string };
    database.raw.prepare("UPDATE issues SET issue_key='XLA-99' WHERE id=?").run(existingEpic.id);
    database.raw.prepare("UPDATE issues SET issue_key='XLA-1' WHERE id=?").run(existingStory.id);

    const preview = await previewPaperclip({ sourceType: "backup", path });
    const group = { ...preview.groups[0], existingProjectId: existingProject.id };
    const result = commitPaperclipImport(database.raw, { previewId: preview.id, groups: [group] });

    expect(result.imported).toBe(true);
    expect(result.receipt.projects).toBe(0);
    expect(result.receipt.reusedProjects).toBe(1);
    expect(result.receipt.reusedEpics).toBe(1);
    expect(result.receipt.reusedStories).toBe(1);
    const merged = database.raw.prepare("SELECT title,external_key FROM issues WHERE id=?").get(existingStory.id) as {
      title: string;
      external_key: string;
    };
    expect(merged).toEqual({ title: "Build import wizard", external_key: "XLA-1" });
  });

  it("does not reuse an Epic when a Paperclip task has the same Jira key", async () => {
    const root = mkdtempSync(join(tmpdir(), "conductor-import-collision-"));
    const path = join(root, "paperclip.sql.gz");
    writeFileSync(path, gzipSync(dump));
    database = createDatabase(join(root, "conductor.sqlite"));
    const existingProject = createProject(database.raw, { key: "XLA", name: "Existing project" }) as { id: string };
    const existingEpic = createIssue(database.raw, {
      projectId: existingProject.id,
      type: "epic",
      title: "Different Epic"
    }) as { id: string; issue_key: string };
    expect(existingEpic.issue_key).toBe("XLA-1");

    const preview = await previewPaperclip({ sourceType: "backup", path });
    const group = { ...preview.groups[0], existingProjectId: existingProject.id };
    const result = commitPaperclipImport(database.raw, { previewId: preview.id, groups: [group] });

    expect(result.imported).toBe(true);
    const original = database.raw.prepare("SELECT type,parent_id FROM issues WHERE id=?").get(existingEpic.id) as {
      type: string;
      parent_id: string | null;
    };
    expect(original).toEqual({ type: "epic", parent_id: null });
    const importedStory = database.raw.prepare(`
      SELECT type,external_key FROM issues
      WHERE external_source='paperclip' AND external_id='i1'
    `).get() as { type: string; external_key: string };
    expect(importedStory).toEqual({ type: "story", external_key: "XLA-1" });
  });

  it("maps company-level tasks into an explicit unprojected fallback Epic", async () => {
    const root = mkdtempSync(join(tmpdir(), "conductor-import-unprojected-"));
    const path = join(root, "paperclip.sql.gz");
    writeFileSync(path, gzipSync(unprojectedDump));
    database = createDatabase(join(root, "conductor.sqlite"));
    const preview = await previewPaperclip({ sourceType: "backup", path });
    expect(preview.groups).toHaveLength(2);
    const fallback = preview.groups.find((group) => group.sourceProjectIds[0].startsWith("__company__:"));
    expect(fallback?.issueCount).toBe(1);

    const result = commitPaperclipImport(database.raw, { previewId: preview.id });
    expect(result.receipt.stories).toBe(2);
    expect(result.receipt.skipped).toEqual([]);
    const imported = database.raw.prepare(`
      SELECT external_key FROM issues
      WHERE external_source='paperclip' AND external_id='i2'
    `).get() as { external_key: string };
    expect(imported.external_key).toBe("FRE-2");
  });

  it("can remove only empty synthetic Epics that duplicate an imported source project", async () => {
    const root = mkdtempSync(join(tmpdir(), "conductor-import-cleanup-"));
    const path = join(root, "paperclip.sql.gz");
    writeFileSync(path, gzipSync(dump));
    database = createDatabase(join(root, "conductor.sqlite"));
    const existingProject = createProject(database.raw, { key: "XLA", name: "Existing project" }) as { id: string };
    const demo = createIssue(database.raw, {
      projectId: existingProject.id,
      type: "epic",
      title: "DEMO — ToonTok"
    }) as { id: string };
    const preview = await previewPaperclip({ sourceType: "backup", path });
    const group = { ...preview.groups[0], existingProjectId: existingProject.id };
    const result = commitPaperclipImport(database.raw, {
      previewId: preview.id,
      groups: [group],
      removeEmptyDemoEpics: true
    });

    expect(result.receipt.removedEmptyDemoEpics).toBe(1);
    expect(database.raw.prepare("SELECT id FROM issues WHERE id=?").get(demo.id)).toBeUndefined();
    expect(
      database.raw.prepare("SELECT COUNT(*) count FROM issues WHERE project_id=? AND type='story'").get(existingProject.id)
    ).toMatchObject({ count: 1 });
  });
});
