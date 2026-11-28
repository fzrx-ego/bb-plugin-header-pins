import { useEffect, useState, useSyncExternalStore } from "react";
import {
  experimental_Icon as Icon,
  experimental_useThreadActionRegistrations,
} from "@get-bb/plugin-sdk/app";
import { RU } from "./shared";
import { CALIBRATION_CHANGE_EVENT, DEFAULT_PER_PERCENT, readCalibration, resetCalibration } from "./thread-usage";

// What the open-thread capsule shows. Kept in this browser's storage and
// shared live by every pane and the settings page.
export interface CapsuleSettings {
  /** Thread action keys (`<owner>/<id>`) shown as buttons, plus PIN_KEY and MENU_KEY. */
  buttons: readonly string[];
  project: boolean;
  model: boolean;
  branch: boolean;
  status: boolean;
  /** The ring around the provider icon: the thread's estimated share of its usage window. */
  usage: boolean;
  /** Percent of the window from which the ring turns amber, and red. */
  usageWarn: number;
  usageAlert: number;
  /** Weighted tokens per percent of the window, set by hand per provider; overrides calibration. */
  perPercent: Readonly<Record<string, number>>;
}

export const PIN_KEY = "header-pins/pin";
export const MENU_KEY = "header-pins/menu";
const CORE_OWNER = "bb--core";
const CORE_PIN_KEY = "bb--core/pin";

export const DEFAULT_SETTINGS: CapsuleSettings = {
  buttons: ["chat-sidebar/new-subthread", "chat-sidebar/park", PIN_KEY, MENU_KEY],
  project: true,
  model: true,
  branch: true,
  status: true,
  usage: true,
  usageWarn: 10,
  usageAlert: 25,
  perPercent: {},
};

type SubtitlePart = "project" | "model" | "branch" | "status";

const STORAGE_KEY = "header-pins:capsule";
const CHANGE_EVENT = "header-pins:capsule-change";

function parse(raw: string | null): CapsuleSettings {
  if (raw === null) return DEFAULT_SETTINGS;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return DEFAULT_SETTINGS;
    const record = value as Record<string, unknown>;
    const buttons = Array.isArray(record.buttons)
      ? record.buttons.filter((key): key is string => typeof key === "string")
      : DEFAULT_SETTINGS.buttons;
    const flag = (name: SubtitlePart) =>
      typeof record[name] === "boolean" ? (record[name] as boolean) : DEFAULT_SETTINGS[name];
    const number = (name: "usageWarn" | "usageAlert") =>
      typeof record[name] === "number" && Number.isFinite(record[name]) ? (record[name] as number) : DEFAULT_SETTINGS[name];
    const perPercent: Record<string, number> = {};
    if (record.perPercent !== null && typeof record.perPercent === "object") {
      for (const [key, item] of Object.entries(record.perPercent as Record<string, unknown>)) {
        if (typeof item === "number" && Number.isFinite(item) && item > 0) perPercent[key] = item;
      }
    }
    return {
      buttons,
      project: flag("project"),
      model: flag("model"),
      branch: flag("branch"),
      status: flag("status"),
      usage: typeof record.usage === "boolean" ? record.usage : DEFAULT_SETTINGS.usage,
      usageWarn: number("usageWarn"),
      usageAlert: number("usageAlert"),
      perPercent,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let cachedRaw: string | null | undefined;
let cached: CapsuleSettings = DEFAULT_SETTINGS;

function read(): CapsuleSettings {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Without storage the defaults stand.
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parse(raw);
  }
  return cached;
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function useCapsuleSettings(): CapsuleSettings {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_SETTINGS);
}

function write(next: CapsuleSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not remembered; the capsule keeps its current buttons.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

const TEXT = RU
  ? {
      buttons: "Кнопки",
      buttonsHint: "Действия из меню треда, которые стоят в капсуле справа. Кнопка появляется, только если действие доступно для открытого треда. Действия с подменю (уведомления, раздел, папка) остаются в меню «…».",
      pin: "Закрепить в шапке",
      menu: "Меню треда (…)",
      menuHint: "Остальные действия; правый клик по капсуле открывает то же меню",
      subtitle: "Вторая строка",
      project: "Проект",
      model: "Модель и уровень reasoning",
      branch: "Ветка",
      status: "Статус треда",
      reset: "Вернуть по умолчанию",
      usage: "Кольцо расхода",
      usageHint: "Кольцо вокруг иконки провайдера: примерная доля этого треда в лимите: от пятичасового окна у Claude, от дневной нормы (седьмой части недели) у Codex. Токены взвешены по ценам API, чтение кэша почти не считается. Треды без данных о расходе, например Cursor, остаются без кольца.",
      usageOn: "Показывать кольцо",
      warn: "Жёлтое с, %",
      alert: "Красное с, %",
      perPercent: "1% окна, тыс. взвешенных токенов",
      perPercentHint: "Пусто: значение по умолчанию, уточняется само, пока работает только открытый тред.",
      calibrated: (samples: number) => `уточнено по ${samples} замерам`,
      byDefault: "по умолчанию",
      resetCalibration: "Сбросить уточнение",
    }
  : {
      buttons: "Buttons",
      buttonsHint: "Thread menu actions shown on the right of the capsule. A button appears only when its action applies to the open thread. Actions with a submenu (notifications, section, folder) stay in the … menu.",
      pin: "Pin to header",
      menu: "Thread menu (…)",
      menuHint: "Every other action; right-click the capsule for the same menu",
      subtitle: "Second line",
      project: "Project",
      model: "Model and reasoning level",
      branch: "Branch",
      status: "Thread status",
      reset: "Restore defaults",
      usage: "Usage ring",
      usageHint: "A ring around the provider icon: this thread's rough share of its limit: of the five-hour window for Claude, of a day's share (a seventh of the week) for Codex. Tokens are weighted by API prices, so cache reads barely count. Threads without usage data, such as Cursor, keep a plain ring.",
      usageOn: "Show the ring",
      warn: "Amber from, %",
      alert: "Red from, %",
      perPercent: "1% of the window, thousand weighted tokens",
      perPercentHint: "Empty: the default, refined on its own while only the open thread works.",
      calibrated: (samples: number) => `refined over ${samples} readings`,
      byDefault: "default",
      resetCalibration: "Reset refinement",
    };

const SETTINGS_CSS = `
.header-pins-settings { display: flex; flex-direction: column; gap: 18px; font-size: 13px; }
.header-pins-settings h4 { margin: 0 0 4px; font-size: 13px; font-weight: 600; }
.header-pins-settings p { margin: 0 0 8px; color: var(--muted-foreground, currentColor); font-size: 12px; }
.header-pins-settings-list { display: flex; flex-direction: column; gap: 2px; }
.header-pins-settings-row {
  display: flex; align-items: center; gap: 10px; min-height: 30px; padding: 0 6px;
  border-radius: 6px; cursor: pointer;
}
.header-pins-settings-row:hover { background: var(--state-hover, rgba(128,128,128,0.1)); }
.header-pins-settings-row input { margin: 0; }
.header-pins-settings-row small { color: var(--muted-foreground, currentColor); }
.header-pins-settings-reset {
  align-self: flex-start; height: 28px; padding: 0 10px; border-radius: 6px;
  border: 1px solid var(--border, rgba(128,128,128,0.3)); background: transparent; color: inherit; cursor: pointer;
}
.header-pins-settings-number { display: flex; align-items: center; gap: 10px; min-height: 30px; padding: 0 6px; }
.header-pins-settings-number input {
  width: 90px; height: 26px; padding: 0 8px; border-radius: 6px;
  border: 1px solid var(--border, rgba(128,128,128,0.3)); background: transparent; color: inherit;
}
.header-pins-settings-number small { color: var(--muted-foreground, currentColor); }
.header-pins-settings-reset:hover { background: var(--state-hover, rgba(128,128,128,0.1)); }
`;

interface Choice {
  key: string;
  title: string;
  icon: string;
  hint?: string;
}

function Row({ choice, checked, onToggle }: { choice: Choice; checked: boolean; onToggle: () => void }) {
  return (
    <label className="header-pins-settings-row" data-key={choice.key}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <Icon name={choice.icon} fallback="Circle" className="size-4" aria-hidden />
      <span>{choice.title}</span>
      {choice.hint === undefined ? null : <small>{choice.hint}</small>}
    </label>
  );
}

export function CapsuleSettingsSection() {
  const settings = useCapsuleSettings();
  const registrations = experimental_useThreadActionRegistrations();
  const choices: Choice[] = [
    // bb's own Pin duplicates the capsule's pin button, which also shows the state.
    ...registrations
      .filter((registration) => registration.key !== CORE_PIN_KEY)
      .map((registration) => ({
        key: registration.key,
        title: registration.title,
        icon: registration.icon,
        hint: registration.pluginId === CORE_OWNER ? undefined : registration.pluginId,
      })),
    { key: PIN_KEY, title: TEXT.pin, icon: "Pin" },
    { key: MENU_KEY, title: TEXT.menu, icon: "MoreHorizontal", hint: TEXT.menuHint },
  ];
  const selected = new Set(settings.buttons);
  const toggle = (key: string) => {
    const buttons = selected.has(key) ? settings.buttons.filter((item) => item !== key) : [...settings.buttons, key];
    write({ ...settings, buttons });
  };
  const flag = (name: SubtitlePart) => write({ ...settings, [name]: !settings[name] });

  return (
    <div className="header-pins-settings">
      <style>{SETTINGS_CSS}</style>
      <section>
        <h4>{TEXT.buttons}</h4>
        <p>{TEXT.buttonsHint}</p>
        <div className="header-pins-settings-list">
          {choices.map((choice) => (
            <Row key={choice.key} choice={choice} checked={selected.has(choice.key)} onToggle={() => toggle(choice.key)} />
          ))}
        </div>
      </section>
      <section>
        <h4>{TEXT.subtitle}</h4>
        <div className="header-pins-settings-list">
          <Row choice={{ key: "project", title: TEXT.project, icon: "Folder" }} checked={settings.project} onToggle={() => flag("project")} />
          <Row choice={{ key: "model", title: TEXT.model, icon: "Sparkles" }} checked={settings.model} onToggle={() => flag("model")} />
          <Row choice={{ key: "branch", title: TEXT.branch, icon: "GitBranch" }} checked={settings.branch} onToggle={() => flag("branch")} />
          <Row choice={{ key: "status", title: TEXT.status, icon: "Circle" }} checked={settings.status} onToggle={() => flag("status")} />
        </div>
      </section>
      <UsageSection settings={settings} />
      <button type="button" className="header-pins-settings-reset" onClick={() => write(DEFAULT_SETTINGS)}>
        {TEXT.reset}
      </button>
    </div>
  );
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex" };

function useCalibration() {
  const [value, setValue] = useState(readCalibration);
  useEffect(() => {
    const update = () => setValue(readCalibration());
    window.addEventListener(CALIBRATION_CHANGE_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(CALIBRATION_CHANGE_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return value;
}

function UsageSection({ settings }: { settings: CapsuleSettings }) {
  const calibration = useCalibration();
  const setNumber = (name: "usageWarn" | "usageAlert", raw: string) => {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) write({ ...settings, [name]: value });
  };
  const setPerPercent = (providerId: string, raw: string) => {
    const next = { ...settings.perPercent };
    const value = Number(raw.replace(",", "."));
    if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) delete next[providerId];
    else next[providerId] = value * 1000;
    write({ ...settings, perPercent: next });
  };
  return (
    <section>
      <h4>{TEXT.usage}</h4>
      <p>{TEXT.usageHint}</p>
      <div className="header-pins-settings-list">
        <Row
          choice={{ key: "usage", title: TEXT.usageOn, icon: "CircleDashed" }}
          checked={settings.usage}
          onToggle={() => write({ ...settings, usage: !settings.usage })}
        />
        <label className="header-pins-settings-number">
          <input type="number" min={0} value={settings.usageWarn} onChange={(event) => setNumber("usageWarn", event.target.value)} />
          <span>{TEXT.warn}</span>
        </label>
        <label className="header-pins-settings-number">
          <input type="number" min={0} value={settings.usageAlert} onChange={(event) => setNumber("usageAlert", event.target.value)} />
          <span>{TEXT.alert}</span>
        </label>
        {Object.entries(DEFAULT_PER_PERCENT).map(([key, fallback]) => {
          const providerId = key.split(":")[0] ?? key;
          const auto = calibration[key];
          const shown = auto?.perPercent ?? fallback;
          const manual = settings.perPercent[providerId];
          return (
            <label key={key} className="header-pins-settings-number">
              <input
                type="number"
                min={0}
                placeholder={String(Math.round(shown / 1000))}
                value={manual === undefined ? "" : Math.round(manual / 1000)}
                onChange={(event) => setPerPercent(providerId, event.target.value)}
              />
              <span>
                {PROVIDER_NAMES[providerId] ?? providerId}: {TEXT.perPercent}
              </span>
              <small>{auto === undefined ? TEXT.byDefault : TEXT.calibrated(auto.samples)}</small>
            </label>
          );
        })}
        <p>{TEXT.perPercentHint}</p>
      </div>
      <button type="button" className="header-pins-settings-reset" onClick={resetCalibration}>
        {TEXT.resetCalibration}
      </button>
    </section>
  );
}
