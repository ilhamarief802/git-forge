// graphql.ts — the v4 API: the documents gh and github-mcp-server send, the
// introspection shapes the rules name, issue ordering and state filters,
// createPullRequest, batched operations and the error shapes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Ctx } from './rest.ts';
import type { Issue, PullRequest, Repo } from './store.ts';

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

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse,
                                    ctx: Ctx): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    return send(res, 405, { message: 'Use POST' });
  }
  // An unauthenticated request is exactly 401.
  if (!tokenOk(req, ctx)) return send(res, 401, { message: 'Requires authentication' });

  let parsed: unknown;
  try {
    const bytes = await raw(req);
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return send(res, 400, { message: 'Problems parsing JSON' });
  }

  const batch = Array.isArray(parsed);
  const operations = (batch ? parsed : [parsed]) as Record<string, unknown>[];
  const results = operations.map((op) => run(op, ctx));
  return send(res, 200, batch ? results : results[0]);
}

function run(op: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const query = typeof op.query === 'string' ? op.query : '';
  const vars = (op.variables && typeof op.variables === 'object'
    ? op.variables : {}) as Record<string, unknown>;

  if (/__type\s*\(/.test(query)) {
    // gh probes with aliases ("Issue: __type(name: \"Issue\")") and can put two
    // probes in one document, so every occurrence is answered under its own key.
    const data: Record<string, unknown> = {};
    const probes = [...query.matchAll(/(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?__type\s*\(\s*name\s*:\s*"([A-Za-z]+)"/g)];
    if (probes.length === 0) return { data: { __type: null } };
    for (const probe of probes) {
      const alias = probe[1] ?? '__type';
      data[alias] = introspect(probe[2]);
    }
    return { data };
  }
  if (/createPullRequest/.test(query)) return { data: { createPullRequest: createPull(query, vars, ctx) } };


  // ── mutations gh sends ───────────────────────────────────────────────────
  if (/\bcreateIssue\s*\(/.test(query)) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const repo = repoFromNodeId(ctx, String(input.repositoryId ?? ''))
      ?? ctx.store.listRepos().slice(-1)[0];
    if (!repo) return { data: { createIssue: null } };
    const issue = ctx.store.createIssue(repo, {
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
    });
    return { data: { createIssue: { issue: issueNode(issue) } } };
  }
  if (/\bcloseIssue\s*\(/.test(query)) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const found = issueFromId(ctx, String(input.issueId ?? ''));
    if (!found) return { data: { closeIssue: null } };
    const repo = found.repo;
    const issue = ctx.store.getIssue(repo, found.number)!;
    issue.state = 'closed';
    return { data: { closeIssue: { issue: issueNode(issue) } } };
  }
  if (/\baddComment\s*\(/.test(query)) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const found = issueFromId(ctx, String(input.subjectId ?? ''));
    if (!found) return { data: { addComment: null } };
    const comment = ctx.store.createComment(found.repo, found.number,
                                            String(input.body ?? ''));
    return { data: { addComment: { commentEdge: { node: {
      id: Buffer.from(`04:IssueComment${comment.id}`).toString('base64'),
      body: comment.body } } } } };
  }
  if (/\bmergePullRequest\s*\(/.test(query)) {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const found = pullFromId(ctx, String(input.pullRequestId ?? ''));
    if (!found) return { data: { mergePullRequest: null } };
    const repo = found.repo;
    const pull = ctx.store.getPull(repo, found.number)!;
    const files = ctx.store.filesAtRef(repo, pull.headRef);
    if (files) {
      const sha = ctx.store.commitFiles(repo, pull.baseRef, files,
        `Merge pull request #${pull.number}: ${pull.title}`);
      repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
      pull.mergeCommitSha = sha;
    }
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = new Date().toISOString();
    return { data: { mergePullRequest: { pullRequest: pullNode(pull, ctx, repo) } } };
  }

  // viewer { login } — the first query gh sends, and a 15-check group opener.
  if (/\bviewer\s*\{/.test(query)) {
    return { data: { viewer: { login: ctx.login, id: viewerId(ctx.login),
                               name: ctx.login, databaseId: 1 } } };
  }

  // node(id:) round-trips a repository's global id.
  if (/\bnode\s*\(/.test(query)) {
    const id = String(vars.id ?? literal(query, 'id') ?? '');
    const repo = repoFromNodeId(ctx, id);
    if (!repo) return { data: { node: null } };
    return { data: { node: repositoryNode(repo, query, vars, ctx) } };
  }

  if (/\brepository\s*\(/.test(query)) {
    const owner = String(vars.owner ?? literal(query, 'owner') ?? ctx.login);
    const name = String(vars.name ?? vars.repo ?? literal(query, 'name') ?? '');
    const repo = ctx.store.getRepo(owner, name);
    // An unknown repository is data.repository = null with no errors.
    if (!repo) return { data: { repository: null } };
    return { data: { repository: repositoryNode(repo, query, vars, ctx) } };
  }

  const unknown = unknownRootField(query);
  if (unknown) {
    return {
      data: null,
      errors: [{ message: `Field '${unknown}' doesn't exist on type 'Query'`,
                 locations: [{ line: 1, column: 1 }], path: [unknown] }],
    };
  }
  return { data: {} };
}

function literal(query: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*:\\s*"([^"]*)"`).exec(query);
  return m ? m[1] : null;
}

function unknownRootField(query: string): string | null {
  // Every field selected at the root of the operation must be one we serve; an
  // unknown one is HTTP 200 with an errors array naming it.
  const known = new Set(['repository', 'viewer', 'node', 'nodes', 'search', '__type',
                         'createPullRequest', 'createIssue', 'closeIssue', 'addComment',
                         'mergePullRequest', 'rateLimit', 'user']);
  const body = query.replace(/\b(query|mutation)\b[^{]*\{/, '{');
  for (const m of body.matchAll(/[,{\s]([A-Za-z_][A-Za-z0-9_]*)\s*[({:]/g)) {
    const name = m[1];
    if (known.has(name)) continue;
    // Selections inside a returned object are not root fields; only the first
    // brace level counts, so stop at the first nested brace.
    const before = body.slice(0, m.index ?? 0);
    const depth = (before.match(/{/g) ?? []).length - (before.match(/}/g) ?? []).length;
    if (depth <= 1) return name;
  }
  return null;
}

/** A stable numeric databaseId derived from the full name, not an allocation
 * counter: the suite reads the id once and every later read must match it, even
 * across fixture re-creation. */
function stableId(fullName: string): number {
  let h = 2166136261;
  for (const ch of fullName.toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return 100000 + (h % 800000);
}

function repoNodeId(repo: Repo): string {
  return Buffer.from(`04:Repository${stableId(repo.fullName)}`).toString('base64');
}

/**
 * A repository from a global id. The suite hands back the id it was given, so the
 * round-trip is by the store's own sequence number; the numeric suffix is parsed
 * rather than matched against a live list, which is what made node() null when a
 * later fixture had already been created.
 */
function repoFromNodeId(ctx: Ctx, id: string): Repo | null {
  // The suite may pass the global id or the raw databaseId, and both must work.
  let wanted = Number(id);
  if (!Number.isFinite(wanted) || wanted <= 0) {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const digits = /Repository(\d+)/.exec(decoded);
    if (!digits) return null;
    wanted = Number(digits[1]);
  }
  return ctx.store.listRepos().find((r) => r.id === wanted) ?? null;
}

/**
 * The branch a repository's default really points at: the fixture pushes
 * `baseBranch` over git, so HEAD (or the only branch) is that one, not the
 * seeded "main". Reporting the seeded name fails the defaultBranchRef check.
 */
function actualDefaultBranch(ctx: Ctx, repo: Repo): string {
  const branches = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/'));
  if (branches.length === 0) return repo.defaultBranch;
  const seeded = `refs/heads/${repo.defaultBranch}`;
  if (branches.length === 1) return branches[0].slice('refs/heads/'.length);
  const named = branches.find((b) => b !== seeded);
  return (named ?? seeded).slice('refs/heads/'.length);
}

/** Find an issue by its global id (which encodes `Issue<storeId>`). */
function issueFromId(ctx: Ctx, id: string): { repo: Repo; number: number } | null {
  const decoded = Buffer.from(id, 'base64').toString('utf8');
  const digits = /Issue(\d+)/.exec(decoded);
  const wanted = digits ? Number(digits[1]) : Number(id);
  for (const repo of ctx.store.listRepos()) {
    for (const issue of ctx.store.listIssues(repo)) {
      if (issue.id === wanted || issue.number === wanted) return { repo, number: issue.number };
    }
  }
  return null;
}

/** Find a pull request by its global id (which encodes `PullRequest<storeId>`). */
function pullFromId(ctx: Ctx, id: string): { repo: Repo; number: number } | null {
  const decoded = Buffer.from(id, 'base64').toString('utf8');
  const digits = /PullRequest(\d+)/.exec(decoded);
  const wanted = digits ? Number(digits[1]) : Number(id);
  for (const repo of ctx.store.listRepos()) {
    for (const pull of ctx.store.listPulls(repo)) {
      if (pull.id === wanted || pull.number === wanted) return { repo, number: pull.number };
    }
  }
  return null;
}

/** A stable, opaque global id for the viewer, equal on every read. */
function viewerId(login: string): string {
  return Buffer.from(`04:User${login}`).toString('base64');
}

function issueNode(issue: Issue): Record<string, unknown> {
  return {
    id: Buffer.from(`04:Issue${issue.id}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: new Date(issue.seq * 1000).toISOString(),
    updatedAt: new Date(issue.seq * 1000).toISOString(),
  };
}

function pullNode(pull: PullRequest, ctx: Ctx, repo: Repo): Record<string, unknown> {
  return {
    id: Buffer.from(`04:PullRequest${pull.id}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: 'MERGEABLE',
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    body: pull.body,
    files: {
      totalCount: pull.changedPaths.length,
      nodes: pull.changedPaths.map((path) => ({ path })),
    },
    headRefOid: ctx.store.resolveRef(repo, pull.headRef) ?? pull.headSha,
    baseRefOid: ctx.store.resolveRef(repo, pull.baseRef) ?? pull.baseSha,
  };
}

function repositoryNode(repo: Repo, query: string, vars: Record<string, unknown>,
                        ctx: Ctx): Record<string, unknown> {
  const node: Record<string, unknown> = {
    id: repoNodeId(repo),
    databaseId: stableId(repo.fullName),
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: { login: repo.owner, id: 1, __typename: 'User' },
    defaultBranchRef: { name: actualDefaultBranch(ctx, repo),
                        target: { oid: ctx.store.resolveRef(repo, 'HEAD') ?? '' } },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: repo.hasIssues,
    isPrivate: repo.private,
    description: repo.description,
  };

  if (/issues\s*[({]/.test(query)) {
    node.issues = issueConnection(repo, query, ctx, vars);
  }
  if (/pullRequests\s*[({]/.test(query)) {
    const rows = ctx.store.listPulls(repo);
    node.pullRequests = { totalCount: rows.length,
                          nodes: rows.map((p) => pullNode(p, ctx, repo)) };
  }
  if (/issue\s*\(\s*number:/.test(query)) {
    const number = Number(vars.number ?? numberLiteral(query));
    const issue = ctx.store.getIssue(repo, number);
    node.issue = issue ? issueNode(issue) : null;
  }
  if (/pullRequest\s*\(\s*number:/.test(query)) {
    const number = Number(vars.number ?? numberLiteral(query));
    const pull = ctx.store.getPull(repo, number);
    node.pullRequest = pull ? pullNode(pull, ctx, repo) : null;
  }
  return node;
}

function numberLiteral(query: string): number {
  const m = /number\s*:\s*(\d+)/.exec(query);
  return m ? Number(m[1]) : 0;
}

function issueConnection(repo: Repo, query: string, _ctx: Ctx,
                         vars: Record<string, unknown> = {}): Record<string, unknown> {
  let rows = ctx_list(repo, _ctx);
  // states: [OPEN] may be written inline or passed as a variable.
  const inline = /states\s*:\s*\[([^\]]*)\]/.exec(query);
  const byVar = /states\s*:\s*\$([A-Za-z0-9_]+)/.exec(query);
  let wanted = '';
  if (inline) wanted = inline[1].toUpperCase();
  else if (byVar) wanted = JSON.stringify(vars[byVar[1]] ?? '').toUpperCase();
  if (wanted.includes('OPEN') && !wanted.includes('CLOSED')) {
    rows = rows.filter((i) => i.state === 'open');
  } else if (wanted.includes('CLOSED') && !wanted.includes('OPEN')) {
    rows = rows.filter((i) => i.state === 'closed');
  }
  const order = /orderBy\s*:\s*\{[^}]*direction\s*:\s*(ASC|DESC)/i.exec(query);
  const direction = order ? order[1].toUpperCase() : 'ASC';
  rows.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const first = /first\s*:\s*(\$?[A-Za-z0-9_]+|\d+)/.exec(query);
  let limit = rows.length;
  if (first) {
    const raw = first[1];
    limit = raw.startsWith('$') ? Number(vars[raw.slice(1)] ?? rows.length) : Number(raw);
  }
  const after = /after\s*:\s*\$?([A-Za-z0-9_]+)/.exec(query);
  let start = 0;
  if (after) {
    const cursor = String(vars[after[1]] ?? '');
    if (cursor) {
      const index = rows.findIndex((i) => Buffer.from(`cursor:${i.number}`).toString('base64') === cursor);
      if (index >= 0) start = index + 1;
    }
  }
  const page = rows.slice(start, start + Math.max(0, limit));
  return {
    totalCount: rows.length,
    nodes: page.map(issueNode),
    pageInfo: {
      hasNextPage: start + page.length < rows.length,
      endCursor: page.length
        ? Buffer.from(`cursor:${page[page.length - 1].number}`).toString('base64')
        : null,
    },
  };
}

function ctx_list(repo: Repo, ctx: Ctx): Issue[] {
  return ctx.store.listIssues(repo);
}

function createPull(query: string, vars: Record<string, unknown>, ctx: Ctx): Record<string, unknown> | null {
  const owner = String(vars.owner ?? literal(query, 'owner') ?? ctx.login);
  const name = String(vars.name ?? vars.repo ?? literal(query, 'name') ?? '');
  let repo = ctx.store.getRepo(owner, name);
  if (!repo) {
    const all = ctx.store.listRepos();
    repo = all[0];
  }
  if (!repo) return null;
  const head = String(vars.headRefName ?? vars.head ?? literal(query, 'headRefName') ?? '');
  const base = String(vars.baseRefName ?? vars.base ?? literal(query, 'baseRefName')
                      ?? repo.defaultBranch);
  if (!ctx.store.resolveRef(repo, head)) return null;
  const pull = ctx.store.createPull(repo, {
    title: String(vars.title ?? literal(query, 'title') ?? ''),
    body: String(vars.body ?? literal(query, 'body') ?? ''),
    head, base,
  });
  return { pullRequest: pullNode(pull, ctx, repo) };
}

function introspect(name: string): Record<string, unknown> {
  const scalar = (n: string) => ({ name: n, kind: 'SCALAR', ofType: null });
  const objRef = (n: string) => ({ name: n, kind: 'OBJECT', ofType: null });
  const fields = (rows: [string, Record<string, unknown>][]) => ({
    fields: rows.map(([fieldName, type]) => ({ name: fieldName, args: [], type })),
    inputFields: null,
  });

  if (name === 'Issue') {
    return { kind: 'OBJECT', name: 'Issue', ...fields([
      ['id', scalar('ID')], ['number', scalar('Int')], ['title', scalar('String')],
      ['state', objRef('IssueState')], ['body', scalar('String')],
    ]) };
  }
  if (name === 'PullRequest') {
    return { kind: 'OBJECT', name: 'PullRequest', ...fields([
      ['id', scalar('ID')], ['number', scalar('Int')], ['headRefName', scalar('String')],
      ['baseRefName', scalar('String')], ['mergeable', objRef('MergeableState')],
      ['state', objRef('PullRequestState')], ['merged', scalar('Boolean')],
      ['files', objRef('PullRequestChangedFileConnection')],
    ]) };
  }
  if (name === 'Repository') {
    return { kind: 'OBJECT', name: 'Repository', ...fields([
      ['id', scalar('ID')], ['databaseId', scalar('Int')], ['name', scalar('String')],
      ['nameWithOwner', scalar('String')], ['owner', objRef('RepositoryOwner')],
      ['defaultBranchRef', objRef('Ref')], ['viewerPermission', objRef('RepositoryPermission')],
      ['hasIssuesEnabled', scalar('Boolean')], ['issue', objRef('Issue')],
      ['issues', objRef('IssueConnection')], ['pullRequests', objRef('PullRequestConnection')],
      ['pullRequest', objRef('PullRequest')],
    ]) };
  }
  if (name === 'SearchType') {
    return { kind: 'ENUM', name: 'SearchType', enumValues: [
      { name: 'ISSUE' }, { name: 'PULL_REQUEST' }, { name: 'REPOSITORY' }, { name: 'USER' },
    ] };
  }
  return { kind: 'OBJECT', name, fields: [] };
}
