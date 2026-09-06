/**
 * Web routes for the panel under the host webserver (when one is composed):
 *   GET  /api/dsh-proactive/state    one full snapshot
 *   POST /api/dsh-proactive/action   one closed action, returns the fresh snapshot
 *   GET  /api/dsh-proactive/events   SSE change stream (client re-pulls state)
 *
 * Missing webserver (headless profiles) degrades to a no-op with one log line;
 * the plugin keep working without a GUI.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { ProactivePanelService } from "./service.js";

const ACTION_BODY_MAX_BYTES = 64 * 1024;
const HEARTBEAT_MS = 15_000;

export interface WebServerLike {
  register(route: { kind: "exact" | "prefix"; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Parse the optional `session` query parameter; empty string → undefined. Malformed encoding fails closed (undefined). */
function sessionParam(req: IncomingMessage): string | undefined {
  const raw = (req.url ?? "").split("?")[1];
  if (raw === undefined) return undefined;
  for (const part of raw.split("&")) {
    if (part.startsWith("session=")) {
      let value: string;
      try {
        value = decodeURIComponent(part.slice("session=".length));
      } catch {
        // Bad percent-encoding: treat as absent rather than crashing the request.
        return undefined;
      }
      value = value.trim();
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

async function readBoundedJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") throw new Error("empty body");
  return JSON.parse(text);
}

/**
 * Install the panel routes on ctx.webserver when available. Returns the
 * combined disposer (all disposers in sequence) or undefined when no
 * webserver is composed.
 */
export function installPanelRoutes(
  ctx: Context,
  service: ProactivePanelService,
  subscribe: (listener: () => void) => () => void
): (() => void) | undefined {
  const webserver = (ctx as unknown as { get: (name: string, strict?: boolean) => unknown }).get("webServer", false) as WebServerLike | undefined;
  if (webserver === undefined || webserver === null) {
    ctx.logger.info("dsh-proactive: no webserver composed; panel routes not installed.");
    return undefined;
  }
  const disposers: Array<() => void> = [];

  disposers.push(
    webserver.register({ kind: "exact", path: "/api/dsh-proactive/state", handler: (req, res) => {
      void service.snapshot(sessionParam(req)).then(
        (snapshot) => writeJson(res, 200, snapshot),
        () => writeJson(res, 500, { code: "internal_error", message: "snapshot failed" })
      );
    } })
  );

  disposers.push(
    webserver.register({ kind: "exact", path: "/api/dsh-proactive/action", handler: (req, res) => {
      if (req.method !== "POST") {
        writeJson(res, 405, { code: "bad_action", message: "POST required" });
        return;
      }
      void readBoundedJson(req, ACTION_BODY_MAX_BYTES)
        .then((body) => service.action(body, sessionParam(req)))
        .then((result) => {
          if (result.ok) writeJson(res, 200, result.snapshot);
          else writeJson(res, 400, result.error);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          writeJson(res, 400, { code: "bad_action", message });
        });
    } })
  );

  disposers.push(
    webserver.register({ kind: "exact", path: "/api/dsh-proactive/events", handler: (req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "connection": "keep-alive"
      });
      let closed = false;
      const send = (payload: string): void => {
        if (closed || res.writableEnded) return;
        res.write(payload);
      };
      const notify = (): void => {
        send("event: changed\ndata: {\"now\":\"" + new Date().toISOString() + "\"}\n\n");
      };
      const unsubscribe = subscribe(notify);
      const heartbeat = setInterval(() => {
        send(": keepalive\n\n");
      }, HEARTBEAT_MS);
      const cleanup = (): void => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
      send(": connected\n\n");
    } })
  );

  return () => {
    for (const dispose of disposers) dispose();
  };
}