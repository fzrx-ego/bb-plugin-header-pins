import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./rpc";
import { readSessionTotals, SUPPORTED_PROVIDERS } from "./usage-reader";

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    // Called only by the open thread's capsule, at most every 15 seconds.
    thread_usage: async ({ threadId, providerId }) => {
      if (!SUPPORTED_PROVIDERS.has(providerId)) return null;
      const events = await bb.sdk.threads.events.list({
        threadId,
        types: ["thread/identity"],
        order: "desc",
        limit: "100",
      });
      const sessionIds = new Set<string>();
      for (const event of events) {
        const id = (event.data as { providerThreadId?: unknown } | null)?.providerThreadId;
        if (typeof id === "string" && id !== "") sessionIds.add(id);
      }
      if (sessionIds.size === 0) return null;
      const sessions = await readSessionTotals(providerId, [...sessionIds]);
      return sessions === null ? null : { sessions };
    },
  });
  bb.log.info("loaded");
  return () => {
    bb.log.info("disposed");
  };
}
