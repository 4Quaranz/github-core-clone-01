// rest.ts — GitHub REST v3 under /api/v3. Every reply is application/json and
// carries a non-empty X-GitHub-Request-Id; errors carry {message: string}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN,
  parseCommit,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER } from './scenario.ts';
import { authorized, isRecord, nextRequestId, parseJson, readBody, sendJson } from './http.ts';

function rid(store: Store): Record<string, string> {
  return { 'x-github-request-id': nextRequestId(store) };
}

function errJson(res: ServerResponse, store: Store, status: number, message: string): void {
  sendJson(res, status, { message }, rid(store));
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: `U_${VIEWER.id}`,
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    avatar_url: '',
    html_url: '',
    url: '/api/v3/user',
  };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: repo.gid,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User', avatar_url: '', html_url: '', url: '/api/v3/user' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    git_url: '',
    ssh_url: '',
    clone_url: '',
    created_at: store.ts(repo.createdSeq),
    updated_at: store.ts(repo.updatedSeq),
    pushed_at: store.ts(repo.updatedSeq),
    fork: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    visibility: repo.private ? 'private' : 'public',
    archived: false,
    disabled: false,
    license: null,
    topics: [],
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.dbId,
    node_id: issue.gid,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    created_at: store.ts(issue.createdSeq),
    updated_at: store.ts(issue.updatedSeq),
    closed_at: issue.closedSeq === null ? null : store.ts(issue.closedSeq),
    comments: issue.comments.length,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.dbId,
    node_id: pull.gid,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: VIEWER.login, id: VIEWER.id } },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: VIEWER.login, id: VIEWER.id } },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: store.ts(pull.createdSeq),
    updated_at: store.ts(pull.updatedSeq),
    closed_at: pull.closedSeq === null ? null : store.ts(pull.closedSeq),
    draft: false,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function parseIdent(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(ident);
  if (match === null) return { name: '', email: '', date: '' };
  const epoch = Number(match[3]);
  return { name: match[1] as string, email: match[2] as string, date: new Date(epoch * 1000).toISOString() };
}

/** Read a JSON body; 400 when the body is present but malformed. */
async function readJsonBody(req: IncomingMessage, res: ServerResponse, store: Store): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  const parsed = parseJson(raw);
  if (parsed === null || !isRecord(parsed)) {
    errJson(res, store, 400, 'Problems parsing JSON');
    return null;
  }
  return parsed;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Handle one /api/v3 request. Returns true when the path was a REST route. */
export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  segments: string[],
  query: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (!authorized(req, store)) {
    errJson(res, store, 401, 'Requires authentication');
    return true;
  }
  const headers = rid(store);

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') {
      errJson(res, store, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { ...headers, 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') {
      errJson(res, store, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0' }, headers);
    return true;
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') {
      errJson(res, store, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, userJson(), headers);
    return true;
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const all = [...store.repos.values()].sort((a, b) => a.dbId - b.dbId);
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const outHeaders: Record<string, string> = { ...headers };
      if (page < totalPages) {
        const host = req.headers.host ?? '127.0.0.1';
        const next = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        const last = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${totalPages}`;
        outHeaders.link = `<${next}>; rel="next", <${last}>; rel="last"`;
      }
      sendJson(res, 200, slice.map((repo) => repoJson(store, repo)), outHeaders);
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req, res, store);
      if (body === null) return true;
      const name = typeof body.name === 'string' ? body.name : '';
      const result = store.createRepo(name, typeof body.description === 'string' ? body.description : '', body.private === true);
      if (!result.ok) {
        errJson(res, store, result.status, result.error);
        return true;
      }
      sendJson(res, 201, repoJson(store, result.value), headers);
      return true;
    }
    errJson(res, store, 404, 'Not Found');
    return true;
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeSegment(segments[1] as string);
    const name = decodeSegment(segments[2] as string);
    const repo = store.getRepo(owner, name);
    const rest = segments.slice(3);
    if (repo === undefined) {
      errJson(res, store, 404, 'Not Found');
      return true;
    }
    const repoPath = `/api/v3/repos/${owner}/${name}`;

    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(store, repo), headers);
        return true;
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req, res, store);
        if (body === null) return true;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        repo.updatedSeq = store.nextSeq();
        sendJson(res, 200, repoJson(store, repo), headers);
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        res.writeHead(204, { ...headers });
        res.end();
        return true;
      }
      errJson(res, store, 404, 'Not Found');
      return true;
    }

    const head = rest[0] as string;

    if (head === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = store.listBranches(repo).map((b) => ({
          name: b.name,
          commit: { sha: b.sha, url: `${repoPath}/commits/${b.sha}` },
          protected: false,
        }));
        sendJson(res, 200, list, headers);
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decodeSegment(rest[1] as string);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) {
          errJson(res, store, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { name: branch, commit: { sha, url: `${repoPath}/commits/${sha}` }, protected: false }, headers);
        return true;
      }
      errJson(res, store, 404, 'Not Found');
      return true;
    }

    if (head === 'commits') {
      if (method === 'GET') {
        const sha = query.get('sha') ?? undefined;
        const list = store.listCommits(repo, sha).map(({ sha: commitSha, info }) => {
          const author = parseIdent(info.author);
          const committer = parseIdent(info.committer);
          return {
            sha: commitSha,
            commit: {
              message: info.message,
              author,
              committer,
              tree: { sha: info.tree, url: '' },
            },
            parents: info.parents.map((p) => ({ sha: p })),
            author: { login: VIEWER.login, id: VIEWER.id },
            committer: { login: VIEWER.login, id: VIEWER.id },
            url: `${repoPath}/commits/${commitSha}`,
            html_url: '',
          };
        });
        sendJson(res, 200, list, headers);
        return true;
      }
      errJson(res, store, 404, 'Not Found');
      return true;
    }

    if (head === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = await readJsonBody(req, res, store);
        if (body === null) return true;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        const result = store.createRef(repo, ref, sha);
        if (!result.ok) {
          errJson(res, store, result.status, result.error);
          return true;
        }
        sendJson(res, 201, { ref: result.value.ref, node_id: '', object: { sha: result.value.sha, type: 'commit', url: '' } }, headers);
        return true;
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = rest.slice(2).map(decodeSegment).join('/');
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          errJson(res, store, 404, 'Not Found');
          return true;
        }
        const obj = store.getObject(sha);
        sendJson(res, 200, { ref, node_id: '', object: { sha, type: obj?.type ?? 'commit', url: '' } }, headers);
        return true;
      }
      errJson(res, store, 404, 'Not Found');
      return true;
    }

    if (head === 'contents') {
      const path = rest.slice(1).map(decodeSegment).join('/');
      if (method === 'GET') {
        const result = store.getContent(repo, path, query.get('ref') ?? undefined);
        if (!result.ok) {
          errJson(res, store, result.status, result.error);
          return true;
        }
        sendJson(res, 200, result.value.data, headers);
        return true;
      }
      if (method === 'PUT') {
        const body = await readJsonBody(req, res, store);
        if (body === null) return true;
        const content = typeof body.content === 'string' ? body.content : '';
        const message = typeof body.message === 'string' ? body.message : '';
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        const branch = typeof body.branch === 'string' ? body.branch : undefined;
        const result = store.putContent(repo, path, content, message, sha, branch);
        if (!result.ok) {
          errJson(res, store, result.status, result.error);
          return true;
        }
        sendJson(res, result.value.isUpdate ? 200 : 201, { content: result.value.content, commit: result.value.commit }, headers);
        return true;
      }
      if (method === 'DELETE') {
        const body = await readJsonBody(req, res, store);
        if (body === null) return true;
        const message = typeof body.message === 'string' ? body.message : '';
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        const branch = typeof body.branch === 'string' ? body.branch : undefined;
        const result = store.deleteContent(repo, path, message, sha, branch);
        if (!result.ok) {
          errJson(res, store, result.status, result.error);
          return true;
        }
        sendJson(res, 200, { commit: result.value.commit }, headers);
        return true;
      }
      errJson(res, store, 404, 'Not Found');
      return true;
    }

    if (head === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson), headers);
        return true;
      }
      if (method === 'POST' && rest.length === 1) {
        const body = await readJsonBody(req, res, store);
        if (body === null) return true;
        const result = store.createLabel(
          repo,
          typeof body.name === 'string' ? body.name : '',
          typeof body.color === 'string' ? body.color : 'ededed',
          typeof body.description === 'string' ? body.description : '',
        );
        if (!result.ok) {
          errJson(res, store, result.status, result.error);
          return true;
        }
        sendJson(res, 201, labelJson(result.value), headers);
        return true;
      }
      errJson(res, store, 404, 'Not Found');
      return true;
    }

    if (head === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          const list = store.listIssues(repo, state, sort, direction);
          sendJson(res, 200, list.map((issue) => issueJson(store, repo, issue)), headers);
          return true;
        }
        if (method === 'POST') {
          const body = await readJsonBody(req, res, store);
          if (body === null) return true;
          const title = typeof body.title === 'string' ? body.title : '';
          const issueBody = typeof body.body === 'string' ? body.body : '';
          const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
          const result = store.createIssue(repo, title, issueBody, labels);
          if (!result.ok) {
            errJson(res, store, result.status, result.error);
            return true;
          }
          sendJson(res, 201, issueJson(store, repo, result.value), headers);
          return true;
        }
        errJson(res, store, 404, 'Not Found');
        return true;
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) {
        errJson(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          const issue = repo.issues.get(number);
          if (issue === undefined) {
            errJson(res, store, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, issueJson(store, repo, issue), headers);
          return true;
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req, res, store);
          if (body === null) return true;
          const result = store.patchIssue(repo, number, {
            state: typeof body.state === 'string' ? body.state : undefined,
            title: typeof body.title === 'string' ? body.title : undefined,
            body: typeof body.body === 'string' ? body.body : undefined,
          });
          if (!result.ok) {
            errJson(res, store, result.status, result.error);
            return true;
          }
          sendJson(res, 200, issueJson(store, repo, result.value), headers);
          return true;
        }
        errJson(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          const issue = repo.issues.get(number);
          if (issue === undefined) {
            errJson(res, store, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, issue.comments.map((c) => ({
            id: c.dbId,
            node_id: c.gid,
            body: c.body,
            user: { login: VIEWER.login, id: VIEWER.id },
            created_at: store.ts(c.createdSeq),
            updated_at: store.ts(c.createdSeq),
            html_url: '',
            url: `${repoPath}/issues/${number}/comments/${c.id}`,
          })), headers);
          return true;
        }
        if (method === 'POST') {
          const body = await readJsonBody(req, res, store);
          if (body === null) return true;
          const result = store.createComment(repo, number, typeof body.body === 'string' ? body.body : '');
          if (!result.ok) {
            errJson(res, store, result.status, result.error);
            return true;
          }
          const c = result.value;
          sendJson(res, 201, {
            id: c.dbId,
            node_id: c.gid,
            body: c.body,
            user: { login: VIEWER.login, id: VIEWER.id },
            created_at: store.ts(c.createdSeq),
            updated_at: store.ts(c.createdSeq),
            html_url: '',
            url: `${repoPath}/issues/${number}/comments/${c.id}`,
          }, headers);
          return true;
        }
        errJson(res, store, 404, 'Not Found');
        return true;
      }
      errJson(res, store, 404, 'Not Found');
      return true;
    }

    if (head === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const list = store.listPulls(repo, state);
          sendJson(res, 200, list.map((pull) => pullJson(store, repo, pull)), headers);
          return true;
        }
        if (method === 'POST') {
          const body = await readJsonBody(req, res, store);
          if (body === null) return true;
          const result = store.createPull(
            repo,
            typeof body.title === 'string' ? body.title : '',
            typeof body.body === 'string' ? body.body : '',
            typeof body.head === 'string' ? body.head : '',
            typeof body.base === 'string' ? body.base : '',
          );
          if (!result.ok) {
            errJson(res, store, result.status, result.error);
            return true;
          }
          sendJson(res, 201, pullJson(store, repo, result.value), headers);
          return true;
        }
        errJson(res, store, 404, 'Not Found');
        return true;
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) {
        errJson(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const pull = repo.pulls.get(number);
        if (pull === undefined) {
          errJson(res, store, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pullJson(store, repo, pull), headers);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const pull = repo.pulls.get(number);
        if (pull === undefined) {
          errJson(res, store, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, store.pullFiles(repo, pull), headers);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const body = await readJsonBody(req, res, store);
        if (body === null) return true;
        const pull = repo.pulls.get(number);
        if (pull === undefined) {
          errJson(res, store, 404, 'Not Found');
          return true;
        }
        const result = store.mergePull(repo, pull, typeof body.merge_method === 'string' ? body.merge_method : '');
        if (!result.ok) {
          errJson(res, store, result.status, result.error);
          return true;
        }
        sendJson(res, 200, result.value, headers);
        return true;
      }
      errJson(res, store, 404, 'Not Found');
      return true;
    }

    errJson(res, store, 404, 'Not Found');
    return true;
  }

  // Unknown /api/v3 route: JSON 404.
  errJson(res, store, 404, 'Not Found');
  return true;
}
