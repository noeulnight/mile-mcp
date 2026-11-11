import { homedir } from "node:os";
import { join } from "node:path";
import { MileError } from "./errors.js";

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.MILE_MCP_PORT ?? 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MileError("INVALID_PORT", "유효한 MCP 포트를 지정해 주세요.");
  }
  return {
    host: env.MILE_MCP_HOST ?? "127.0.0.1",
    port,
    databasePath:
      env.MILE_MCP_DATABASE_PATH ??
      join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "mile-mcp", "mile.db"),
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
