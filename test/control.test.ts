import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlServer, sendControlCommand } from "../src/daemon/control";
import { paths } from "../src/lib/paths";

let dir: string;
const prevDataDir = process.env.CLAUDE_SYNC_DATA_DIR;
let server: Awaited<ReturnType<typeof startControlServer>> | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-sync-control-"));
  process.env.CLAUDE_SYNC_DATA_DIR = dir;
  // startControlServer binds the unix socket directly without creating its parent dir —
  // in the real daemon that's a side effect of acquirePidLock() running first (same
  // parent dir as the pidfile), which these tests bypass, so create it explicitly.
  await mkdir(paths.daemonDir(), { recursive: true });
});

afterEach(async () => {
  server?.stop(true);
  server = undefined;
  await rm(dir, { recursive: true, force: true });
  if (prevDataDir) process.env.CLAUDE_SYNC_DATA_DIR = prevDataDir;
  else delete process.env.CLAUDE_SYNC_DATA_DIR;
});

describe("control socket NDJSON framing", () => {
  test("a command delivered as a single write round-trips normally", async () => {
    server = await startControlServer(async (cmd) => ({ ok: true, echoed: cmd.cmd }));
    const response = (await sendControlCommand({ cmd: "status" })) as { ok: boolean; echoed: string };
    expect(response).toEqual({ ok: true, echoed: "status" });
  });

  test("a command split across two socket writes is still parsed correctly (server-side buffering)", async () => {
    let received: unknown;
    server = await startControlServer(async (cmd) => {
      received = cmd;
      return { ok: true };
    });

    const payload = `${JSON.stringify({ cmd: "summarize_now", session_id: "sess-aaa111" })}\n`;
    const splitAt = Math.floor(payload.length / 2);

    const response = await new Promise((resolve) => {
      Bun.connect({
        unix: paths.daemonSock(),
        socket: {
          open(sock) {
            sock.write(payload.slice(0, splitAt));
            setTimeout(() => sock.write(payload.slice(splitAt)), 20);
          },
          data(sock, data) {
            resolve(JSON.parse(Buffer.from(data).toString("utf8")));
            sock.end();
          },
        },
      });
    });

    expect(response).toEqual({ ok: true });
    expect(received).toEqual({ cmd: "summarize_now", session_id: "sess-aaa111" });
  });

  test("two NDJSON commands delivered in one write are both processed", async () => {
    const receivedCmds: string[] = [];
    server = await startControlServer(async (cmd) => {
      receivedCmds.push(cmd.cmd);
      return { ok: true, cmd: cmd.cmd };
    });

    const responses: unknown[] = await new Promise((resolve) => {
      const collected: unknown[] = [];
      Bun.connect({
        unix: paths.daemonSock(),
        socket: {
          open(sock) {
            sock.write(`${JSON.stringify({ cmd: "status" })}\n${JSON.stringify({ cmd: "status" })}\n`);
          },
          data(sock, data) {
            for (const line of Buffer.from(data).toString("utf8").split("\n")) {
              if (!line.trim()) continue;
              collected.push(JSON.parse(line));
            }
            if (collected.length >= 2) {
              resolve(collected);
              sock.end();
            }
          },
        },
      });
    });

    expect(receivedCmds).toEqual(["status", "status"]);
    expect(responses).toHaveLength(2);
  });

  test("client-side sendControlCommand buffers a response split across two writes", async () => {
    // The server writes its response as one Bun socket.write call, so to exercise the
    // CLIENT's buffering we drive a raw server manually and split the response bytes.
    const sockPath = paths.daemonSock();
    server = Bun.listen({
      unix: sockPath,
      socket: {
        data(sock) {
          const payload = `${JSON.stringify({ ok: true, split: true })}\n`;
          const mid = Math.floor(payload.length / 2);
          sock.write(payload.slice(0, mid));
          setTimeout(() => sock.write(payload.slice(mid)), 20);
        },
      },
    });

    const response = await sendControlCommand({ cmd: "status" });
    expect(response).toEqual({ ok: true, split: true });
  });
});
