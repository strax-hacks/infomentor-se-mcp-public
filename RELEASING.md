# Releasing InfoMentor MCP

This repository publishes the `infomentor-se-mcp` package to the public npm
registry. The package is a local stdio MCP server; npm distribution does not
change the MCP protocol or add a hosted service.

## One-time setup

1. Keep the GitHub repository public. The package metadata and npm provenance
   must point to the exact public repository:
   `https://github.com/strax-hacks/infomentor-se-mcp-public`.
2. Use an npm account with two-factor authentication enabled.
3. Publish the first package version manually. npm must know the package before
   its Trusted Publisher can be configured.
4. After the first package exists, configure npm Trusted Publishing in the
   package settings (or with npm 11.15+):
   - provider: GitHub Actions
   - owner: `strax-hacks`
   - repository: `infomentor-se-mcp-public`
   - workflow: `publish.yml`
   - environment: leave empty unless the workflow is later protected by a
     GitHub environment

The equivalent authenticated CLI command is:

```sh
npm trust github infomentor-se-mcp \
  --repo strax-hacks/infomentor-se-mcp-public \
  --file publish.yml \
  --allow-publish \
  --yes
```

Trusted Publishing is used by `.github/workflows/publish.yml`; no long-lived
npm token belongs in the repository or in GitHub secrets.

## First npm release

The first npm release is `1.1.0`. Before publishing, make sure the changelog
contains all changes in that release and the package version is exactly
`1.1.0`.

Run from the release commit in a clean checkout:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun test --timeout 30000
npm run build
npm pack --dry-run
npm whoami
npm publish
```

`infomentor-se-mcp` is an unscoped package and is public by default. The npm
publish command requires an authenticated npm account with 2FA, or an
appropriate granular access token. Never put npm credentials in this
repository, a command argument, or a chat message.

Then verify the registry result:

```sh
npm view infomentor-se-mcp version dist-tags
npx -y infomentor-se-mcp@1.1.0 --version
```

After the release commit has passed the normal CI workflow, publish the package
manually, verify it, and configure the Trusted Publisher in npm. Then create the
matching Git tag and GitHub release:

```sh
git tag -a v1.1.0 -m "Release InfoMentor MCP 1.1.0"
git push origin v1.1.0
gh release create v1.1.0 --generate-notes
```

The tag workflow repeats all checks. It sees that `1.1.0` already exists and
skips a duplicate publish. Future tags with a new package version are published
automatically with npm provenance.

## Future releases

Add a new `## X.Y.Z` heading and its release notes at the top of
`CHANGELOG.md`, then run:

```sh
./release.sh X.Y.Z
```

The script checks the main branch and clean worktree, verifies npm/GitHub
authentication and the Trusted Publisher reminder, updates `package.json` and
the pinned README version, runs all quality gates, commits and pushes the
release, waits for CI, asks before pushing the publication-triggering tag,
waits for the npm workflow, creates the GitHub release, and verifies both npm
and a fresh `npx` consumer. It never asks for or handles an npm password or
2FA code.

A published name/version pair cannot be reused. If a published version has a
problem, deprecate it and publish the next patch version instead of trying to
republish it.

## Consumer smoke test

From a clean Node 20+ directory, configure an MCP host with the published
command:

```json
{
  "mcpServers": {
    "infomentor": {
      "command": "npx",
      "args": ["-y", "infomentor-se-mcp@X.Y.Z"],
      "env": {
        "INFOMENTOR_SE_SESSION_PATH": "/absolute/path/infomentor-session.json",
        "INFOMENTOR_SE_CREDENTIALS_FILE": "/absolute/path/credentials.json"
      }
    }
  }
}
```

Log in once with a private credentials file, keep the session and credentials
outside the repository, and verify that the host can list tools and report an
unauthenticated status before testing an authorized account read.
