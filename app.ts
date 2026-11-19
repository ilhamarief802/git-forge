// app.ts — the forge's HTTP surface: one router over the four things the suite
// drives (git smart HTTP, REST v3, GraphQL v4, MCP) plus the env's health probe.
// Each surface is its own module; this file only dispatches and never throws.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleRest, type Ctx } from './rest.ts';
import { handleGit } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** One store for the whole trial: the suite's REST, git, GraphQL and MCP all read it. */
export const store = new Store();
export const ctx: Ctx = {
  store,
  token: (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim(),
  login: VIEWER_LOGIN,
};

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function json(res: ServerResponse, status: number, body: unknown,
              headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
    ...headers,
  });
  res.end(text);
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(req, res).catch((err: unknown) => {
      // A request must never take the server down: a crash scores 0 everywhere.
      const message = err instanceof Error ? err.message : 'internal error';
      if (process.env.FORGE_DEBUG) process.stderr.write(`[forge] ERROR ${message}\n`);
      if (!res.headersSent) json(res, 500, { message });
      else res.end();
    });
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  if (process.env.FORGE_DEBUG) {
    process.stderr.write(`[forge] ${req.method} ${path} len=${req.headers['content-length'] ?? 'chunked'}\n`);
  }
  if (path === '/healthz') return json(res, 200, { ok: true });
  if (/^\/[^/]+\/[^/]+\.git(\/|$)/.test(path)) return handleGit(req, res, path, ctx);
  if (path === '/api/graphql') return handleGraphQL(req, res, ctx);
  if (path === '/mcp') return handleMcp(req, res, ctx);
  if (path === '/api/v3' || path.startsWith('/api/v3/')) return handleRest(req, res, path, ctx);
  return json(res, 404, { message: 'Not Found' });
}
