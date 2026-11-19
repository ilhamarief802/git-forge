// store.ts — the forge's in-memory state: repositories, refs, git objects, issues, labels, pulls.
// Pure data plus small helpers, no HTTP. Every surface (REST, git smart HTTP, GraphQL, MCP) reads
// and writes this one store, so an object created on one surface reads back identically on the others.

import { createHash, randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** The all-zero oid (unborn branch / delete marker). */
export const ZERO_OID = '0'.repeat(40);

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: sha1 over `<type> <size>\0` + bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\u0000`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries (stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object's headers. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag object. */
export function parseTagObject(data: Buffer): { object: string; type: string; tag: string; tagger: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
  };
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTreeBytes(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(left, right);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/**
 * Every object reachable from `roots`: commit → tree + parents, tree → entries (gitlinks skipped),
 * tag → target. Objects a lookup misses are skipped, never a throw.
 */
export function reachableObjects(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (isObjectId(commit.tree)) queue.push(commit.tree);
      for (const parent of commit.parents) if (isObjectId(parent)) queue.push(parent);
    } else if (object.type === 'tag') {
      const target = parseTagObject(object.data).object;
      if (isObjectId(target)) queue.push(target);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        if (isObjectId(entry.oid)) queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// domains
// ---------------------------------------------------------------------------

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  /** `refs/...` -> oid; includes `HEAD` never (HEAD is derived from defaultBranch). */
  refs: Map<string, string>;
  hasIssues: boolean;
  createdAtSeq: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  repoFullName: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  /** Creation order within the repo (monotonic per store). */
  seq: number;
  isPull: boolean;
}

export interface Comment {
  id: number;
  repoFullName: string;
  issueNumber: number;
  body: string;
}

export interface PullRequest {
  id: number;
  number: number;
  repoFullName: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  /** Resolved at creation (and refreshed at read): the head branch tip. */
  headSha: string;
  /** The base branch tip at creation. */
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  /** Files changed between base and head, computed at creation. */
  changedPaths: string[];
}

export interface FileEntry {
  path: string;
  sha: string;
  size: number;
  content: Buffer;
  encoding: 'base64';
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

/** The login every repository belongs to: the token names this user. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'Ada Iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export class Store {
  readonly repos = new Map<string, Repo>(); // key: full_name lowercased
  readonly labels = new Map<string, Map<string, Label>>(); // repoFullName(lower) -> name -> label
  readonly issues = new Map<string, Map<number, Issue>>(); // repoFullName(lower) -> number -> issue
  readonly comments = new Map<string, Comment[]>(); // repoFullName(lower) -> comments in order
  readonly pulls = new Map<string, Map<number, PullRequest>>(); // repoFullName(lower) -> number -> pull
  readonly objects = new Map<string, GitObject>(); // oid -> object (global; oids are content-addressed)
  readonly files = new Map<string, Map<string, FileEntry>>(); // repoFullName(lower) -> path -> entry (working tree at default branch)
  readonly branchFiles = new Map<string, Map<string, Map<string, FileEntry>>>(); // repo -> branch -> path -> entry

  private nextRepoId = 5001;
  private nextIssueSeq = new Map<string, number>();
  private nextCommentId = 1;
  private nextNodeId = 1;
  private requestCounter = 0;

  nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${randomUUID()}`;
  }

  nextGlobalNodeId(): string {
    this.nextNodeId += 1;
    return `node-${this.nextNodeId}`;
  }

  // -- repos ------------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`.toLowerCase();
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoByFullName(fullName: string): Repo | undefined {
    return this.repos.get(fullName.toLowerCase());
  }

  createRepo(name: string, options: { private?: boolean; description?: string; defaultBranch?: string } = {}): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER_LOGIN,
      name,
      fullName: `${VIEWER_LOGIN}/${name}`,
      private: options.private ?? true,
      description: options.description ?? '',
      defaultBranch: options.defaultBranch ?? 'main',
      refs: new Map(),
      hasIssues: true,
      createdAtSeq: this.nextRepoId,
    };
    this.repos.set(repoKeyLower(repo.fullName), repo);
    this.labels.set(repoKeyLower(repo.fullName), new Map());
    this.issues.set(repoKeyLower(repo.fullName), new Map());
    this.pulls.set(repoKeyLower(repo.fullName), new Map());
    this.files.set(repoKeyLower(repo.fullName), new Map());
    this.nextIssueSeq.set(repoKeyLower(repo.fullName), 1);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.repoKey(owner, name);
    const deleted = this.repos.delete(key);
    this.labels.delete(key);
    this.issues.delete(key);
    this.pulls.delete(key);
    this.comments.delete(key);
    this.files.delete(key);
    this.branchFiles.delete(key);
    this.nextIssueSeq.delete(key);
    return deleted;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // -- refs and objects ---------------------------------------------------

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') ref = `refs/heads/${repo.defaultBranch}`;
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    // Accept a bare branch or tag name too.
    const headed = `refs/heads/${ref}`;
    if (repo.refs.has(headed)) return repo.refs.get(headed);
    const tagged = `refs/tags/${ref}`;
    if (repo.refs.has(tagged)) return repo.refs.get(tagged);
    return undefined;
  }

  /** The files (path -> entry) of a ref's tip tree, walking the object graph. */
  filesAtRef(repo: Repo, ref: string): Map<string, FileEntry> | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return null;
    const out = new Map<string, FileEntry>();
    const walkTree = (oid: string, prefix: string, depth: number): void => {
      if (depth > 32) return;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walkTree(entry.oid, path, depth + 1);
        else if (entry.mode === '160000') continue;
        else {
          const blob = this.objects.get(entry.oid);
          if (blob && blob.type === 'blob') {
            out.set(path, { path, sha: entry.oid, size: blob.data.length, content: blob.data, encoding: 'base64' });
          }
        }
      }
    };
    const tipObject = this.objects.get(tip);
    if (!tipObject || tipObject.type !== 'commit') return out;
    walkTree(parseCommit(tipObject.data).tree, '', 0);
    return out;
  }

  /** Build a commit object tree from a flat path->entry map and commit it; returns the new tip. */
  commitFiles(repo: Repo, branch: string, files: Map<string, FileEntry>, message: string): string {
    const rootEntries: TreeEntry[] = [];
    const dirs = new Map<string, { files: Map<string, FileEntry>; dirs: Set<string> }>();
    const rootFiles = new Map<string, FileEntry>();
    // Group by directory.
    const byDir = new Map<string, Map<string, FileEntry>>();
    for (const [path, entry] of files) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const base = slash < 0 ? path : path.slice(slash + 1);
      let bucket = byDir.get(dir);
      if (!bucket) {
        bucket = new Map();
        byDir.set(dir, bucket);
      }
      bucket.set(base, entry);
    }
    const buildDir = (dir: string, depth: number): string => {
      if (depth > 64) throw new Error('path too deep');
      const entries: TreeEntry[] = [];
      const bucket = byDir.get(dir) ?? new Map();
      for (const [name, entry] of bucket) {
        if (name.includes('/')) {
          const subDir = dir === '' ? name.slice(0, name.indexOf('/')) : `${dir}/${name.slice(0, name.indexOf('/'))}`;
          // never happens: buckets hold base names only
        }
        const oid = entry.sha && this.objects.get(entry.sha) ? entry.sha : this.putObject('blob', entry.content);
        entries.push({ mode: '100644', name, oid });
      }
      // Child directories: every distinct first path segment under this dir.
      for (const key of byDir.keys()) {
        if (!key.startsWith(dir === '' ? '' : `${dir}/`)) continue;
        const rest = dir === '' ? key : key.slice(dir.length + 1);
        if (rest === '' || rest.includes('/')) continue;
        const childOid = buildDir(key, depth + 1);
        entries.push({ mode: '40000', name: rest, oid: childOid });
      }
      const bytes = buildTreeBytes(entries);
      return this.putObject('tree', bytes);
    };
    const treeOid = buildDir('', 0);
    const parent = this.resolveRef(repo, branch);
    const parents = parent ? [parent] : [];
    const seq = this.nextTreeCommitSeq();
    const timestamp = 1_700_000_000 + (seq % 1_000_000);
    const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${timestamp} +0000`;
    const lines = [`tree ${treeOid}`];
    for (const parentOid of parents) lines.push(`parent ${parentOid}`);
    lines.push(`author ${identity}`);
    lines.push(`committer ${identity}`);
    lines.push('');
    const commitData = Buffer.from(`${lines.join('\n')}\n${message.endsWith('\n') ? message : `${message}\n`}`, 'utf8');
    return this.putObject('commit', commitData);
  }

  private treeCommitSeq = 0;
  private nextTreeCommitSeq(): number {
    this.treeCommitSeq += 1;
    return this.treeCommitSeq;
  }

  // -- labels / issues / comments / pulls ----------------------------------

  listLabels(repo: Repo): Label[] {
    return [...(this.labels.get(repoKeyLower(repo.fullName))?.values() ?? [])];
  }

  getLabel(repo: Repo, name: string): Label | undefined {
    return this.labels.get(repoKeyLower(repo.fullName))?.get(name);
  }

  createLabel(repo: Repo, name: string, color = 'ededed', description = ''): Label {
    const label: Label = { name, color, description };
    this.labels.get(repoKeyLower(repo.fullName))!.set(name, label);
    return label;
  }

  nextIssueNumber(repo: Repo): number {
    const key = repoKeyLower(repo.fullName);
    const next = this.nextIssueSeq.get(key) ?? 1;
    this.nextIssueSeq.set(key, next + 1);
    return next;
  }

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): Issue {
    const number = this.nextIssueNumber(repo);
    const issue: Issue = {
      id: 9_000_000 + number,
      number,
      repoFullName: repo.fullName,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: input.labels ? [...input.labels] : [],
      seq: number,
      isPull: false,
    };
    this.issues.get(repoKeyLower(repo.fullName))!.set(number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return this.issues.get(repoKeyLower(repo.fullName))?.get(number);
  }

  listIssues(repo: Repo): Issue[] {
    const map = this.issues.get(repoKeyLower(repo.fullName));
    if (!map) return [];
    return [...map.values()].sort((a, b) => a.seq - b.seq);
  }

  createComment(repo: Repo, issueNumber: number, body: string): Comment {
    const comment: Comment = {
      id: this.nextCommentId++,
      repoFullName: repo.fullName,
      issueNumber,
      body,
    };
    const list = this.comments.get(repoKeyLower(repo.fullName));
    if (list) list.push(comment);
    else this.comments.set(repoKeyLower(repo.fullName), [comment]);
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): Comment[] {
    return (this.comments.get(repoKeyLower(repo.fullName)) ?? []).filter((comment) => comment.issueNumber === issueNumber);
  }

  nextPullNumber(repo: Repo): number {
    // GitHub shares the number space between issues and pulls.
    return this.nextIssueNumber(repo);
  }

  createPull(repo: Repo, input: {
    title: string;
    body?: string;
    head: string;
    base: string;
    headSha?: string;
    baseSha?: string;
    changedPaths?: string[];
  }): PullRequest {
    const number = this.nextPullNumber(repo);
    const headSha = input.headSha ?? this.resolveRef(repo, input.head) ?? ZERO_OID;
    const baseSha = input.baseSha ?? this.resolveRef(repo, input.base) ?? ZERO_OID;
    const pull: PullRequest = {
      id: 9_000_000 + number,
      number,
      repoFullName: repo.fullName,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      headRef: input.head,
      baseRef: input.base,
      headSha,
      baseSha,
      mergeCommitSha: null,
      mergedAt: null,
      changedPaths: input.changedPaths ?? [],
    };
    this.pulls.get(repoKeyLower(repo.fullName))!.set(number, pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return this.pulls.get(repoKeyLower(repo.fullName))?.get(number);
  }

  listPulls(repo: Repo): PullRequest[] {
    const map = this.pulls.get(repoKeyLower(repo.fullName));
    if (!map) return [];
    return [...map.values()].sort((a, b) => a.number - b.number);
  }
}

function repoKeyLower(fullName: string): string {
  return fullName.toLowerCase();
}
