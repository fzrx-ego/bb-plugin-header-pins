import { useEffect, useRef, useState } from "react";
import { useSdk, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";

// An estimate of how much of the provider's usage window the open thread
// took: its tokens, weighted roughly by API prices so cache reads count for
// little, divided by the tokens one percent of the window holds. Reads only
// the open thread: its latest usage events and the provider's window.

export type WindowKind = "session" | "week";

export interface ThreadUsage {
  /**
   * Estimated share of the scale, in percent; may pass 100. The scale is the
   * five-hour window, or a day's share (a seventh) of a weekly window, where a
   * single thread would barely show.
   */
  percent: number;
  kind: WindowKind;
  rawTokens: number;
  weightedTokens: number;
  /** Weighted tokens one percent of the window holds, as used for `percent`. */
  perPercent: number;
  calibrated: boolean;
}

interface Totals {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
}

// Output weight against an uncached input token, from API list prices.
const OUTPUT_WEIGHT: Readonly<Record<string, number>> = { "claude-code": 5, codex: 8 };
const DEFAULT_OUTPUT_WEIGHT = 5;

// Weighted tokens in one percent of a window, measured on real accounts:
// Claude Team's five-hour session and Codex's week.
export const DEFAULT_PER_PERCENT: Readonly<Record<string, number>> = {
  "claude-code:session": 80_000,
  "codex:week": 3_400_000,
};

const DAYS_PER_WEEK = 7;
const REFRESH_MS = 15_000;
const LIMITS_TTL_MS = 60_000;
const CALIBRATION_KEY = "header-pins:usage-calibration";
const CALIBRATION_EVENT = "header-pins:usage-calibration-change";

function weigh(totals: Totals, providerId: string): number {
  // Codex counts cached tokens inside input, Claude Code apart from it; the
  // total minus cached and output is the uncached input either way.
  const uncached = Math.max(0, totals.totalTokens - totals.cachedInputTokens - totals.outputTokens);
  const cacheRead = totals.cacheReadInputTokens ?? totals.cachedInputTokens;
  const cacheWrite = totals.cacheWriteInputTokens ?? 0;
  const output = OUTPUT_WEIGHT[providerId] ?? DEFAULT_OUTPUT_WEIGHT;
  return uncached + cacheRead * 0.1 + cacheWrite * 1.25 + totals.outputTokens * output;
}

// bb tags windows "five-hour" or "weekly"; older hosts only label them.
function windowKind(kind: unknown, label: string): WindowKind | null {
  if (kind === "five-hour") return "session";
  if (kind === "weekly") return "week";
  if (/week/iu.test(label)) return "week";
  if (/session|5\s*h|hour/iu.test(label)) return "session";
  return null;
}

interface WindowReading {
  kind: WindowKind;
  usedPercent: number;
  resetsAt: string | null;
}

type Sdk = ReturnType<typeof useSdk>;

// The shortest window the provider reports, cached for every capsule.
const limits = new Map<string, { at: number; request: Promise<WindowReading | null> }>();

function readWindow(sdk: Sdk, providerId: string): Promise<WindowReading | null> {
  const cached = limits.get(providerId);
  if (cached !== undefined && Date.now() - cached.at < LIMITS_TTL_MS) return cached.request;
  const request = sdk.system
    .usageLimits({ providerId })
    .then((result) => {
      const entry = result[providerId];
      if (entry === undefined || entry.status !== "ok") return null;
      const windows = entry.windows
        .map((window) => ({
          kind: windowKind((window as { kind?: unknown }).kind, window.label),
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt,
        }))
        .filter((window): window is WindowReading => window.kind !== null);
      return windows.find((window) => window.kind === "session") ?? windows.find((window) => window.kind === "week") ?? null;
    })
    .catch(() => null);
  limits.set(providerId, { at: Date.now(), request });
  return request;
}

// Calibration: while only the open thread of a provider works, the window's
// growth belongs to it, so its weighted tokens over that growth give the size
// of one percent. Kept in this browser's storage per provider and window.
interface Baseline {
  threadId: string;
  weighted: number;
  usedPercent: number;
  resetsAt: string | null;
  at: number;
}

interface CalibrationEntry {
  perPercent: number;
  samples: number;
  baseline: Baseline | null;
}

type Calibration = Record<string, CalibrationEntry>;

function loadCalibration(): Calibration {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return value !== null && typeof value === "object" ? (value as Calibration) : {};
  } catch {
    return {};
  }
}

function saveCalibration(calibration: Calibration) {
  try {
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration));
  } catch {
    // Not remembered; the defaults stand.
  }
  window.dispatchEvent(new Event(CALIBRATION_EVENT));
}

export function readCalibration(): Readonly<Record<string, { perPercent: number; samples: number }>> {
  const calibration = loadCalibration();
  const result: Record<string, { perPercent: number; samples: number }> = {};
  for (const [key, entry] of Object.entries(calibration)) {
    if (entry.samples > 0) result[key] = { perPercent: entry.perPercent, samples: entry.samples };
  }
  return result;
}

export function resetCalibration() {
  saveCalibration({});
}

export const CALIBRATION_CHANGE_EVENT = CALIBRATION_EVENT;

const MIN_GROWTH = 2;
const SMOOTHING = 0.3;

function calibrate(
  key: string,
  fallback: number,
  thread: PluginSidebarThread,
  weighted: number,
  reading: WindowReading,
  others: readonly PluginSidebarThread[],
): CalibrationEntry {
  const calibration = loadCalibration();
  const entry: CalibrationEntry = calibration[key] ?? { perPercent: fallback, samples: 0, baseline: null };
  const now = Date.now();
  const current: Baseline = { threadId: thread.id, weighted, usedPercent: reading.usedPercent, resetsAt: reading.resetsAt, at: now };
  const base = entry.baseline;
  const alone =
    base !== null &&
    !others.some((other) => other.id !== thread.id && other.providerId === thread.providerId && other.updatedAt > base.at);
  if (base === null || base.threadId !== thread.id || base.resetsAt !== reading.resetsAt || !alone) {
    entry.baseline = current;
  } else {
    const growth = reading.usedPercent - base.usedPercent;
    const spent = weighted - base.weighted;
    if (growth < 0 || spent < 0) {
      entry.baseline = current;
    } else if (growth >= MIN_GROWTH && spent > 0) {
      const sample = Math.min(Math.max(spent / growth, fallback / 5), fallback * 5);
      entry.perPercent = entry.samples === 0 ? (fallback + sample) / 2 : entry.perPercent * (1 - SMOOTHING) + sample * SMOOTHING;
      entry.samples += 1;
      entry.baseline = current;
    }
  }
  calibration[key] = entry;
  saveCalibration(calibration);
  return entry;
}

async function readThreadTotals(sdk: Sdk, threadId: string, signal: AbortSignal): Promise<Totals[]> {
  const events = await sdk.threads.events.list({
    threadId,
    types: ["thread/tokenUsage/updated"],
    order: "desc",
    limit: "100",
    signal,
  });
  // Totals are cumulative per provider session; the newest one per session counts.
  const sessions = new Map<string, Totals>();
  for (const event of events) {
    const data = event.data as { providerThreadId?: unknown; tokenUsage?: { total?: Totals } } | null;
    const session = typeof data?.providerThreadId === "string" ? data.providerThreadId : "";
    const total = data?.tokenUsage?.total;
    if (total === undefined || sessions.has(session)) continue;
    sessions.set(session, total);
  }
  return [...sessions.values()];
}

/** The open thread's estimated share of its provider's usage window, or null without data. */
export function useThreadUsage(
  thread: PluginSidebarThread | undefined,
  threads: readonly PluginSidebarThread[],
  enabled: boolean,
  manualPerPercent: Readonly<Record<string, number>>,
): ThreadUsage | null {
  const sdk = useSdk();
  const [usage, setUsage] = useState<ThreadUsage | null>(null);
  const lastRun = useRef(0);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const threadRef = useRef(thread);
  threadRef.current = thread;

  const threadId = thread?.id;
  const providerId = thread?.providerId;
  // The thread's row changes when it works or finishes: the only refresh signal.
  const updatedAt = thread?.updatedAt;
  const status = thread?.status;
  const manual = providerId === undefined ? undefined : manualPerPercent[providerId];

  useEffect(() => {
    setUsage(null);
    lastRun.current = 0;
  }, [threadId]);

  useEffect(() => {
    if (!enabled || threadId === undefined || providerId === undefined) {
      setUsage(null);
      return;
    }
    const controller = new AbortController();
    const run = async () => {
      lastRun.current = Date.now();
      try {
        const [totals, reading] = await Promise.all([
          readThreadTotals(sdk, threadId, controller.signal),
          readWindow(sdk, providerId),
        ]);
        if (controller.signal.aborted) return;
        const current = threadRef.current;
        if (totals.length === 0 || reading === null || current === undefined) {
          setUsage(null);
          return;
        }
        const weighted = totals.reduce((sum, item) => sum + weigh(item, providerId), 0);
        const rawTokens = totals.reduce((sum, item) => sum + item.totalTokens, 0);
        const key = `${providerId}:${reading.kind}`;
        const fallback = DEFAULT_PER_PERCENT[key];
        let perPercent: number | undefined;
        let calibrated = false;
        if (manual !== undefined && manual > 0) {
          perPercent = manual;
        } else if (fallback !== undefined) {
          const entry = calibrate(key, fallback, current, weighted, reading, threadsRef.current);
          perPercent = entry.perPercent;
          calibrated = entry.samples > 0;
        }
        if (perPercent === undefined) {
          setUsage(null);
          return;
        }
        const share = weighted / perPercent;
        setUsage({ percent: reading.kind === "week" ? share * DAYS_PER_WEEK : share, kind: reading.kind, rawTokens, weightedTokens: weighted, perPercent, calibrated });
      } catch {
        // Keeps the last reading; the next change tries again.
      }
    };
    const wait = Math.max(0, lastRun.current + REFRESH_MS - Date.now());
    const timer = window.setTimeout(() => void run(), wait);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [sdk, enabled, threadId, providerId, updatedAt, status, manual]);

  return usage;
}
