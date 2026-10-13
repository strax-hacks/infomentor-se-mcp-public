# Changelog

## 1.2.0

- Item-local notification detail failures return `detailStatus: "pending"` with
  a safe `detailError` while complete items can proceed. Pending details retry
  on unchanged scans after cursor advancement and emit recovered content.
- Authentication, account/child context, cancellation and other systemic failures
  continue to fail closed without advancing the collector cursor.
- Added the opt-in read-only `infomentor_get_calendar_week` and public calendar
  week schemas/types. Whole-week CalendarV2 links now resolve automatically in
  high-level collection as `detail.kind: "calendar_week"`, preserving exact
  entries and allowing empty weeks without guessing one event.
- Week reads validate explicit ISO year/week, verify child/account context after
  the feed read, share calendar feed caches, and restore the original selection.
  Incomplete feeds stay pending and are retried; exact-event reads remain strict.
- The source tool surface is 9 default, 15 advanced, 13 setup, or 19 combined.
  These changes are included in npm `1.2.0`.

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
