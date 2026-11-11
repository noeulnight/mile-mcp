import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { publicError } from "../errors.js";
import type { MileService } from "../mile/service.js";
import { createServer } from "./server.js";

export async function startHttpServer(
  service: MileService,
  host = "127.0.0.1",
  port = 8000,
  options: { apiKey?: string; allowedHosts?: string[] } = {},
): Promise<Server> {
  const app = createMcpExpressApp({
    host,
    allowedHosts: options.allowedHosts ?? ["127.0.0.1", "localhost", "[::1]"],
  });
  if (options.apiKey) {
    const expected = Buffer.from(`Bearer ${options.apiKey}`);
    app.use("/mcp", (req, res, next) => {
      const provided = Buffer.from(req.headers.authorization ?? "");
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    });
  }
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.post("/mcp", async (req, res) => {
    const server = createServer(service);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(JSON.stringify(publicError(error)));
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "MCP 요청을 처리하지 못했습니다." },
        });
      }
    }
  });
  app.all("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed" });
  });
  return new Promise((resolve, reject) => {
    const listener = app.listen(port, host);
    listener.once("listening", () => resolve(listener));
    listener.once("error", reject);
  });
}
