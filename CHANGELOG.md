# Changelog

## 0.11.0 — Direct NewsItem reads

- Added `infomentor_get_news_item`, which resolves a numeric notification ID of
  type `NewsItem` to the matching authenticated news row over direct HTTPS.
- Parses the matched HTML as inert data and returns body text, original HTML,
  links, images, and attachment URLs without requiring browser automation or
  marking the notification read.
- Added response-shape, HTML extraction, malformed-row, and notification-ID
  resolution coverage.

## 0.10.0 — Verified fritidsschema time writes

- Added `infomentor_set_fritidsschema_times` for explicit local start/end times,
  including opt-in overnight pickup times.
- Discovered and implemented InfoMentor's JSON `SaveTimeRegistrations` contract.
- Rejects malformed dates/times, non-editable, locked, and school-closed rows.
- Reads the exact row back after every mutation and reports success only when the
  persisted start/end values match the request.
- Added JSON HTTP contract, payload, permission, overnight, and read-back tests.

## 0.9.1 — Structured fritidsschema reads

- Added `infomentor_get_fritidsschema`, which reads the selected child's entered
  daily fritidsschema times from `GetTimeRegistrations` for an explicit date.
- Returns exact start/end datetimes and extracted local times, preserving leave,
  lock, closure, comment, and malformed-row information.
- Added Swedish relay/direct-login coverage and restored focused loopback and
  fritidsschema contract tests.

## 0.9.0 — Fritidsschema comments

- Added `infomentor_set_fritidsschema_comment` for setting a parent's comment
  for a selected child and explicit date.
- Verifies the selected child and fritidsschema entry before writing, and reads
  the comment back before reporting success.
- Added direct form-POST support for the InfoMentor SaveComment endpoint.

## 0.7.0

Breaking changes:

- Removed the optional local HTTP password form: `--local-form` and the MCP
  `localForm` field are rejected, and setup status no longer includes `waiting`.
  A stale form could send credentials to another local process after cancellation
  or timeout.
- Use a private credentials file or privately injected `INFOMENTOR_SE_USERNAME` /
  `INFOMENTOR_SE_PASSWORD` instead. Restart upgraded MCP processes and close any old
  local-form browser tabs. Existing sessions, account binding, session import,
  cancellation, and automatic renewal remain supported.

## 0.6.1

- Upgrades now report old running server processes and can stop them with
  `--stop-running`; otherwise restart the MCP host to use the new binary.

## 0.6.0

Historical release from the upstream monorepo. The standalone extraction keeps
the Swedish implementation and required shared helpers, while omitting the
other MCP servers, site assets, route helpers, and monorepo tooling. See
[`ATTRIBUTION.md`](ATTRIBUTION.md) for provenance.

Breaking changes:

- `infomentor_login`, `infomentor_setup_status`, `infomentor_cancel_setup`, and
  `infomentor_logout` are registered only when `serve` runs with `--allow-setup-tools`.
  By default the server exposes seven read tools and a missing session points to the CLI.
- An explicit `login` or `import` refuses to replace a session verified for a
  different account, or an unreadable session file, unless `--allow-account-change`
  (or `allowAccountChange`) is given.
- `infomentor_setup_status` no longer returns `loginUrl`; the local form URL is
  printed on the server's standard error only.
- New installs store the session at `~/.config/infomentor-se-mcp/session.json`
  (XDG). An existing `~/.infomentor-se-mcp/session.json` keeps working.
- Migrated to `@modelcontextprotocol/server` v2. The npm package and library
  entry points are gone; the native executable is the only distribution.

Other changes:

- Feed items (timetable, messages, notifications) are parsed independently: a
  malformed item is skipped and counted in `skipped` and `skippedByFeed`, display
  names may be `null`, and unknown notification `state` values pass through.
  Collection keeps the previous baseline for any feed with skipped rows, so a
  transient upstream glitch cannot produce false "missing" reports.
- A `429 Retry-After` pause is capped at one hour, saved with the session, and
  honoured by every process using that session file.
- The login `--timeout` now covers waiting for the session lock.
- Session, import, and credentials files are read through the shared session-store
  helpers with owner, mode, symlink, hard-link, and size checks;
  writes are `fsync`ed; the lock waits up to 30 seconds and never expires a live process.
- Logout also removes collection snapshots.
- Tool errors are fixed, reviewed messages; upstream text never reaches tool output.
- Tests run under `bun test` with injected seams; a loopback HTTP fixture covers
  redirects, cookies, rate limits, and oversized bodies.

## 0.5.0

Last release from the standalone `infomentor-se-mcp` repository.
