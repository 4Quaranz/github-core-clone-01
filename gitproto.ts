// gitproto.ts — git smart HTTP: info/refs advertisements, upload-pack v2/v0,
// receive-pack v0. Plain objects only (the suite's client never sends deltas,
// and this server never advertises ofs-delta, so no delta ever appears).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  buildPack,
  parseCommit,
  parsePack,
  parseTag,
  parseTree,
  type ObjectType,
  type Repo,
  type Store,
} from './store.ts';
import { nextRequestId, readBody, sendJson, sendRaw } from './http.ts';

const AGENT = 'forge/1.0';

function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

type Pkt = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' };

function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = parseInt(buf.toString('ascii', offset, offset + 4), 16);
    if (Number.isNaN(length) || length < 0) break;
    if (length === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (offset + length > buf.length) break;
    out.push({ kind: 'data', data: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}

function textOf(pkt: Pkt): string {
  if (pkt.kind !== 'data') return '';
  return pkt.data.toString('utf8');
}

function trimLine(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

/** The v0 ref advertisement lines for a repo (first line carries `caps`). */
function advertisementLines(repo: Repo, store: Store, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const branches = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort();
  const tags = [...repo.refs.keys()].filter((r) => r.startsWith('refs/tags/')).sort();
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (branches.length === 0 && tags.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  const headOid = mainTip ?? ZERO_OID;
  lines.push(pktLine(`${headOid} HEAD\0${caps}\n`));
  for (const ref of branches) lines.push(pktLine(`${repo.refs.get(ref) as string} ${ref}\n`));
  for (const ref of tags) {
    const oid = repo.refs.get(ref) as string;
    lines.push(pktLine(`${oid} ${ref}\n`));
    const obj = store.getObject(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      const peeled = store.peelToCommit(target);
      if (peeled !== undefined) lines.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  return lines;
}

const UPLOAD_V0_CAPS = `symref=HEAD:refs/heads/main side-band-64k thin-pack multi_ack_detailed shallow agent=${AGENT} object-format=sha1`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs agent=${AGENT} symref=HEAD:refs/heads/main`;

function isV2(req: IncomingMessage): boolean {
  return (req.headers['git-protocol'] ?? '') === 'version=2';
}

function repo404(res: ServerResponse, store: Store): void {
  sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': nextRequestId(store) });
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, store: Store, repo: Repo | undefined, service: string): void {
  if (repo === undefined) {
    repo404(res, store);
    return;
  }
  const requestId = nextRequestId(store);
  if (service === 'git-upload-pack' && isV2(req)) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow filter\n'),
      pktLine('object-format=sha1\n'),
      pktLine(`agent=${AGENT}\n`),
      flushPkt(),
    ]);
    sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', body, { 'x-github-request-id': requestId });
    return;
  }
  if (service === 'git-upload-pack') {
    const body = Buffer.concat([
      pktLine('# service=git-upload-pack\n'),
      flushPkt(),
      ...advertisementLines(repo, store, UPLOAD_V0_CAPS),
      flushPkt(),
    ]);
    sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', body, { 'x-github-request-id': requestId });
    return;
  }
  if (service === 'git-receive-pack') {
    const body = Buffer.concat([
      pktLine('# service=git-receive-pack\n'),
      flushPkt(),
      ...advertisementLines(repo, store, RECEIVE_V0_CAPS),
      flushPkt(),
    ]);
    sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', body, { 'x-github-request-id': requestId });
    return;
  }
  repo404(res, store);
}

// ---------------------------------------------------------------------------
// fetch object collection
// ---------------------------------------------------------------------------

interface FetchPlan {
  objects: { type: ObjectType; data: Buffer }[];
  shallow: string[];
  unshallow: string[];
}

function treeClosure(store: Store, treeOid: string, out: Map<string, { type: ObjectType; data: Buffer }>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    const obj = store.getObject(oid);
    if (obj === undefined || out.has(oid)) continue;
    out.set(oid, { type: obj.type, data: obj.data });
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  }
}

/** Which commits a fetch includes, and which objects it sends. */
function collectFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallows: string[],
  depth: number | null,
): FetchPlan {
  const wantCommits: string[] = [];
  const wantTags: { oid: string; type: ObjectType; data: Buffer }[] = [];
  for (const want of wants) {
    const obj = store.getObject(want);
    // A wanted tag object travels as itself (the client checks for its bytes);
    // its target commit is what the history walk starts from.
    if (obj !== undefined && obj.type === 'tag') {
      wantTags.push({ oid: want, type: 'tag', data: obj.data });
    }
    const commit = store.peelToCommit(want);
    if (commit !== undefined) wantCommits.push(commit);
  }
  // Included commits with their distance from a want (want = 0).
  const included = new Map<string, number>();
  const queue: [string, number][] = wantCommits.map((c) => [c, 0] as [string, number]);
  while (queue.length > 0) {
    const [cur, dist] = queue.shift() as [string, number];
    if (included.has(cur)) continue;
    if (depth !== null && dist >= depth) continue;
    included.set(cur, dist);
    const obj = store.getObject(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push([parent, dist + 1]);
  }
  // What the client already has: a shallow have is just itself plus its tree;
  // a full have is its whole reachable closure.
  const shallowSet = new Set(clientShallows);
  const haveObjects = new Map<string, { type: ObjectType; data: Buffer }>();
  for (const have of haves) {
    const commit = store.peelToCommit(have);
    if (commit === undefined) continue;
    if (shallowSet.has(have) || shallowSet.has(commit)) {
      const obj = store.getObject(commit);
      if (obj !== undefined) {
        haveObjects.set(commit, { type: obj.type, data: obj.data });
        treeClosure(store, parseCommit(obj.data).tree, haveObjects);
      }
    } else {
      for (const oid of store.reachableObjects(commit)) {
        const obj = store.getObject(oid);
        if (obj !== undefined) haveObjects.set(oid, { type: obj.type, data: obj.data });
      }
    }
  }
  // Objects to send: each included commit (minus the have closure) plus its tree.
  const send = new Map<string, { type: ObjectType; data: Buffer }>();
  const toSendCommits: string[] = [];
  for (const commit of included.keys()) {
    if (haveObjects.has(commit)) continue;
    toSendCommits.push(commit);
    const obj = store.getObject(commit);
    if (obj === undefined) continue;
    send.set(commit, { type: obj.type, data: obj.data });
    treeClosure(store, parseCommit(obj.data).tree, send);
  }
  for (const tag of wantTags) {
    if (!haveObjects.has(tag.oid)) send.set(tag.oid, { type: tag.type, data: tag.data });
  }
  for (const oid of haveObjects.keys()) send.delete(oid);
  // The new shallow boundary: included commits at the depth limit that we send.
  const shallow: string[] = [];
  if (depth !== null) {
    for (const [commit, dist] of included) {
      if (dist === depth - 1 && send.has(commit)) shallow.push(commit);
    }
  }
  // Unshallow: a commit the client held shallow whose parents are now included.
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of clientShallows) {
      const commit = store.peelToCommit(oid);
      if (commit === undefined || !included.has(commit)) continue;
      const obj = store.getObject(commit);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.every((p) => included.has(p))) unshallow.push(commit);
    }
  }
  // Deterministic order: by object id.
  const withOid = [...send.entries()].map(([oid, obj]) => ({ oid, ...obj }));
  withOid.sort((a, b) => (a.oid < b.oid ? -1 : 1));
  return { objects: withOid.map(({ type, data }) => ({ type, data })), shallow, unshallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    packets.push(pktLine(payload));
  }
  return packets;
}

function ackLines(store: Store, haves: string[]): string[] {
  if (haves.length === 0) return ['NAK\n'];
  const known = haves.filter((h) => store.getObject(h) !== undefined || store.peelToCommit(h) !== undefined);
  if (known.length === 0) return ['NAK\n'];
  return [...known.map((h) => `ACK ${h}\n`), 'ready\n'];
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export async function handleUploadPack(req: IncomingMessage, res: ServerResponse, store: Store, repo: Repo | undefined): Promise<void> {
  if (repo === undefined) {
    repo404(res, store);
    return;
  }
  const body = await readBody(req);
  const requestId = nextRequestId(store);
  if (isV2(req)) {
    // v2: [command section] delim [args] flush.
    const pkts = decodePktLines(body);
    const firstSection: string[] = [];
    const args: string[] = [];
    let seenDelim = false;
    for (const pkt of pkts) {
      if (pkt.kind === 'delim') {
        seenDelim = true;
        continue;
      }
      if (pkt.kind === 'flush') break;
      if (pkt.kind === 'data') {
        if (seenDelim) args.push(trimLine(textOf(pkt)));
        else firstSection.push(trimLine(textOf(pkt)));
      }
    }
    const cmd = firstSection[0] ?? '';
    if (cmd === 'command=ls-refs') {
      const peel = args.includes('peel');
      const symrefs = args.includes('symrefs');
      const unborn = args.includes('unborn');
      const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
      const lines: string[] = [];
      const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
      const branches = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort();
      const tags = [...repo.refs.keys()].filter((r) => r.startsWith('refs/tags/')).sort();
      const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (branches.length === 0 && tags.length === 0) {
        if (unborn && matches('HEAD')) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
      } else {
        if (mainTip !== undefined && matches('HEAD')) {
          lines.push(symrefs ? `${mainTip} HEAD symref-target:refs/heads/${repo.defaultBranch}` : `${mainTip} HEAD`);
        }
        for (const ref of branches) {
          if (matches(ref)) lines.push(`${repo.refs.get(ref) as string} ${ref}`);
        }
        for (const ref of tags) {
          if (!matches(ref)) continue;
          const oid = repo.refs.get(ref) as string;
          const obj = store.getObject(oid);
          if (peel && obj !== undefined && obj.type === 'tag') {
            const target = parseTag(obj.data).object;
            const peeled = store.peelToCommit(target);
            lines.push(peeled !== undefined ? `${oid} ${ref} peeled:${peeled}` : `${oid} ${ref}`);
          } else {
            lines.push(`${oid} ${ref}`);
          }
        }
      }
      const out = Buffer.concat([...lines.map((l) => pktLine(`${l}\n`)), flushPkt()]);
      sendRaw(res, 200, 'application/x-git-upload-pack-result', out, { 'x-github-request-id': requestId });
      return;
    }
    if (cmd === 'command=fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallows: string[] = [];
      let depth: number | null = null;
      for (const arg of args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) shallows.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) {
          const n = Number(arg.slice(7).trim());
          if (Number.isInteger(n) && n > 0) depth = n;
        }
      }
      const plan = collectFetch(store, repo, wants, haves, shallows, depth);
      const parts: Buffer[] = [pktLine('acknowledgments\n')];
      for (const line of ackLines(store, haves)) parts.push(pktLine(line));
      parts.push(delimPkt());
      if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
        for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
        parts.push(delimPkt());
      }
      if (plan.objects.length > 0) {
        const pack = buildPack(plan.objects);
        parts.push(pktLine('packfile\n'));
        parts.push(...sidebandPackets(pack));
      }
      parts.push(flushPkt());
      sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts), { 'x-github-request-id': requestId });
      return;
    }
    sendJson(res, 400, { message: 'Unknown command' }, { 'x-github-request-id': requestId });
    return;
  }
  // v0 fetch: [want section] flush [have section] flush.
  const pkts = decodePktLines(body);
  const sections: string[][] = [[]];
  for (const pkt of pkts) {
    if (pkt.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (pkt.kind === 'data') sections[sections.length - 1]?.push(trimLine(textOf(pkt)));
  }
  const first = sections[0] ?? [];
  const second = sections[1] ?? [];
  const wants: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  for (const line of first) {
    const clean = line.split('\0')[0] as string;
    if (clean.startsWith('want ')) wants.push(clean.slice(5).trim());
    else if (clean.startsWith('shallow ')) shallows.push(clean.slice(8).trim());
    else if (clean.startsWith('deepen ')) {
      const n = Number(clean.slice(7).trim());
      if (Number.isInteger(n) && n > 0) depth = n;
    }
  }
  const haves: string[] = [];
  for (const line of second) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const plan = collectFetch(store, repo, wants, haves, shallows, depth);
  const parts: Buffer[] = [];
  for (const line of ackLines(store, haves)) parts.push(pktLine(line));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) {
    const pack = buildPack(plan.objects);
    parts.push(...sidebandPackets(pack));
  }
  parts.push(flushPkt());
  sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts), { 'x-github-request-id': requestId });
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export async function handleReceivePack(req: IncomingMessage, res: ServerResponse, store: Store, repo: Repo | undefined): Promise<void> {
  if (repo === undefined) {
    repo404(res, store);
    return;
  }
  const body = await readBody(req);
  const requestId = nextRequestId(store);
  // Command pkt-lines until the first flush; the rest is the raw pack.
  let offset = 0;
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const length = parseInt(body.toString('ascii', offset, offset + 4), 16);
    if (Number.isNaN(length) || length < 0) break;
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (offset + length > body.length) break;
    const line = trimLine(body.toString('utf8', offset + 4, offset + length));
    const clean = line.split('\0')[0] as string;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(clean);
    if (match !== null) {
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    }
    offset += length;
  }
  const packBytes = body.subarray(packStart);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes);
      for (const obj of objects) store.putObject(obj.type, obj.data);
    } catch (e) {
      unpackError = e instanceof Error ? e.message : String(e);
    }
  }
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack failed\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        } else {
          repo.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
      } else if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${cmd.ref} remote ref already exists\n`);
        } else if (store.getObject(cmd.newOid) === undefined) {
          reportLines.push(`ng ${cmd.ref} unable to read ${cmd.newOid}\n`);
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
      } else {
        // Update.
        if (current === undefined) {
          reportLines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        } else if (cmd.oldOid !== current) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        } else if (store.getObject(cmd.newOid) === undefined) {
          reportLines.push(`ng ${cmd.ref} unable to read ${cmd.newOid}\n`);
        } else if (!store.isAncestor(cmd.oldOid, cmd.newOid)) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
      }
    }
    repo.updatedSeq = store.nextSeq();
  }
  const inner = Buffer.concat([...reportLines.map((l) => pktLine(l)), flushPkt()]);
  const outer = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), flushPkt()]);
  sendRaw(res, 200, 'application/x-git-receive-pack-result', outer, { 'x-github-request-id': requestId });
}
