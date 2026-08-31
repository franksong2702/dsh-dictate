# DSH 0.1.2-alpha.2 npm and source compatibility candidate

This change targets the official `@deepseek-ai/dsh@0.1.2-alpha.2` npm release and its immutable upstream source commit `0a53fb55bea101816fa226bb964ae2bed71c343b`, based on Dictate commit `6b86d280d796b6c87f0dbb3ba5688c36c0bcf557`. It is ready for code review, **not a release approval**.

## Scope

- Preserve Web Speech as default, optional local SenseVoice, the approved single focus card, and user-controlled sending.
- Replace removed client-runtime loading and APIProxy model discovery with the current Cordis/Remote contracts.
- Update custom RPC registration for the new Connection API without bypassing Host authentication.
- Limit changes to dependency metadata, affected API calls, regression tests, and source-check tooling. Exclude Windows, UI redesign, release-workflow repair, and deployments.

## Verification

Completion criterion: build the fixed upstream source; pass plugin typechecking, build, regression tests and plugin loading checks against that source package graph; regenerate the plugin lockfile from official npm artifacts; and pass the isolated DSH profile installation canary.

Reproduction commands (replace the upstream path with your clean, built checkout):

```sh
# In the upstream checkout at the exact commit above:
npx --yes pnpm@11.7.0 install --frozen-lockfile --ignore-scripts
npx --yes pnpm@11.7.0 run build

# In this plugin checkout, with an existing test/build toolchain:
node scripts/check-dsh-source.mjs --source /path/to/built-upstream --tools /path/to/toolchain/node_modules
```

The source checker prints its isolated fixture path and writes `report.json` with the exact commands, exit codes and per-stage log paths. Toolchain dependencies can come from the locked prior plugin baseline; **all `@deepseek-ai` packages resolve into the fixed upstream checkout**, never the old DSH graph. The checker rejects a different upstream SHA or tracked source modifications. It requires upstream artifacts to have been built first.

Observed on 2026-08-31 (Node v26.5.0):

| Check | Result |
|---|---|
| Upstream build | Exit 0; 220 client artifacts recorded |
| Pinned source checker | Exit 0; all 9 stages exit 0 |
| Frozen plugin install | Exit 0 with pnpm 9.15.9 and the regenerated lockfile |
| Typecheck, declaration generation, client bundle and package contents | Passed |
| Plugin regression tests (including the parent Remote injection fix) | 6 test files; 130/130 tests passed |
| Real upstream Connection | Token exchange 303; anonymous request 401; untrusted Origin/Host 403 |
| Authenticated custom RPC | Polish/terms success, invalid input rejection, isolated settings persistence |
| Real upstream module loader, Cordis and SlotRegistry | Built client materialized; all 3 plugin slots registered and unloaded |
| Official npm profile installation | DSH `0.1.2-alpha.2`; profile registered and prepared; host exports `Config`, `apply`, `inject`, `name` |
| Canary contract | 31/31 assertions passed |
| Canary workflow contract | 17/17 assertions passed |
| Diff and source-check script syntax | Exit 0 |

The smoke test uses actual upstream Connection, browser authentication, FileSettingsProvider, ClientModuleSystem and SlotRegistry. HTTP streams and LLM/session content are deterministic fixtures. UI primitives use the upstream's real icon exports. The npm canary invokes the Web profile's help-only path so the official launcher prepares its module fallback inside the temporary `DSH_HOME` before the plugin import check; the probe requires app help with no server URL or stderr and does not enter Web server startup. No live model is started and no persistent user profile is modified.

Review objection: does removing `authority: 'trusted-host'` weaken protection, or merely satisfy a mocked test? The new Connection API no longer accepts that argument and centrally enforces Host/Origin and browser-session checks. The smoke test exercises the real upstream implementation and verifies both rejection and authenticated success. It does not establish real microphone or model end-to-end behavior.

Confidence: high for the fixed-source API/loading checks and listed automated regressions only.

## Independent pinned-source CI

`.github/workflows/dsh-source-compat.yml` adds **Pinned DSH source compatibility** on pull requests and manual runs, independently of the existing npm CI. Each Node 22.19.0 / 24.15.0 job:

1. Checks out the exact upstream commit declared above, never a moving branch or tag.
2. Installs the unchanged toolchain lockfile from Dictate commit `6b86d280d796b6c87f0dbb3ba5688c36c0bcf557` with pnpm 9.15.9. This supplies build/test tools only; its DSH dependencies are excluded from the candidate fixture.
3. Installs and builds upstream using its frozen lockfile and pnpm 11.7.0.
4. Runs `check-dsh-source.mjs` against that source graph, including the additional dependency-free source-workflow contract check (nine stages in total). `npm exec` exposes pinned pnpm 9.15.9 on PATH for nested package verification; no preinstalled global pnpm is assumed.
5. Uploads per-stage logs and `report.json` when available, including on failure. Source reports record the upstream/plugin commits, Node version and result, with `npmArtifactsVerified: false` and `realMicrophoneVerified: false`; npm artifact verification remains the separate isolated profile canary described above.

The workflow has read-only permissions, immutable action references, no persisted checkout credentials, no secrets, no publishing and no service startup. Logs are retained for 14 days. A green **source-only** check is not an npm installation or release approval. The original `.github/workflows/ci.yml` remains unchanged and still requires the candidate's own frozen-lockfile installation.

Local reproduction with a built source checkout and locked tools:

```sh
node scripts/check-source-workflow.mjs
node scripts/check-dsh-source.mjs --source /path/to/built-upstream --tools /path/to/locked-tools/node_modules --report-dir /path/to/source-evidence
```

On 2026-08-31, the official registry resolved `@deepseek-ai/dsh@0.1.2-alpha.2` and the pinned `@deepseek-ai` dependency graph. The lockfile was regenerated, a fresh frozen install passed, and the isolated npm profile canary passed. This removes the prior npm-availability blocker; it does not replace real Composer, microphone, model, or local-ASR acceptance.

## Merge and release gates

- [x] Resolve and lock the official `0.1.2-alpha.2` npm artifacts; pass a fresh frozen-lockfile install.
- [x] Repeat the full isolated profile installation canary using official artifacts.
- [ ] Obtain real Composer/microphone/local-ASR acceptance in an explicitly authorized test profile.
- [ ] Update the release version and user documentation before publishing.

`pnpm-lock.yaml` now matches the `0.1.2-alpha.2` manifest and passes a fresh frozen install. The package version and user-facing README still describe the prior plugin release, so do not publish this compatibility candidate as-is.

This candidate raises the minimum DSH peer version to `0.1.2-alpha.2`; it does not claim continued compatibility with `0.1.1-rc.2` or `0.1.2-alpha.1`. Windows, real browser layout, microphone capture, actual model polishing and native ASR audio transcription are unverified in this run.
