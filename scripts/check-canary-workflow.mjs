#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflow = await readFile(resolve(root, '.github/workflows/upstream-dsh-canary.yml'), 'utf8')
const documentation = await readFile(resolve(root, '.github/UPSTREAM_DSH_CANARY.md'), 'utf8')
const compatibility = JSON.parse(await readFile(resolve(root, 'compatibility.json'), 'utf8'))
const packageManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const failures = []
let assertions = 0

function assertContract(name, condition) {
  assertions += 1
  if (!condition) failures.push(name)
}

assertContract('scheduled trigger exists', workflow.includes('cron: "0 3 * * *"'))
assertContract('manual trigger exists', workflow.includes('workflow_dispatch:'))
assertContract('workflow has read-only contents permission', workflow.includes('contents: read'))
assertContract('issue write is scoped to canary job', workflow.includes('issues: write'))
assertContract('latest and next are both checked', workflow.includes('channel: latest') && workflow.includes('channel: next'))
assertContract('next deduplicates against latest', workflow.includes('dedupe_args: --dedupe-against latest'))
assertContract('canary keeps the provisioned pnpm major active', workflow.includes('npm_config_manage_package_manager_versions: "false"'))
assertContract('canary provisions exactly one pinned pnpm version',
  workflow.includes('npm install --global pnpm@10.30.3')
    && workflow.includes('test "$(pnpm --version)" = \'10.30.3\'')
    && !workflow.includes('pnpm/action-setup@'))
assertContract('candidate failures are retried unchanged', workflow.includes('first-canary') && workflow.includes('second-canary') && workflow.includes('continue-on-error: true'))
assertContract('workflow fails after two failures', workflow.includes('Fail after two unsuccessful checks') && workflow.includes('run: exit 1'))
assertContract('workflow never publishes or deploys', !/npm\s+publish|gh\s+release|dsh\s+web|deploy/iu.test(workflow))
assertContract('all third-party actions are pinned', [...workflow.matchAll(/uses:\s+[^\s@]+@([^\s#]+)/gu)].every(match => /^[0-9a-f]{40}$/u.test(match[1] ?? '')))
assertContract('documentation excludes local ASR from upstream canary', documentation.includes('does not start a model provider') && documentation.includes('optional local ASR runtime/model'))
assertContract('documentation defines infrastructure exit code', documentation.includes('`2` for candidate resolution or checker infrastructure failures'))
assertContract('compatibility baseline is explicit', compatibility.schemaVersion === 1 && compatibility.dshPluginApi?.version === '0.1.2-alpha.1')
assertContract('canary scripts are package scripts', packageManifest.scripts?.['check:dsh-next'] === 'node scripts/check-dsh-next.mjs' && packageManifest.scripts?.['check:dsh-install'] === 'node scripts/check-dsh-install.mjs')

if (failures.length > 0) {
  console.error(`Canary workflow contract failed (${failures.length}/${assertions}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`Canary workflow contract: ${assertions}/${assertions} assertions passed`)
