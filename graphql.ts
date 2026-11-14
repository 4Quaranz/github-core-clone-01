// graphql.ts — a small GraphQL executor for the documents gh and
// github-mcp-server send. It parses queries, mutations, fragments and
// variables, resolves them against the same store as REST, and answers
// unknown fields with HTTP 200 + an errors array naming the field.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN,
  gid,
  parseGid,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER } from './scenario.ts';
import { authorized, isRecord, parseJson, readBody, sendJson } from './http.ts';

// ---------------------------------------------------------------------------
// lexer + parser (the subset the suite's documents use)
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$()[]{}:=@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else out += esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}
interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; defaultValue: ValueNode | null }[];
  selectionSet: SelectionNode[];
}
interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}
type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.kind}`);
  }
  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }
  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      this.next();
      return this.parseOperation(token.value as 'query' | 'mutation');
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      const selectionSet = this.parseSelectionSet();
      return { kind: 'fragment', name, typeCondition, selectionSet };
    }
    if (token.kind === 'punct' && token.value === '{') {
      return this.parseOperation('query');
    }
    throw new Error(`unexpected definition ${token.kind}`);
  }

  private parseOperation(operation: 'query' | 'mutation'): OperationNode {
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name') {
      name = this.next().value as string;
    }
    const variables: { name: string; defaultValue: ValueNode | null }[] = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.isPunct('=')) {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    // Directives (parsed, ignored).
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArguments();
    }
    const selectionSet = this.parseSelectionSet();
    return { kind: 'operation', operation, name, variables, selectionSet };
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value !== 'on') {
        return { kind: 'spread', name: this.next().value as string };
      }
      let typeCondition: string | null = null;
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      while (this.isPunct('@')) {
        this.next();
        this.expectName();
        if (this.isPunct('(')) this.parseArguments();
      }
      return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.isPunct('(') ? this.parseArguments() : [];
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArguments();
    }
    const selectionSet = this.isPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const args: { name: string; value: ValueNode }[] = [];
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

type NodeValue = Record<string, unknown> & { __typename: string };

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string; path: string[] }[];
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PullRequestFileConnection: ['nodes'],
  PageInfo: ['hasNextPage', 'endCursor'],
  BranchRef: ['name'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  PullRequestFile: ['path'],
};

const SEARCH_TYPE_VALUES = ['COMMIT', 'DISCUSSION', 'ISSUE', 'LABEL', 'MILESTONE', 'PULLREQUEST', 'REPOSITORY', 'USER'];

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

function issueNode(repo: Repo, issue: Issue): NodeValue {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): NodeValue {
  return { __typename: 'PullRequest', repo, pull };
}

function repoNode(repo: Repo): NodeValue {
  return { __typename: 'Repository', repo };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

class FieldError extends Error {}

function resolveField(ctx: ExecContext, typeName: string, field: FieldNode, parent: NodeValue): unknown {
  const args = argsOf(field, ctx.variables);
  const store = ctx.store;

  if (field.name === '__typename') return typeName;

  if (typeName === 'Query') {
    if (field.name === 'viewer') {
      return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
    }
    if (field.name === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      const repo = store.getRepo(owner, name);
      return repo === undefined ? null : repoNode(repo);
    }
    if (field.name === 'node') {
      const parsed = parseGid(String(args.id ?? ''));
      if (parsed === null) return null;
      const repo = store.reposById.get(parsed.repoDbId);
      if (repo === undefined) return null;
      if (parsed.kind === 'repo') return repoNode(repo);
      if (parsed.kind === 'issue') {
        const issue = repo.issues.get(parsed.number);
        return issue === undefined ? null : issueNode(repo, issue);
      }
      if (parsed.kind === 'pr') {
        const pull = repo.pulls.get(parsed.number);
        return pull === undefined ? null : pullNode(repo, pull);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      const fields = TYPE_FIELDS[name];
      if (fields === undefined && name !== 'SearchType') return null;
      return {
        __typename: '__Type',
        name,
        fields: fields === undefined ? null : fields.map((f) => ({ __typename: '__Field', name: f })),
        enumValues: name === 'SearchType' ? SEARCH_TYPE_VALUES.map((v) => ({ __typename: '__EnumValue', name: v })) : null,
      };
    }
    if (field.name === '__schema') {
      return { __typename: '__Schema', queryType: { __typename: '__Type', name: 'Query' }, mutationType: { __typename: '__Type', name: 'Mutation' } };
    }
    throw new FieldError(`Cannot query field "${field.name}" on type "Query".`);
  }

  if (typeName === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed === null ? undefined : store.reposById.get(parsed.repoDbId);
      if (repo === undefined) throw new FieldError('Repository not found.');
      const result = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if (!result.ok) throw new FieldError(result.error);
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, result.value) };
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.issueId ?? ''));
      const repo = parsed === null ? undefined : store.reposById.get(parsed.repoDbId);
      const issue = repo?.issues.get(parsed?.number ?? -1);
      if (repo === undefined || issue === undefined) throw new FieldError('Issue not found.');
      const result = store.patchIssue(repo, issue.number, { state: 'closed' });
      if (!result.ok) throw new FieldError(result.error);
      return { __typename: 'CloseIssuePayload', issue: issueNode(repo, result.value) };
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.repositoryId ?? ''));
      const repo = parsed === null ? undefined : store.reposById.get(parsed.repoDbId);
      if (repo === undefined) throw new FieldError('Repository not found.');
      const result = store.createPull(repo, String(input.title ?? ''), '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if (!result.ok) throw new FieldError(result.error);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, result.value) };
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.pullRequestId ?? ''));
      const repo = parsed === null ? undefined : store.reposById.get(parsed.repoDbId);
      const pull = repo?.pulls.get(parsed?.number ?? -1);
      if (repo === undefined || pull === undefined) throw new FieldError('Pull request not found.');
      const result = store.mergePull(repo, pull, 'squash');
      if (!result.ok) throw new FieldError(result.error);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(String(input.subjectId ?? ''));
      const repo = parsed === null ? undefined : store.reposById.get(parsed.repoDbId);
      if (repo === undefined || parsed === null) throw new FieldError('Subject not found.');
      if (parsed.kind === 'issue') {
        const result = store.createComment(repo, parsed.number, String(input.body ?? ''));
        if (!result.ok) throw new FieldError(result.error);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', id: result.value.gid, body: result.value.body } },
        };
      }
      throw new FieldError('Comments can only be added to issues.');
    }
    throw new FieldError(`Cannot query field "${field.name}" on type "Mutation".`);
  }

  if (typeName === 'Repository') {
    const repo = parent.repo as Repo;
    switch (field.name) {
      case 'id':
        return repo.gid;
      case 'databaseId':
        return repo.dbId;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return { __typename: 'User', login: repo.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : { __typename: 'BranchRef', name: repo.defaultBranch };
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : issueNode(repo, issue);
      }
      case 'issues': {
        let list = [...repo.issues.values()];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = String(orderBy.direction ?? 'DESC');
        if (String(orderBy.field ?? 'CREATED_AT') === 'CREATED_AT') {
          list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
        }
        const after = decodeCursor(args.after);
        if (after !== null) {
          const index = list.findIndex((i) => i.number === after);
          if (index >= 0) list = list.slice(index + 1);
        }
        const first = typeof args.first === 'number' ? args.first : list.length;
        const page = list.slice(0, first);
        const hasNextPage = list.length > first;
        return {
          __typename: 'IssueConnection',
          nodes: page.map((issue) => issueNode(repo, issue)),
          pageInfo: {
            __typename: 'PageInfo',
            hasNextPage,
            endCursor: page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null,
          },
        };
      }
      case 'pullRequests': {
        let list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
        const first = typeof args.first === 'number' ? args.first : list.length;
        const page = list.slice(0, first);
        return {
          __typename: 'PullRequestConnection',
          nodes: page.map((pull) => pullNode(repo, pull)),
          pageInfo: {
            __typename: 'PageInfo',
            hasNextPage: list.length > first,
            endCursor: page.length > 0 ? encodeCursor((page[page.length - 1] as Pull).number) : null,
          },
        };
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : pullNode(repo, pull);
      }
      default:
        throw new FieldError(`Cannot query field "${field.name}" on type "Repository".`);
    }
  }

  if (typeName === 'Issue') {
    const issue = parent.issue as Issue;
    switch (field.name) {
      case 'id':
        return issue.gid;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueState(issue);
      case 'body':
        return issue.body;
      default:
        throw new FieldError(`Cannot query field "${field.name}" on type "Issue".`);
    }
  }

  if (typeName === 'PullRequest') {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    switch (field.name) {
      case 'id':
        return pull.gid;
      case 'number':
        return pull.number;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return store.computeMergeable(repo, pull);
      case 'state':
        return pullState(pull);
      case 'merged':
        return pull.merged;
      case 'files': {
        const files = store.pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        return {
          __typename: 'PullRequestFileConnection',
          nodes: files.slice(0, first).map((f) => ({ __typename: 'PullRequestFile', path: f.filename })),
        };
      }
      default:
        throw new FieldError(`Cannot query field "${field.name}" on type "PullRequest".`);
    }
  }

  if (typeName === 'User') {
    const user = parent as unknown as { login: string; id: number; name: string; email: string };
    switch (field.name) {
      case 'login':
        return user.login;
      case 'id':
        return user.id;
      case 'name':
        return user.name;
      case 'email':
        return user.email;
      default:
        throw new FieldError(`Cannot query field "${field.name}" on type "User".`);
    }
  }

  if (typeName === '__Type') {
    const type = parent as unknown as { name: string; fields: { name: string }[] | null; enumValues: { name: string }[] | null };
    switch (field.name) {
      case 'name':
        return type.name;
      case 'fields':
        return type.fields;
      case 'enumValues':
        return type.enumValues;
      default:
        throw new FieldError(`Cannot query field "${field.name}" on type "__Type".`);
    }
  }

  if (typeName === '__Schema') {
    const schema = parent as unknown as { queryType: unknown; mutationType: unknown };
    if (field.name === 'queryType') return schema.queryType;
    if (field.name === 'mutationType') return schema.mutationType;
    throw new FieldError(`Cannot query field "${field.name}" on type "__Schema".`);
  }

  // Generic container types (connections, payloads, edges): read the property.
  if (field.name in parent) return parent[field.name];
  throw new FieldError(`Cannot query field "${field.name}" on type "${typeName}".`);
}

function executeSelectionSet(
  ctx: ExecContext,
  typeName: string,
  parent: NodeValue,
  selections: SelectionNode[],
  path: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) {
        Object.assign(out, executeSelectionSet(ctx, typeName, parent, fragment.selectionSet, path));
      }
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(ctx, typeName, parent, selection.selectionSet, path));
      }
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    const fieldPath = [...path, responseKey];
    let value: unknown;
    try {
      value = resolveField(ctx, typeName, field, parent);
    } catch (e) {
      if (e instanceof FieldError) {
        ctx.errors.push({ message: e.message, path: fieldPath });
        out[responseKey] = null;
        continue;
      }
      throw e;
    }
    if (field.selectionSet === null || value === null || value === undefined) {
      out[responseKey] = value ?? null;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item, index) => {
        if (item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
          const node = item as NodeValue;
          return executeSelectionSet(ctx, node.__typename, node, field.selectionSet as SelectionNode[], [...fieldPath, String(index)]);
        }
        return item;
      });
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      const node = value as NodeValue;
      out[responseKey] = executeSelectionSet(ctx, node.__typename, node, field.selectionSet as SelectionNode[], fieldPath);
      continue;
    }
    // A scalar with a sub-selection (invalid): return it as-is.
    out[responseKey] = value;
  }
  return out;
}

function executeOperation(store: Store, operation: OperationNode, variables: Record<string, unknown>, fragments: Map<string, FragmentNode>): { data: Record<string, unknown>; errors?: { message: string; path: string[] }[] } {
  const ctx: ExecContext = { store, variables, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: NodeValue = { __typename: rootType };
  const data = executeSelectionSet(ctx, rootType, root, operation.selectionSet, []);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

function executeDocument(store: Store, body: unknown): { status: number; payload: unknown } {
  if (!isRecord(body)) return { status: 400, payload: { errors: [{ message: 'Request body must be a JSON object.' }] } };
  const query = body.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { status: 400, payload: { errors: [{ message: 'Must provide query string.' }] } };
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(lex(query)).parseDocument();
  } catch (e) {
    return { status: 400, payload: { errors: [{ message: e instanceof Error ? e.message : String(e) }] } };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const def of definitions) {
    if (def.kind === 'fragment') fragments.set(def.name, def);
    else operations.push(def);
  }
  if (operations.length === 0) {
    return { status: 400, payload: { errors: [{ message: 'No operation provided.' }] } };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let operation = operations[0] as OperationNode;
  if (operationName !== null) {
    const found = operations.find((op) => op.name === operationName);
    if (found !== undefined) operation = found;
  }
  // Apply variable defaults.
  const vars: Record<string, unknown> = { ...variables };
  for (const def of operation.variables) {
    if (vars[def.name] === undefined && def.defaultValue !== null) vars[def.name] = valueOf(def.defaultValue, vars);
  }
  return { status: 200, payload: executeOperation(store, operation, vars, fragments) };
}

/** POST /api/graphql. */
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (!authorized(req, store)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const raw = await readBody(req);
  const parsed = parseJson(raw);
  if (parsed === null) {
    sendJson(res, 400, { errors: [{ message: 'Request body must be valid JSON.' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    // Batch: one result per document, in order.
    const results = parsed.map((doc) => executeDocument(store, doc).payload);
    sendJson(res, 200, results);
    return;
  }
  const { status, payload } = executeDocument(store, parsed);
  sendJson(res, status, payload);
}
