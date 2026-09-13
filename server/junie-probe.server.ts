import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface JunieProbeAdapters {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  readFile(path: string): string | null;
  readDir(path: string): string[];
  stat(path: string): { mtimeMs: number; isDirectory(): boolean } | null;
}

export class JunieProbeError extends Error {}

export interface JunieBalance {
  status: "active" | "insufficient_balance" | string;
  percent: number;
}

export interface JunieUsage {
  sessionTokens: number;
  lastActiveMs?: number | null;
}

export interface JunieQuotaSummary {
  source: string;
  status: string;
  notice: string | null;
  plan: string;
  balance: JunieBalance;
  usage: JunieUsage;
}

export function createNodeJunieProbeAdapters(): JunieProbeAdapters {
  return {
    homeDir: homedir(),
    env: process.env,
    readFile(path: string): string | null {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    readDir(path: string): string[] {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    stat(path: string): { mtimeMs: number; isDirectory(): boolean } | null {
      try {
        const s = statSync(path);
        return {
          mtimeMs: s.mtimeMs,
          isDirectory: () => s.isDirectory(),
        };
      } catch {
        return null;
      }
    },
  };
}

export async function probeJunieQuota(
  adapters: JunieProbeAdapters = createNodeJunieProbeAdapters(),
): Promise<JunieQuotaSummary> {
  const junieHome = adapters.env.JUNIE_HOME?.trim() || join(adapters.homeDir, ".junie");

  // Check credentials
  const credsPath = join(junieHome, "secure_credentials.json");
  const credsText = adapters.readFile(credsPath);
  let hasCredentials = false;
  if (credsText !== null && credsText.trim().length > 0) {
    try {
      const credsJson = JSON.parse(credsText);
      if (typeof credsJson === "object" && credsJson !== null && !Array.isArray(credsJson)) {
        if (Object.keys(credsJson).length > 0) {
          hasCredentials = true;
        }
      }
    } catch {
      hasCredentials = false;
    }
  }

  // Check sessions directory
  const sessionsDir = join(junieHome, "sessions");
  const sessionEntries = adapters.readDir(sessionsDir);
  const sessionFolders: { name: string; path: string; mtimeMs: number }[] = [];

  for (const entry of sessionEntries) {
    const sessionPath = join(sessionsDir, entry);
    const st = adapters.stat(sessionPath);
    if (st && st.isDirectory()) {
      sessionFolders.push({ name: entry, path: sessionPath, mtimeMs: st.mtimeMs });
    }
  }

  if (!hasCredentials && sessionFolders.length === 0) {
    throw new JunieProbeError("Junie is not installed or configured on this machine");
  }

  if (sessionFolders.length === 0) {
    return {
      source: "junie",
      status: "ok",
      notice: null,
      plan: "JetBrains AI",
      balance: { status: "active", percent: 100 },
      usage: { sessionTokens: 0, lastActiveMs: null },
    };
  }

  sessionFolders.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latestSession = sessionFolders[0];
  if (!latestSession) {
    throw new JunieProbeError("Junie is not installed or configured on this machine");
  }

  const eventsPath = join(latestSession.path, "events.jsonl");
  const eventsText = adapters.readFile(eventsPath);

  let totalSessionTokens = 0;
  let lastTimestamp: number | null = null;
  let lastFailureEvent: string | null = null;

  if (eventsText !== null) {
    const lines = eventsText.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const isInsufficient =
        trimmed.includes("ExitPaymentRequired") ||
        trimmed.includes("Insufficient account balance") ||
        trimmed.includes("INSUFFICIENT_ACCOUNT_BALANCE");

      if (isInsufficient) {
        lastFailureEvent = "ExitPaymentRequired";
      } else {
        try {
          const data = JSON.parse(trimmed);
          const kind = data.kind ?? data.event?.agentEvent?.kind ?? data.event?.kind;
          const state = data.state ?? data.event?.state;
          if (
            (typeof kind === "string" && kind.startsWith("Exit") && kind !== "ExitSuccess") ||
            state === "ERROR" ||
            state === "FAILED"
          ) {
            lastFailureEvent = "other";
          }
        } catch {
          // ignore non-json
        }
      }

      // Check timestamp
      try {
        const data = JSON.parse(trimmed);
        const ts = data.timestampMs ?? data.event?.timestampMs;
        if (typeof ts === "number" && !Number.isNaN(ts)) {
          lastTimestamp = Math.max(lastTimestamp ?? 0, ts);
        }
      } catch {
        // ignore non-json
      }

      // Check LlmResponseMetadataEvent for token consumption
      if (trimmed.includes("LlmResponseMetadataEvent")) {
        try {
          const data = JSON.parse(trimmed);
          const modelUsage = data.event?.agentEvent?.modelUsage;
          if (Array.isArray(modelUsage)) {
            for (const item of modelUsage) {
              const inputTokens = typeof item.inputTokens === "number" ? item.inputTokens : 0;
              const outputTokens = typeof item.outputTokens === "number" ? item.outputTokens : 0;
              totalSessionTokens += inputTokens + outputTokens;
            }
          }
        } catch {
          // ignore non-json
        }
      }
    }
  }

  const isInsufficientBalance = lastFailureEvent === "ExitPaymentRequired";
  const balance: JunieBalance = isInsufficientBalance
    ? { status: "insufficient_balance", percent: 0 }
    : { status: "active", percent: 100 };

  const notice = isInsufficientBalance
    ? "Insufficient account balance (all tokens spent)"
    : null;

  return {
    source: "junie",
    status: "ok",
    notice,
    plan: "JetBrains AI",
    balance,
    usage: {
      sessionTokens: totalSessionTokens,
      lastActiveMs: lastTimestamp ?? latestSession.mtimeMs,
    },
  };
}

async function main(): Promise<void> {
  try {
    process.stdout.write(`${JSON.stringify(await probeJunieQuota(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void main();
}
