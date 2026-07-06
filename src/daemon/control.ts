import { unlink } from "node:fs/promises";
import { paths } from "../lib/paths";
import { log } from "./log";

export type ControlCommand = { cmd: string; [key: string]: unknown };
export type ControlHandler = (cmd: ControlCommand) => Promise<unknown>;

/** NDJSON control server over a unix domain socket. CLI-only — never called from the hook
 * hot path, so there is no latency budget to protect here. */
export async function startControlServer(handler: ControlHandler) {
  const sockPath = paths.daemonSock();
  await unlink(sockPath).catch(() => {});

  // Per-connection buffer for lines split across multiple `data` events — a unix socket
  // read is not guaranteed to deliver a full NDJSON line in one chunk. Keyed by socket
  // object identity; entries are naturally abandoned (and GC'd) once a connection closes.
  const buffers = new WeakMap<object, string>();

  return Bun.listen({
    unix: sockPath,
    socket: {
      data(socket, data) {
        void (async () => {
          const combined = (buffers.get(socket) ?? "") + Buffer.from(data).toString("utf8");
          const lines = combined.split("\n");
          buffers.set(socket, lines.pop() ?? "");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const cmd = JSON.parse(line) as ControlCommand;
              const response = await handler(cmd);
              socket.write(`${JSON.stringify(response)}\n`);
            } catch (err) {
              socket.write(`${JSON.stringify({ ok: false, error: String(err) })}\n`);
            }
          }
        })();
      },
      error(_socket, err) {
        void log(`control socket error: ${err}`);
      },
    },
  });
}

/** Client helper: send one command to the daemon's control socket and read one NDJSON
 * response line. Used by the CLI (Phase 4). Resolves undefined if the daemon isn't
 * listening or times out — callers should treat that as "daemon down". */
export async function sendControlCommand(cmd: ControlCommand, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => finish(undefined), timeoutMs);
    let buffer = "";

    let socket: Awaited<ReturnType<typeof Bun.connect>> | undefined;
    Bun.connect({
      unix: paths.daemonSock(),
      socket: {
        open(sock) {
          sock.write(`${JSON.stringify(cmd)}\n`);
        },
        data(_sock, data) {
          buffer += Buffer.from(data).toString("utf8");
          const newlineAt = buffer.indexOf("\n");
          if (newlineAt === -1) return; // wait for the rest of the line
          clearTimeout(timer);
          try {
            finish(JSON.parse(buffer.slice(0, newlineAt)));
          } catch {
            finish(undefined);
          }
          socket?.end();
        },
        error() {
          clearTimeout(timer);
          finish(undefined);
        },
        close() {
          clearTimeout(timer);
          finish(undefined);
        },
      },
    })
      .then((sock) => {
        socket = sock;
      })
      .catch(() => {
        clearTimeout(timer);
        finish(undefined);
      });
  });
}
