#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage: ./release.sh VERSION

Prepare, verify, commit, tag, and publish a release through GitHub Actions.
VERSION must be a stable semver such as 1.2.0.

The npm Trusted Publisher for .github/workflows/publish.yml must be configured
once before the tag is pushed. The script never asks for an npm password or OTP.
EOF
}

die() {
  printf 'release.sh: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 1 ]] || { usage; exit 2; }
if [[ "$1" == "--help" || "$1" == "-h" ]]; then
  usage
  exit 0
fi
VERSION=$1
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION must be stable semver, for example 1.2.0"

for command in bun gh git node npm; do
  command -v "$command" >/dev/null 2>&1 || die "required command not found: $command"
done

git rev-parse --show-toplevel >/dev/null 2>&1 || die "run this from the repository"
[[ "$(git branch --show-current)" == "main" ]] || die "release from the main branch"
[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] || \
  die "working tree is not clean; commit or remove local changes first"

gh auth status >/dev/null 2>&1 || die "authenticate gh before releasing"
npm whoami --registry=https://registry.npmjs.org >/dev/null 2>&1 || \
  die "authenticate npm before releasing"

printf '%s\n' 'The npm Trusted Publisher must be configured for:'
printf '%s\n' "  package: infomentor-se-mcp" "  repository: strax-hacks/infomentor-se-mcp-public" "  workflow: publish.yml"
printf 'Is that Trusted Publisher configured? [y/N] '
read -r confirmation
[[ "$confirmation" =~ ^[Yy]$ ]] || die "configure npm Trusted Publishing before releasing"

REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
CURRENT_VERSION=$(node -p 'require("./package.json").version')

node -e '
const [current, next] = process.argv.slice(1);
const parse = (version) => version.split(".").map(Number);
const [currentMajor, currentMinor, currentPatch] = parse(current);
const [nextMajor, nextMinor, nextPatch] = parse(next);
const currentValue = currentMajor * 1_000_000 + currentMinor * 1_000 + currentPatch;
const nextValue = nextMajor * 1_000_000 + nextMinor * 1_000 + nextPatch;
if (nextValue <= currentValue) {
  console.error(`next version ${next} must be greater than current version ${current}`);
  process.exit(1);
}
' "$CURRENT_VERSION" "$VERSION" || exit 1

if git ls-remote --exit-code --refs origin "refs/tags/v$VERSION" >/dev/null 2>&1; then
  die "tag v$VERSION already exists"
fi

node -e '
const fs = require("node:fs");
const version = process.argv[1];
const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
const firstVersionHeading = changelog.split(/\r?\n/).find((line) => line.startsWith("## "));
if (firstVersionHeading !== `## ${version}`) {
  console.error(`CHANGELOG.md must start with ## ${version} and release notes before running release.sh`);
  process.exit(1);
}
' "$VERSION" || exit 1

printf 'Preparing InfoMentor MCP %s (current %s)\n' "$VERSION" "$CURRENT_VERSION"

node -e '
const fs = require("node:fs");
const [current, next] = process.argv.slice(1);
const packagePath = "package.json";
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
if (packageJson.version !== current) throw new Error(`package.json is ${packageJson.version}, expected ${current}`);
packageJson.version = next;
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const readmePath = "README.md";
let readme = fs.readFileSync(readmePath, "utf8");
readme = readme.split(`Current release: \`${current}\``).join(`Current release: \`${next}\``);
readme = readme.split(`infomentor-se-mcp@${current}`).join(`infomentor-se-mcp@${next}`);
fs.writeFileSync(readmePath, readme);
' "$CURRENT_VERSION" "$VERSION"

printf '%s\n' 'Run the release quality gates...'
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun test --timeout 30000
npm run build
npm pack --dry-run
git diff --check

printf '%s\n' 'Release changes:'
git diff --stat
printf 'Commit and push these changes to main? [y/N] '
read -r confirmation
[[ "$confirmation" =~ ^[Yy]$ ]] || die "stopped before commit; local release edits were kept"

git add package.json README.md CHANGELOG.md
git commit -m "Release InfoMentor MCP $VERSION"
git push origin HEAD:main
MAIN_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git ls-remote origin refs/heads/main | cut -f1)
[[ "$MAIN_SHA" == "$REMOTE_SHA" ]] || die "remote main does not match $MAIN_SHA"

printf '%s\n' 'Waiting for main CI...'
CI_RUN_ID=""
for _ in $(seq 1 60); do
  CI_RUN_ID=$(gh run list --repo "$REPO" --workflow ci.yml --commit "$MAIN_SHA" --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)
  [[ -n "$CI_RUN_ID" ]] && break
  sleep 2
done
[[ -n "$CI_RUN_ID" ]] || die "could not find the CI run for $MAIN_SHA"
gh run watch "$CI_RUN_ID" --repo "$REPO" --exit-status

printf '%s\n' 'CI passed. The next step pushes a tag and triggers npm publication.'
printf 'Push v%s and trigger the release workflow? [y/N] ' "$VERSION"
read -r confirmation
[[ "$confirmation" =~ ^[Yy]$ ]] || die "stopped before tagging; main is pushed and the tag was not created"

git tag -a "v$VERSION" -m "Release InfoMentor MCP $VERSION"
git push origin "refs/tags/v$VERSION"

printf '%s\n' 'Waiting for the npm release workflow...'
PUBLISH_RUN_ID=""
for _ in $(seq 1 60); do
  PUBLISH_RUN_ID=$(gh run list --repo "$REPO" --workflow publish.yml --commit "$MAIN_SHA" --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)
  [[ -n "$PUBLISH_RUN_ID" ]] && break
  sleep 2
done
[[ -n "$PUBLISH_RUN_ID" ]] || die "could not find the publish workflow for $MAIN_SHA"
gh run watch "$PUBLISH_RUN_ID" --repo "$REPO" --exit-status

gh release create "v$VERSION" --repo "$REPO" --title "InfoMentor MCP $VERSION" --generate-notes

PUBLISHED_VERSION=$(npm view "infomentor-se-mcp@$VERSION" version --registry=https://registry.npmjs.org)
[[ "$PUBLISHED_VERSION" == "$VERSION" ]] || die "npm registry returned version $PUBLISHED_VERSION"

CONSUMER_DIR=$(mktemp -d "${TMPDIR:-/tmp}/infomentor-release.XXXXXX")
printf '{}' > "$CONSUMER_DIR/package.json"
INSTALLED_VERSION=$(cd "$CONSUMER_DIR" && npx --yes "infomentor-se-mcp@$VERSION" --version)
[[ "$INSTALLED_VERSION" == "$VERSION" ]] || die "fresh npx returned version $INSTALLED_VERSION"
rm -rf -- "$CONSUMER_DIR"

printf '\nRelease complete: infomentor-se-mcp@%s\n' "$VERSION"
printf 'GitHub release: https://github.com/%s/releases/tag/v%s\n' "$REPO" "$VERSION"
printf 'npm package: https://www.npmjs.com/package/infomentor-se-mcp\n'
