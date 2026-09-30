# Provenance, attribution, and third-party notices

This standalone Swedish integration adapts the InfoMentor MCP package from
[`olafurns7/family-mcp`](https://github.com/olafurns7/family-mcp), at source
commit `133a0a4ffd09ff0a761048222b58cbffb5e20fd5`.

- The original package is `packages/infomentor-se-mcp`; its source and the copied
  `packages/session-store` are covered by the upstream MIT license. The original
  copyright holder is **Ólafur Nils Sigurðsson**.
- The standalone changes include Swedish InfoMentor endpoints and authentication,
  Swedish session/environment names, fritidsschema reads and writes, and this
  source-based standalone layout. This version also adds a NewsItem notification
  reader and tests not claimed as part of the cited base commit.
- `test/collection.test.ts`, `test/lock.test.ts`, and `test/targeted.test.ts`
  include adaptations of tests from the sibling InfoMentor package.
- The copied `mcp-runtime` source has been removed. The server uses the official
  `@modelcontextprotocol/server` TypeScript SDK package, which is MIT-licensed
  and is installed from the lockfile rather than vendored here. Project-specific
  tool-result and HTTP-body handling lives in this repository's own source.
- Bun is an execution and package-management prerequisite installed separately
  by each user. This repository does not bundle Bun, distribute its binary, or
  compile a single-file executable.

The root [`LICENSE`](LICENSE) is MIT, matching the upstream Swedish package and
session-store license. Third-party npm dependencies retain their own licenses;
this project does not relicense them. The package manifest remains `private` to
prevent accidental npm publication.

## InfoMentor name and marks

The [WIPO Madrid Monitor record for registration 1113587](https://www3.wipo.int/madrid/monitor/en/showData.jsp?ID=ROM.1113587)
identifies **InfoMentor P.O.D.B AB** as the holder of the InfoMentor word mark.
The name is used here only to identify the compatible third-party service.
This project is independent and is not affiliated with, sponsored by, endorsed
by, approved by, or otherwise connected to InfoMentor P.O.D.B AB or its
affiliates. No InfoMentor logos or official branding are used. This notice does
not grant rights to the InfoMentor service or content; use remains subject to the
provider's applicable terms.

The repository and package are currently private/local-only. No public release,
package publication, or official InfoMentor relationship is claimed.
