import { useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useBbNavigate,
  useSdk,
  experimental_Icon as Icon,
  type PluginSidebarThread,
  type ExperimentalThreadHeaderTitleProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { CurrentThreadPill } from "./current-pill";
import {
  LANE_COLORS,
  PROVIDER_COLORS,
  RU,
  SIDEBAR_ROW,
  treeLanes,
  useStripeColors,
  type Lane,
} from "./shared";

const PINS_ATTR = "data-header-pins";

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
  const { colors, chatSidebar } = useStripeColors(pinned, threads, projects);
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
  app.slots.experimental_threadHeaderRow({
    id: "current-thread",
    component: CurrentThreadPill,
  });
});
