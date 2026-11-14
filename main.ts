// main.ts — the entry's lifecycle against the trial env (see env/src/wire.ts).
//
// The env owns port 8080 and drives the trial; this process only serves the
// forge app and reports when it is done. The five steps, in order:
//
//   1. Read MAKEFUN_ENV_URL (the env's origin, e.g. http://store:8080 in a
//      trial container). Without it there is nothing to talk to, so exit 1.
//   2. Build the server (createApp from app.ts) and listen on port 0, so the
//      kernel picks a free ephemeral port. Never bind 8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the
//      request's source address plus N as this entry's base URL and dials it
//      from then on. The first register wins; a 409 means another entry
//      already registered, and this process just keeps waiting like any other.
//   4. Poll GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The
//      env answers at once ({"done": false} while the suite runs), so this is
//      a poll, not a long-held request. A failed or slow poll is retried with
//      a short exponential backoff; the process never exits before done.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// main.ts imports its own server and nothing else: no package, no Node
// built-in, no model call.

import { createApp } from './app.ts';

// The env's origin, with any trailing slashes removed.
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// How long one register or done request may take before it is abandoned.
const REQUEST_TIMEOUT_MS = 30_000;
// The first wait between retries, and the longest wait allowed.
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Wait after `failures` failed requests: exponential from RETRY_FIRST_MS,
// doubling per failure but never past RETRY_CAP_MS.
function backoffMs(failures: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(failures, 8));
}

// POST the bound port until the env accepts it. 200 is the normal answer;
// 409 means a first register already won, which is not this process's to fix.
// 400 and 405 are contract errors and end the program; a network error or any
// other status is retried, since the env may still be starting up.
async function register(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      // A contract error thrown above must end the program; anything else
      // (network error, timeout) just means "try again below".
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoffMs(failures));
  }
}

// Poll GET /done until it answers {"done": true}; never return before that.
async function waitForDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done,
      // so poll again after the backoff below.
    }
    await sleep(backoffMs(failures));
  }
}

// Bind the port, register it, then wait for the env: the whole life of the process.
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
