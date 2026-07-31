import type { Bootstrap } from "./types";

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed with ${response.status}.`);
  return body as T;
}

export const loadBootstrap = () => api<Bootstrap>("/api/bootstrap");

export function subscribeToEvents(onEvent: () => void) {
  const source = new EventSource("/api/events");
  const events = [
    "project.created",
    "project.updated",
    "issue.created",
    "issue.updated",
    "issues.bulk_updated",
    "issue.linked",
    "sprint.created",
    "planning.queued",
    "plan.ready",
    "plan.changes_requested",
    "plan.approved",
    "worker.queued",
    "run.started",
    "run.finished",
    "run.review_ready",
    "run.accepted",
    "session.started",
    "import.committed",
    "queue.changed"
  ];
  let timer: number | undefined;
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(onEvent, 120);
  };
  events.forEach((event) => source.addEventListener(event, schedule));
  return () => {
    window.clearTimeout(timer);
    source.close();
  };
}
