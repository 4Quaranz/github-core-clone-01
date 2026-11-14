// http.ts — shared HTTP plumbing: JSON replies, body reading, auth.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

export function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a JSON body; returns null when the body is not valid JSON. */
export function parseJson(buf: Buffer): unknown | null {
  if (buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/** The bearer token the request presents, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(auth);
  return match === null ? null : (match[1] as string);
}

/** True when the request carries the suite's token. */
export function authorized(req: IncomingMessage, store: Store): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const presented = bearerToken(req);
  if (token === '') return presented !== null && presented !== '';
  return presented === token;
}

/** A fresh deterministic request id for the X-GitHub-Request-Id header. */
export function nextRequestId(store: Store): string {
  store.reqSeq += 1;
  return `req-${store.reqSeq}`;
}
