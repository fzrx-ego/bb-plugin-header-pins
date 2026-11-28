import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  experimental_Icon as Icon,
  experimental_ProviderIcon as ProviderIcon,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadActionsMenu as ThreadActionsMenu,
  experimental_useProviders,
  experimental_useSidebarThreads,
  experimental_useThreadActionRegistrations,
  experimental_useThreadActions,
  useSdk,
  type ExperimentalThreadHeaderRowProps,
  type PluginSidebarThread,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { MENU_KEY, PIN_KEY, useCapsuleSettings } from "./capsule-settings";
import { useThreadModel } from "./thread-model";
import { useThreadUsage } from "./thread-usage";
import { LANE_COLORS, PROVIDER_COLORS, RU, laneOf, treeLanes, useStripeColors, type Lane } from "./shared";

const TEXT = RU
  ? {
      label: "Открытый тред",
      actions: "Действия треда",
      pin: "Закрепить в шапке",
      unpin: "Открепить из шапки",
      pinFailed: "Не удалось закрепить тред",
      unpinFailed: "Не удалось открепить тред",
      waiting: "ждёт ответа",
      failedSend: "сообщение не отправлено",
      error: "ошибка",
      working: "работает",
      childWaiting: "подтред ждёт ответа",
      childWorking: "подтред работает",
      done: "готово",
      updated: "обновлён",
      justNow: "только что",
    }
  : {
      label: "Open thread",
      actions: "Thread actions",
      pin: "Pin to header",
      unpin: "Unpin from header",
      pinFailed: "Couldn't pin the thread",
      unpinFailed: "Couldn't unpin the thread",
      waiting: "waiting for you",
      failedSend: "message not sent",
      error: "error",
      working: "working",
      childWaiting: "sub-thread waiting",
      childWorking: "sub-thread working",
      done: "done",
      updated: "updated",
      justNow: "just now",
    };

const RELATIVE = new Intl.RelativeTimeFormat(RU ? "ru" : "en", { numeric: "auto" });

function relativeTime(at: number, now: number): string {
  const seconds = Math.round((at - now) / 1000);
  if (seconds > -60) return TEXT.justNow;
  const minutes = Math.round(seconds / 60);
  if (minutes > -60) return RELATIVE.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours > -24) return RELATIVE.format(hours, "hour");
  return RELATIVE.format(Math.round(hours / 24), "day");
}

// "was online 53 minutes ago" in Telegram: what the thread is doing now,
// or when it last changed. Its own state comes first, then its sub-threads'.
function statusLine(thread: PluginSidebarThread, tree: Lane | null, now: number): { text: string; lane: Lane | null } {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") {
    return { text: TEXT.waiting, lane: "attention" };
  }
  if (thread.queuedWork === "failed" || thread.indicator === "queued-failed") {
    return { text: TEXT.failedSend, lane: "attention" };
  }
  if (thread.indicator === "unread-error") return { text: TEXT.error, lane: "attention" };
  const own = laneOf(thread);
  if (own === "working") return { text: TEXT.working, lane: "working" };
  if (tree === "attention") return { text: TEXT.childWaiting, lane: "attention" };
  if (tree === "working") return { text: TEXT.childWorking, lane: "working" };
  if (own === "done") return { text: TEXT.done, lane: "done" };
  return { text: `${TEXT.updated} ${relativeTime(thread.updatedAt, now)}`, lane: null };
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function actionTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  const environmentId = thread.environment?.id ?? null;
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    parentNotifications: thread.parentNotifications,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment: environmentId === null ? null : { id: environmentId, path: thread.environment?.path ?? null },
  };
}

// The capsule floats over the top of the timeline, like a chat header in
// Telegram: a zero-height row keeps the timeline where it was.
const PILL_CSS = `
[data-thread-header-rows]:has(> * > .header-pins-current),
[data-thread-header-rows]:has(> .header-pins-current) {
  position: relative;
  z-index: 30;
}
/* The capsule covers the top 52px of the timeline. The start of the history
   gets room for it, and anything scrolled into view stops below it. */
[data-page-scroll-viewport]:has([data-timeline-row-list]) { scroll-padding-top: 60px; }
[data-page-scroll-viewport] [data-timeline-row-list]:not(:is([data-timeline-row-list] *)) { padding-top: 44px; }
.header-pins-current {
  position: relative;
  z-index: 20;
  height: 0;
  pointer-events: none;
}
.header-pins-current-bar {
  position: absolute;
  top: 8px;
  left: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.header-pins-current-glass {
  pointer-events: auto;
  display: flex;
  align-items: center;
  min-width: 0;
  height: 44px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--border, rgba(128,128,128,0.3)) 80%, transparent);
  background: color-mix(in srgb, var(--background, #fff) 90%, transparent);
  -webkit-backdrop-filter: blur(16px) saturate(1.5);
  backdrop-filter: blur(16px) saturate(1.5);
  box-shadow: var(--shadow-md, 0 4px 14px rgba(0,0,0,0.08));
}
.header-pins-current-main { flex: 1; gap: 10px; padding: 0 16px 0 7px; cursor: default; }
.header-pins-current-actions { flex: none; gap: 2px; padding: 0 5px; }
.header-pins-current-avatar {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
}
.header-pins-current-avatar svg, .header-pins-current-avatar img { width: 16px; height: 16px; }
.header-pins-current-ring {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  pointer-events: none;
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px));
}
.header-pins-current-dot { z-index: 1; }
.header-pins-current-dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 10px;
  height: 10px;
  border-radius: 999px;
  box-shadow: 0 0 0 2px var(--background, #fff);
}
.header-pins-current-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.header-pins-current-title {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.header-pins-current-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  font-size: 11.5px;
  white-space: nowrap;
  color: var(--muted-foreground, currentColor);
}
.header-pins-current-sub > span { overflow: hidden; text-overflow: ellipsis; }
.header-pins-current-sub > span:last-child { flex: none; }
.header-pins-current-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 999px;
  padding: 0;
  background: transparent;
  color: var(--muted-foreground, currentColor);
  cursor: pointer;
}
.header-pins-current-btn:hover,
.header-pins-current-btn[data-state="open"] {
  background: var(--state-hover, rgba(128,128,128,0.15));
  color: var(--foreground, currentColor);
}
.header-pins-current-btn:disabled { opacity: 0.4; cursor: default; background: transparent; }
.header-pins-current-btn[aria-pressed="true"] { color: var(--foreground, currentColor); }
`;

// The right capsule: chosen thread actions in menu order, then pin and the
// thread menu. Without anything to show it takes no room.
function ActionsCapsule({ thread, target }: { thread: PluginSidebarThread; target: PluginThreadActionTarget }) {
  const settings = useCapsuleSettings();
  const sdk = useSdk();
  const registrations = experimental_useThreadActionRegistrations();
  const keys = useMemo(() => {
    const chosen = new Set(settings.buttons);
    return registrations.map((registration) => registration.key).filter((key) => chosen.has(key));
  }, [registrations, settings.buttons]);
  const entries = experimental_useThreadActions(target, { keys });
  const showPin = settings.buttons.includes(PIN_KEY);
  const showMenu = settings.buttons.includes(MENU_KEY);
  const quick = entries.filter((entry) => entry.action.choices === undefined);
  if (quick.length === 0 && !showPin && !showMenu) return null;

  const togglePin = () => {
    const request = thread.isPinned ? sdk.threads.unpin({ threadId: thread.id }) : sdk.threads.pin({ threadId: thread.id });
    request.catch((cause: unknown) => {
      toast.error(thread.isPinned ? TEXT.unpinFailed : TEXT.pinFailed, {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    });
  };

  return (
    <div className="header-pins-current-glass header-pins-current-actions">
      {quick.map((entry) => (
        <button
          key={entry.key}
          type="button"
          className="header-pins-current-btn"
          title={entry.action.label}
          aria-label={entry.action.label}
          disabled={entry.action.disabled}
          onClick={() => void entry.action.run()}
        >
          <Icon name={entry.action.icon} fallback="Circle" className="size-4" />
        </button>
      ))}
      {showPin ? (
        <button
          type="button"
          className="header-pins-current-btn"
          title={thread.isPinned ? TEXT.unpin : TEXT.pin}
          aria-label={thread.isPinned ? TEXT.unpin : TEXT.pin}
          aria-pressed={thread.isPinned}
          onClick={togglePin}
        >
          <Icon name={thread.isPinned ? "PinOff" : "Pin"} className="size-4" />
        </button>
      ) : null}
      {showMenu ? (
        <ThreadActionsMenu
          thread={target}
          align="end"
          sideOffset={6}
          trigger={(props) => (
            <button
              type="button"
              {...props}
              className="header-pins-current-btn"
              title={TEXT.actions}
              aria-label={TEXT.actions}
            >
              <Icon name="MoreHorizontal" className="size-4" />
            </button>
          )}
        />
      ) : null}
    </div>
  );
}

export function CurrentThreadPill({ threadId }: ExperimentalThreadHeaderRowProps) {
  const settings = useCapsuleSettings();
  const { threads, projects } = experimental_useSidebarThreads();
  const { providers } = experimental_useProviders();
  const now = useNow(30_000);
  const thread = useMemo(() => threads.find((candidate) => candidate.id === threadId), [threads, threadId]);
  const model = useThreadModel(thread, settings.model);
  const usage = useThreadUsage(thread, threads, settings.usage, settings.perPercent);
  const own = useMemo(() => (thread === undefined ? [] : [thread]), [thread]);
  const { colors, chatSidebar } = useStripeColors(own, threads, projects);
  const tree = useMemo(
    () => (thread === undefined ? null : treeLanes(threads, new Set([thread.id])).get(thread.id) ?? null),
    [threads, thread],
  );
  if (thread === undefined || thread.isHidden) return null;

  const project = projects.find((candidate) => candidate.id === thread.projectId);
  const provider = providers.find((candidate) => candidate.id === thread.providerId) ?? { id: thread.providerId };
  const color = (chatSidebar ? colors[thread.id] : PROVIDER_COLORS[thread.providerId]) ?? "var(--muted-foreground, #888)";
  const status = statusLine(thread, tree, now);
  const dot = tree ?? status.lane;
  const branch = thread.environment?.branchName ?? null;

  const target = actionTarget(thread);
  const arc =
    usage === null
      ? null
      : usage.percent >= settings.usageAlert
        ? "#dc2626"
        : usage.percent >= settings.usageWarn
          ? "#d97706"
          : color;
  const filled = usage === null ? 0 : Math.min(100, Math.max(usage.percent, 4));
  const subtitle: { key: string; node: ReactNode }[] = [];
  if (settings.project && project !== undefined) subtitle.push({ key: "project", node: <span>{project.name}</span> });
  if (settings.model && model !== null) subtitle.push({ key: "model", node: <span>{model}</span> });
  if (settings.branch && branch !== null) {
    subtitle.push({
      key: "branch",
      node: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
          <Icon name="GitBranch" style={{ width: 11, height: 11, flex: "none" }} aria-hidden />
          {branch}
        </span>
      ),
    });
  }
  if (settings.status) {
    subtitle.push({
      key: "status",
      node: (
        <span style={status.lane === null ? undefined : { color: LANE_COLORS[status.lane], fontWeight: 500 }}>
          {status.text}
        </span>
      ),
    });
  }

  return (
    <div className="header-pins-current" role="region" aria-label={TEXT.label}>
      <style>{PILL_CSS}</style>
      <div className="header-pins-current-bar">
        <ThreadActionsContextMenu thread={target}>
          <div className="header-pins-current-glass header-pins-current-main" title={thread.displayTitle}>
            <span
              className="header-pins-current-avatar"
              style={{
                background: `color-mix(in srgb, ${color} 22%, var(--background, #fff))`,
                boxShadow: arc === null ? `inset 0 0 0 1.5px color-mix(in srgb, ${color} 55%, transparent)` : undefined,
              } as CSSProperties}
            >
              {arc === null ? null : (
                <span
                  className="header-pins-current-ring"
                  style={{
                    background: `conic-gradient(${arc} 0 ${filled}%, color-mix(in srgb, ${color} 30%, var(--background, #fff)) ${filled}% 100%)`,
                  }}
                  aria-hidden
                />
              )}
              <ProviderIcon providerKind="agent" provider={provider} aria-hidden />
              {dot === null ? null : <span className="header-pins-current-dot" style={{ background: LANE_COLORS[dot] }} />}
            </span>
            <span className="header-pins-current-text">
              <span className="header-pins-current-title">{thread.displayTitle}</span>
              {subtitle.length === 0 ? null : (
                <span className="header-pins-current-sub">
                  {subtitle.map((part, index) => (
                    <Fragment key={part.key}>
                      {index === 0 ? null : <span aria-hidden>·</span>}
                      {part.node}
                    </Fragment>
                  ))}
                </span>
              )}
            </span>
          </div>
        </ThreadActionsContextMenu>
        <ActionsCapsule thread={thread} target={target} />
      </div>
    </div>
  );
}
