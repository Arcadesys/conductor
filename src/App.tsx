import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  Activity as ActivityIcon,
  Archive,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsLeft,
  Circle,
  CircleDot,
  Clock3,
  Columns3,
  Database,
  FileCheck2,
  Filter,
  FolderKanban,
  GripVertical,
  Inbox,
  Info,
  Link2,
  List,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Settings,
  Sparkles,
  Square,
  SquareTerminal,
  X
} from "lucide-react";
import { api, loadBootstrap, subscribeToEvents } from "./api";
import type { Activity, Bootstrap, Issue, IssueStatus, Plan, Project, Run, Sprint } from "./types";

type View = "backlog" | "board" | "all" | "activity";

const statusLabel: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled"
};

const agentLabel: Record<Issue["agent_state"], string> = {
  not_started: "Not started",
  planning: "Planning",
  plan_ready: "Plan ready",
  approved_queued: "Approved / queued",
  running: "Running",
  evaluating: "Evaluating",
  awaiting_acceptance: "Awaiting acceptance"
};

const dispatchAgentLabel: Record<"codex" | "claude", string> = {
  codex: "Codex",
  claude: "Claude Code"
};

function iconForStatus(status: IssueStatus) {
  if (status === "done") return <CheckCircle2 aria-hidden="true" />;
  if (status === "in_progress" || status === "in_review") return <Clock3 aria-hidden="true" />;
  if (status === "blocked" || status === "cancelled") return <CircleDot aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
}

export function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [view, setView] = useState<View>("backlog");
  const [projectId, setProjectId] = useState("");
  const [epicId, setEpicId] = useState("");
  const [issueId, setIssueId] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"rank" | "key" | "priority">("rank");
  const [statusFilter, setStatusFilter] = useState<IssueStatus | "all">("all");
  const [sprintFilter, setSprintFilter] = useState("all");
  const [collapsed, setCollapsed] = useState(() =>
    window.matchMedia("(max-width: 850px), (min-resolution: 1.8dppx) and (max-width: 1500px)").matches
  );
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ issueId: string; x: number; y: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await loadBootstrap();
      setData(next);
      setError("");
      setProjectId((current) => current || next.projects[0]?.id || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return subscribeToEvents(() => void refresh());
  }, [refresh]);

  const currentProject = data?.projects.find((project) => project.id === projectId) ?? data?.projects[0];
  const projectIssues = useMemo(
    () => data?.issues.filter((issue) => issue.project_id === currentProject?.id) ?? [],
    [data, currentProject]
  );
  const epics = useMemo(() => projectIssues.filter((issue) => issue.type === "epic"), [projectIssues]);

  useEffect(() => {
    if (!epics.length) {
      setEpicId("");
      return;
    }
    if (!epics.some((epic) => epic.id === epicId)) setEpicId(epics[0].id);
  }, [epics, epicId]);

  const visibleStories = useMemo(() => {
    let rows = projectIssues.filter((issue) => issue.type === "story" && (!epicId || issue.parent_id === epicId));
    if (query.trim()) {
      const needle = query.toLowerCase();
      rows = rows.filter((issue) => `${issue.issue_key} ${issue.title} ${issue.labels.join(" ")}`.toLowerCase().includes(needle));
    }
    if (statusFilter !== "all") rows = rows.filter((issue) => issue.status === statusFilter);
    if (sprintFilter === "unassigned") rows = rows.filter((issue) => !issue.sprint_id);
    else if (sprintFilter !== "all") rows = rows.filter((issue) => issue.sprint_id === sprintFilter);
    return [...rows].sort((a, b) => {
      if (sort === "key") return a.issue_number - b.issue_number;
      if (sort === "priority") {
        const weight = { highest: 0, high: 1, medium: 2, low: 3 };
        return weight[a.priority] - weight[b.priority] || a.rank - b.rank;
      }
      return a.rank - b.rank;
    });
  }, [projectIssues, epicId, query, sort, statusFilter, sprintFilter]);

  useEffect(() => {
    if (view !== "backlog") return;
    if (!visibleStories.length) return;
    if (!visibleStories.some((story) => story.id === issueId)) setIssueId(visibleStories[0].id);
  }, [view, visibleStories, issueId]);

  const selectedIssue = projectIssues.find((issue) => issue.id === issueId);
  const selectedPlan = data?.plans.find((plan) => plan.issue_id === issueId);
  const selectedActivity = data?.activity.filter((item) => item.issue_id === issueId) ?? [];
  const links = data?.links.filter((link) => link.source_issue_id === issueId || link.target_issue_id === issueId) ?? [];
  const selectedSuccessfulRun = data?.runs.find((run) => run.issue_id === issueId && run.status === "succeeded");

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.closest("input,textarea,select,[contenteditable=true]")) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key.toLowerCase() === "c") {
        setCreateOpen(true);
      } else if (event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k") {
        event.preventDefault();
        const current = visibleStories.findIndex((story) => story.id === issueId);
        const delta = event.key.toLowerCase() === "j" ? 1 : -1;
        const next = Math.max(0, Math.min(visibleStories.length - 1, current + delta));
        if (visibleStories[next]) setIssueId(visibleStories[next].id);
      } else if (event.key === "Escape") {
        setCreateOpen(false);
        setSettingsOpen(false);
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [visibleStories, issueId]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3600);
  }

  function handleContextMenu(event: ReactMouseEvent, id: string) {
    event.preventDefault();
    setContextMenu({ issueId: id, x: event.clientX, y: event.clientY });
  }

  async function updateIssue(id: string, changes: Record<string, unknown>) {
    try {
      await api(`/api/issues/${id}`, { method: "PATCH", body: JSON.stringify(changes) });
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function rankBefore(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    const targetIndex = visibleStories.findIndex((story) => story.id === targetId);
    const before = visibleStories[targetIndex - 1]?.rank ?? 0;
    const target = visibleStories[targetIndex].rank;
    await updateIssue(draggedId, { rank: (before + target) / 2 });
  }

  async function approve(plan: Plan) {
    try {
      await api(`/api/plans/${plan.id}/approve`, { method: "POST", body: JSON.stringify({ actionScope: "repo_write" }) });
      notify("Plan approved and queued.");
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function requestChanges(plan: Plan) {
    const feedback = window.prompt("What should the planner change?");
    if (feedback === null) return;
    await api(`/api/plans/${plan.id}/request-changes`, {
      method: "POST",
      body: JSON.stringify({ feedback })
    });
    notify("Changes requested.");
    await refresh();
  }

  async function startSession(id: string) {
    try {
      const result = await api<{ workspace: string }>(`/api/issues/${id}/session`, { method: "POST", body: "{}" });
      notify(`Session started in ${result.workspace}.`);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function acceptRun(runId: string) {
    try {
      await api(`/api/runs/${runId}/accept`, { method: "POST", body: "{}" });
      notify("Handoff accepted. Story moved to Done.");
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function bulkUpdate(changes: Record<string, unknown>) {
    if (!selectedIds.size) return;
    await api("/api/issues/bulk", {
      method: "POST",
      body: JSON.stringify({ issueIds: [...selectedIds], changes })
    });
    setSelectedIds(new Set());
    notify(`Updated ${selectedIds.size} Stories.`);
    await refresh();
  }

  if (error && !data) {
    return (
      <main className="fatal-state">
        <Database aria-hidden="true" />
        <h1>Conductor could not reach SQLite</h1>
        <p>{error}</p>
        <button className="primary-button" onClick={() => void refresh()}>
          <RefreshCw aria-hidden="true" /> Retry
        </button>
      </main>
    );
  }

  if (!data || !currentProject) {
    return (
      <main className="fatal-state" aria-busy="true">
        <RefreshCw className="spin" aria-hidden="true" />
        <h1>Loading Conductor</h1>
      </main>
    );
  }

  return (
    <div className={`app-shell ${collapsed ? "nav-collapsed" : ""} ${inspectorOpen ? "" : "inspector-closed"}`}>
      <a className="skip-link" href="#workspace">Skip to backlog</a>
      <Sidebar
        projects={data.projects}
        project={currentProject}
        view={view}
        collapsed={collapsed}
        onCollapse={() => setCollapsed((value) => !value)}
        onProject={(id) => {
          setProjectId(id);
          setView("backlog");
          setIssueId("");
        }}
        onView={setView}
      />
      <Header
        project={currentProject}
        view={view}
        query={query}
        searchRef={searchRef}
        onQuery={setQuery}
        onCreate={() => setCreateOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onMenu={() => setCollapsed(false)}
      />
      <main id="workspace" className="workspace" tabIndex={-1}>
        {view === "backlog" && (
          <Backlog
            epics={epics}
            selectedEpicId={epicId}
            stories={visibleStories}
            allIssues={projectIssues}
            links={data.links}
            selectedIssueId={issueId}
            sort={sort}
            statusFilter={statusFilter}
            bulkMode={bulkMode}
            selectedIds={selectedIds}
            sprints={data.sprints.filter((sprint) => sprint.project_id === currentProject.id)}
            sprintFilter={sprintFilter}
            onEpic={setEpicId}
            onIssue={(id) => {
              setIssueId(id);
              setInspectorOpen(true);
            }}
            onSort={setSort}
            onFilter={setStatusFilter}
            onSprintFilter={setSprintFilter}
            onToggleBulk={() => setBulkMode((value) => !value)}
            onSelect={(id) =>
              setSelectedIds((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onBulkUpdate={bulkUpdate}
            onRank={rankBefore}
            onCreate={() => setCreateOpen(true)}
            onContextMenu={handleContextMenu}
          />
        )}
        {view === "board" && (
          <Board
            issues={projectIssues.filter((issue) => issue.type === "story")}
            onIssue={(id) => {
              setIssueId(id);
              setInspectorOpen(true);
            }}
            onContextMenu={handleContextMenu}
          />
        )}
        {view === "all" && (
          <AllWork
            issues={projectIssues}
            onIssue={(id) => {
              setIssueId(id);
              setInspectorOpen(true);
            }}
            onContextMenu={handleContextMenu}
          />
        )}
        {view === "activity" && <ActivityView activity={data.activity.filter((item) => item.project_id === currentProject.id)} />}
      </main>
      {view !== "activity" && selectedIssue && inspectorOpen && (
        <Inspector
          issue={selectedIssue}
          plan={selectedPlan}
          links={links}
          allIssues={projectIssues}
          activity={selectedActivity}
          project={currentProject}
          successfulRun={selectedSuccessfulRun}
          onClose={() => setInspectorOpen(false)}
          onApprove={approve}
          onRequestChanges={requestChanges}
          onAccept={acceptRun}
          onUpdate={updateIssue}
          onStartSession={startSession}
        />
      )}
      {!inspectorOpen && selectedIssue && (
        <button className="open-inspector" onClick={() => setInspectorOpen(true)} aria-label={`Open ${selectedIssue.issue_key} details`}>
          <ChevronLeft aria-hidden="true" />
        </button>
      )}
      <StatusBar data={data} />
      {createOpen && (
        <CreateIssueModal
          project={currentProject}
          epics={epics}
          onClose={() => setCreateOpen(false)}
          onCreated={async (id) => {
            setCreateOpen(false);
            await refresh();
            setIssueId(id);
            notify("Issue created.");
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          project={currentProject}
          sprints={data.sprints.filter((sprint) => sprint.project_id === currentProject.id)}
          onClose={() => setSettingsOpen(false)}
          onSaved={async () => {
            await refresh();
            notify("Project settings saved.");
          }}
          onImported={async () => {
            await refresh();
            notify("Paperclip import committed.");
          }}
        />
      )}
      {contextMenu && (
        <IssueContextMenu
          issue={projectIssues.find((issue) => issue.id === contextMenu.issueId)}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onOpen={() => {
            setIssueId(contextMenu.issueId);
            setInspectorOpen(true);
            setContextMenu(null);
          }}
          onUpdate={updateIssue}
          onNotify={notify}
          onStartSession={startSession}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Sidebar(props: {
  projects: Project[];
  project: Project;
  view: View;
  collapsed: boolean;
  onCollapse(): void;
  onProject(id: string): void;
  onView(view: View): void;
}) {
  const nav = [
    ["backlog", List, "Backlog"],
    ["board", Columns3, "Board"],
    ["all", Inbox, "All work"],
    ["activity", ActivityIcon, "Activity"]
  ] as const;
  return (
    <aside className="sidebar" aria-label="Project navigation">
      <div className="brand-row">
        <strong>Conductor</strong>
        <button className="icon-button" onClick={props.onCollapse} aria-label={props.collapsed ? "Expand navigation" : "Collapse navigation"}>
          <ChevronsLeft aria-hidden="true" />
        </button>
      </div>
      <h2>Projects</h2>
      <label className="project-picker">
        <BookOpen aria-hidden="true" />
        <span className="sr-only">Current project</span>
        <select value={props.project.id} onChange={(event) => props.onProject(event.target.value)}>
          {props.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
        </select>
        <ChevronDown aria-hidden="true" />
      </label>
      <nav>
        {nav.map(([id, Icon, label]) => (
          <button className={props.view === id ? "active" : ""} key={id} onClick={() => props.onView(id)}>
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-rule" />
      <p className="sidebar-label">OTHER PROJECTS</p>
      <div className="other-projects">
        {props.projects.filter((project) => project.id !== props.project.id).slice(0, 4).map((project) => (
          <button key={project.id} onClick={() => props.onProject(project.id)}>
            <span className="project-avatar" aria-hidden="true">{project.key.slice(0, 2)}</span>
            <span>{project.name}</span>
          </button>
        ))}
      </div>
      <button className="collapse-button" onClick={props.onCollapse}>
        <ChevronsLeft aria-hidden="true" />
        <span>Collapse</span>
      </button>
    </aside>
  );
}

function Header(props: {
  project: Project;
  view: View;
  query: string;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onQuery(value: string): void;
  onCreate(): void;
  onSettings(): void;
  onMenu(): void;
}) {
  const viewName = props.view === "all" ? "All work" : props.view[0].toUpperCase() + props.view.slice(1);
  return (
    <header className="topbar">
      <button className="icon-button menu-button" onClick={props.onMenu} aria-label="Open navigation"><Menu /></button>
      <div className="breadcrumbs"><strong>{props.project.name}</strong><span>/</span><a>{viewName}</a></div>
      <label className="search-box">
        <Search aria-hidden="true" />
        <span className="sr-only">Search issues, epics, and projects</span>
        <input
          ref={props.searchRef}
          value={props.query}
          onChange={(event) => props.onQuery(event.target.value)}
          placeholder="Search issues, epics, projects…"
        />
        <kbd>/</kbd>
      </label>
      <button className="primary-button create-button" onClick={props.onCreate}>Create <Plus aria-hidden="true" /></button>
      <button className="secondary-button settings-button" onClick={props.onSettings}><Settings aria-hidden="true" /> Settings</button>
    </header>
  );
}

function Backlog(props: {
  epics: Issue[];
  selectedEpicId: string;
  stories: Issue[];
  allIssues: Issue[];
  links: Bootstrap["links"];
  selectedIssueId: string;
  sort: "rank" | "key" | "priority";
  statusFilter: IssueStatus | "all";
  bulkMode: boolean;
  selectedIds: Set<string>;
  sprints: Sprint[];
  sprintFilter: string;
  onEpic(id: string): void;
  onIssue(id: string): void;
  onSort(value: "rank" | "key" | "priority"): void;
  onFilter(value: IssueStatus | "all"): void;
  onSprintFilter(value: string): void;
  onToggleBulk(): void;
  onSelect(id: string): void;
  onBulkUpdate(changes: Record<string, unknown>): Promise<void>;
  onRank(draggedId: string, targetId: string): Promise<void>;
  onCreate(): void;
  onContextMenu(event: ReactMouseEvent, id: string): void;
}) {
  const selectedEpic = props.epics.find((epic) => epic.id === props.selectedEpicId);
  const [dragged, setDragged] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  return (
    <section className="backlog-view" aria-label="Project backlog">
      <div className="section-title-row">
        <h1>Epics</h1>
        <button className="text-button" onClick={props.onCreate}><Plus /> Add epic</button>
      </div>
      <div className="epic-list">
        {props.epics.map((epic) => {
          const count = props.allIssues.filter((issue) => issue.parent_id === epic.id).length;
          return (
            <button
              key={epic.id}
              className={epic.id === props.selectedEpicId ? "selected" : ""}
              onClick={() => props.onEpic(epic.id)}
              onContextMenu={(event) => props.onContextMenu(event, epic.id)}
            >
              {epic.id === props.selectedEpicId ? <ChevronRight /> : <Archive />}
              <span>{epic.title}</span>
              <span className="epic-count">{count}</span>
            </button>
          );
        })}
      </div>
      <div className="stories-toolbar">
        <h2>Stories in {selectedEpic?.title ?? "project"}</h2>
        {props.bulkMode && props.selectedIds.size > 0 && (
          <div className="bulk-actions" aria-label="Bulk actions">
            <span>{props.selectedIds.size} selected</span>
            <button onClick={() => void props.onBulkUpdate({ status: "todo" })}>Move to To do</button>
            <button onClick={() => void props.onBulkUpdate({ status: "backlog" })}>Backlog</button>
            {props.sprints.length > 0 && (
              <select
                aria-label="Move selected Stories to sprint"
                defaultValue=""
                onChange={(event) => {
                  if (event.target.value) void props.onBulkUpdate({ sprint_id: event.target.value });
                }}
              >
                <option value="">Move to sprint…</option>
                {props.sprints.map((sprint) => <option value={sprint.id} key={sprint.id}>{sprint.name}</option>)}
              </select>
            )}
          </div>
        )}
        <label className="toolbar-select">
          <Filter aria-hidden="true" />
          <span className="sr-only">Filter status</span>
          <select value={props.statusFilter} onChange={(event) => props.onFilter(event.target.value as IssueStatus | "all")}>
            <option value="all">Filter</option>
            {Object.entries(statusLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
          <ChevronDown />
        </label>
        {props.sprints.length > 0 && (
          <label className="toolbar-select sprint-filter">
            <FolderKanban aria-hidden="true" />
            <span className="sr-only">Filter by sprint</span>
            <select value={props.sprintFilter} onChange={(event) => props.onSprintFilter(event.target.value)}>
              <option value="all">All backlog</option>
              <option value="unassigned">No sprint</option>
              {props.sprints.map((sprint) => <option value={sprint.id} key={sprint.id}>{sprint.name}</option>)}
            </select>
            <ChevronDown />
          </label>
        )}
        <label className="toolbar-select">
          <ArrowUp aria-hidden="true" />
          <ArrowDown aria-hidden="true" />
          <span className="sr-only">Sort Stories</span>
          <select value={props.sort} onChange={(event) => props.onSort(event.target.value as typeof props.sort)}>
            <option value="rank">Sort</option>
            <option value="key">Key</option>
            <option value="priority">Priority</option>
          </select>
        </label>
        <div className="more-menu">
          <button className="icon-button bordered" aria-label="More backlog actions" onClick={() => setMoreOpen((value) => !value)}>
            <MoreHorizontal />
          </button>
          {moreOpen && (
            <div className="menu-popover">
              <button onClick={() => { props.onToggleBulk(); setMoreOpen(false); }}>
                <Check aria-hidden="true" /> {props.bulkMode ? "End bulk selection" : "Bulk select"}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="story-table" role="table" aria-label="Ranked Stories">
        <div className="story-header" role="row">
          <span role="columnheader">#</span>
          <span role="columnheader">Story</span>
          <span role="columnheader">Type</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Priority</span>
          <span role="columnheader">Estimate</span>
          <span role="columnheader">Deps</span>
          <span role="columnheader">Agent state</span>
        </div>
        {props.stories.map((story, index) => {
          const depCount = props.links.filter((link) => link.source_issue_id === story.id || link.target_issue_id === story.id).length;
          return (
            <div
              role="row"
              className={`story-row ${story.id === props.selectedIssueId ? "selected" : ""}`}
              key={story.id}
              draggable={!props.bulkMode}
              onDragStart={() => setDragged(story.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => { void props.onRank(dragged, story.id); setDragged(""); }}
              onClick={() => props.onIssue(story.id)}
              onContextMenu={(event) => props.onContextMenu(event, story.id)}
            >
              <span role="cell" className="rank-cell">
                {props.bulkMode ? (
                  <input
                    type="checkbox"
                    aria-label={`Select ${story.issue_key}`}
                    checked={props.selectedIds.has(story.id)}
                    onChange={() => props.onSelect(story.id)}
                    onClick={(event) => event.stopPropagation()}
                  />
                ) : <GripVertical aria-label="Drag to rank" />}
                <span>{index + 1}</span>
              </span>
              <span role="cell" className="story-title-cell"><code>{story.issue_key}</code><strong>{story.title}</strong></span>
              <span role="cell" className="icon-text type-text"><FileCheck2 /> Story</span>
              <span role="cell" className={`icon-text status-${story.status}`}>{iconForStatus(story.status)} {statusLabel[story.status]}</span>
              <span role="cell" className="icon-text priority-text"><ArrowUp /> {story.priority[0].toUpperCase() + story.priority.slice(1)}</span>
              <span role="cell">{story.estimate_hours ? `${story.estimate_hours}h` : "—"}</span>
              <span role="cell" className="icon-text"><Link2 /> {depCount}</span>
              <span role="cell" className="icon-text agent-text">{story.agent_state === "plan_ready" ? <Info /> : <Circle />} {agentLabel[story.agent_state]}</span>
            </div>
          );
        })}
        <button className="create-story-row" onClick={props.onCreate}><Plus /> Create story</button>
        <div className="table-footer"><span>1–{props.stories.length} of {props.stories.length}</span><button><RefreshCw /> Refresh</button></div>
      </div>
    </section>
  );
}

function Inspector(props: {
  issue: Issue;
  plan?: Plan;
  links: Bootstrap["links"];
  allIssues: Issue[];
  activity: Activity[];
  project: Project;
  successfulRun?: Run;
  onClose(): void;
  onApprove(plan: Plan): Promise<void>;
  onRequestChanges(plan: Plan): Promise<void>;
  onAccept(runId: string): Promise<void>;
  onUpdate(id: string, changes: Record<string, unknown>): Promise<void>;
  onStartSession(id: string): Promise<void>;
}) {
  const related = props.links.map((link) => {
    const id = link.source_issue_id === props.issue.id ? link.target_issue_id : link.source_issue_id;
    return { link, issue: props.allIssues.find((item) => item.id === id) };
  }).filter((item) => item.issue);
  return (
    <aside className="inspector" aria-label={`${props.issue.issue_key} details`}>
      <div className="inspector-key-row">
        <code>{props.issue.issue_key}</code>
        <div>
          <button className="icon-button bordered" aria-label="Previous issue"><ChevronUp /></button>
          <button className="icon-button bordered" aria-label="Next issue"><ChevronDown /></button>
          <button className="icon-button" onClick={props.onClose} aria-label="Close issue details"><X /></button>
        </div>
      </div>
      <h2>{props.issue.title}</h2>
      <button
        className="secondary-button start-session-button"
        onClick={() => void props.onStartSession(props.issue.id)}
        disabled={!props.project.repo_root}
        title={!props.project.repo_root ? "Configure a repository root in Settings before starting a session." : undefined}
      >
        <SquareTerminal aria-hidden="true" /> Start Claude Code session
      </button>
      <div className="issue-meta">
        <span><FileCheck2 /> Story</span>
        <label className={`status-${props.issue.status}`}>
          {iconForStatus(props.issue.status)}
          <select value={props.issue.status} onChange={(event) => void props.onUpdate(props.issue.id, { status: event.target.value })}>
            {Object.entries(statusLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </label>
        <span><ArrowUp /> {props.issue.priority[0].toUpperCase() + props.issue.priority.slice(1)}</span>
        <span className="estimate">{props.issue.estimate_hours ? `${props.issue.estimate_hours}h` : "—"}</span>
      </div>
      <section>
        <h3>Description</h3>
        <p>{props.issue.description || "No description yet."}</p>
      </section>
      <section>
        <h3>Acceptance criteria</h3>
        <ul className="criteria-list">
          {props.issue.acceptance_criteria.map((criterion, index) => (
            <li key={criterion}>
              <Square aria-hidden="true" className={props.issue.status === "done" || index < 2 ? "checked" : ""} />
              <span>{criterion}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3>Dependencies</h3>
        {related.length ? related.map(({ link, issue }) => (
          <div className="dependency-row" key={link.id}>
            <Link2 />
            <code>{issue!.issue_key}</code>
            <span>{issue!.title}</span>
            <em className={`status-${issue!.status}`}>{statusLabel[issue!.status].toUpperCase()}</em>
          </div>
        )) : <p className="empty-copy">No linked dependencies.</p>}
      </section>
      <section>
        <h3>Activity</h3>
        <ol className="activity-mini">
          {props.activity.slice(0, 4).map((item) => (
            <li key={item.id}>
              <span className="activity-avatar" aria-hidden="true">{item.actor.includes("Agent") ? "A" : "Y"}</span>
              <div><small>{formatDate(item.created_at)} · {item.actor}</small><p>{item.message}</p></div>
            </li>
          ))}
        </ol>
      </section>
      {props.plan?.status === "ready" && (
        <section className="plan-card">
          <div className="plan-heading"><Sparkles /><h3>Agent plan ready</h3><button className="text-button">View full plan <Box /></button></div>
          <div className="approval-warning"><LockKeyhole /><div><strong>Execution requires your approval</strong><p>No actions will be taken until you approve and dispatch.</p></div></div>
          <button
            className="primary-button approve-button"
            onClick={() => void props.onApprove(props.plan!)}
            title={!props.project.dispatch_enabled ? "Enable dispatch in Settings before approval" : undefined}
          >
            <Rocket /> Approve &amp; dispatch
          </button>
          <button className="secondary-button request-button" onClick={() => void props.onRequestChanges(props.plan!)}>
            <Pencil /> Request changes
          </button>
        </section>
      )}
      {props.issue.agent_state === "awaiting_acceptance" && props.successfulRun && (
        <section className="plan-card acceptance-card">
          <div className="plan-heading"><CheckCircle2 /><h3>Handoff ready</h3></div>
          <p>Execution and required verification finished. Review the receipt before closing the Story.</p>
          <p className="run-agent-tag">Executed by {dispatchAgentLabel[props.successfulRun.agent]} · {props.successfulRun.model}</p>
          <button className="primary-button approve-button" onClick={() => void props.onAccept(props.successfulRun!.id)}>
            <CheckCircle2 /> Accept &amp; move to Done
          </button>
        </section>
      )}
    </aside>
  );
}

function Board({
  issues,
  onIssue,
  onContextMenu
}: {
  issues: Issue[];
  onIssue(id: string): void;
  onContextMenu(event: ReactMouseEvent, id: string): void;
}) {
  const columns: IssueStatus[] = ["backlog", "todo", "in_progress", "in_review", "done"];
  return (
    <section className="secondary-view">
      <div className="view-heading"><div><h1>Board</h1><p>Current work by workflow state</p></div></div>
      <div className="board-grid">
        {columns.map((status) => (
          <section className="board-column" key={status}>
            <h2>{statusLabel[status]} <span>{issues.filter((issue) => issue.status === status).length}</span></h2>
            {issues.filter((issue) => issue.status === status).map((issue) => (
              <button key={issue.id} onClick={() => onIssue(issue.id)} onContextMenu={(event) => onContextMenu(event, issue.id)}>
                <code>{issue.issue_key}</code><strong>{issue.title}</strong>
                <span>{agentLabel[issue.agent_state]}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </section>
  );
}

function AllWork({
  issues,
  onIssue,
  onContextMenu
}: {
  issues: Issue[];
  onIssue(id: string): void;
  onContextMenu(event: ReactMouseEvent, id: string): void;
}) {
  return (
    <section className="secondary-view">
      <div className="view-heading"><div><h1>All work</h1><p>Every Epic, Story, and Sub-task in this project</p></div></div>
      <div className="all-work-table">
        {issues.map((issue) => (
          <button key={issue.id} onClick={() => onIssue(issue.id)} onContextMenu={(event) => onContextMenu(event, issue.id)}>
            <code>{issue.issue_key}</code><strong>{issue.title}</strong><span>{issue.type}</span>
            <span className={`status-${issue.status}`}>{statusLabel[issue.status]}</span><span>{issue.priority}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

const priorityValues: Array<"highest" | "high" | "medium" | "low"> = ["highest", "high", "medium", "low"];

function IssueContextMenu(props: {
  issue?: Issue;
  x: number;
  y: number;
  onClose(): void;
  onOpen(): void;
  onUpdate(id: string, changes: Record<string, unknown>): Promise<void>;
  onNotify(message: string): void;
  onStartSession(id: string): Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocMouseDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) props.onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") props.onClose();
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [props]);

  const issue = props.issue;
  if (!issue) return null;

  async function apply(changes: Record<string, unknown>) {
    await props.onUpdate(issue!.id, changes);
    props.onClose();
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={`${issue.issue_key} actions`}
      style={{ left: Math.min(props.x, window.innerWidth - 232), top: Math.min(props.y, window.innerHeight - 24) }}
    >
      <div className="context-menu-header"><code>{issue.issue_key}</code><span>{issue.title}</span></div>
      <button role="menuitem" onClick={props.onOpen}><FileCheck2 aria-hidden="true" /> Open</button>
      <button
        role="menuitem"
        onClick={() => {
          void props.onStartSession(issue.id);
          props.onClose();
        }}
      >
        <SquareTerminal aria-hidden="true" /> Start Claude Code session
      </button>
      <button
        role="menuitem"
        onClick={() => {
          void navigator.clipboard.writeText(issue.issue_key);
          props.onNotify(`Copied ${issue.issue_key}.`);
          props.onClose();
        }}
      >
        <Link2 aria-hidden="true" /> Copy issue key
      </button>
      <div className="context-menu-section">
        <span>Status</span>
        {Object.entries(statusLabel).map(([value, label]) => (
          <button
            key={value}
            role="menuitem"
            className={issue.status === value ? "active" : ""}
            onClick={() => void apply({ status: value })}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="context-menu-section">
        <span>Priority</span>
        {priorityValues.map((value) => (
          <button
            key={value}
            role="menuitem"
            className={issue.priority === value ? "active" : ""}
            onClick={() => void apply({ priority: value })}
          >
            {value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      <button
        role="menuitem"
        className="context-menu-danger"
        title="Sets status to Cancelled — reversible from this same menu."
        onClick={() => void apply({ status: "cancelled" })}
      >
        <X aria-hidden="true" /> Delete
      </button>
    </div>
  );
}

function ActivityView({ activity }: { activity: Activity[] }) {
  return (
    <section className="secondary-view activity-view">
      <div className="view-heading"><div><h1>Activity</h1><p>Append-only project and agent receipts</p></div></div>
      <ol>
        {activity.map((item) => (
          <li key={item.id}>
            <span className="activity-avatar">{item.actor[0]}</span>
            <div><strong>{item.message}</strong><p>{item.actor} · {formatDate(item.created_at)}</p></div>
            <code>{item.kind}</code>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StatusBar({ data }: { data: Bootstrap }) {
  const active = data.queue.active.length;
  const awaiting = data.plans.filter((plan) => plan.status === "ready").length;
  return (
    <footer className="statusbar">
      <span><i className="dot green" /> {active} {active === 1 ? "agent" : "agents"} running</span>
      <span><i className="dot amber" /> {awaiting} {awaiting === 1 ? "plan" : "plans"} awaiting approval</span>
      <span><Database /> SQLite saved</span>
      <span><CheckCircle2 /> Local mode</span>
    </footer>
  );
}

function CreateIssueModal(props: { project: Project; epics: Issue[]; onClose(): void; onCreated(id: string): void }) {
  const [type, setType] = useState<"epic" | "story">("story");
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState(props.epics[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [estimate, setEstimate] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const issue = await api<Issue>("/api/issues", {
        method: "POST",
        body: JSON.stringify({
          projectId: props.project.id,
          type,
          parentId: type === "story" ? parentId : null,
          title,
          description,
          priority,
          estimateHours: estimate ? Number(estimate) : null
        })
      });
      props.onCreated(issue.id);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Create issue" onClose={props.onClose}>
      <form className="form-grid" onSubmit={(event) => void submit(event)}>
        <label>Issue type<select value={type} onChange={(event) => setType(event.target.value as "epic" | "story")}><option value="story">Story</option><option value="epic">Epic</option></select></label>
        {type === "story" && <label>Epic<select value={parentId} onChange={(event) => setParentId(event.target.value)} required>{props.epics.map((epic) => <option value={epic.id} key={epic.id}>{epic.title}</option>)}</select></label>}
        <label className="wide">Summary<input value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus /></label>
        <label className="wide">Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} /></label>
        <label>Priority<select value={priority} onChange={(event) => setPriority(event.target.value)}><option>highest</option><option>high</option><option>medium</option><option>low</option></select></label>
        <label>Estimate (hours)<input type="number" min="0" step="0.5" value={estimate} onChange={(event) => setEstimate(event.target.value)} /></label>
        <div className="modal-actions wide"><button type="button" className="secondary-button" onClick={props.onClose}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Creating…" : "Create"}</button></div>
      </form>
    </Modal>
  );
}

function SettingsModal(props: { project: Project; sprints: Sprint[]; onClose(): void; onSaved(): void; onImported(): void }) {
  const [repoRoot, setRepoRoot] = useState(props.project.repo_root ?? "");
  const [policy, setPolicy] = useState(props.project.workspace_policy);
  const [dispatch, setDispatch] = useState(Boolean(props.project.dispatch_enabled));
  const [commands, setCommands] = useState(props.project.verification_commands.join("\n"));
  const [plannerAgent, setPlannerAgent] = useState(props.project.planner_agent);
  const [plannerModel, setPlannerModel] = useState(props.project.planner_model);
  const [workerAgent, setWorkerAgent] = useState(props.project.worker_agent);
  const [workerModel, setWorkerModel] = useState(props.project.worker_model);
  const [evaluatorAgent, setEvaluatorAgent] = useState(props.project.evaluator_agent);
  const [evaluatorModel, setEvaluatorModel] = useState(props.project.evaluator_model);
  const [backupPath, setBackupPath] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [tab, setTab] = useState<"project" | "import">("project");
  const [sprintName, setSprintName] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    await api(`/api/projects/${props.project.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        repo_root: repoRoot || null,
        workspace_policy: policy,
        dispatch_enabled: dispatch,
        verification_commands: commands.split("\n").map((item) => item.trim()).filter(Boolean),
        planner_agent: plannerAgent,
        planner_model: plannerModel,
        worker_agent: workerAgent,
        worker_model: workerModel,
        evaluator_agent: evaluatorAgent,
        evaluator_model: evaluatorModel
      })
    });
    props.onSaved();
  }
  async function makePreview() {
    const result = await api("/api/imports/paperclip/preview", {
      method: "POST",
      body: JSON.stringify({ sourceType: "backup", path: backupPath })
    });
    setPreview(result);
  }
  async function commit() {
    await api("/api/imports/paperclip/commit", {
      method: "POST",
      body: JSON.stringify({ previewId: preview.id, groups: preview.groups })
    });
    setPreview(null);
    props.onImported();
  }
  async function createSprint() {
    if (!sprintName.trim()) return;
    await api("/api/sprints", {
      method: "POST",
      body: JSON.stringify({
        projectId: props.project.id,
        name: sprintName.trim(),
        state: props.sprints.some((sprint) => sprint.state === "active") ? "future" : "active"
      })
    });
    setSprintName("");
    props.onSaved();
  }
  return (
    <Modal title="Settings" onClose={props.onClose} wide>
      <div className="settings-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "project"} onClick={() => setTab("project")}>Project</button>
        <button role="tab" aria-selected={tab === "import"} onClick={() => setTab("import")}>Paperclip import</button>
      </div>
      {tab === "project" ? (
        <form className="settings-form" onSubmit={(event) => void save(event)}>
          <label>Repository root<input value={repoRoot} onChange={(event) => setRepoRoot(event.target.value)} placeholder="/absolute/path/to/repository" /></label>
          <label>Workspace policy<select value={policy} onChange={(event) => setPolicy(event.target.value as "shared" | "worktree")}><option value="shared">Shared canonical workspace</option><option value="worktree">Isolated Git worktree</option></select></label>
          <label>Planner agent<select value={plannerAgent} onChange={(event) => setPlannerAgent(event.target.value as "codex" | "claude")}>{Object.entries(dispatchAgentLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label>Planner model<input value={plannerModel} onChange={(event) => setPlannerModel(event.target.value)} placeholder="gpt-5.6-terra or claude-opus-5" /></label>
          <label>Worker agent<select value={workerAgent} onChange={(event) => setWorkerAgent(event.target.value as "codex" | "claude")}>{Object.entries(dispatchAgentLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label>Worker model<input value={workerModel} onChange={(event) => setWorkerModel(event.target.value)} placeholder="gpt-5.6-sol or claude-sonnet-5" /></label>
          <label>Evaluator agent<select value={evaluatorAgent} onChange={(event) => setEvaluatorAgent(event.target.value as "codex" | "claude")}>{Object.entries(dispatchAgentLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label>Evaluator model<input value={evaluatorModel} onChange={(event) => setEvaluatorModel(event.target.value)} placeholder="gpt-5.6-sol or claude-sonnet-5" /></label>
          <label>Verification commands<textarea rows={4} value={commands} onChange={(event) => setCommands(event.target.value)} placeholder={"npm test\nnpm run build"} /></label>
          <label className="toggle-row"><input type="checkbox" checked={dispatch} onChange={(event) => setDispatch(event.target.checked)} /><span><strong>Enable dispatch</strong><small>Approved plans may modify this configured workspace.</small></span></label>
          <div className="sprint-settings">
            <h3>Optional sprints</h3>
            {props.sprints.map((sprint) => <p key={sprint.id}><strong>{sprint.name}</strong> · {sprint.state}</p>)}
            <div>
              <input value={sprintName} onChange={(event) => setSprintName(event.target.value)} placeholder="Sprint name" />
              <button type="button" className="secondary-button" onClick={() => void createSprint()} disabled={!sprintName.trim()}><Plus /> Add sprint</button>
            </div>
          </div>
          <div className="modal-actions"><button className="primary-button">Save project settings</button></div>
        </form>
      ) : (
        <div className="import-panel">
          <p>Preview a Paperclip backup without changing either system. Commit remains idempotent and never syncs back.</p>
          <label>Paperclip .sql.gz backup path<input value={backupPath} onChange={(event) => setBackupPath(event.target.value)} placeholder="/Users/…/paperclip-backup.sql.gz" /></label>
          <button className="secondary-button" onClick={() => void makePreview()} disabled={!backupPath}><Search /> Preview import</button>
          {preview && (
            <div className="import-preview">
              <h3>Import preview</h3>
              <p>{preview.groups.length} Conductor projects · {preview.counts.issues ?? 0} issues · {preview.counts.issue_comments ?? 0} comments</p>
              <ul>{preview.groups.map((group: any) => <li key={group.proposedKey}><code>{group.proposedKey}</code><span>{group.name}</span><strong>{group.issueCount} issues</strong></li>)}</ul>
              {preview.warnings.map((warning: string) => <p className="warning-copy" key={warning}>{warning}</p>)}
              <button className="primary-button" onClick={() => void commit()}><Database /> Commit import</button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Modal(props: { title: string; onClose(): void; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) props.onClose(); }}>
      <section className={`modal ${props.wide ? "wide-modal" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-header"><h2 id="modal-title">{props.title}</h2><button className="icon-button" onClick={props.onClose} aria-label={`Close ${props.title}`}><X /></button></div>
        {props.children}
      </section>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
