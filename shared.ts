import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { assignProjectColors, colorForKey, isColorId, swatch, type ColorId } from "./vendor/chat-sidebar-colors";

export const RU = typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ru");
// Watches a few elements instead of the whole window. Chat streaming changes
// the DOM many times a second; that only costs a throttled check that the
// watched elements are still the same. Layout and styles are read only when
// a watched element itself changes or the window resizes.
export function useElementWatch(
  find: () => readonly Element[],
  init: MutationObserverInit,
  update: () => void,
  deps: readonly unknown[],
) {
  const updateRef = useRef(update);
  updateRef.current = update;
  useLayoutEffect(() => {
    let targets: readonly Element[] = [];
    let frame = 0;
    let check = 0;
    const run = () => {
      frame = 0;
      updateRef.current();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(run);
    };
    const local = new MutationObserver(schedule);
    const resize = new ResizeObserver(schedule);
    const bind = () => {
      check = 0;
      const next = find();
      if (next.length === targets.length && next.every((element, index) => element === targets[index])) return;
      targets = next;
      local.disconnect();
      resize.disconnect();
      for (const element of targets) {
        local.observe(element, init);
        resize.observe(element);
      }
      schedule();
    };
    const structure = new MutationObserver(() => {
      if (!check) check = window.setTimeout(bind, 250);
    });
    structure.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    bind();
    schedule();
    return () => {
      structure.disconnect();
      local.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      if (check) window.clearTimeout(check);
    };
  }, deps);
}

export const SIDEBAR_ROW = "[data-chat-row]";
const PROJECT_PICKS_KEY = "chat-sidebar/project-colors";

// Lane rules mirror Chat Sidebar (lib/status.ts), so the dot matches the sidebar row.
export type Lane = "attention" | "working" | "done";
export const LANE_COLORS: Record<Lane, string> = { attention: "#e8a317", working: "#3987e5", done: "#1f9d55" };
const ATTENTION_INDICATORS = new Set<string>(["waiting-for-input", "queued-failed", "unread-error"]);
const WORKING_INDICATORS = new Set<string>([
  "runtime",
  "workflow",
  "background-agent",
  "background-command",
  "plan-mode",
  "queued-waiting",
  "working-draft",
]);
const BUSY_STATUSES = new Set<string>(["starting", "active", "stopping", "provisioning", "waiting-for-host"]);

export function laneOf(thread: PluginSidebarThread): Lane | null {
  if (
    thread.hasPendingInteraction ||
    thread.queuedWork === "failed" ||
    ATTENTION_INDICATORS.has(thread.indicator)
  ) {
    return "attention";
  }
  const { activity } = thread;
  if (
    BUSY_STATUSES.has(thread.runtimeStatus) ||
    BUSY_STATUSES.has(thread.status) ||
    WORKING_INDICATORS.has(thread.indicator) ||
    activity.workflows + activity.backgroundAgents + activity.backgroundCommands + activity.planMode > 0
  ) {
    return "working";
  }
  if (thread.indicator === "unread-success") return "done";
  return null;
}

export const LANE_RANK: Record<Lane, number> = { attention: 3, working: 2, done: 1 };

// The most urgent lane across each pinned thread and its descendants, as the
// sidebar row shows it (working, "+1", when only a child works).
export function treeLanes(threads: readonly PluginSidebarThread[], roots: ReadonlySet<string>): Map<string, Lane> {
  const visible = threads.filter((thread) => !thread.isHidden && !thread.isArchived);
  const byId = new Map(visible.map((thread) => [thread.id, thread]));
  const lanes = new Map<string, Lane>();
  for (const thread of visible) {
    const lane = laneOf(thread);
    if (lane === null) continue;
    const seen = new Set<string>();
    let current: PluginSidebarThread | undefined = thread;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (roots.has(current.id)) {
        const known = lanes.get(current.id);
        if (known === undefined || LANE_RANK[lane] > LANE_RANK[known]) lanes.set(current.id, lane);
      }
      current = current.parentThreadId === null ? undefined : byId.get(current.parentThreadId);
    }
  }
  return lanes;
}

type Colors = Readonly<Record<string, string>>;

const CHAT_SIDEBAR_ROOT = ".chat-sidebar";
const BUILTIN_THREAD_LIST = '[data-bb-plugin="thread-list"]';
const LIST_MODE_KEY = "header-pins:chat-sidebar";

// Without Chat Sidebar the stripe shows who runs the thread.
export const PROVIDER_COLORS: Readonly<Record<string, string>> = {
  "claude-code": "#d97757",
  codex: "#8e8ea0",
  "acp-cursor": "var(--foreground, #111)",
  pi: "#8b5cf6",
  "acp-opencode": "#06b6d4",
  "acp-omp": "#65a30d",
  "acp-grok": "#c026d3",
  "acp-hermes-agent": "#a16207",
};

function readListMode(): boolean {
  try {
    return localStorage.getItem(LIST_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

// Which list fills the sidebar. While the sidebar is hidden neither list is
// mounted, so the last answer stands.
function detectChatSidebar(current: boolean): boolean {
  if (document.querySelector(CHAT_SIDEBAR_ROOT)) return true;
  if (document.querySelector(BUILTIN_THREAD_LIST)) return false;
  return current;
}

function findThreadLists(): Element[] {
  return [document.querySelector(CHAT_SIDEBAR_ROOT), document.querySelector(BUILTIN_THREAD_LIST)].filter(
    (element): element is Element => element !== null,
  );
}

const LIST_WATCH: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["style"],
};

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; read again from the sidebar on the next change.
  }
}

type ProjectPicks = Readonly<Record<string, ColorId>>;

function readProjectPicks(): ProjectPicks {
  try {
    const raw = localStorage.getItem(PROJECT_PICKS_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, ColorId] => isColorId(entry[1])));
  } catch {
    // The sidebar also uses automatic project colors when picks aren't stored.
    return {};
  }
}

function samePicks(a: ProjectPicks, b: ProjectPicks): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((id) => a[id] === b[id]);
}

// Chat Sidebar (lib/model.ts, projectsByUse) hands automatic colors only to
// projects that have chats, most recently used first, and folds sub-threads
// into their root's row. The same input gives the same colors here.
export function projectsByUse(
  threads: readonly PluginSidebarThread[],
  projects: readonly PluginSidebarProject[],
): PluginSidebarProject[] {
  const visible = threads.filter((thread) => !thread.isHidden && !thread.isArchived);
  const byId = new Map(visible.map((thread) => [thread.id, thread]));
  const lastUse = new Map<string, number>();
  for (const thread of visible) {
    let root = thread;
    const seen = new Set<string>([root.id]);
    while (root.parentThreadId !== null) {
      const parent = byId.get(root.parentThreadId);
      if (parent === undefined || seen.has(parent.id)) break;
      seen.add(parent.id);
      root = parent;
    }
    const at = Math.max(thread.updatedAt, thread.latestAttentionAt);
    lastUse.set(root.projectId, Math.max(lastUse.get(root.projectId) ?? 0, at));
  }
  return projects
    .filter((project) => lastUse.has(project.id))
    .sort((a, b) => (lastUse.get(b.id) ?? 0) - (lastUse.get(a.id) ?? 0));
}

// Resolve colors from the same project list as Chat Sidebar, not from its
// rows: filters and virtualization unmount them.
export function useStripeColors(
  pins: readonly PluginSidebarThread[],
  threads: readonly PluginSidebarThread[],
  projects: readonly PluginSidebarProject[],
): { colors: Colors; chatSidebar: boolean } {
  const [picks, setPicks] = useState<ProjectPicks>(readProjectPicks);
  const [chatSidebar, setChatSidebar] = useState(readListMode);
  const refreshPicks = () => {
    const next = readProjectPicks();
    setPicks((current) => samePicks(current, next) ? current : next);
  };
  useElementWatch(
    findThreadLists,
    LIST_WATCH,
    () => {
      setChatSidebar((current) => {
        const next = detectChatSidebar(current);
        if (next !== current) writeStored(LIST_MODE_KEY, next ? "1" : "0");
        return next;
      });
      refreshPicks();
    },
    [],
  );
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === PROJECT_PICKS_KEY) refreshPicks();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const projectIds = useMemo(
    () => projectsByUse(threads, projects).map((project) => project.id).join("\n"),
    [threads, projects],
  );
  const colors = useMemo(() => {
    const inUse = projectIds === "" ? [] : projectIds.split("\n");
    const assigned = assignProjectColors(inUse, picks);
    const knownProjects = new Set(inUse);
    return Object.fromEntries(pins.map((thread) => [
      thread.id,
      swatch(knownProjects.has(thread.projectId)
        ? assigned.get(thread.projectId)!
        : colorForKey(thread.id)),
    ]));
  }, [pins, projectIds, picks]);
  return { colors, chatSidebar };
}
