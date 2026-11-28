import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const totalsSchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheWriteInputTokens: z.number(),
  outputTokens: z.number(),
});

export type SessionTotals = z.infer<typeof totalsSchema>;

export const rpcContract = defineRpcContract({
  /**
   * A thread's whole token use from its provider's own session logs on this
   * machine: Claude Code with its subagents, or Codex. Null when the provider
   * keeps no log here, so the caller falls back to bb's own usage events.
   */
  thread_usage: {
    input: z.object({ threadId: z.string(), providerId: z.string() }),
    output: z.object({ sessions: z.array(totalsSchema) }).nullable(),
  },
});
