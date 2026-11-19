// mcp.ts — the Model Context Protocol endpoint: JSON-RPC 2.0 over Streamable
// HTTP, revision 2026-07-28 through server/discover plus the handshake
// revisions, and the six tools the rules name, acting on the same store REST
// reads back.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Ctx } from './rest.ts';

const REVISION = '2026-07-28';
const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
  });
  res.end(text);
}

function raw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tokenOk(req: IncomingMessage, ctx: Ctx): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m !== null && m[1].trim() === ctx.token;
}

const text = (value: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const toolError = (message: string) => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

const str = (description: string) => ({ type: 'string', description });
const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object', properties, required, additionalProperties: true,
});

/** The tool names this server answers; an unknown one is -32601, not -32602. */
const KNOWN_TOOLS = new Set(['create_repo', 'get_repo', 'create_issue', 'list_issues',
                             'create_pull_request', 'merge_pull_request']);

/** The six tools, in a fixed order: two tools/list calls must be byte-identical. */
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository and return it.',
    inputSchema: schema({ name: str('Repository name'),
                          description: str('Optional description') }, ['name']),
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: schema({ owner: str('Owner login'), repo: str('Repository name') },
                         ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: schema({ owner: str('Owner login'), repo: str('Repository name'),
                          title: str('Issue title'), body: str('Issue body') },
                         ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List a repository issues, open by default.',
    inputSchema: schema({ owner: str('Owner login'), repo: str('Repository name'),
                          state: str('open, closed or all') }, ['owner', 'repo']),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: schema({ owner: str('Owner login'), repo: str('Repository name'),
                          title: str('Pull request title'), head: str('Head branch'),
                          base: str('Base branch') },
                         ['owner', 'repo', 'title', 'head', 'base']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number.',
    inputSchema: schema({ owner: str('Owner login'), repo: str('Repository name'),
                          pull_number: { type: 'number', description: 'Pull request number' } },
                         ['owner', 'repo', 'pull_number']),
  },
] as const;

export async function handleMcp(req: IncomingMessage, res: ServerResponse,
                                ctx: Ctx): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { message: 'Use POST' });
  // A call with no Authorization header answers 401.
  if (!tokenOk(req, ctx)) return send(res, 401, { message: 'Requires authentication' });

  let parsed: unknown;
  try {
    const bytes = await raw(req);
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    // A body that is not JSON answers HTTP 400 with -32700.
    return send(res, 400, { jsonrpc: '2.0', id: null,
                            error: { code: -32700, message: 'Parse error' } });
  }

  const batch = Array.isArray(parsed);
  const calls = (batch ? parsed : [parsed]) as Record<string, unknown>[];
  const answers = calls.map((call) => answer(call, ctx)).filter((x) => x !== null);
  if (!batch) return send(res, 200, answers[0] ?? { jsonrpc: '2.0', id: null, result: {} });
  if (answers.length === 0) {
    res.writeHead(202, { 'x-github-request-id': randomUUID() });
    res.end();
    return;
  }
  return send(res, 200, answers);
}

function answer(call: Record<string, unknown>, ctx: Ctx): Record<string, unknown> | null {
  const id = call.id ?? null;
  const method = typeof call.method === 'string' ? call.method : '';
  const params = (call.params && typeof call.params === 'object'
    ? call.params : {}) as Record<string, unknown>;

  if (method === 'notifications/initialized' || method === 'initialized'
      || method === 'notifications/cancelled') return null;

  if (method === 'server/discover') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: REVISION,
      supportedVersions: SUPPORTED,
      serverInfo: { name: 'forge', version: '1.0.0' },
      capabilities: { tools: { listChanged: false } },
    } };
  }
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: String(params.protocolVersion ?? REVISION),
      serverInfo: { name: 'forge', version: '1.0.0' },
      capabilities: { tools: { listChanged: false } },
    } };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (params.arguments && typeof params.arguments === 'object'
      ? params.arguments : {}) as Record<string, unknown>;
    return callTool(name, args, id, ctx);
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

/** A server prefix is allowed (github__create_issue): match the name as a suffix. */
function bare(name: string): string {
  const lower = name.toLowerCase();
  return lower.includes('__') ? lower.split('__').pop()! : lower;
}

function callTool(name: string, args: Record<string, unknown>, id: unknown,
                  ctx: Ctx): Record<string, unknown> {
  const tool = bare(name);
  // The unknown-tool answer comes first: checking required arguments before the
  // name makes an unknown tool answer -32602 instead of -32601 (measured).
  if (!KNOWN_TOOLS.has(tool)) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
  }
  const login = ctx.login;
  const owner = String(args.owner ?? login);
  const repoName = String(args.repo ?? '');
  const missing = (arg: string) => ({ jsonrpc: '2.0', id,
    error: { code: -32602, message: `Missing required argument: ${arg}` } });

  if (tool === 'create_repo') {
    if (!args.name) return missing('name');
    const repo = ctx.store.createRepo(String(args.name), {
      description: String(args.description ?? ''),
    });
    return { jsonrpc: '2.0', id, result: text({
      id: repo.id, name: repo.name, full_name: repo.fullName,
      owner: repo.owner, default_branch: repo.defaultBranch }) };
  }

  if (!repoName) return missing('repo');
  const repo = ctx.store.getRepo(owner, repoName);

  if (tool === 'get_repo') {
    if (!repo) return { jsonrpc: '2.0', id, result: toolError('Repository not found') };
    return { jsonrpc: '2.0', id, result: text({
      id: repo.id, name: repo.name, full_name: repo.fullName, owner: repo.owner,
      description: repo.description, default_branch: repo.defaultBranch }) };
  }
  if (!repo) return { jsonrpc: '2.0', id, result: toolError('Repository not found') };

  if (tool === 'create_issue') {
    if (!args.title) return missing('title');
    const issue = ctx.store.createIssue(repo, {
      title: String(args.title), body: String(args.body ?? ''),
    });
    return { jsonrpc: '2.0', id, result: text({
      id: issue.id, number: issue.number, title: issue.title, state: issue.state }) };
  }
  if (tool === 'list_issues') {
    const wanted = String(args.state ?? 'open');
    const rows = ctx.store.listIssues(repo)
      .filter((i) => (wanted === 'all' ? true : i.state === wanted));
    return { jsonrpc: '2.0', id, result: text(rows.map((i) => ({
      id: i.id, number: i.number, title: i.title, state: i.state }))) };
  }
  if (tool === 'create_pull_request') {
    for (const arg of ['title', 'head', 'base']) {
      if (!args[arg]) return missing(arg);
    }
    if (!ctx.store.resolveRef(repo, String(args.head))) {
      return { jsonrpc: '2.0', id, result: toolError('Head branch not found') };
    }
    const pull = ctx.store.createPull(repo, {
      title: String(args.title), body: String(args.body ?? ''),
      head: String(args.head), base: String(args.base),
    });
    return { jsonrpc: '2.0', id, result: text({
      id: pull.id, number: pull.number, state: pull.state,
      head: pull.headRef, base: pull.baseRef }) };
  }
  if (tool === 'merge_pull_request') {
    if (args.pull_number === undefined) return missing('pull_number');
    const pull = ctx.store.getPull(repo, Number(args.pull_number));
    if (!pull) return { jsonrpc: '2.0', id, result: toolError('Pull request not found') };
    const files = ctx.store.filesAtRef(repo, pull.headRef);
    if (!files) return { jsonrpc: '2.0', id, result: toolError('Pull request is not mergeable') };
    const sha = ctx.store.commitFiles(repo, pull.baseRef, files,
      `Merge pull request #${pull.number}: ${pull.title}`);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = sha;
    return { jsonrpc: '2.0', id, result: text({ number: pull.number, merged: true, sha }) };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
}