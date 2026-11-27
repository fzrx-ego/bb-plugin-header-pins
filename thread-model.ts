import { useEffect, useState } from "react";
import { useSdk, type PluginSidebarThread } from "@get-bb/plugin-sdk/app";

// The open thread's model and reasoning level, written the way bb's composer
// writes them: "6.2-Sol High", "Opus 5.5 Extra High".

// bb's composer labels for reasoning levels.
const REASONING_LABELS: Record<string, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultracode: "Ultracode",
  max: "Max",
  ultra: "Ultra",
};

function reasoningLabel(level: string): string {
  const known = REASONING_LABELS[level];
  if (known !== undefined) return known;
  return level
    .split(/[\s_-]+/u)
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// The composer drops the vendor prefix: "GPT-6.2-Sol" shows as "6.2-Sol".
function modelLabel(displayName: string): string {
  return displayName.replace(/^(gpt|claude)[\s-]+/iu, "");
}

type Catalog = Map<string, { displayName: string; efforts: Map<string, string> }>;

// One catalog request per provider and environment for the page's lifetime.
const catalogs = new Map<string, Promise<Catalog>>();

function loadCatalog(
  sdk: ReturnType<typeof useSdk>,
  providerId: string,
  environmentId: string | null,
  projectId: string,
): Promise<Catalog> {
  const key = `${providerId}\u0000${environmentId ?? `project:${projectId}`}`;
  let request = catalogs.get(key);
  if (request === undefined) {
    const scope = environmentId === null ? { projectId } : { environmentId };
    request = sdk.providers
      .models({ ...scope, providerId, preferCached: true })
      .then((result) => {
        const catalog: Catalog = new Map();
        for (const model of result.models) {
          const efforts = new Map<string, string>();
          for (const effort of model.supportedReasoningEfforts) {
            if (effort.label !== undefined) efforts.set(effort.reasoningEffort, effort.label);
          }
          catalog.set(model.model, { displayName: model.displayName, efforts });
          if (model.id !== model.model) catalog.set(model.id, { displayName: model.displayName, efforts });
        }
        return catalog;
      })
      .catch(() => {
        catalogs.delete(key);
        return new Map();
      });
    catalogs.set(key, request);
  }
  return request;
}

/** "6.2-Sol High" for the thread's latest turn, or null until it is known. */
export function useThreadModel(thread: PluginSidebarThread | undefined, enabled: boolean): string | null {
  const sdk = useSdk();
  const [label, setLabel] = useState<string | null>(null);
  const threadId = thread?.id;
  const providerId = thread?.providerId;
  const projectId = thread?.projectId;
  const environmentId = thread?.environment?.id ?? null;
  // A new turn can switch the model; status changes mark turn boundaries.
  const status = thread?.status;

  useEffect(() => {
    if (!enabled || threadId === undefined || providerId === undefined || projectId === undefined) {
      setLabel(null);
      return;
    }
    const controller = new AbortController();
    let live = true;
    void (async () => {
      try {
        const options = await sdk.threads.defaultExecutionOptions({ threadId, signal: controller.signal });
        if (!live) return;
        if (options === null) {
          setLabel(null);
          return;
        }
        const catalog = await loadCatalog(sdk, providerId, environmentId, projectId);
        if (!live) return;
        const entry = catalog.get(options.model);
        const name = modelLabel(entry?.displayName ?? options.model);
        const effort = entry?.efforts.get(options.reasoningLevel) ?? reasoningLabel(options.reasoningLevel);
        setLabel(effort === "" ? name : `${name} ${effort}`);
      } catch {
        // The thread keeps its other parts; the model just stays hidden.
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [sdk, enabled, threadId, providerId, projectId, environmentId, status]);

  return label;
}
