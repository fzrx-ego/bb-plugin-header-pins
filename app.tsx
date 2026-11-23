import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useBbNavigate,
  useSdk,
  experimental_Icon as Icon,
  type PluginSidebarThread,
  type PluginSidebarProject,
  type ExperimentalThreadHeaderTitleProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { assignProjectColors, colorForKey, isColorId, swatch, type ColorId } from "./vendor/chat-sidebar-colors";

const PINS_ATTR = "data-header-pins";

// Watches a few elements instead of the whole window. Chat streaming changes
// the DOM many times a second; that only costs a throttled check that the
// watched elements are still the same. Layout and styles are read only when
// a watched element itself changes or the window resizes.
function useElementWatch(
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

const SIDEBAR_ROW = "[data-chat-row]";
const PROJECT_PICKS_KEY = "chat-sidebar/project-colors";

// Lane rules mirror Chat Sidebar (lib/status.ts), so the dot matches the sidebar row.
type Lane = "attention" | "working" | "done";
const LANE_COLORS: Record<Lane, string> = { attention: "#e8a317", working: "#3987e5", done: "#1f9d55" };
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

function laneOf(thread: PluginSidebarThread): Lane | null {
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

const LANE_RANK: Record<Lane, number> = { attention: 3, working: 2, done: 1 };

// The most urgent lane across each pinned thread and its descendants, as the
// sidebar row shows it (working, "+1", when only a child works).
function treeLanes(threads: readonly PluginSidebarThread[], roots: ReadonlySet<string>): Map<string, Lane> {
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
const PROVIDER_COLORS: Readonly<Record<string, string>> = {
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

// Resolve colors from the complete project list, just as Chat Sidebar does.
// Visible rows cannot be the color source: filters and virtualization unmount them.
function useStripeColors(
  pins: readonly PluginSidebarThread[],
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
  const colors = useMemo(() => {
    const assigned = assignProjectColors(projects.map((project) => project.id), picks);
    const knownProjects = new Set(projects.map((project) => project.id));
    return Object.fromEntries(pins.map((thread) => [
      thread.id,
      swatch(knownProjects.has(thread.projectId)
        ? assigned.get(thread.projectId)!
        : colorForKey(thread.id)),
    ]));
  }, [pins, projects, picks]);
  return { colors, chatSidebar };
}

function Stripe({ color, lane }: { color: string | undefined; lane: Lane | null }) {
  if (color === undefined && lane === null) return null;
  const dot = lane === null ? null : LANE_COLORS[lane];
  return (
    <span
      aria-hidden
      style={{
        position: "relative",
        flex: "none",
        width: 3,
        height: 16,
        borderRadius: 999,
        background: color ?? "transparent",
      }}
    >
      {dot === null ? null : (
        <span
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: 6,
            height: 6,
            borderRadius: 999,
            background: dot,
            transform: "translate(-50%, -50%)",
            boxShadow: "0 0 0 1.5px var(--background, #fff)",
          }}
        />
      )}
    </span>
  );
}
const REVEAL_TIMEOUT_MS = 1500;

function revealInSidebar(threadId: string) {
  const started = performance.now();
  const step = () => {
    const row = document.querySelector<HTMLElement>(
      `${SIDEBAR_ROW}[data-chat-row="${CSS.escape(threadId)}"]`,
    );
    if (row) {
      row.scrollIntoView({ block: "nearest" });
      return;
    }
    if (performance.now() - started < REVEAL_TIMEOUT_MS) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function comparePins(a: PluginSidebarThread, b: PluginSidebarThread): number {
  if (a.pinSortKey !== null && b.pinSortKey !== null) {
    return a.pinSortKey < b.pinSortKey ? -1 : a.pinSortKey > b.pinSortKey ? 1 : 0;
  }
  if (a.pinSortKey !== null) return -1;
  if (b.pinSortKey !== null) return 1;
  return (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0);
}

const RU = typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ru");
const TEXT = RU
  ? {
      empty: "Нет закреплённых тредов",
      unpin: "Открепить",
      unpinLabel: (title: string) => `Открепить «${title}»`,
      unpinFailed: "Не удалось открепить тред",
    }
  : {
      empty: "No pinned threads",
      unpin: "Unpin",
      unpinLabel: (title: string) => `Unpin “${title}”`,
      unpinFailed: "Couldn't unpin the thread",
    };

// The unpin button floats over the chip's right end on hover, so it takes
// no room; the title fades out underneath it.
const CHIP_CSS = `
.header-pins-chip { position: relative; }
.header-pins-unpin {
  position: absolute;
  top: 50%;
  right: 4px;
  display: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 4px;
  padding: 0;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  transform: translateY(-50%);
}
.header-pins-chip:hover .header-pins-unpin { display: inline-flex; }
.header-pins-unpin:hover { opacity: 1; background: var(--state-hover, rgba(128,128,128,0.15)); }
.header-pins-chip:hover .header-pins-link {
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 34px), transparent calc(100% - 22px));
  mask-image: linear-gradient(to right, #000 calc(100% - 34px), transparent calc(100% - 22px));
}
.header-pins-chip:not(:has([aria-current="page"])):hover { background: var(--state-hover, rgba(128,128,128,0.1)); }
`;

export function HeaderPins({ threadId }: ExperimentalThreadHeaderTitleProps) {
  const strip = useRef<HTMLDivElement>(null);
  const { threads, projects } = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const unpin = (id: string) => {
    sdk.threads.unpin({ threadId: id }).catch((cause: unknown) => {
      toast.error(TEXT.unpinFailed, {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    });
  };
  const pinned = useMemo(
    () => threads.filter((thread) => thread.isPinned && !thread.isHidden && !thread.isArchived).sort(comparePins),
    [threads],
  );
  const pinnedIds = useMemo(() => pinned.map((thread) => thread.id), [pinned]);
  const { colors, chatSidebar } = useStripeColors(pinned, projects);
  const lanes = useMemo(() => treeLanes(threads, new Set(pinnedIds)), [threads, pinnedIds]);

  useLayoutEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [threadId, pinnedIds]);

  return (
    <>
      <style>{CHIP_CSS}</style>
      <div
        ref={strip}
        role="navigation"
        aria-label={RU ? "Закреплённые треды" : "Pinned threads"}
        {...{ [PINS_ATTR]: "" }}
        style={{
          width: "100%",
          minWidth: 0,
          height: 28,
          display: "flex",
          alignItems: "center",
          gap: 4,
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "none",
        }}
      >
        {pinned.length === 0 ? (
          <span
            style={{
              pointerEvents: "none",
              fontSize: 12,
              color: "var(--muted-foreground, currentColor)",
              opacity: 0.7,
              whiteSpace: "nowrap",
            }}
          >
            {TEXT.empty}
          </span>
        ) : (
          pinned.map((thread) => {
            const active = thread.id === threadId;
            const lane = lanes.get(thread.id) ?? null;
            return (
              <span
                key={thread.id}
                className="header-pins-chip"
                style={{
                  pointerEvents: "auto",
                  WebkitAppRegion: "no-drag",
                  appRegion: "no-drag",
                  display: "inline-flex",
                  alignItems: "center",
                  flex: "none",
                  maxWidth: 200,
                  height: 28,
                  borderRadius: 6,
                  background: active
                    ? "var(--state-active, rgba(128,128,128,0.18))"
                    : "transparent",
                } as CSSProperties}
              >
                <a
                  className="header-pins-link"
                  href={thread.href}
                  title={thread.displayTitle}
                  aria-current={active ? "page" : undefined}
                  onClick={(event) => {
                    if (
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey ||
                      event.button !== 0
                    ) {
                      return;
                    }
                    event.preventDefault();
                    navigate.toThread(thread.id);
                    revealInSidebar(thread.id);
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    minWidth: 0,
                    height: "100%",
                    padding: "0 8px",
                    fontSize: 12,
                    lineHeight: "16px",
                    whiteSpace: "nowrap",
                    textDecoration: "none",
                    color: "inherit",
                  }}
                >
                  <Stripe
                    color={chatSidebar ? colors[thread.id] : PROVIDER_COLORS[thread.providerId]}
                    lane={lane}
                  />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {thread.displayTitle}
                  </span>
                </a>
                <button
                  type="button"
                  className="header-pins-unpin"
                  title={TEXT.unpin}
                  aria-label={TEXT.unpinLabel(thread.displayTitle)}
                  onClick={() => unpin(thread.id)}
                >
                  <Icon name="PinOff" className="size-3" />
                </button>
              </span>
            );
          })
        )}
      </div>
    </>
  );
}

// The title slot replaces the text. Scoped shell styles let it fill the title
// area and hide the adjacent actions menu while our tabs are present.
export const HEADER_LAYOUT_CSS = `
[data-testid="app-page-header-content-row"] > div:first-child > div:has([data-header-pins]),
[data-testid="app-page-header-content-row"] > div:first-child > div > div:has([data-header-pins]) {
  flex: 1;
  min-width: 0;
}
[data-testid="app-page-header-content-row"] > div:first-child > div:has([data-header-pins]) > span {
  display: none;
}
.header-pins-chip:focus-within .header-pins-unpin { display: inline-flex; }
`;

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "header-pins-layout",
    mount() {
      const style = document.createElement("style");
      style.dataset.headerPinsLayout = "";
      style.textContent = HEADER_LAYOUT_CSS;
      document.head.append(style);
      return () => style.remove();
    },
  });
  app.slots.experimental_threadHeaderTitle({
    id: "header-pins",
    component: HeaderPins,
  });
});
