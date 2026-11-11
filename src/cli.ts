import { createApplication } from "./app.js";
import { parseSession } from "./auth/session.js";
import { loadConfig } from "./config.js";
import { MileError, publicError } from "./errors.js";

async function main() {
  const command = process.argv[2] ?? "http";
  if (!["http", "stdio", "status", "import-session"].includes(command)) {
    throw new MileError(
      "INVALID_COMMAND",
      "사용법: node dist/cli.js [http|stdio|status|import-session [--replace]]",
    );
  }
  const app = createApplication(loadConfig());
  if (command === "http" || command === "stdio") {
    const shutdown = () => {
      void app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error(JSON.stringify(publicError(error)));
          process.exit(1);
        },
      );
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await app.start(command);
    return;
  }
  try {
    if (command === "import-session") {
      // Credentials enter via stdin, never process arguments or a session file.
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk.toString();
      }
      const session = await parseSession(input);
      if ((await app.store.load()) && !process.argv.includes("--replace")) {
        throw new MileError(
          "SESSION_EXISTS",
          "저장된 세션이 있습니다. 서버를 중지한 뒤 --replace로 교체해 주세요.",
        );
      }
      await app.store.save(session);
      console.log(JSON.stringify({ imported: true }));
    } else {
      await app.api.read("/users/info");
      await app.api.read("/members/my/info");
      const rooms = await app.service.listRooms({ page: 1, pageSize: 1, roomIds: [] });
      console.log(
        JSON.stringify({
          authenticated: true,
          meetingsAccessible: true,
          roomsReturned: rooms.meetingRoomList.length,
        }),
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify(publicError(error)));
  process.exitCode = 1;
});
