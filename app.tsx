import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useSdk,
  experimental_Icon as Icon,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

const TITLE_BAR = '[data-testid="app-window-title-bar"]';
const OVERLAY_ATTR = "data-header-pins";
const PLUGIN_OVERLAYS = "[data-bb-plugin-app-overlays]";
const CONTROLS = 'button, a, [role="button"], [role="link"], input';

type Band = {
  key: string;
  top: number;
  left: number;
  width: number;
  height: number;
};

function measureBands(): Band[] {
  const bar = document.querySelector<HTMLElement>(TITLE_BAR);
  if (!bar) return [];
  const rect = bar.getBoundingClientRect();
  if (rect.width < 80 || rect.height < 8) return [];
  const center = rect.left + rect.width / 2;
  let left = rect.left;
  let right = rect.right - 12;
  let middle = rect.top + rect.height / 2;
  const controls = [
    ...Array.from(bar.querySelectorAll<HTMLElement>(CONTROLS)),
    ...Array.from(document.querySelectorAll<HTMLElement>(`${PLUGIN_OVERLAYS} :is(${CONTROLS})`)),
  ];
  controls.forEach((control) => {
    if (control.closest(`[${OVERLAY_ATTR}]`)) return;
    const box = control.getBoundingClientRect();
    if (box.width === 0 || box.bottom <= rect.top || box.top >= rect.bottom) return;
    if (box.right <= center) {
      if (box.right > left) middle = box.top + box.height / 2;
      left = Math.max(left, box.right);
    } else right = Math.min(right, box.left);
  });
  left += 16;
  right -= 16;
  const width = right - left;
  if (width < 72) return [];
  const top = Math.round(middle - rect.height / 2);
  return [{ key: "title-bar", top, left, width, height: rect.height }];
}

function sameBands(a: readonly Band[], b: readonly Band[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (band, index) =>
      band.left === b[index]?.left &&
      band.top === b[index]?.top &&
      band.width === b[index]?.width &&
      band.height === b[index]?.height,
  );
}

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

function findTitleBarParts(): Element[] {
  return [document.querySelector(TITLE_BAR), document.querySelector(PLUGIN_OVERLAYS)].filter(
    (element): element is Element => element !== null,
  );
}

const BAR_WATCH: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["class", "style", "hidden"],
};

function useHeaderBands(): readonly Band[] {
  const [bands, setBands] = useState<readonly Band[]>([]);
  useElementWatch(
    findTitleBarParts,
    BAR_WATCH,
    () => {
      const next = measureBands();
      setBands((current) => (sameBands(current, next) ? current : next));
    },
    [],
  );
  return bands;
}

const SIDEBAR_ROW = "[data-chat-row]";
const STRIPE = ".chat-stripe";
const AVATAR = 'span[aria-hidden="true"]';
const FIRST_COLOR = /(rgba?|hsla?|oklch|oklab|color)\([^)]*\)/;

// Chat Sidebar paints the project colour as a bar on the row (some builds)
// or as a gradient avatar (the published 0.2.x). Take the bar's colour, or
// the avatar gradient's first stop.
function rowColor(row: Element): string | null {
  const stripe = row.querySelector<HTMLElement>(STRIPE);
  if (stripe) return getComputedStyle(stripe).backgroundColor || null;
  for (const span of Array.from(row.querySelectorAll<HTMLElement>(AVATAR)).slice(0, 4)) {
    const image = getComputedStyle(span).backgroundImage;
    if (!image.includes("gradient")) continue;
    return FIRST_COLOR.exec(image)?.[0] ?? null;
  }
  return null;
}
const COLORS_KEY = "header-pins:stripe-colors";

// Lane rules mirror Chat Sidebar (lib/status.ts), so the dot matches the sidebar row.
type Lane = "attention" | "working" | "done";
const LANE_COLORS: Record<Lane, string> = { attention: "#e8a317", working: "#3987e5", done: "#1f9d55" };
const ATTENTION_INDICATORS = new Set<string>(["waiting-for-input", "queued-failed", "unread-error"]);
const WORKING_INDICATORS = new Set<string>([
  "runtime",
  "workflow",
  "background-agent",
  "background-command",
  "goal",
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
    activity.workflows + activity.backgroundAgents + activity.backgroundCommands + activity.goals > 0
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

function readColors(): Colors {
  try {
    const raw = localStorage.getItem(COLORS_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return value !== null && typeof value === "object" ? (value as Colors) : {};
  } catch {
    return {};
  }
}

// Chat Sidebar keeps project colours to itself, so the chip copies the colour
// its row is painted with and remembers it for when the row is not mounted.
function useStripeColors(ids: readonly string[]): { colors: Colors; chatSidebar: boolean } {
  const [colors, setColors] = useState<Colors>(readColors);
  const [chatSidebar, setChatSidebar] = useState(readListMode);
  useElementWatch(
    findThreadLists,
    LIST_WATCH,
    () => {
      setChatSidebar((current) => {
        const next = detectChatSidebar(current);
        if (next !== current) writeStored(LIST_MODE_KEY, next ? "1" : "0");
        return next;
      });
      setColors((current) => {
        const next: Record<string, string> = {};
        let changed = Object.keys(current).some((id) => !ids.includes(id));
        for (const id of ids) {
          const row = document.querySelector(`${SIDEBAR_ROW}[data-chat-row="${CSS.escape(id)}"]`);
          const color = (row && rowColor(row)) ?? current[id];
          if (!color) continue;
          next[id] = color;
          if (color !== current[id]) changed = true;
        }
        if (!changed) return current;
        writeStored(COLORS_KEY, JSON.stringify(next));
        return next;
      });
    },
    [ids.join(",")],
  );
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

function HeaderPins() {
  const bands = useHeaderBands();
  const { threads } = experimental_useSidebarThreads();
  const { threadId } = useBbContext();
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
  const { colors, chatSidebar } = useStripeColors(pinnedIds);
  const lanes = useMemo(() => treeLanes(threads, new Set(pinnedIds)), [threads, pinnedIds]);

  if (bands.length === 0) return null;

  return (
    <>
      <style>{CHIP_CSS}</style>
      {bands.map((band) => (
        <div
          key={band.key}
          {...{ [OVERLAY_ATTR]: "" }}
          style={{
            position: "fixed",
            top: band.top,
            left: band.left,
            width: band.width,
            height: band.height,
            display: "flex",
            alignItems: "center",
            gap: 4,
            overflow: "hidden",
            zIndex: 49,
            pointerEvents: "none",
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
      ))}
    </>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "header-pins",
    component: HeaderPins,
  });
});
