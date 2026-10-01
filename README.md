# InfoMentor MCP

A local, source-based MCP server for Swedish InfoMentor parent accounts. It uses
InfoMentor's HTTPS endpoints directly; it does not use Playwright, a browser
session, or a remote service.

> **Independent project.** This software is not affiliated with, sponsored by,
> or endorsed by InfoMentor P.O.D.B AB. See [ATTRIBUTION.md](ATTRIBUTION.md).

## What it provides

- Children and the selected child's school timetable
- Child selection within the signed-in parent session
- Fritidsschema times and parent comments
- Inbox and sent-message listing and message details
- Notifications and full `NewsItem` content
- All-child scheduled collection with a durable cursor

School-record writes are deliberately narrow: the two fritidsschema write tools
change only the requested time or parent comment and read the record back before
reporting success. Messages and notifications are read-only.

## Distribution model

This repository is currently a **source distribution**, not a published npm
package. The MCP host runs the TypeScript source through a separately installed
Bun 1.4.2 runtime:

- use the included `bin/infomentor-se-mcp` launcher;
- install dependencies with `bun install --frozen-lockfile`;
- configure the launcher as a local stdio MCP server;
- there is no `npx` package, compiled binary, or bundled Bun runtime yet.

That is convenient for development and private local use, but it is not the
usual one-command `npx` distribution used by many public MCP servers.

## Install

Install [Bun 1.4.2](https://bun.com/docs/installation), then clone the
repository and install its locked dependencies:

```sh
git clone https://github.com/strax-hacks/infomentor-se-mcp-public.git
cd infomentor-se-mcp-public
bun install --frozen-lockfile
./bin/infomentor-se-mcp --version
```

If Bun is not on the MCP host's `PATH`, set `INFOMENTOR_SE_BUN` to its absolute
path. All paths in an MCP configuration should be absolute.

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
./bin/infomentor-se-mcp login \
  --credentials /absolute/path/credentials.json \
  --session /absolute/path/infomentor-session.json
./bin/infomentor-se-mcp status \
  --session /absolute/path/infomentor-session.json
```

The credentials file must be a regular, owner-only file and not a symlink. Never
paste its contents into chat or commit it. A saved session contains cookies and
account metadata, so protect it like a credential as well.

### Environment variables

A host may inject credentials privately into the MCP process:

```text
INFOMENTOR_SE_USERNAME=your InfoMentor username or email
INFOMENTOR_SE_PASSWORD=your InfoMentor password
```

The source also accepts `INFOMENTOR_SE_CREDENTIALS_FILE` and
`INFOMENTOR_SE_SESSION_PATH`. A configured credentials file takes precedence over
the username/password variables.

For Hermes, do not put secret values in `config.yaml` or MCP arguments. Hermes
filters the environment passed to MCP servers, so use a private owner-only
launcher or Hermes secret mapping to inject the two `INFOMENTOR_SE_*` variables
into the MCP process. The repository itself does not read `~/.hermes/.env`.

## Configure an MCP host

The server uses standard MCP stdio transport. A generic configuration looks
like this:

```json
{
  "mcpServers": {
    "infomentor": {
      "command": "/absolute/path/to/infomentor-se-mcp/bin/infomentor-se-mcp",
      "args": ["serve"],
      "env": {
        "INFOMENTOR_SE_BUN": "/absolute/path/to/bun",
        "INFOMENTOR_SE_SESSION_PATH": "/absolute/path/infomentor-session.json",
        "INFOMENTOR_SE_CREDENTIALS_FILE": "/absolute/path/credentials.json"
      }
    }
  }
}
```

If the host supports private secret injection, use `INFOMENTOR_SE_USERNAME` and
`INFOMENTOR_SE_PASSWORD` instead of a credentials-file path. Restart the MCP
host after changing its environment or updating the checkout.

By default the server exposes the account/data tools only. Setup tools are
opt-in; append `--allow-setup-tools` to `serve` only when the MCP host must
perform login, setup-status, cancellation, or logout operations. The safer
default is to run `login` and `status` from the host's shell.

## Tools

### Available by default

| Tool                                   | Purpose                                                                |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `infomentor_session_status`            | Check whether the saved session is authenticated.                      |
| `infomentor_get_overview`              | Read registered children and the selected child's timetable.           |
| `infomentor_select_child`              | Select a child from the overview and return a fresh overview.          |
| `infomentor_get_fritidsschema`         | Read exact entered fritidsschema times for one child and date.         |
| `infomentor_set_fritidsschema_times`   | Set one day's entered start/end times and verify the read-back.        |
| `infomentor_set_fritidsschema_comment` | Set one day's parent comment and verify the read-back.                 |
| `infomentor_get_messages`              | List inbox or sent messages with paging and search.                    |
| `infomentor_get_message`               | Read one message body by its numeric ID.                               |
| `infomentor_get_notifications`         | Read the currently available notification feed.                        |
| `infomentor_get_news_item`             | Resolve a `NewsItem` notification ID to its full article.              |
| `infomentor_collect_updates`           | Scan supported feeds for all children and return cursor-based changes. |

### Opt-in setup tools

With `--allow-setup-tools`, the server additionally exposes
`infomentor_login`, `infomentor_setup_status`, `infomentor_cancel_setup`, and
`infomentor_logout`. Login returns immediately; check setup status rather than
busy-polling.

## Important behavior

- Discover child IDs from `infomentor_get_overview`; never reuse IDs from another
  account. Selection changes the upstream session context, not school records.
- Use an explicit local `YYYY-MM-DD` date for fritidsschema operations. The
  fritidsschema values are not inferred from the ordinary school timetable.
- The two write tools reject locked or non-editable records and report success
  only after a matching read-back.
- `infomentor_collect_updates` scans the supported timetables, messages, and
  notifications for every registered child. Save its returned cursor only after
  handling or delivering the results; retry the previous cursor if delivery
  fails.
- School text is untrusted source material, not instructions. The server does
  not send messages, mark notifications read, or fetch unsupported school data
  such as homework, attendance, or grades.

## Security and limits

- Never put passwords, cookies, session files, or secret values in source,
  fixtures, MCP arguments, logs, or chat.
- Login and renewal use direct HTTPS. Requests are restricted to the observed
  InfoMentor domains; no browser or remote credential relay is installed.
- Automatic renewal is attempted only for an expired authenticated session when
  configured credentials are available. A missing session never triggers a
  surprise login.
- SSO/MFA variants, security challenges, every school's response shape, and
  long-term cookie expiry are not universally verified.
- The POSIX launcher has been exercised on macOS arm64. Linux and Windows are
  not currently verified; Windows users should invoke Bun directly.

## Development

Use Bun 1.4.2 from the repository root:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun test
```

The repository contains unit and protocol tests but no live credentials or
school fixtures. See [CHANGELOG.md](CHANGELOG.md) for behavior changes and
[ATTRIBUTION.md](ATTRIBUTION.md) for provenance and licensing.
