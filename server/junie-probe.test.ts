import { describe, expect, test } from "vitest";
import {
  type JunieProbeAdapters,
  JunieProbeError,
  probeJunieQuota,
} from "./junie-probe.server";

function createMockAdapters(options: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  files?: Record<string, string>;
  directories?: Record<string, string[]>;
  stats?: Record<string, { mtimeMs?: number; isDirectory?: boolean }>;
}): JunieProbeAdapters {
  const homeDir = options.homeDir ?? "/home/tester";
  const env = options.env ?? {};
  const files = options.files ?? {};
  const directories = options.directories ?? {};
  const stats = options.stats ?? {};

  return {
    homeDir,
    env,
    readFile(path: string): string | null {
      return files[path] ?? null;
    },
    readDir(path: string): string[] {
      return directories[path] ?? [];
    },
    stat(path: string): { mtimeMs: number; isDirectory(): boolean } | null {
      const explicit = stats[path];
      if (explicit) {
        return {
          mtimeMs: explicit.mtimeMs ?? 1000,
          isDirectory: () => explicit.isDirectory ?? true,
        };
      }
      if (directories[path] !== undefined) {
        return {
          mtimeMs: 1000,
          isDirectory: () => true,
        };
      }
      if (files[path] !== undefined) {
        return {
          mtimeMs: 1000,
          isDirectory: () => false,
        };
      }
      return null;
    },
  };
}

function junieEvent(modelUsage: { inputTokens?: number; outputTokens?: number }[], timestampMs = 1787746500000) {
  return JSON.stringify({
    kind: "SessionA2uxEvent",
    event: {
      state: "IN_PROGRESS",
      agentEvent: {
        kind: "LlmResponseMetadataEvent",
        modelUsage: modelUsage.map((u) => ({
          model: "gpt-4.1",
          inputTokens: u.inputTokens ?? 100,
          outputTokens: u.outputTokens ?? 20,
        })),
      },
    },
    timestampMs,
  });
}

describe("probeJunieQuota", () => {
  test("returns active balance (100%) and token count for an active account with recent session", async () => {
    const homeDir = "/home/tester";
    const adapters = createMockAdapters({
      homeDir,
      files: {
        [`${homeDir}/.junie/secure_credentials.json`]: JSON.stringify({ ast_token: "secret_123" }),
        [`${homeDir}/.junie/sessions/s1/events.jsonl`]: [
          junieEvent([{ inputTokens: 1500, outputTokens: 300 }], 1787746100000),
          junieEvent([{ inputTokens: 200, outputTokens: 100 }], 1787746500000),
        ].join("\n"),
        [`${homeDir}/.junie/sessions/s0/events.jsonl`]: junieEvent([{ inputTokens: 50, outputTokens: 10 }]),
      },
      directories: {
        [`${homeDir}/.junie/sessions`]: ["s0", "s1"],
      },
      stats: {
        [`${homeDir}/.junie/sessions/s0`]: { mtimeMs: 1000, isDirectory: true },
        [`${homeDir}/.junie/sessions/s1`]: { mtimeMs: 2000, isDirectory: true },
      },
    });

    const summary = await probeJunieQuota(adapters);

    expect(summary).toEqual({
      source: "junie",
      status: "ok",
      notice: null,
      plan: "JetBrains AI",
      balance: { status: "active", percent: 100 },
      usage: { sessionTokens: 2100, lastActiveMs: 1787746500000 },
    });
  });

  test("returns 0% balance and notice when session ended with ExitPaymentRequired / insufficient balance", async () => {
    const homeDir = "/home/tester";
    const adapters = createMockAdapters({
      homeDir,
      files: {
        [`${homeDir}/.junie/secure_credentials.json`]: JSON.stringify({ ast_token: "secret_123" }),
        [`${homeDir}/.junie/sessions/s1/events.jsonl`]: [
          junieEvent([{ inputTokens: 800, outputTokens: 200 }], 1787746000000),
          JSON.stringify({
            kind: "SessionA2uxEvent",
            event: {
              state: "ERROR",
              kind: "ExitPaymentRequired",
              message: "Junie: Insufficient account balance. All tokens in your account have been spent.",
            },
            timestampMs: 1787746100000,
          }),
        ].join("\n"),
      },
      directories: {
        [`${homeDir}/.junie/sessions`]: ["s1"],
      },
      stats: {
        [`${homeDir}/.junie/sessions/s1`]: { mtimeMs: 2000, isDirectory: true },
      },
    });

    const summary = await probeJunieQuota(adapters);

    expect(summary).toEqual({
      source: "junie",
      status: "ok",
      notice: "Insufficient account balance (all tokens spent)",
      plan: "JetBrains AI",
      balance: { status: "insufficient_balance", percent: 0 },
      usage: { sessionTokens: 1000, lastActiveMs: 1787746100000 },
    });
  });

  test("detects INSUFFICIENT_ACCOUNT_BALANCE string in failure event", async () => {
    const homeDir = "/home/tester";
    const adapters = createMockAdapters({
      homeDir,
      files: {
        [`${homeDir}/.junie/secure_credentials.json`]: JSON.stringify({ ast_token: "secret_123" }),
        [`${homeDir}/.junie/sessions/s1/events.jsonl`]: [
          junieEvent([{ inputTokens: 300, outputTokens: 50 }], 1787746000000),
          JSON.stringify({
            error: "INSUFFICIENT_ACCOUNT_BALANCE",
            timestampMs: 1787746200000,
          }),
        ].join("\n"),
      },
      directories: {
        [`${homeDir}/.junie/sessions`]: ["s1"],
      },
      stats: {
        [`${homeDir}/.junie/sessions/s1`]: { mtimeMs: 2000, isDirectory: true },
      },
    });

    const summary = await probeJunieQuota(adapters);

    expect(summary.balance).toEqual({ status: "insufficient_balance", percent: 0 });
    expect(summary.notice).toBe("Insufficient account balance (all tokens spent)");
    expect(summary.usage.sessionTokens).toBe(350);
  });

  test("throws JunieProbeError when Junie is not installed or configured", async () => {
    const adapters = createMockAdapters({
      homeDir: "/home/tester",
      files: {},
      directories: {},
      stats: {},
    });

    await expect(probeJunieQuota(adapters)).rejects.toThrow(JunieProbeError);
    await expect(probeJunieQuota(adapters)).rejects.toThrow(
      "Junie is not installed or configured on this machine",
    );
  });

  test("honours custom JUNIE_HOME environment override", async () => {
    const customHome = "/opt/custom/junie";
    const adapters = createMockAdapters({
      homeDir: "/home/tester",
      env: { JUNIE_HOME: customHome },
      files: {
        [`${customHome}/secure_credentials.json`]: JSON.stringify({ "jb-account-stored": "true" }),
        [`${customHome}/sessions/session-custom/events.jsonl`]: junieEvent([
          { inputTokens: 500, outputTokens: 150 },
        ]),
      },
      directories: {
        [`${customHome}/sessions`]: ["session-custom"],
      },
      stats: {
        [`${customHome}/sessions/session-custom`]: { mtimeMs: 5000, isDirectory: true },
      },
    });

    const summary = await probeJunieQuota(adapters);

    expect(summary.balance).toEqual({ status: "active", percent: 100 });
    expect(summary.usage.sessionTokens).toBe(650);
  });

  test("handles missing credentials gracefully when sessions exist", async () => {
    const homeDir = "/home/tester";
    const adapters = createMockAdapters({
      homeDir,
      files: {
        [`${homeDir}/.junie/sessions/s1/events.jsonl`]: junieEvent([{ inputTokens: 400, outputTokens: 100 }]),
      },
      directories: {
        [`${homeDir}/.junie/sessions`]: ["s1"],
      },
      stats: {
        [`${homeDir}/.junie/sessions/s1`]: { mtimeMs: 3000, isDirectory: true },
      },
    });

    const summary = await probeJunieQuota(adapters);

    expect(summary.status).toBe("ok");
    expect(summary.balance).toEqual({ status: "active", percent: 100 });
    expect(summary.usage.sessionTokens).toBe(500);
  });

  test("handles empty sessions directory gracefully when credentials exist", async () => {
    const homeDir = "/home/tester";
    const adapters = createMockAdapters({
      homeDir,
      files: {
        [`${homeDir}/.junie/secure_credentials.json`]: JSON.stringify({ ast_token: "token_abc" }),
      },
      directories: {
        [`${homeDir}/.junie/sessions`]: [],
      },
    });

    const summary = await probeJunieQuota(adapters);

    expect(summary).toEqual({
      source: "junie",
      status: "ok",
      notice: null,
      plan: "JetBrains AI",
      balance: { status: "active", percent: 100 },
      usage: { sessionTokens: 0, lastActiveMs: null },
    });
  });
});
