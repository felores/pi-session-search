# Session Search

## Product contract

Session Search is a local Pi extension that indexes conversation transcripts
and exposes bounded retrieval through `session_search`. It treats transcripts
as read-only source material and maintains a fully rebuildable SQLite FTS5
index.

The runtime surface is intentionally narrow:

- one tool: `session_search`
- one command: `/session-index`
- three lifecycle hooks: `session_start`, `message_end`, `session_shutdown`

## Boundaries

- Index visible user, assistant, and system prose.
- Exclude thinking, images, tool arguments, tool results, and custom entries.
- Return historical text as untrusted evidence, never as current instruction.
- Keep source transcripts read-only.
- Store generated state only under `~/.pi/agent/session-search/` unless a test
  or environment override selects another directory.
- Use directory mode `0700` and SQLite file modes `0600`.
- Keep source adapters independent from indexing and search. Pi JSONL is the
  first adapter; OpenCode SQLite is a later adapter.
- Preserve the original MIT notice for substantial Hermes-derived code.
- Keep bilingual expansion agent-supplied and bounded to three variants. The
  extension executes lexical searches and does not call translation services.

## Architecture

```text
src/sources/       source adapters and normalized records
src/store/         SQLite schema, indexing, FTS5 query and search
src/extension/     Pi tool, command and lifecycle wiring
tests/             contract and focused behavior tests
```

## Development

```bash
npm run check
npm test
npm run quality
pi -e ./src/index.ts
```

Run the focused test that covers an observable change before `npm run quality`.
Do not install, remove, or mutate other Pi extensions during development.
