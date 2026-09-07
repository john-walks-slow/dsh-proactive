/**
 * resolveSessionTitle unit tests: the two-source title fold for the panel
 * tables. Prefers sessionQuery.readTitle (log-backed fold that also sees cold
 * sessions), falls back to the live in-memory sessions+sessionTitle fold, and
 * degrades to an empty title when the host mounts neither.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSessionTitle } from "../src/index.js";

/** Minimal cordis-like ctx whose `get` serves from a fixed map. */
function fakeCtx(services: Record<string, unknown>): { get: (name: string, strict?: boolean) => unknown } {
  return {
    get(name: string) {
      return services[name];
    }
  };
}

test("title: prefers sessionQuery.readTitle over the live fold", async () => {
  const readTitle = async () => ({ title: "query 标题" });
  const sessions = {
    get: (id: string) => (id === "live" ? { id } : undefined)
  };
  const sessionTitle = {
    get: (session: unknown) => ({ title: "live 标题" })
  };
  const resolve = resolveSessionTitle(fakeCtx({ sessions, sessionTitle, sessionQuery: { readTitle } }) as never);
  // query wins even when the session is live and would have a live title.
  assert.equal(await resolve("live"), "query 标题");
  // cold session also resolves through the query source.
  assert.equal(await resolve("cold-persisted"), "query 标题");
});

test("title: falls back to the live sessions+sessionTitle fold without a query service", async () => {
  const sessions = {
    get: (id: string) => (id === "live" ? { id } : undefined)
  };
  const sessionTitle = {
    get: (session: unknown) => ({ title: "live 标题" })
  };
  const resolve = resolveSessionTitle(fakeCtx({ sessions, sessionTitle }) as never);
  assert.equal(await resolve("live"), "live 标题");
  // unknown session -> empty title (panel shows the raw id).
  assert.equal(await resolve("missing"), "");
});

test("title: no title services -> always empty", async () => {
  const resolve = resolveSessionTitle(fakeCtx({}) as never);
  assert.equal(await resolve("anything"), "");
});

test("title: query readTitle rejects -> empty title, never throws", async () => {
  const readTitle = async () => {
    throw new Error("boom");
  };
  const resolve = resolveSessionTitle(fakeCtx({ sessionQuery: { readTitle } }) as never);
  assert.equal(await resolve("x"), "");
});