# Changelog

## 1.1.0

- Child-context-dependent overview, message, and notification reads can receive
  an explicit `childId`; the client selects and verifies that child before the
  request and reports the effective selected child in the result.
- Updated public tool descriptions and instructions to treat child selection
  as mutable session state rather than trusting a previous selection.
- Added `infomentor_search_news` for one-child, inclusive date-bounded news
  searches without running the account-wide collector.
- `infomentor_collect_updates` now avoids unchanged message bodies and unchanged
  notification detail resolution while preserving its account-wide cursor
  semantics.
- Legacy collection snapshots are upgraded without replaying unchanged items;
  partial feeds preserve their previous baselines and detail failures leave the
  cursor retryable.

## 1.0.0

- First standalone release of the Swedish InfoMentor MCP server.
- Eight everyday tools are available by default; lower-level detail tools and
  account setup tools are independently opt-in.
- `infomentor_collect_updates` is the preferred high-level workflow and resolves
  supported `NewsItem` and `CalendarV2` notifications automatically.
- Fritidsschema time and parent-comment writes are narrow, explicit, and verified
  by exact read-back.
- Source checkout support uses Bun; the npm distribution targets Node.js 20+.
- The MCP contains InfoMentor access only. Google Calendar synchronization and
  other downstream side effects are intentionally outside this package.
