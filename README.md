# Session Search

Local, read-only conversation search for Pi.

Session Search indexes the visible prose in Pi JSONL transcripts into a private,
rebuildable SQLite FTS5 database. It exposes one LLM tool, `session_search`, and
does not create durable memories, context banks, generated skills, or automatic
context injection.

Exact matches retain newest-first ordering. Broader natural-language fallback
uses FTS5 BM25 relevance. The engine is lexical and does not claim translation
or general cross-lingual semantic retrieval by itself; the calling agent may
provide bilingual query variants without an additional model call.

## Runtime contract

- `session_search` searches bounded historical snippets.
- `queryVariants` accepts up to three agent-supplied source-language
  translations or keyword paraphrases. Variants are searched first and results
  are interleaved and deduplicated by session.
- `/session-index` reconciles and incrementally updates the local index.
- Startup performs a bounded incremental backfill.
- Live indexing follows finalized messages.
- Shutdown flushes pending indexing and closes SQLite.
- Transcript results are marked as untrusted historical evidence.

Indexed by default:

- user prose
- visible assistant prose
- system prose
- project, cwd, timestamp, role, and tool names as metadata

Excluded by default:

- thinking blocks
- images and base64
- tool arguments and tool results
- extension custom entries

## Install

Session Search currently installs from GitHub:

```bash
pi install git:github.com/felores/pi-session-search
```

Restart Pi or run `/reload`, then build the initial index:

```text
/session-index
```

Ask Pi about earlier conversations normally. The agent can call
`session_search` with optional source-language `queryVariants` when the current
question and the historical conversation may use different languages.

The extension reads Pi JSONL transcripts without modifying them. Generated
state stays in `~/.pi/agent/session-search/` with private filesystem modes.

## Local development

```bash
npm install
npm run hooks:install # optional contributor hook
npm run quality
pi -e ./src/index.ts
```

Generated state defaults to `~/.pi/agent/session-search/index.sqlite`. Override
the storage directory with `PI_SESSION_SEARCH_DIR` and the transcript root with
`PI_CODING_AGENT_SESSION_DIR`.

Do not enable Session Search globally alongside another extension that already
registers `session_search`; Pi will suffix duplicate tool and command names.
During migration, validate this checkout with `pi -e ./src/index.ts` and switch
the global package only after the replacement index passes its gates.

## Status

The first release supports Pi JSONL sessions. The normalized source boundary is
reserved for a later read-only OpenCode SQLite adapter.

## License and origin

MIT. Parts of the parser and search behavior are derived from
[`pi-hermes-memory`](https://github.com/chandra447/pi-hermes-memory). See
[ATTRIBUTION.md](ATTRIBUTION.md).
