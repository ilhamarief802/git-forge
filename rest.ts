// rest.ts — REST v3 on top of the Store: repositories, contents, labels, issues,
// comments, pull requests and the merge endpoint. Every reply is JSON, and every
// reply carries X-GitHub-Request-Id.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  commentView, commitView, contentView, issueView, labelView, pullView, repoView,
  userView,
} from './views.ts';
import { parseCommit } from './store.ts';
import type { Repo, Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const PER_PAGE = 30;

export interface Ctx {
  store: Store;
  token: string;
  login: string;
}

function send(res: ServerResponse, status: number, body: unknown,
              headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
    ...headers,
  });
  res.end(text);
}

const notFound = (res: ServerResponse) => send(res, 404, { message: 'Not Found' });
const unauth = (res: ServerResponse) => send(res, 401, { message: 'Requires authentication' });
const badJson = (res: ServerResponse) => send(res, 400, { message: 'Problems parsing JSON' });

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await body(req);
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
}

function authed(req: IncomingMessage, ctx: Ctx): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m !== null && m[1].trim() === ctx.token;
}

export async function handleRest(req: IncomingMessage, res: ServerResponse,
                                 path: string, ctx: Ctx): Promise<void> {
  if (!authed(req, ctx)) return unauth(res);
  const method = req.method ?? 'GET';
  const { store } = ctx;

  // ── root, meta, user ─────────────────────────────────────────────────────
  if (path === '/api/v3' || path === '/api/v3/') {
    return send(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_repositories_url: '/api/v3/user/repos',
    }, { 'x-oauth-scopes': 'repo, read:org, gist' });
  }
  if (path === '/api/v3/meta') {
    return send(res, 200, { installed_version: 'forge-1.0.0',
                            verifiable_password_authentication: true });
  }
  if (path === '/api/v3/user') return send(res, 200, userView(ctx.login));
  if (path === '/api/v3/rate_limit') {
    return send(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 0 } } });
  }

  // ── the viewer's repositories ────────────────────────────────────────────
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const all = store.listRepos();
      const page = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('page') ?? 1);
      const per = Math.min(100, Number(new URL(req.url ?? '/', 'http://x')
        .searchParams.get('per_page') ?? PER_PAGE));
      const slice = all.slice((page - 1) * per, page * per);
      const headers: Record<string, string> = {};
      if (page * per < all.length) {
        // The suite rejects a Link that leaves the origin, so it is absolute.
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
        headers.link = `<${origin}/api/v3/user/repos?page=${page + 1}&per_page=${per}>; rel="next"`;
      }
      return send(res, 200, slice.map((r) => repoView(store, r)), headers);
    }
    if (method === 'POST') {
      let payload: Record<string, unknown>;
      try {
        payload = await json(req);
      } catch {
        return badJson(res);
      }
      const name = String(payload.name ?? '').trim();
      if (!name) return send(res, 422, { message: 'Repository name is required' });
      const repo = store.createRepo(name, {
        private: payload.private === true,
        description: String(payload.description ?? ''),
      });
      return send(res, 201, repoView(store, repo));
    }
    return notFound(res);
  }

  // ── one repository and everything under it ───────────────────────────────
  const m = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return notFound(res);
  const [, owner, name, rest = ''] = m;
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound(res);
  if (repo.owner.toLowerCase() !== ctx.login.toLowerCase()) return notFound(res);

  if (rest === '' || rest === '/') {
    if (method === 'GET') return send(res, 200, repoView(store, repo));
    if (method === 'PATCH') {
      try {
        const payload = await json(req);
        if (typeof payload.description === 'string') repo.description = payload.description;
        if (typeof payload.private === 'boolean') repo.private = payload.private;
        if (typeof payload.has_issues === 'boolean') repo.hasIssues = payload.has_issues;
      } catch {
        return badJson(res);
      }
      return send(res, 200, repoView(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      res.writeHead(204, { 'x-github-request-id': randomUUID() });
      res.end();
      return;
    }
    return notFound(res);
  }

  if (rest === '/commits' && method === 'GET') {
    const sha = new URL(req.url ?? '/', 'http://x').searchParams.get('sha')
      ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, sha);
    if (!tip) return send(res, 200, []);
    const out: Record<string, unknown>[] = [];
    let cursor: string | undefined = tip;
    let guard = 0;
    while (cursor && guard++ < 100) {
      const obj = store.getObject(cursor);
      if (!obj || obj.type !== 'commit') break;
      const parsed = parseCommit(obj.data);
      out.push({
        sha: cursor,
        commit: {
          message: parsed.message.replace(/\n+$/, ''),
          author: { name: 'Forge', date: new Date(0).toISOString() },
        },
        parents: parsed.parents.map((p) => ({ sha: p })),
      });
      cursor = parsed.parents[0];
    }
    return send(res, 200, out);
  }

  if (rest === '/branches' && method === 'GET') {
    return send(res, 200, [...repo.refs.keys()]
      .filter((r) => r.startsWith('refs/heads/'))
      .map((r) => ({ name: r.slice('refs/heads/'.length),
                     commit: { sha: repo.refs.get(r) } })));
  }

  if (rest === '/labels') {
    if (method === 'POST') {
      try {
        const payload = await json(req);
        const label = store.createLabel(repo, String(payload.name ?? ''),
                                        String(payload.color ?? 'ededed'),
                                        String(payload.description ?? ''));
        return send(res, 201, labelView(label));
      } catch {
        return badJson(res);
      }
    }
    if (method === 'GET') return send(res, 200, store.listLabels(repo).map(labelView));
  }

  if (rest === '/issues' || rest === '/issues/') {
    if (method === 'POST') return createIssue(req, res, store, repo);
    if (method === 'GET') {
      const query = new URL(req.url ?? '/', 'http://x').searchParams;
      const wanted = query.get('state') ?? 'open';
      const direction = (query.get('direction') ?? 'desc').toLowerCase();
      const rows = store.listIssues(repo)
        .filter((i) => (wanted === 'all' ? true : i.state === wanted))
        // Newest first is GitHub's default; direction=asc reverses it.
        .sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const labels = store.listLabels(repo);
      return send(res, 200, rows.map((i) => issueView(repo, i, labels)));
    }
    return notFound(res);
  }

  const issueM = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
  if (issueM) {
    const issue = store.getIssue(repo, Number(issueM[1]));
    if (!issue) return notFound(res);
    if (issueM[2]) {
      if (method === 'POST') {
        try {
          const payload = await json(req);
          const comment = store.createComment(repo, issue.number, String(payload.body ?? ''));
          return send(res, 201, commentView(repo, comment));
        } catch {
          return badJson(res);
        }
      }
      if (method === 'GET') {
        return send(res, 200, store.listComments(repo, issue.number)
          .map((c) => commentView(repo, c)));
      }
      return notFound(res);
    }
    if (method === 'GET') return send(res, 200, issueView(repo, issue, store.listLabels(repo)));
    if (method === 'PATCH') {
      try {
        const payload = await json(req);
        if (typeof payload.title === 'string') issue.title = payload.title;
        if (typeof payload.body === 'string') issue.body = payload.body;
        if (payload.state === 'closed' || payload.state === 'open') issue.state = payload.state;
        if (Array.isArray(payload.labels)) issue.labels = payload.labels.map(String);
      } catch {
        return badJson(res);
      }
      return send(res, 200, issueView(repo, issue, store.listLabels(repo)));
    }
  }

  if (rest === '/pulls' || rest === '/pulls/') {
    if (method === 'POST') return createPull(req, res, store, repo);
    if (method === 'GET') {
      const wanted = new URL(req.url ?? '/', 'http://x').searchParams.get('state') ?? 'open';
      const rows = store.listPulls(repo)
        .filter((p) => (wanted === 'all' ? true : p.state === wanted));
      return send(res, 200, rows.map((p) => pullView(store, repo, p)));
    }
    return notFound(res);
  }

  const pullM = /^\/pulls\/(\d+)$/.exec(rest);
  if (pullM) {
    const pull = store.getPull(repo, Number(pullM[1]));
    if (!pull) return notFound(res);
    if (method === 'GET') return send(res, 200, pullView(store, repo, pull));
    if (method === 'PATCH') {
      try {
        const payload = await json(req);
        if (typeof payload.title === 'string') pull.title = payload.title;
        if (typeof payload.body === 'string') pull.body = payload.body;
        if (payload.state === 'closed' || payload.state === 'open') pull.state = payload.state;
      } catch {
        return badJson(res);
      }
      return send(res, 200, pullView(store, repo, pull));
    }
  }

  const filesM = /^\/pulls\/(\d+)\/files$/.exec(rest);
  if (filesM && method === 'GET') {
    const pull = store.getPull(repo, Number(filesM[1]));
    if (!pull) return notFound(res);
    const base = store.filesAtRef(repo, pull.baseRef) ?? new Map();
    const head = store.filesAtRef(repo, pull.headRef) ?? new Map();
    const rows = [...head.entries()].map(([path, entry]) => ({
      sha: entry.sha,
      filename: path,
      status: base.has(path) ? 'modified' : 'added',
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: '',
    }));
    return send(res, 200, rows);
  }

  const mergeM = /^\/pulls\/(\d+)\/merge$/.exec(rest);
  if (mergeM && method === 'PUT') return mergePull(res, store, repo, Number(mergeM[1]));

  if (rest.startsWith('/contents')) {
    // The suite commits onto a named branch (?branch= / body.branch), so the
    // branch has to travel with the request or every PR fixture 404s.
    const contentsQuery = new URL(req.url ?? '/', 'http://x').searchParams;
    const branchInQuery = contentsQuery.get('branch') ?? contentsQuery.get('ref');
    return handleContents(req, res, store, repo, rest, branchInQuery);
  }

  if (rest === '/git/refs') {
    if (method === 'POST') {
      // Create a branch: the suite's preparePull starts every PR this way.
      let payload: Record<string, unknown>;
      try {
        payload = await json(req);
      } catch {
        return badJson(res);
      }
      const ref = String(payload.ref ?? '');
      const sha = String(payload.sha ?? '');
      if (!ref.startsWith('refs/')) return send(res, 422, { message: 'ref is required' });
      if (!sha) return send(res, 422, { message: 'sha is required' });
      if (!store.getObject(sha)) return send(res, 422, { message: 'Object does not exist' });
      repo.refs.set(ref, sha);
      return send(res, 201, { ref, node_id: ref, url: `${'https://forge.example.invalid'}/api/v3/repos/${repo.fullName}/git/refs`, object: { sha, type: 'commit' } });
    }
    if (method === 'GET') {
      return send(res, 200, [...repo.refs.entries()].map(([ref, sha]) => ({
        ref, object: { sha, type: 'commit' },
      })));
    }
  }

  if (rest.startsWith('/git/refs/') && method === 'GET') {
    const ref = `refs/${rest.replace(/^\/git\/refs\//, '')}`;
    const sha = repo.refs.get(ref);
    if (!sha) return notFound(res);
    return send(res, 200, { ref, object: { sha, type: 'commit' } });
  }

  return notFound(res);
}

// ── issues / pulls ─────────────────────────────────────────────────────────

async function createIssue(req: IncomingMessage, res: ServerResponse, store: Store,
                           repo: Repo): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await json(req);
  } catch {
    return badJson(res);
  }
  const labels = Array.isArray(payload.labels) ? payload.labels.map(String) : [];
  for (const label of labels) {
    if (!store.getLabel(repo, label)) {
      return send(res, 422, { message: `Label does not exist: ${label}` });
    }
  }
  const issue = store.createIssue(repo, {
    title: String(payload.title ?? ''),
    body: String(payload.body ?? ''),
    labels,
  });
  if (payload.state === 'closed') issue.state = 'closed';
  return send(res, 201, issueView(repo, issue, store.listLabels(repo)));
}

async function createPull(req: IncomingMessage, res: ServerResponse, store: Store,
                          repo: Repo): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await json(req);
  } catch {
    return badJson(res);
  }
  const head = String(payload.head ?? '');
  const base = String(payload.base ?? repo.defaultBranch);
  if (!store.resolveRef(repo, head)) {
    return send(res, 422, { message: `No commits on ${head}` });
  }
  const pull = store.createPull(repo, {
    title: String(payload.title ?? ''),
    body: String(payload.body ?? ''),
    head, base,
  });
  return send(res, 201, pullView(store, repo, pull));
}

/** Squash-merge the head branch onto the base: one new commit, ref moved. */
function mergePull(res: ServerResponse, store: Store, repo: Repo, number: number): void {
  const pull = store.getPull(repo, number);
  if (!pull) return notFound(res);
  if (pull.merged) return send(res, 405, { message: 'Pull Request is not mergeable' });
  const headFiles = store.filesAtRef(repo, pull.headRef);
  if (!headFiles) return send(res, 405, { message: 'Pull Request is not mergeable' });
  // A conflicted pull is one whose head does not descend from the base tip: git
  // could not fast-forward it, so a squash merge is refused with 405.
  const baseTip = store.resolveRef(repo, pull.baseRef);
  const headTip = store.resolveRef(repo, pull.headRef);
  if (baseTip && headTip && !isAncestorOf(store, baseTip, headTip)) {
    return send(res, 405, { message: 'Pull Request is not mergeable' });
  }
  const baseRef = `refs/heads/${pull.baseRef}`;
  const sha = store.commitFiles(repo, pull.baseRef,
    headFiles, `Merge pull request #${pull.number}: ${pull.title}`);
  repo.refs.set(baseRef, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = sha;
  return send(res, 200, {
    sha,
    merged: true,
    message: 'Pull Request successfully merged',
  });
}

// ── contents ───────────────────────────────────────────────────────────────

async function handleContents(req: IncomingMessage, res: ServerResponse, store: Store,
                              repo: Repo, rest: string,
                              branchInQuery: string | null): Promise<void> {
  const method = req.method ?? 'GET';
  const raw = rest.replace(/^\/contents\/?/, '');
  const full = raw !== '' && !raw.includes('.') && !raw.includes('/') &&
               store.filesAtRef(repo, repo.defaultBranch)?.has(raw) !== true &&
               [...(store.filesAtRef(repo, repo.defaultBranch)?.keys() ?? [])]
                 .some((k) => k.startsWith(`${raw}/`));
  if (method === 'GET') {
    const branch = branchInQuery ?? repo.defaultBranch;
    const files = store.filesAtRef(repo, branch) ?? new Map();
    if (raw === '') {
      return send(res, 200, [...files.values()].map((f) => ({
        name: f.path.split('/').pop(), path: f.path, sha: f.sha, size: f.size,
        type: 'file',
      })));
    }
    if (full) {
      return send(res, 200, [...files.values()]
        .filter((f) => f.path.startsWith(`${raw}/`))
        .map((f) => ({ name: f.path.split('/').pop(), path: f.path, sha: f.sha,
                       size: f.size, type: 'file' })));
    }
    const entry = files.get(decodeURIComponent(raw));
    if (!entry) return notFound(res);
    return send(res, 200, contentView(repo, entry.path, entry.sha, entry.content,
                                      repo.defaultBranch));
  }

  if (method === 'PUT') {
    let payload: Record<string, unknown>;
    try {
      payload = await json(req);
    } catch {
      return badJson(res);
    }
    const path = decodeURIComponent(raw);
    const branch = typeof payload.branch === 'string' && payload.branch !== ''
      ? payload.branch : (branchInQuery ?? repo.defaultBranch);
    const files = store.filesAtRef(repo, branch) ?? new Map();
    const existing = files.get(path);
    const provided = payload.sha === undefined || payload.sha === null
      ? null : String(payload.sha);
    if (existing && provided !== null && provided !== existing.sha) {
      return send(res, 409, { message: 'sha does not match' });
    }
    const content = decodeContent(payload);
    const parent = store.resolveRef(repo, branch);
    files.set(path, { path, sha: '', size: content.length, content, encoding: 'base64' });
    const message = String(payload.message ?? 'Update content');
    const sha = store.commitFiles(repo, branch, files, message);
    repo.refs.set(`refs/heads/${branch}`, sha);
    const stored = store.filesAtRef(repo, branch)?.get(path);
    return send(res, existing ? 200 : 201, {
      content: contentView(repo, path, stored?.sha ?? '', content, branch),
      commit: commitView(repo, sha, message, parent ? [parent] : []),
    });
  }

  if (method === 'DELETE') {
    let payload: Record<string, unknown> = {};
    try {
      const bytes = await body(req);
      if (bytes.length) payload = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    } catch {
      return badJson(res);
    }
    const path = decodeURIComponent(raw);
    const branch = typeof payload.branch === 'string' && payload.branch !== ''
      ? payload.branch : (branchInQuery ?? repo.defaultBranch);
    const files = store.filesAtRef(repo, branch) ?? new Map();
    if (!files.has(path)) return notFound(res);
    files.delete(path);
    const parent = store.resolveRef(repo, branch);
    const message = String(payload.message ?? 'Delete content');
    const sha = store.commitFiles(repo, branch, files, message);
    repo.refs.set(`refs/heads/${branch}`, sha);
    return send(res, 200, { commit: { sha } });
  }

  return notFound(res);
}

/** Is `ancestor` reachable from `tip` (commits only, bounded)? */
function isAncestorOf(store: Store, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  let budget = 5000;
  while (queue.length && budget-- > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.getObject(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const line of obj.data.toString('utf8').split('\n')) {
      if (line.startsWith('parent ')) {
        const parent = line.slice(7).trim();
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
  }
  return false;
}

function decodeContent(payload: Record<string, unknown>): Buffer {
  const raw = payload.content;
  if (typeof raw !== 'string') return Buffer.alloc(0);
  // GitHub's contents API is base64 unless the caller says otherwise, and the
  // suite omits the field entirely — so base64 is the default, not the exception.
  if (payload.encoding === 'utf-8' || payload.encoding === 'utf8') {
    return Buffer.from(raw, 'utf8');
  }
  return Buffer.from(raw.replace(/[\r\n\t ]+/g, ''), 'base64');
}
