#!/usr/bin/env node

// Dependency-free guard: this check must run before any package installation.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const workflow = read('.github/workflows/dsh-source-compat.yml')
const npmWorkflow = read('.github/workflows/ci.yml')
const checker = read('scripts/check-dsh-source.mjs')
const compatibility = JSON.parse(read('compatibility.json'))
let checks = 0
function check(condition, message) { assert(condition, message); checks++ }

check(workflow.includes('pull_request:') && workflow.includes('workflow_dispatch:'), 'PR and manual triggers required')
check(workflow.includes('ref: ${{ github.event.pull_request.head.sha || github.sha }}'), 'Record the exact PR head rather than a synthetic merge commit')
check(!workflow.includes('pull_request_target:'), 'Never execute PR code with a privileged trigger')
check(workflow.includes('contents: read') && !/\bwrite\b/.test(workflow), 'Read-only permissions required')
check(!/secrets\.|continue-on-error:|npm\s+publish|gh\s+(?:pr\s+merge|release)|dsh\s+web/.test(workflow), 'No credentials, suppressed failures, publishing or live services')
check([...workflow.matchAll(/uses:\s+[^\s@]+@([^\s#]+)/g)].every(match => /^[a-f0-9]{40}$/.test(match[1])), 'Pin every action to an immutable commit')
check((workflow.match(/persist-credentials: false/g) ?? []).length === 3, 'All three checkouts must discard credentials')
check(workflow.includes('repository: deepseek-ai/deepseek-harness') && workflow.includes(`ref: ${compatibility.sourceCandidate.commit}`), 'Upstream checkout must match compatibility.json')
check(workflow.includes('ref: 6b86d280d796b6c87f0dbb3ba5688c36c0bcf557'), 'Use the immutable toolchain baseline, not main')
check(workflow.includes('node: [22.19.0, 24.15.0]') && workflow.includes('fail-fast: false'), 'Check both Node lines independently')
check(workflow.includes('timeout-minutes: 30') && workflow.includes('shell: bash'), 'Bound execution and preserve pipe failures')
check(workflow.includes('npx --yes pnpm@9.15.9 install --frozen-lockfile --ignore-scripts'), 'Keep baseline toolchain locked')
check(workflow.includes('npx --yes pnpm@11.7.0 install --frozen-lockfile --ignore-scripts'), 'Keep upstream graph locked')
check(workflow.includes('npx --yes pnpm@11.7.0 run build'), 'Build upstream before verifying the candidate')
check(workflow.includes('node scripts/check-dsh-source.mjs --source .source-upstream --tools .source-toolchain/node_modules --report-dir'), 'Exercise the actual isolated source checker')
check(workflow.includes('npx --yes --package=pnpm@9.15.9 -- node scripts/check-dsh-source.mjs'), 'Expose pinned pnpm on PATH for nested package verification')
check(workflow.includes('if: always()') && workflow.includes('actions/upload-artifact@') && workflow.includes('retention-days: 14'), 'Preserve bounded evidence on success and failure')
check(workflow.includes('not npm installability'), 'Do not imply npm installation readiness')
check(npmWorkflow.includes('pnpm install --frozen-lockfile') && !/continue-on-error:|if:/.test(npmWorkflow), 'Do not bypass the separate npm CI gate')
check(checker.includes("if (entry === '@deepseek-ai' || entry === '.pnpm') continue"), 'Never inherit the old DSH package graph')
check(checker.includes('npmArtifactsVerified: false') && checker.includes('realMicrophoneVerified: false'), 'Keep evidence boundaries explicit')
console.log(`Source workflow contract: ${checks}/${checks} assertions passed`)
