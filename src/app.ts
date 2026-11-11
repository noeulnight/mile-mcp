import type { Server } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SessionRefresher } from "./auth/refresher.js";
import { HttpTransport } from "./auth/transport.js";
import type { AppConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { SqliteSessionStore } from "./db/session-store.js";
import { startHttpServer } from "./mcp/http.js";
import { createServer } from "./mcp/server.js";
import { MileApi } from "./mile/api.js";
import { MileService } from "./mile/service.js";

export function createApplication(config: AppConfig, fetcher: typeof fetch = fetch) {
  const database = openDatabase(config.databasePath);
  const store = new SqliteSessionStore(database.db);
  const transport = new HttpTransport(store, fetcher);
  const api = new MileApi(transport);
  const service = new MileService(api);
  const refresher = new SessionRefresher(transport, store);
  let listener: Server | undefined;
  let server: McpServer | undefined;
  let closing: Promise<void> | undefined;

  function close(): Promise<void> {
    closing ??= Promise.resolve().then(async () => {
      try {
        const activeListener = listener;
        await Promise.all([
          refresher.stop(),
          activeListener
            ? new Promise<void>((resolve, reject) => {
                activeListener.close((error) => (error ? reject(error) : resolve()));
              })
            : server?.close(),
        ]);
      } finally {
        try {
          await transport.close();
        } finally {
          database.close();
        }
      }
    });
    return closing;
  }

  async function start(mode: "http" | "stdio") {
    try {
      if (mode === "http") {
        listener = await startHttpServer(service, config.host, config.port, config);
        console.error(JSON.stringify({ event: "mcp_http_started", port: config.port }));
      } else {
        server = createServer(service);
        const stdio = new StdioServerTransport();
        await server.connect(stdio);
        const onclose = stdio.onclose;
        stdio.onclose = () => {
          onclose?.();
          void close().catch(reportShutdownError);
        };
      }
      refresher.start();
      return listener?.address();
    } catch (error) {
      await close();
      throw error;
    }
  }

  return { store, api, service, start, close };
}

function reportShutdownError() {
  console.error(JSON.stringify({ event: "shutdown_failed" }));
  process.exitCode = 1;
}
