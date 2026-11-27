import { useSyncExternalStore } from "react";
import {
  experimental_Icon as Icon,
  experimental_useThreadActionRegistrations,
} from "@get-bb/plugin-sdk/app";
import { RU } from "./shared";

// What the open-thread capsule shows. Kept in this browser's storage and
// shared live by every pane and the settings page.
export interface CapsuleSettings {
  /** Thread action keys (`<owner>/<id>`) shown as buttons, plus PIN_KEY and MENU_KEY. */
  buttons: readonly string[];
  project: boolean;
  model: boolean;
  branch: boolean;
  status: boolean;
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
    return { buttons, project: flag("project"), model: flag("model"), branch: flag("branch"), status: flag("status") };
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
      <button type="button" className="header-pins-settings-reset" onClick={() => write(DEFAULT_SETTINGS)}>
        {TEXT.reset}
      </button>
    </div>
  );
}
