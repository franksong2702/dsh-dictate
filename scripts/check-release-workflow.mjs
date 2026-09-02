import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url))
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const workflow = readFileSync(workflowPath, 'utf8')
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))

const failures = []
let assertionCount = 0

function assertContract(name, condition) {
  assertionCount += 1
  if (!condition) failures.push(name)
}

assertContract('workflow is manually triggered', /^on:\s*\n\s+workflow_dispatch:/m.test(workflow))
assertContract('version input is required', /workflow_dispatch:[\s\S]*?inputs:[\s\S]*?^\s+version:\s*\n[\s\S]*?required:\s*true/m.test(workflow))
assertContract('explicit publish confirmation input is required', /workflow_dispatch:[\s\S]*?inputs:[\s\S]*?^\s+confirm:\s*\n[\s\S]*?required:\s*true/m.test(workflow))
assertContract('confirmation is checked for exact PUBLISH', /if\s+\[\[\s*"\$CONFIRM"\s*!=\s*['"]PUBLISH['"]\s*\]\]/.test(workflow))
assertContract('automatic triggers are absent', !/^\s+(?:push|pull_request|schedule):/m.test(workflow))
assertContract('release is gated to main', /if:\s*github\.ref\s*==\s*['"]refs\/heads\/main['"]/.test(workflow))
assertContract('npm-release environment is required', /^\s+environment:\s*npm-release\s*$/m.test(workflow))
assertContract('release concurrency is configured', /^concurrency:\s*\n/m.test(workflow))
assertContract('GitHub-hosted macOS runner is used', /^\s+runs-on:\s*macos-14\s*$/m.test(workflow))

const permissionBlock = workflow.match(/^permissions:\s*\n((?:^[ \t]+[^\n]*\n?)+)/m)?.[1] ?? ''
const permissionNames = [...permissionBlock.matchAll(/^\s+([a-z-]+):/gm)].map((match) => match[1])
assertContract(
  'permissions are limited to contents write and id-token write',
  permissionNames.length === 2
    && permissionNames.includes('contents')
    && permissionNames.includes('id-token')
    && /\bcontents:\s*write\b/.test(permissionBlock)
    && /\bid-token:\s*write\b/.test(permissionBlock),
)
assertContract('long-lived npm token names are absent', !/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\b/i.test(workflow))
assertContract('all actions are pinned to full commit SHAs', (() => {
  const uses = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gm)].map((match) => match[1])
  return uses.length > 0 && uses.every((ref) => /@[0-9a-f]{40}$/.test(ref))
})())
assertContract('pnpm version is pinned', /pnpm\/action-setup@[0-9a-f]{40}[\s\S]*?version:\s*9\.15\.9/.test(workflow))
assertContract('Node version is pinned', /node-version:\s*24\.15\.0/.test(workflow))
assertContract('npm version is pinned', /npm\s+install\s+--global\s+npm@11\.17\.0/.test(workflow))
assertContract('npm registry is configured', /registry-url:\s*https:\/\/registry\.npmjs\.org/.test(workflow))
assertContract('release dependency cache is disabled', /package-manager-cache:\s*false/.test(workflow))
assertContract('dependency installation is frozen', /pnpm\s+--config\.minimum-release-age=0\s+install\s+--frozen-lockfile/.test(workflow))
assertContract('strict alpha semver validation is present', /VERSION"\s*=~\s*\^\(0\|[\s\S]*-alpha\\\./.test(workflow))
assertContract('input version is compared with package.json', /package_version[\s\S]*?VERSION/.test(workflow))
assertContract('git tag target existence is checked before publishing', /git ls-remote --exit-code --refs origin "refs\/tags\/v\$\{VERSION\}"/.test(workflow))
assertContract('GitHub release target existence is checked before publishing', /gh release view "v\$\{VERSION\}"/.test(workflow))

const packedArtifactPublish = 'npm publish "./artifacts/${PACKAGE}-${VERSION}.tgz" --tag next --provenance'
const publishIndex = workflow.indexOf(packedArtifactPublish)
const packageCheckIndex = workflow.indexOf('pnpm run test:package')
const nativeCheckIndex = workflow.indexOf('codesign --verify --strict')
assertContract('package and native checks precede npm publish', packageCheckIndex >= 0 && nativeCheckIndex > packageCheckIndex && publishIndex > nativeCheckIndex)
assertContract('publish uses the already packed artifact with npm OIDC provenance and next tag', publishIndex >= 0)
assertContract('an identical npm artifact can safely resume after publishing',
  /npm view "\$PACKAGE\@\$VERSION" version/.test(workflow)
    && /Existing npm version does not match this artifact and next tag; refusing unsafe resume/.test(workflow)
    && /npm already contains the identical/.test(workflow))
assertContract('workflow never uses a long-lived-token-only dist-tag command', !/npm dist-tag/.test(workflow))
assertContract('post-publish verification checks version, next tag, and artifact shasum',
  /for attempt in \{1\.\.30\}/.test(workflow)
    && /sleep 10/.test(workflow)
    && /dist-tags\.next/.test(workflow)
    && /dist\.shasum/.test(workflow)
    && /local_shasum/.test(workflow))
assertContract('GitHub prerelease is created from the workflow SHA with the tarball',
  /gh release create[\s\S]*?artifacts\/dsh-dictate-\$\{VERSION\}\.tgz[\s\S]*?--prerelease[\s\S]*?--target "\$GITHUB_SHA"/.test(workflow))
assertContract('release notes state DSH and platform compatibility',
  /Requires DeepSeek Harness >=0\.1\.2-alpha\.3 <0\.2\.0/.test(workflow)
    && /Experimental local ASR supports Apple Silicon Macs and unsigned Windows x64/.test(workflow)
    && /Mixed rc\.2\/Alpha\.2 profile dependencies may report peer warnings/.test(workflow))
assertContract('release verifies the bundled Windows x64 runtime',
  /file native\/win32-x64\/dsh-dictate-asr\.exe/.test(workflow)
    && /92b727dbcd7f2edcb7b96bd6e012147480b9ef408c10ed343347e9722b09f5f2/.test(workflow))
assertContract('package check invokes this contract', packageJson.scripts?.['check:release-workflow'] === 'node scripts/check-release-workflow.mjs')

if (failures.length > 0) {
  console.error(`release workflow contract failed (${failures.length}/${assertionCount}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`release workflow contract: ${assertionCount}/${assertionCount} assertions passed`)
