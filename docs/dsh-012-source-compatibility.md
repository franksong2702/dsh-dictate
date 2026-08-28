# DSH 0.1.2-alpha.1 source compatibility candidate

This change targets the immutable upstream release source `cd5ef8148158c3a752a658978873241fdf8e2bbc`, based on Dictate commit `6b86d280d796b6c87f0dbb3ba5688c36c0bcf557`. It is ready for code review, **not ready for merge or release**.

## Scope

- Preserve Web Speech as default, optional local SenseVoice, the approved single focus card, and user-controlled sending.
- Replace removed client-runtime loading and APIProxy model discovery with the current Cordis/Remote contracts.
- Update custom RPC registration for the new Connection API without bypassing Host authentication.
- Limit changes to dependency metadata, affected API calls, regression tests, and source-check tooling. Exclude Windows, UI redesign, release-workflow repair, and deployments.

## Verification

Completion criterion: build the fixed upstream source, then pass plugin typechecking, build, regression tests and plugin loading checks against that source package graph. Official npm artifact verification remains a separate release gate.

Reproduction commands (replace the upstream path with your clean, built checkout):

```sh
# In the upstream checkout at the exact commit above:
npx --yes pnpm@11.7.0 install --frozen-lockfile --ignore-scripts
npx --yes pnpm@11.7.0 run build

# In this plugin checkout, with an existing test/build toolchain:
node scripts/check-dsh-source.mjs --source /path/to/built-upstream --tools /path/to/toolchain/node_modules
```

The source checker prints its isolated fixture path and writes `report.json` with the exact commands, exit codes and per-stage log paths. Toolchain dependencies can come from the locked prior plugin baseline; **all `@deepseek-ai` packages resolve into the fixed upstream checkout**, never the old DSH graph. The checker rejects a different upstream SHA or tracked source modifications. It requires upstream artifacts to have been built first.

Observed on 2026-08-28 (Node v26.5.0):

| Check | Result |
|---|---|
| Upstream build | Exit 0; 218 client artifacts recorded |
| Source checker (before the CI addition below) | Exit 0; all 8 stages exit 0 |
| Typecheck, declaration generation, client bundle and package contents | Passed |
| Plugin regression tests (including the parent Remote injection fix) | 6 test files; 130/130 tests passed |
| Real upstream Connection | Token exchange 303; anonymous request 401; untrusted Origin/Host 403 |
| Authenticated custom RPC | Polish/terms success, invalid input rejection, isolated settings persistence |
| Real upstream module loader, Cordis and SlotRegistry | Built client materialized; all 3 plugin slots registered and unloaded |
| Canary contract | 31/31 assertions passed |
| Canary workflow contract | 16/16 assertions passed |
| Diff and source-check script syntax | Exit 0 |

The smoke test uses actual upstream Connection, browser authentication, FileSettingsProvider, ClientModuleSystem and SlotRegistry. HTTP streams and LLM/session content are deterministic fixtures. UI primitives use the upstream's real icon exports. No live server or model is started, and no user profile is modified.

Review objection: does removing `authority: 'trusted-host'` weaken protection, or merely satisfy a mocked test? The new Connection API no longer accepts that argument and centrally enforces Host/Origin and browser-session checks. The smoke test exercises the real upstream implementation and verifies both rejection and authenticated success. It does not establish real microphone or model end-to-end behavior.

Confidence: high for the fixed-source API/loading checks and listed automated regressions only.

## Independent pinned-source CI

`.github/workflows/dsh-source-compat.yml` adds **Pinned DSH source compatibility** on pull requests and manual runs, independently of the existing npm CI. Each Node 22.19.0 / 24.15.0 job:

1. Checks out the exact upstream commit declared above, never a moving branch or tag.
2. Installs the unchanged toolchain lockfile from Dictate commit `6b86d280d796b6c87f0dbb3ba5688c36c0bcf557` with pnpm 9.15.9. This supplies build/test tools only; its DSH dependencies are excluded from the candidate fixture.
3. Installs and builds upstream using its frozen lockfile and pnpm 11.7.0.
4. Runs `check-dsh-source.mjs` against that source graph, including the additional dependency-free source-workflow contract check (nine stages in total). `npm exec` exposes pinned pnpm 9.15.9 on PATH for nested package verification; no preinstalled global pnpm is assumed.
5. Uploads per-stage logs and `report.json` when available, including on failure. Reports record the upstream/plugin commits, Node version and result, with `npmArtifactsVerified: false` and `realMicrophoneVerified: false`.

The workflow has read-only permissions, immutable action references, no persisted checkout credentials, no secrets, no publishing and no service startup. Logs are retained for 14 days. A green **source-only** check is not an npm installation or release approval. The original `.github/workflows/ci.yml` remains unchanged and still requires the candidate's own frozen-lockfile installation.

Local reproduction with a built source checkout and locked tools:

```sh
node scripts/check-source-workflow.mjs
node scripts/check-dsh-source.mjs --source /path/to/built-upstream --tools /path/to/locked-tools/node_modules --report-dir /path/to/source-evidence
```

On 2026-08-28, the official npm registry returned `E404` for both `@deepseek-ai/dsh@0.1.2-alpha.1` and `@deepseek-ai/dsh-api-remotes@0.1.2-alpha.1`. An isolated lockfile regeneration failed with `ERR_PNPM_NO_MATCHING_VERSION` for `@deepseek-ai/dsh-typert-protocol@0.1.2-alpha.1`. The source workflow does not remove this blocker.

## Merge and release gates

- [ ] Resolve and lock the official `0.1.2-alpha.1` npm artifacts; pass a fresh frozen-lockfile install.
- [ ] Repeat the full isolated profile installation canary using official artifacts.
- [ ] Obtain real Composer/microphone/local-ASR acceptance in an explicitly authorized test profile.
- [ ] Update the release version and user documentation before publishing.

`pnpm-lock.yaml` deliberately remains the prior baseline and **does not match the new manifest**. Frozen-lockfile CI has not been claimed to pass. The older README also describes the prior release. Do not merge or publish this source-only candidate while those gates remain open.

This candidate raises the minimum DSH peer version to `0.1.2-alpha.1`; it does not claim continued compatibility with `0.1.1-rc.2`. Windows, real browser layout, microphone capture, actual model polishing and native ASR audio transcription are unverified in this run.
