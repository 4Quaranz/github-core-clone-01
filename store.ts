// store.ts — the forge's whole state: git objects, repositories, issues, pull
// requests, labels. One in-memory store, no clock, no randomness: every id and
// timestamp derives from monotonic counters, so two runs on the same request
// sequence leave byte-identical state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { VIEWER, type Viewer } from './scenario.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = VIEWER.login;

/** The scenario's day one: every timestamp is this plus a counter, in seconds. */
export const EPOCH_SEC = 1_735_689_600;

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git tree sort: directories compare as name + '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function serializeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.toString('ascii', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function buildCommit(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${author}\ncommitter ${committer}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const out = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

// ---------------------------------------------------------------------------
// packfiles (plain objects only — the suite's client never sends deltas)
// ---------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Inflate a zlib stream starting at `offset`; binary-search its exact end. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  let lo = offset;
  let hi = buf.length;
  // The stream must end at or before the pack trailer (last 20 bytes).
  hi = Math.min(hi, buf.length - 20);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = inflateSync(buf.subarray(offset, lo));
  return { data, next: lo };
}

export interface PackObject {
  readonly type: ObjectType;
  readonly data: Buffer;
  readonly oid: string;
}

export function parsePack(buf: Buffer): PackObject[] {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects: PackObject[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = buf[offset++];
    const typeNum = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6) {
      // ofs-delta: not produced by the suite's client; refuse rather than guess.
      throw new Error('ofs-delta pack entries are not supported');
    }
    if (typeNum === 7) throw new Error('ref-delta pack entries are not supported');
    const type = PACK_TYPES[typeNum];
    if (type === undefined) throw new Error(`unknown pack object type ${typeNum} at ${entryOffset}`);
    const { data, next } = inflateAt(buf, offset);
    if (data.length !== size) throw new Error(`pack object at ${entryOffset} inflated to ${data.length} bytes, header says ${size}`);
    offset = next;
    objects.push({ type, data, oid: objectId(type, data) });
  }
  return objects;
}

function packEntryHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (typeNum << 4) | (size & 15);
  size >>>= 4;
  while (size > 0) {
    byte |= 0x80;
    bytes.push(byte);
    byte = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

const PACK_TYPE_NUM: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function buildPack(objects: readonly { type: ObjectType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packEntryHeader(PACK_TYPE_NUM[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// global ids (opaque, stable): base64url of "<kind>:<repoDbId>:<number>"
// ---------------------------------------------------------------------------

export function gid(kind: string, repoDbId: number, number: number): string {
  return Buffer.from(`${kind}:${repoDbId}:${number}`).toString('base64url');
}

export function parseGid(id: string): { kind: string; repoDbId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, repo, num] = text.split(':');
    if (kind === undefined || repo === undefined || num === undefined) return null;
    const repoDbId = Number(repo);
    const number = Number(num);
    if (!Number.isInteger(repoDbId) || !Number.isInteger(number)) return null;
    return { kind, repoDbId, number };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// domain objects
// ---------------------------------------------------------------------------

export interface Comment {
  dbId: number;
  gid: string;
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  dbId: number;
  gid: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  updatedSeq: number;
  closedSeq: number | null;
}

export interface Pull {
  dbId: number;
  gid: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
  closedSeq: number | null;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  dbId: number;
  gid: string;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  createdSeq: number;
  updatedSeq: number;
}

export type ServiceError = { error: string; status: number };
export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

function err<T>(status: number, message: string): ServiceResult<T> {
  return { ok: false, error: message, status };
}

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  seq = 0;
  reqSeq = 0;
  nextRepoId = 5000;
  nextDbId = 100000;

  /** A deterministic timestamp: the scenario epoch plus `seq` seconds. */
  ts(seq: number): string {
    return new Date((EPOCH_SEC + seq) * 1000).toISOString();
  }

  /** The git ident line for a commit the forge itself authors. */
  ident(seq: number): string {
    return `${VIEWER.name} <${VIEWER.email}> ${EPOCH_SEC + seq} +0000`;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  putObject(type: ObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  // -- repositories ----------------------------------------------------------

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(name);
  }

  createRepo(name: string, description: string, isPrivate: boolean): ServiceResult<Repo> {
    if (typeof name !== 'string' || name.trim() === '' || /[/\s]/.test(name)) {
      return err(422, 'Repository name is invalid');
    }
    if (this.repos.has(name)) return err(422, 'Repository already exists');
    const seq = this.nextSeq();
    const dbId = this.nextRepoId++;
    const repo: Repo = {
      dbId,
      gid: gid('repo', dbId, 0),
      name,
      owner: VIEWER_LOGIN,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      createdSeq: seq,
      updatedSeq: seq,
    };
    this.repos.set(name, repo);
    this.reposById.set(dbId, repo);
    return { ok: true, value: repo };
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name);
    this.reposById.delete(repo.dbId);
  }

  // -- refs ------------------------------------------------------------------

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  createRef(repo: Repo, ref: string, sha: string): ServiceResult<{ ref: string; sha: string }> {
    if (!ref.startsWith('refs/')) return err(422, 'Invalid ref name');
    if (repo.refs.has(ref)) return err(422, 'Reference already exists');
    if (!this.objects.has(sha)) return err(422, 'Object does not exist');
    repo.refs.set(ref, sha);
    repo.updatedSeq = this.nextSeq();
    return { ok: true, value: { ref, sha } };
  }

  listBranches(repo: Repo): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  resolveRefish(repo: Repo, refish: string | undefined): string | undefined {
    if (refish === undefined || refish === '') return this.defaultTip(repo);
    const direct = repo.refs.get(refish);
    if (direct !== undefined) return direct;
    const head = repo.refs.get(`refs/heads/${refish}`);
    if (head !== undefined) return head;
    const tag = repo.refs.get(`refs/tags/${refish}`);
    if (tag !== undefined) return this.peelToCommit(tag);
    if (this.objects.has(refish)) return refish;
    return undefined;
  }

  peelToCommit(oid: string): string | undefined {
    let current = oid;
    for (let i = 0; i < 10; i += 1) {
      const obj = this.objects.get(current);
      if (obj === undefined) return undefined;
      if (obj.type === 'commit') return current;
      if (obj.type === 'tag') {
        current = parseTag(obj.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  // -- graph -----------------------------------------------------------------

  isAncestor(ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = this.objects.get(cur);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return false;
  }

  /** The nearest common ancestor of two commits (by fewest total hops). */
  mergeBase(a: string, b: string): string | undefined {
    const distA = new Map<string, number>();
    const queueA: [string, number][] = [[a, 0]];
    while (queueA.length > 0) {
      const [cur, dist] = queueA.shift() as [string, number];
      if (distA.has(cur)) continue;
      distA.set(cur, dist);
      const obj = this.objects.get(cur);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queueA.push([parent, dist + 1]);
    }
    let best: string | undefined;
    let bestDist = Infinity;
    const queueB: [string, number][] = [[b, 0]];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const [cur, dist] = queueB.shift() as [string, number];
      if (seenB.has(cur)) continue;
      seenB.add(cur);
      const da = distA.get(cur);
      if (da !== undefined && da + dist < bestDist) {
        bestDist = da + dist;
        best = cur;
      }
      const obj = this.objects.get(cur);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queueB.push([parent, dist + 1]);
    }
    return best;
  }

  /** All commits reachable from `tip` (tip first, parents after). */
  walkCommits(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = this.objects.get(cur);
      if (obj === undefined || obj.type !== 'commit') continue;
      out.push(cur);
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
    return out;
  }

  /** Every object id reachable from a commit (the commit, its trees, its blobs). */
  reachableObjects(tip: string): Set<string> {
    const out = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj === undefined) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        stack.push(info.tree);
        for (const parent of info.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return out;
  }

  /** path -> {mode, oid} for a whole tree, recursively. */
  flattenTree(treeOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = this.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree from a flat path map. */
  buildTreeFromMap(files: Map<string, { mode: string; oid: string }>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, { mode: string; oid: string }>>();
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: file.mode, name: rest, oid: file.oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (sub === undefined) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(path, file);
        }
      }
      for (const [dir, sub] of dirs) {
        const subOid = build(`${prefix}${dir}/`);
        entries.push({ mode: '40000', name: dir, oid: subOid });
      }
      return this.putObject('tree', serializeTree(entries));
    };
    return build('');
  }

  createCommit(tree: string, parents: readonly string[], message: string): string {
    const seq = this.nextSeq();
    const ident = this.ident(seq);
    return this.putObject('commit', buildCommit(tree, parents, ident, ident, message));
  }

  // -- labels -----------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string, description: string): ServiceResult<Label> {
    if (typeof name !== 'string' || name.trim() === '') return err(422, 'Label name is required');
    if (repo.labels.has(name)) return err(422, 'Label already exists');
    const label: Label = { name, color: color || 'ededed', description: description || '' };
    repo.labels.set(name, label);
    repo.updatedSeq = this.nextSeq();
    return { ok: true, value: label };
  }

  // -- issues -----------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): ServiceResult<Issue> {
    if (typeof title !== 'string' || title.trim() === '') return err(422, 'Title is required');
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return err(422, `Label does not exist: ${name}`);
    }
    const seq = this.nextSeq();
    const number = repo.nextIssue++;
    const dbId = this.nextDbId++;
    const issue: Issue = {
      dbId,
      gid: gid('issue', repo.dbId, number),
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labelNames],
      comments: [],
      createdSeq: seq,
      updatedSeq: seq,
      closedSeq: null,
    };
    repo.issues.set(number, issue);
    return { ok: true, value: issue };
  }

  listIssues(repo: Repo, state: string, sort: string, direction: string): Issue[] {
    let list = [...repo.issues.values()];
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    const dir = direction === 'asc' ? 1 : -1;
    if (sort === 'created') list.sort((a, b) => (a.createdSeq - b.createdSeq) * dir || (a.number - b.number) * dir);
    else list.sort((a, b) => (a.number - b.number) * dir);
    return list;
  }

  patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): ServiceResult<Issue> {
    const issue = repo.issues.get(number);
    if (issue === undefined) return err(404, 'Not Found');
    if (patch.state === 'closed' && issue.state !== 'closed') {
      issue.state = 'closed';
      issue.closedSeq = this.nextSeq();
    } else if (patch.state === 'open' && issue.state !== 'open') {
      issue.state = 'open';
      issue.closedSeq = null;
    }
    if (typeof patch.title === 'string') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    issue.updatedSeq = this.nextSeq();
    return { ok: true, value: issue };
  }

  createComment(repo: Repo, issueNumber: number, body: string): ServiceResult<Comment> {
    const issue = repo.issues.get(issueNumber);
    if (issue === undefined) return err(404, 'Not Found');
    if (typeof body !== 'string' || body === '') return err(422, 'Body is required');
    const seq = this.nextSeq();
    const id = repo.nextComment++;
    const dbId = this.nextDbId++;
    const comment: Comment = { dbId, gid: gid('comment', repo.dbId, id), id, body, createdSeq: seq };
    issue.comments.push(comment);
    issue.updatedSeq = seq;
    return { ok: true, value: comment };
  }

  // -- pull requests ----------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, head: string, base: string): ServiceResult<Pull> {
    if (typeof title !== 'string' || title.trim() === '') return err(422, 'Title is required');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    if (headSha === undefined) return err(422, `Head branch does not exist: ${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (baseSha === undefined) return err(422, `Base branch does not exist: ${base}`);
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
        return err(422, 'A pull request already exists for this head branch');
      }
    }
    const seq = this.nextSeq();
    const number = repo.nextPull++;
    const dbId = this.nextDbId++;
    const pull: Pull = {
      dbId,
      gid: gid('pr', repo.dbId, number),
      number,
      title,
      body: body ?? '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: seq,
      updatedSeq: seq,
      closedSeq: null,
    };
    repo.pulls.set(number, pull);
    return { ok: true, value: pull };
  }

  listPulls(repo: Repo, state: string): Pull[] {
    let list = [...repo.pulls.values()];
    if (state === 'open') list = list.filter((p) => p.state === 'open');
    else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
    list.sort((a, b) => b.number - a.number);
    return list;
  }

  /** The three-way merge plan for a pull: the merged tree, or the conflicting paths. */
  mergePlan(repo: Repo, pull: Pull): { conflict: string[]; tree: string | null } {
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const headCommit = this.peelToCommit(headSha);
    const baseCommit = this.peelToCommit(baseSha);
    if (headCommit === undefined || baseCommit === undefined) return { conflict: [], tree: null };
    const base = this.mergeBase(headCommit, baseCommit);
    const headTree = parseCommit(this.objects.get(headCommit)?.data ?? Buffer.alloc(0)).tree;
    const baseTree = parseCommit(this.objects.get(baseCommit)?.data ?? Buffer.alloc(0)).tree;
    const mergeTree = base === undefined ? '' : parseCommit(this.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
    const headFiles = this.flattenTree(headTree);
    const baseFiles = this.flattenTree(baseTree);
    const mergeFiles = mergeTree === '' ? new Map<string, { mode: string; oid: string }>() : this.flattenTree(mergeTree);
    const conflicts: string[] = [];
    const result = new Map<string, { mode: string; oid: string }>(baseFiles);
    const paths = new Set([...headFiles.keys(), ...baseFiles.keys(), ...mergeFiles.keys()]);
    for (const path of paths) {
      const h = headFiles.get(path);
      const b = baseFiles.get(path);
      const m = mergeFiles.get(path);
      const headChanged = (h?.oid ?? null) !== (m?.oid ?? null) || (h?.mode ?? null) !== (m?.mode ?? null);
      const baseChanged = (b?.oid ?? null) !== (m?.oid ?? null) || (b?.mode ?? null) !== (m?.mode ?? null);
      if (!headChanged && !baseChanged) continue;
      if (headChanged && !baseChanged) {
        if (h === undefined) result.delete(path);
        else result.set(path, h);
      } else if (baseChanged && !headChanged) {
        // keep the base tip's version (already in `result`)
      } else if ((h?.oid ?? null) === (b?.oid ?? null) && (h?.mode ?? null) === (b?.mode ?? null)) {
        // both changed to the same thing
      } else {
        conflicts.push(path);
      }
    }
    if (conflicts.length > 0) return { conflict: conflicts, tree: null };
    return { conflict: [], tree: this.buildTreeFromMap(result) };
  }

  computeMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const plan = this.mergePlan(repo, pull);
    return plan.conflict.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
  }

  mergePull(repo: Repo, pull: Pull, mergeMethod: string): ServiceResult<{ sha: string; merged: boolean; message: string }> {
    if (pull.state !== 'open') return err(405, 'Pull request is not open');
    if (mergeMethod !== '' && mergeMethod !== 'squash' && mergeMethod !== 'merge' && mergeMethod !== 'rebase') {
      return err(422, `Unknown merge method: ${mergeMethod}`);
    }
    const plan = this.mergePlan(repo, pull);
    if (plan.conflict.length > 0) return err(405, 'This pull request cannot be merged due to conflicts');
    if (plan.tree === null) return err(422, 'Cannot compute the merge');
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseSha === undefined) return err(422, 'Base branch does not exist');
    const baseCommit = this.peelToCommit(baseSha);
    if (baseCommit === undefined) return err(422, 'Base branch has no commit');
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const sha = this.createCommit(plan.tree, [baseCommit], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    const seq = this.nextSeq();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.ts(seq);
    pull.mergeCommitSha = sha;
    pull.closedSeq = seq;
    pull.updatedSeq = seq;
    repo.updatedSeq = seq;
    return { ok: true, value: { sha, merged: true, message } };
  }

  /** Line-diff counts for one changed path (shape only: non-negative integers). */
  diffCounts(oldContent: Buffer | null, newContent: Buffer | null): { additions: number; deletions: number; changes: number } {
    if (oldContent === null && newContent !== null) {
      const lines = newContent.toString('utf8').split('\n').length;
      return { additions: lines, deletions: 0, changes: lines };
    }
    if (newContent === null && oldContent !== null) {
      const lines = oldContent.toString('utf8').split('\n').length;
      return { additions: 0, deletions: lines, changes: lines };
    }
    if (oldContent === null || newContent === null) return { additions: 0, deletions: 0, changes: 0 };
    const oldLines = oldContent.toString('utf8').split('\n');
    const newLines = newContent.toString('utf8').split('\n');
    if (oldLines.length * newLines.length > 4_000_000) {
      const additions = newLines.length;
      const deletions = oldLines.length;
      return { additions, deletions, changes: additions + deletions };
    }
    // LCS over lines.
    const m = oldLines.length;
    const n = newLines.length;
    const dp = new Uint32Array((m + 1) * (n + 1));
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        dp[i * (n + 1) + j] = oldLines[i] === newLines[j] ? dp[(i + 1) * (n + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
      }
    }
    const common = dp[0];
    const additions = n - common;
    const deletions = m - common;
    return { additions, deletions, changes: additions + deletions };
  }

  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const headCommit = this.peelToCommit(headSha);
    const baseCommit = this.peelToCommit(baseSha);
    if (headCommit === undefined || baseCommit === undefined) return [];
    const base = this.mergeBase(headCommit, baseCommit);
    const headTree = parseCommit(this.objects.get(headCommit)?.data ?? Buffer.alloc(0)).tree;
    const headFiles = this.flattenTree(headTree);
    const baseFiles = base === undefined ? new Map() : this.flattenTree(parseCommit(this.objects.get(base)?.data ?? Buffer.alloc(0)).tree);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
    for (const path of [...paths].sort()) {
      const h = headFiles.get(path);
      const b = baseFiles.get(path);
      if (h !== undefined && b === undefined) {
        const blob = this.objects.get(h.oid);
        const counts = this.diffCounts(null, blob?.type === 'blob' ? blob.data : null);
        out.push({ filename: path, status: 'added', ...counts });
      } else if (h === undefined && b !== undefined) {
        const blob = this.objects.get(b.oid);
        const counts = this.diffCounts(blob?.type === 'blob' ? blob.data : null, null);
        out.push({ filename: path, status: 'removed', ...counts });
      } else if (h !== undefined && b !== undefined && (h.oid !== b.oid || h.mode !== b.mode)) {
        const oldBlob = this.objects.get(b.oid);
        const newBlob = this.objects.get(h.oid);
        const counts = this.diffCounts(oldBlob?.type === 'blob' ? oldBlob.data : null, newBlob?.type === 'blob' ? newBlob.data : null);
        out.push({ filename: path, status: 'modified', ...counts });
      }
    }
    return out;
  }

  // -- contents ---------------------------------------------------------------

  putContent(
    repo: Repo,
    path: string,
    contentBase64: string,
    message: string,
    sha: string | undefined,
    branch: string | undefined,
  ): ServiceResult<{ content: Record<string, unknown>; commit: { sha: string }; isUpdate: boolean }> {
    const branchName = branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branchName}`;
    const tip = repo.refs.get(ref);
    let content: Buffer;
    try {
      content = Buffer.from(contentBase64, 'base64');
    } catch {
      return err(422, 'Content is not valid base64');
    }
    if (typeof message !== 'string' || message === '') return err(422, 'Message is required');
    const blobOid = this.putObject('blob', content);
    let baseFiles = new Map<string, { mode: string; oid: string }>();
    const parents: string[] = [];
    if (tip !== undefined) {
      const tipCommit = this.peelToCommit(tip);
      if (tipCommit === undefined) return err(422, 'Branch tip is not a commit');
      const tipInfo = parseCommit(this.objects.get(tipCommit)?.data ?? Buffer.alloc(0));
      baseFiles = this.flattenTree(tipInfo.tree);
      parents.push(tipCommit);
      const existing = baseFiles.get(path);
      if (sha !== undefined) {
        if (existing === undefined) return err(422, 'File does not exist');
        if (existing.oid !== sha) return err(409, 'File sha does not match');
      } else if (existing !== undefined) {
        return err(422, 'File already exists');
      }
    } else if (sha !== undefined) {
      return err(422, 'File does not exist');
    }
    const isUpdate = baseFiles.has(path);
    baseFiles.set(path, { mode: '100644', oid: blobOid });
    const treeOid = this.buildTreeFromMap(baseFiles);
    const commitOid = this.createCommit(treeOid, parents, message);
    repo.refs.set(ref, commitOid);
    repo.updatedSeq = this.nextSeq();
    const contentJson: Record<string, unknown> = {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      size: content.length,
      encoding: 'base64',
      content: contentBase64,
      type: 'file',
    };
    return { ok: true, value: { content: contentJson, commit: { sha: commitOid }, isUpdate } };
  }

  deleteContent(
    repo: Repo,
    path: string,
    message: string,
    sha: string | undefined,
    branch: string | undefined,
  ): ServiceResult<{ commit: { sha: string } }> {
    const branchName = branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branchName}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return err(404, 'Not Found');
    const tipCommit = this.peelToCommit(tip);
    if (tipCommit === undefined) return err(422, 'Branch tip is not a commit');
    const tipInfo = parseCommit(this.objects.get(tipCommit)?.data ?? Buffer.alloc(0));
    const baseFiles = this.flattenTree(tipInfo.tree);
    const existing = baseFiles.get(path);
    if (existing === undefined) return err(404, 'Not Found');
    if (sha !== undefined && existing.oid !== sha) return err(409, 'File sha does not match');
    if (typeof message !== 'string' || message === '') return err(422, 'Message is required');
    baseFiles.delete(path);
    const treeOid = this.buildTreeFromMap(baseFiles);
    const commitOid = this.createCommit(treeOid, [tipCommit], message);
    repo.refs.set(ref, commitOid);
    repo.updatedSeq = this.nextSeq();
    return { ok: true, value: { commit: { sha: commitOid } } };
  }

  getContent(
    repo: Repo,
    path: string,
    refish: string | undefined,
  ): ServiceResult<{ kind: 'file'; data: Record<string, unknown> } | { kind: 'dir'; data: Record<string, unknown>[] }> {
    const tip = this.resolveRefish(repo, refish);
    if (tip === undefined) return err(404, 'Not Found');
    const tipCommit = this.peelToCommit(tip);
    if (tipCommit === undefined) return err(404, 'Not Found');
    const tipInfo = parseCommit(this.objects.get(tipCommit)?.data ?? Buffer.alloc(0));
    const files = this.flattenTree(tipInfo.tree);
    const file = files.get(path);
    if (file !== undefined) {
      const blob = this.objects.get(file.oid);
      if (blob === undefined || blob.type !== 'blob') return err(404, 'Not Found');
      return {
        ok: true,
        value: {
          kind: 'file',
          data: {
            name: path.split('/').pop() ?? path,
            path,
            sha: file.oid,
            size: blob.data.length,
            encoding: 'base64',
            content: blob.data.toString('base64'),
            type: 'file',
          },
        },
      };
    }
    // Directory: entries directly under `path/`.
    const prefix = path === '' ? '' : `${path}/`;
    const entries: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ name: rest, path: filePath, sha: entry.oid, size: this.objects.get(entry.oid)?.data.length ?? 0, type: 'file' });
      } else {
        const dir = rest.slice(0, slash);
        if (!seen.has(dir)) {
          seen.add(dir);
          entries.push({ name: dir, path: `${prefix}${dir}`, sha: '', size: 0, type: 'dir' });
        }
      }
    }
    if (entries.length === 0) return err(404, 'Not Found');
    entries.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
    return { ok: true, value: { kind: 'dir', data: entries } };
  }

  listCommits(repo: Repo, refish: string | undefined): { sha: string; info: CommitInfo }[] {
    const tip = this.resolveRefish(repo, refish);
    if (tip === undefined) return [];
    const tipCommit = this.peelToCommit(tip);
    if (tipCommit === undefined) return [];
    return this.walkCommits(tipCommit).map((sha) => ({ sha, info: parseCommit(this.objects.get(sha)?.data ?? Buffer.alloc(0)) }));
  }
}

export type { Viewer };
