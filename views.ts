// views.ts — the JSON shapes the suite reads back, built from the store's own
// types. One place for every GitHub-shaped object, so REST, GraphQL and MCP
// cannot drift apart.

import type { Comment, Issue, Label, PullRequest, Repo, Store } from './store.ts';
import { VIEWER_LOGIN } from './store.ts';

const HOST = 'https://forge.example.invalid';

export function userView(login = VIEWER_LOGIN): Record<string, unknown> {
  let id = 0;
  for (const ch of login) id = (id * 31 + ch.charCodeAt(0)) % 100000;
  return { login, id, node_id: `U_${id}`, type: 'User', site_admin: false };
}

export function repoView(store: Store, repo: Repo): Record<string, unknown> {
  const full = repo.fullName;
  const head = store.resolveRef(repo, 'HEAD');
  return {
    id: repo.id,
    node_id: Buffer.from(`04:Repository${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: full,
    owner: userView(repo.owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    has_issues: repo.hasIssues,
    open_issues_count: store.listIssues(repo).filter((i) => i.state === 'open').length,
    created_at: new Date(repo.createdAtSeq * 1000).toISOString(),
    updated_at: new Date(repo.createdAtSeq * 1000).toISOString(),
    pushed_at: head ? new Date(repo.createdAtSeq * 1000).toISOString() : null,
    clone_url: `${HOST}/${full}.git`,
    html_url: `${HOST}/${full}`,
    url: `${HOST}/api/v3/repos/${full}`,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelView(label: Label): Record<string, unknown> {
  return {
    id: [...label.name].reduce((n, ch) => n + ch.charCodeAt(0), 0),
    node_id: `L_${label.name}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

const ISO = new Date(0).toISOString();

export function issueView(repo: Repo, issue: Issue, labels: Label[]): Record<string, unknown> {
  const full = repo.fullName;
  const serialised = labels.length === 0 ? [] : labels.map(labelView);
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: serialised,
    user: userView(),
    comments: 0,
    created_at: ISO,
    updated_at: ISO,
    html_url: `${HOST}/${full}/issues/${issue.number}`,
    url: `${HOST}/api/v3/repos/${full}/issues/${issue.number}`,
    repository_url: `${HOST}/api/v3/repos/${full}`,
  };
}

export function commentView(repo: Repo, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    issue_number: comment.issueNumber,
    user: userView(),
    created_at: new Date(comment.id * 1000).toISOString(),
    url: `${HOST}/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
  };
}

export function pullView(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const full = repo.fullName;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    head: {
      ref: pull.headRef,
      label: `${repo.owner}:${pull.headRef}`,
      sha: store.resolveRef(repo, pull.headRef) ?? pull.headSha,
    },
    base: {
      ref: pull.baseRef,
      label: `${repo.owner}:${pull.baseRef}`,
      sha: store.resolveRef(repo, pull.baseRef) ?? pull.baseSha,
    },
    user: userView(),
    changed_files: pull.changedPaths.length,
    created_at: new Date(pull.number * 1000).toISOString(),
    updated_at: new Date(pull.number * 1000).toISOString(),
    html_url: `${HOST}/${full}/pull/${pull.number}`,
    url: `${HOST}/api/v3/repos/${full}/pulls/${pull.number}`,
  };
}

export function contentView(repo: Repo, path: string, sha: string, content: Buffer,
                            ref: string): Record<string, unknown> {
  const full = repo.fullName;
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: content.length,
    name,
    path,
    sha,
    content: content.toString('base64'),
    url: `${HOST}/api/v3/repos/${full}/contents/${path}?ref=${ref}`,
    git_url: `${HOST}/api/v3/repos/${full}/git/blobs/${sha}`,
    html_url: `${HOST}/${full}/blob/${ref}/${path}`,
    download_url: `${HOST}/${full}/raw/${ref}/${path}`,
  };
}

export function commitView(repo: Repo, sha: string, message: string,
                           parents: string[]): Record<string, unknown> {
  const iso = new Date().toISOString();
  const person = { name: 'Forge', email: 'forge@example.invalid', date: iso };
  return {
    sha,
    node_id: sha,
    message,
    author: person,
    committer: person,
    parents: parents.map((p) => ({ sha: p })),
    url: `${HOST}/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
    html_url: `${HOST}/${repo.fullName}/commit/${sha}`,
  };
}
