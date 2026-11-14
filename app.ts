// app.ts — the forge's HTTP server: one Store, four surfaces (git smart HTTP,
// REST v3, GraphQL v4, MCP), plus the env's health probe.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { authorized, sendJson } from './http.ts';

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const { pathname, query } = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3 under /api/v3.
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const rest = pathname.slice('/api/v3'.length).split('/').filter((s) => s !== '');
          await handleRest(req, res, store, rest, query);
          return;
        }

        // GraphQL v4.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          await handleGraphQL(req, res, store);
          return;
        }

        // MCP.
        if (pathname === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          await handleMcp(req, res, store);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
        if (gitMatch !== null) {
          const owner = decodeSegment(gitMatch[1] as string);
          const repoName = decodeSegment(gitMatch[2] as string);
          const tail = gitMatch[3] as string;
          if (!authorized(req, store)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const repo = store.getRepo(owner, repoName);
          if (tail === 'info/refs') {
            handleInfoRefs(req, res, store, repo, query.get('service') ?? '');
            return;
          }
          if (tail === 'git-upload-pack' && method === 'POST') {
            await handleUploadPack(req, res, store, repo);
            return;
          }
          if (tail === 'git-receive-pack' && method === 'POST') {
            await handleReceivePack(req, res, store, repo);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (e) {
        process.stderr.write(`[entry] request failed: ${e instanceof Error ? e.message : String(e)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
