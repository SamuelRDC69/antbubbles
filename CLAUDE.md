@AGENTS.md

## Code Exploration — Use the Knowledge Graph First

This project has a persistent knowledge graph (code-review-graph MCP).

**NEVER use Grep/Glob/Read to explore the codebase.** Always reach for the graph tools first:

| Task | Tool |
|------|------|
| Find a function/component | `semantic_search_nodes` |
| Understand what calls what | `query_graph` (callers_of / callees_of) |
| Check impact of a change | `get_impact_radius` |
| Find imports/dependencies | `query_graph` (imports_of) |
| Code review | `detect_changes` + `get_review_context` |

Only fall back to Grep/Read when the graph doesn't cover it (e.g. reading a specific known line range to make an edit).
