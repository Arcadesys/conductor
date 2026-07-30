import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, createIssue, createProject, wouldCreateBlockCycle } from "../server/db.ts";
import type { ConductorDb } from "../server/db.ts";

let database: ConductorDb | undefined;
afterEach(() => database?.close());

describe("SQLite model", () => {
  it("uses WAL and seeds a Jira-shaped backlog", () => {
    database = createDatabase(":memory:");
    const mode = database.raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const projects = database.raw.prepare("SELECT COUNT(*) count FROM projects").get() as { count: number };
    const epics = database.raw.prepare("SELECT COUNT(*) count FROM issues WHERE type='epic'").get() as { count: number };
    const stories = database.raw.prepare("SELECT COUNT(*) count FROM issues WHERE type='story'").get() as { count: number };
    expect(["memory", "wal"]).toContain(mode.journal_mode);
    expect(projects.count).toBe(1);
    expect(epics.count).toBe(3);
    expect(stories.count).toBe(12);
  });

  it("enforces Epic → Story → Sub-task hierarchy", () => {
    database = createDatabase(":memory:");
    const project = createProject(database.raw, { key: "TEST", name: "Test project" }) as { id: string };
    const epic = createIssue(database.raw, { projectId: project.id, type: "epic", title: "Epic" }) as { id: string };
    const story = createIssue(database.raw, {
      projectId: project.id,
      type: "story",
      parentId: epic.id,
      title: "Story"
    }) as { id: string };
    expect(() =>
      createIssue(database!.raw, {
        projectId: project.id,
        type: "story",
        parentId: story.id,
        title: "Invalid nested story"
      })
    ).toThrow(/stories must belong to epics/);
  });

  it("detects dependency cycles", () => {
    database = createDatabase(":memory:");
    const project = createProject(database.raw, { key: "CYC", name: "Cycle test" }) as { id: string };
    const epic = createIssue(database.raw, { projectId: project.id, type: "epic", title: "Epic" }) as { id: string };
    const a = createIssue(database.raw, { projectId: project.id, type: "story", parentId: epic.id, title: "A" }) as {
      id: string;
    };
    const b = createIssue(database.raw, { projectId: project.id, type: "story", parentId: epic.id, title: "B" }) as {
      id: string;
    };
    database.raw
      .prepare("INSERT INTO issue_links(id,source_issue_id,target_issue_id,type,created_at) VALUES('link',?,?, 'blocks',?)")
      .run(a.id, b.id, new Date().toISOString());
    expect(wouldCreateBlockCycle(database.raw, b.id, a.id)).toBe(true);
    expect(wouldCreateBlockCycle(database.raw, a.id, b.id)).toBe(false);
  });
});
