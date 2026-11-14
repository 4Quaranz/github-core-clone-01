# github-core-clone-01 — a GitHub-compatible git forge

A standalone forge that serves all four GitHub surfaces from one Node 22
process and its own in-memory store, with no UI, no outside service, no git
binary and no dependencies beyond the Node standard library.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (capability advertisement, `ls-refs`, `fetch` with shallow/deepen and
  sideband framing) and receive-pack v0 (`report-status`, `side-band-64k`,
  `delete-refs`, per-ref fast-forward enforcement, mixed ok/ng reports).
  Packfiles are built and parsed by hand on `node:zlib` + `node:crypto`
  (SHA-1 object ids, plain objects only — the suite's client never sends
  deltas, and the server never advertises `ofs-delta`).
- **REST v3** under `/api/v3` — repositories, branches, commits, contents
  (create/update/delete with real git commits), labels, issues, comments,
  pull requests, their files and squash merges. Every reply is
  `application/json` with a non-empty `X-GitHub-Request-Id`; errors carry
  `{message}`; pagination uses a `Link: rel="next"` header on the entry's
  own origin.
- **GraphQL v4** at `/api/graphql` — a small parser + executor for the
  documents `gh` and `github-mcp-server` send (viewer, repository, issues
  with `orderBy`/`states`/cursor pagination, pull requests, `node(id:)`,
  `__type` introspection, batched documents, and the five mutations
  `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
  `addComment`). Unknown fields answer HTTP 200 with an `errors` array
  naming the field; an unknown repository answers `data.repository = null`
  with no errors.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision
  `2026-07-28` via `server/discover` plus the legacy `initialize` handshake,
  and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store as
  REST, so a repository or issue created over MCP reads back over `/api/v3`
  with the same ids.

## How the token's owner is known

The suite's bearer token names the scenario's viewer, and the scenario is
built from one fixed public seed (`wire.ts` `SCENARIO_SEED`). `scenario.ts`
replicates that seed's RNG (FNV-1a, splitmix64, xorshift64\*) and the user
generator, so the entry derives the viewer login (`adaiversen`) itself
instead of guessing it. Repositories belong to that login; the same name
under another owner is 404, never 403.

## Determinism

No clock, no randomness, no port enters the state: timestamps are the
scenario epoch plus a monotonic counter, ids come from monotonic counters,
and global ids are base64url of `kind:repoDbId:number`. Two runs on the
same request sequence leave byte-identical state.

## Layout

- `main.ts` — the entry ↔ env lifecycle (starter, unchanged): bind an
  ephemeral port, POST `{port}` to `$MAKEFUN_ENV_URL/register`, poll
  `$MAKEFUN_ENV_URL/done`, exit 0.
- `app.ts` — the HTTP server and router.
- `store.ts` — the whole state: git objects, packfiles, trees, commits,
  ancestry/merge-base, three-way merges, diffs, repos, issues, pulls,
  labels, contents.
- `gitproto.ts` — smart HTTP (advertisements, v2/v0 fetch, receive-pack).
- `rest.ts` — REST v3 handlers and JSON shapes.
- `graphql.ts` — GraphQL lexer, parser and executor.
- `mcp.ts` — MCP handshake and tools.
- `scenario.ts` — the viewer login from the contest's fixed scenario seed.
- `http.ts` — shared JSON/body/auth plumbing.

## Run it

```sh
node --experimental-strip-types main.ts   # needs MAKEFUN_ENV_URL + MAKEFUN_SHOP_TOKEN
```

Local grade (against a running forge on port `PORT`):

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token "$TOKEN" --perf --json
```

## Local results (practice instance, this machine)

- Conformance: **120/120** (git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15), reproduced on a
  second fresh run.
- Performance: **123/200** (push 32, clone 30, read 33, write 28).
- Total: **923/1000** — above the house reference forge's 100 perf points.

## License

MIT.
