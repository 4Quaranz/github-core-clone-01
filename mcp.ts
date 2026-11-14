// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0).
// Modern revision 2026-07-28 via server/discover, plus the legacy initialize
// handshake. Tools act on the same store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { VIEWER } from './scenario.ts';
import { authorized, isRecord, parseJson, readBody, sendJson } from './http.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: repo.gid,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: store.ts(repo.createdSeq),
    updated_at: store.ts(repo.updatedSeq),
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.dbId,
    node_id: issue.gid,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: store.ts(issue.createdSeq),
    updated_at: store.ts(issue.updatedSeq),
    closed_at: issue.closedSeq === null ? null : store.ts(issue.closedSeq),
    comments: issue.comments.length,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.dbId,
    node_id: pull.gid,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha },
    base: { ref: pull.baseRef, sha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: store.ts(pull.createdSeq),
    updated_at: store.ts(pull.updatedSeq),
  };
}

/** Resolve owner/repo from arguments (owner+repo, or full_name, or synonyms). */
function resolveRepo(store: Store, args: Record<string, unknown>): { owner: string; repo: string; name: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : '';
  if (name === '' && typeof args.repository === 'string') name = args.repository as string;
  if (name === '' && typeof args.repo_name === 'string') name = args.repo_name as string;
  if ((owner === '' || name === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      if (owner === '') owner = parts[0] as string;
      if (name === '') name = parts[1] as string;
    }
  }
  if (owner === '' || name === '') return null;
  return { owner, repo: name, name };
}

function findTool(name: string): ToolDef | undefined {
  const lower = name.toLowerCase();
  return TOOLS.find((tool) => {
    const toolLower = tool.name.toLowerCase();
    return lower === toolLower || lower.endsWith(`__${toolLower}`) || lower.endsWith(`_${toolLower}`) || toolLower.endsWith(lower);
  });
}

function toolResult(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (tool === undefined) {
    return toolError(`Unknown tool: ${name}`);
  }
  // Missing required arguments.
  for (const required of tool.inputSchema.required) {
    const present =
      args[required] !== undefined ||
      (required === 'repo' && (args.repository !== undefined || args.repo_name !== undefined || args.full_name !== undefined)) ||
      ((required === 'owner' || required === 'repo') && args.full_name !== undefined) ||
      (required === 'pull_number' && (args.number !== undefined || args.pullNumber !== undefined));
    if (!present) return toolError(`Missing required argument: ${required}`);
  }

  if (tool.name === 'create_repo') {
    const repoName = String(args.name ?? '');
    const result = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
    if (!result.ok) return toolError(result.error);
    return toolResult(repoJson(store, result.value));
  }

  const resolved = resolveRepo(store, args);
  if (resolved === null) return toolError('A repository owner and name are required.');
  const repo = store.getRepo(resolved.owner, resolved.repo);

  if (tool.name === 'get_repo') {
    if (repo === undefined) return toolError('Not Found');
    return toolResult(repoJson(store, repo));
  }
  if (repo === undefined) return toolError('Not Found');

  if (tool.name === 'create_issue') {
    const result = store.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
    if (!result.ok) return toolError(result.error);
    return toolResult(issueJson(store, repo, result.value));
  }
  if (tool.name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = store.listIssues(repo, state, 'created', 'desc');
    return toolResult(list.map((issue) => issueJson(store, repo, issue)));
  }
  if (tool.name === 'create_pull_request') {
    const result = store.createPull(
      repo,
      String(args.title ?? ''),
      typeof args.body === 'string' ? args.body : '',
      String(args.head ?? ''),
      String(args.base ?? ''),
    );
    if (!result.ok) return toolError(result.error);
    return toolResult(pullJson(store, repo, result.value));
  }
  if (tool.name === 'merge_pull_request') {
    const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : Number(args.pull_number ?? args.number ?? NaN);
    if (!Number.isInteger(number)) return toolError('A pull request number is required.');
    const pull = repo.pulls.get(number);
    if (pull === undefined) return toolError('Not Found');
    const result = store.mergePull(repo, pull, 'squash');
    if (!result.ok) return toolError(result.error);
    return toolResult({ merged: true, sha: result.value.sha, message: result.value.message, number });
  }
  return toolError(`Unknown tool: ${name}`);
}

/** POST /mcp. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (!authorized(req, store)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const raw = await readBody(req);
  const parsed = parseJson(raw);
  if (parsed === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const id = parsed.id === undefined ? null : parsed.id;
  const params = isRecord(parsed.params) ? parsed.params : {};
  // A notification (no id) is accepted with 202 and no body.
  if (id === null && parsed.id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  const result = (value: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: value });
  };
  const rpcError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  if (method === 'server/discover') {
    result({
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return;
  }
  if (method === 'initialize') {
    const requested = typeof (params as Record<string, unknown>).protocolVersion === 'string' ? ((params as Record<string, unknown>).protocolVersion as string) : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0] as string;
    result({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'ping') {
    result({});
    return;
  }
  if (method === 'tools/list') {
    result({ tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = findTool(name);
    if (tool === undefined) {
      rpcError(-32602, `Unknown tool: ${name}`);
      return;
    }
    result(callTool(store, name, args));
    return;
  }
  rpcError(-32601, `Method not found: ${method}`);
}
