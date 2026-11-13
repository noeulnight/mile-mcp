# mile-mcp

A Model Context Protocol (MCP) server for managing [Mile](https://mile.im) meeting rooms through AI assistants such as Codex.

## Features

- Find available rooms by time, capacity, and location.
- Search attendees and create one-time or recurring bookings with conflict checks.
- View and cancel reservations.
- Store credentials in SQLite with automatic renewal.

## Installation

Requires Docker and an MCP client such as Codex.

### 1. Import Mile credentials

Prepare a valid Mile session with `version: 1`, `accessToken`, and `cookieJar` (a serialized `tough-cookie` CookieJar with refresh cookies). You must obtain these credentials separately; sign-in is not included.

```sh
docker volume create mile-mcp-data
docker run --rm -i \
  -v mile-mcp-data:/data \
  ghcr.io/noeulnight/mile-mcp:latest \
  node dist/cli.js import-session
```

Paste the session JSON, press Enter, then Ctrl+D. Credentials are stored in SQLite on the Docker volume.

### 2. Start the server

```sh
docker run -d --name mile-mcp \
  --restart unless-stopped \
  -p 127.0.0.1:18787:8000 \
  -v mile-mcp-data:/data \
  ghcr.io/noeulnight/mile-mcp:latest
```

### 3. Connect Codex

```sh
codex mcp add mile --url http://127.0.0.1:18787/mcp
```

Ask the assistant to list your workspaces and select one before booking. Workspace selection is shared across all connections.
