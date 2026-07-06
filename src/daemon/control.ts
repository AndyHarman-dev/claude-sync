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

  return Bun.listen({
    unix: sockPath,
    socket: {
      data(socket, data) {
        void (async () => {
          const text = Buffer.from(data).toString("utf8");
          for (const line of text.split("\n")) {
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

    let socket: Awaited<ReturnType<typeof Bun.connect>> | undefined;
    Bun.connect({
      unix: paths.daemonSock(),
      socket: {
        open(sock) {
          sock.write(`${JSON.stringify(cmd)}\n`);
        },
        data(_sock, data) {
          clearTimeout(timer);
          try {
            finish(JSON.parse(Buffer.from(data).toString("utf8")));
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
