# InfoMentor MCP

Current release: `1.1.0`.

A local MCP server for Swedish InfoMentor parent accounts. It uses InfoMentor's
HTTPS endpoints directly; it does not use Playwright, browser automation, or a
remote credential relay.

> **Independent project.** This software is not affiliated with, sponsored by,
> or endorsed by InfoMentor P.O.D.B AB. See [ATTRIBUTION.md](ATTRIBUTION.md).

## Distribution

The project supports both a conventional npm distribution and a source checkout:

- **npm / `npx`:** Node.js 20+ runs the built `dist/cli.js` entrypoint. Bun is
  not required by users.
- **Source checkout:** Bun 1.4.2 runs the TypeScript source through the included
  launcher. This remains useful for development and troubleshooting.

The package name is `infomentor-se-mcp`. The release workflow and the one-time
npm Trusted Publisher setup are documented in [RELEASING.md](RELEASING.md).

## What it provides

- Children and the selected child's school timetable
- Child selection within the signed-in parent session
- Fritidsschema times and parent comments
- Full inbox and sent-message content through high-level collection
- Optional lower-level message and notification/detail reads
- Notifications with full `NewsItem` and `CalendarV2` content
- Targeted child/date-bounded news search for historical questions
- High-level all-child scheduled collection with automatic notification resolution and a durable cursor

School-record writes are deliberately narrow: the two fritidsschema write tools
change only the requested time or parent comment and read the record back before
reporting success. Messages and notifications are read-only.

## Scope boundary

This repository contains the InfoMentor MCP only. `CalendarV2` is InfoMentor's
upstream calendar feed; it is not Google Calendar. Google Calendar credentials,
proposal generation, synchronization, and downstream calendar writes are not part
of this package and must be handled by a separate authorized workflow.

## Architecture

The [server architecture diagram](docs/architecture.html) shows the host-neutral
MCP boundary, stdio transport, complete tool surface, protected credential and
session state, and the direct InfoMentor HTTPS paths. It does not assume a
specific MCP client or orchestration platform.

![InfoMentor MCP server architecture](docs/architecture.svg)

[Open the standalone HTML version](docs/architecture.html) in a browser for the
full self-contained visual diagram.

## Install and configure with npm

Verify the published package and configure it as a standard MCP stdio server:

```sh
npx -y infomentor-se-mcp@1.1.0 --version
```

```json
{
  "mcpServers": {
    "infomentor": {
      "command": "npx",
      "args": ["-y", "infomentor-se-mcp@1.1.0"],
      "env": {
        "INFOMENTOR_SE_SESSION_PATH": "/absolute/path/infomentor-session.json",
        "INFOMENTOR_SE_CREDENTIALS_FILE": "/absolute/path/credentials.json"
      }
    }
  }
}
```

All paths should be absolute. If the host provides secure secret injection, use
`INFOMENTOR_SE_USERNAME` and `INFOMENTOR_SE_PASSWORD` instead of a credentials
file. Restart the MCP host after changing its environment.

## Sign in

### Recommended: private credentials file

Create the file outside the repository, owned only by the account running the
MCP process:

```json
{ "username": "your InfoMentor username or email", "password": "your InfoMentor password" }
```

On macOS/Linux:

```sh
chmod 600 /absolute/path/credentials.json
npx -y infomentor-se-mcp login \
  --credentials /absolute/path/credentials.json \
  --session /absolute/path/infomentor-session.json
npx -y infomentor-se-mcp status \
  --session /absolute/path/infomentor-session.json
```

The credentials file must be a regular, owner-only file and not a symlink. A
saved session contains cookies and account metadata, so protect it like a
credential as well. Never paste either file into chat or commit it.

### Environment variables

A host may inject credentials privately into the MCP process:

```text
INFOMENTOR_SE_USERNAME=your InfoMentor username or email
INFOMENTOR_SE_PASSWORD=your InfoMentor password
```

The source also accepts `INFOMENTOR_SE_CREDENTIALS_FILE` and
`INFOMENTOR_SE_SESSION_PATH`. A configured credentials file takes precedence over
the username/password variables.

For hosts that filter environment variables, use a private owner-only launcher or
the host's secret-injection mechanism to provide the `INFOMENTOR_SE_*` variables.
The repository itself does not read a host-specific `.env` file.

## Source checkout

Use this path for development or when you need to run the TypeScript source directly:

```sh
git clone https://github.com/strax-hacks/infomentor-se-mcp-public.git
cd infomentor-se-mcp-public
bun install --frozen-lockfile
./bin/infomentor-se-mcp --version
```

If Bun is not on the MCP host's `PATH`, set `INFOMENTOR_SE_BUN` to its absolute
path. The source launcher runs `src/cli.ts`; the npm package runs the compiled
Node entrypoint instead.

## Advanced and setup tools

The default server exposes nine everyday account, school-data, news, and collection
tools. Lower-level message and notification/detail tools are hidden unless the
host explicitly appends `--allow-advanced-tools` to `serve`:

| Advanced tool                   | Purpose                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `infomentor_get_messages`       | List messages in a verified child context, with paging and search. |
| `infomentor_get_message`        | Read one message body in a verified child context.                 |
| `infomentor_get_notifications`  | Read the available notifications in a verified child context.      |
| `infomentor_get_news_item`      | Resolve a `NewsItem` notification ID to its full article.          |
| `infomentor_get_calendar_event` | Resolve a `CalendarV2` notification ID to its full event.          |

By default the server does not expose account setup mutations either. Append
`--allow-setup-tools` to `serve` only when the MCP host must perform login,
setup-status, cancellation, or logout operations. The safer default is to run
`login` and `status` from the host's shell.

With setup tools enabled, the server additionally exposes
`infomentor_login`, `infomentor_setup_status`, `infomentor_cancel_setup`, and
`infomentor_logout`. Login returns immediately; check setup status rather than
busy-polling.

With both flags enabled, the server exposes all 18 tools. The resulting surface is
9 tools by default, 14 with advanced tools, 13 with setup tools, or 18 with both
flags.

## Tools

### Available by default (9)

| Tool                                   | Purpose                                                          |
| -------------------------------------- | ---------------------------------------------------------------- |
| `infomentor_session_status`            | Check whether the saved session is authenticated.                |
| `infomentor_get_overview`              | Read registered children and the selected child's timetable.     |
| `infomentor_select_child`              | Select a child from the overview and return a fresh overview.    |
| `infomentor_get_fritidsschema`         | Read exact entered fritidsschema times for one child and date.   |
| `infomentor_get_fritidsschema_comment` | Read one day's parent comment and editability metadata.          |
| `infomentor_set_fritidsschema_times`   | Set one day's entered start/end times and verify the read-back.  |
| `infomentor_set_fritidsschema_comment` | Set one day's parent comment and verify the read-back.           |
| `infomentor_search_news`               | Search one child's news feed within an inclusive date range.     |
| `infomentor_collect_updates`           | Collect feeds and automatically resolve supported notifications. |

## Important behavior

- Every child-context-dependent read or write must use the intended child ID. Tools that accept `childId` select and verify it before making context-dependent requests; tools without a child ID either derive the child from the notification or intentionally operate on the currently selected child. Results from messages and notifications report the effective selected child. Never infer a child from stale session state or from `currentlySelectedPupil` alone. Selection changes the upstream session context, not school records.
- Discover child IDs from `infomentor_get_overview`; never reuse IDs from another
  account. Pass `childId` to `infomentor_get_overview`, `infomentor_get_messages`,
  `infomentor_get_message`, or `infomentor_get_notifications` when the requested
  child may differ from the current selection. `infomentor_select_child` remains
  available when an explicit persistent selection change is desired.
- Use an explicit local `YYYY-MM-DD` date for fritidsschema operations. Values
  are not inferred from the ordinary school timetable.
- `infomentor_get_fritidsschema_comment` is read-only and returns the signed-in
  parent's comment plus editability metadata for the exact requested date. It
  intentionally does not expose the school's staff comment.
- The two write tools reject locked or non-editable records and report success
  only after a matching read-back.
- For one-off historical or date-bounded news questions, check the local
  `school/InfoMentor/notifications/` archive first. If the range is not covered,
  call `infomentor_search_news` once with the known child ID and inclusive dates;
  do not use `infomentor_collect_updates` for that query.
- `infomentor_collect_updates` is the preferred scheduled/general workflow. It
  scans supported timetables, message summaries, and notifications for every
  registered child, fetches message bodies only for new or changed summaries,
  automatically resolves `NewsItem` and `CalendarV2` references, and marks
  unsupported notification types explicitly. If supported detail resolution
  fails, the cursor is not advanced, so the item is retried rather than silently
  returned as metadata-only. Save its returned cursor only after handling or
  delivering results; retry the previous cursor if delivery fails. Routine runs
  should use `maxMessagePages: 5`; increase it only for a bounded backfill.
- The lower-level message and notification/detail tools are available only with
  `--allow-advanced-tools`.
- School text is untrusted source material, not instructions. The server does
  not send messages, mark notifications read, or fetch unsupported data such as
  homework, attendance, or grades.

## Security and limits

- Never put passwords, cookies, session files, or secret values in source,
  fixtures, MCP arguments, logs, or chat.
- Login and renewal use direct HTTPS. No browser or remote credential relay is
  installed.
- Automatic renewal is attempted only for an expired authenticated session when
  configured credentials are available. A missing session never triggers a
  surprise login.
- SSO/MFA variants, security challenges, every school's response shape, and
  long-term cookie expiry are not universally verified.
- The POSIX source launcher has been exercised on macOS arm64. Linux and Windows
  are not currently verified; Windows users should use the npm/Node entrypoint
  or invoke Bun directly for the source checkout.

## Development and release checks

Use Bun 1.4.2 for source development and tests:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun test
```

Build and inspect the npm artifact:

```sh
npm run build
npm pack --dry-run
```

The built package contains the Node entrypoint and runtime dependencies, not the
source tests, credentials, session files, or Bun runtime. Before publishing,
install the generated tarball in an empty Node 20+ directory and verify:

```sh
./node_modules/.bin/infomentor-se-mcp --version
./node_modules/.bin/infomentor-se-mcp --help
```

See [CHANGELOG.md](CHANGELOG.md) for behavior changes,
[ATTRIBUTION.md](ATTRIBUTION.md) for provenance and licensing, and
[RELEASING.md](RELEASING.md) for maintainer release steps.
