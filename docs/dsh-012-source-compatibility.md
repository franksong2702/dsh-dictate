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
| Source checker | Exit 0; all 8 stages exit 0 |
| Typecheck, declaration generation, client bundle and package contents | Passed |
| Plugin regression tests | 6 test files; 129/129 tests passed |
| Real upstream Connection | Token exchange 303; anonymous request 401; untrusted Origin/Host 403 |
| Authenticated custom RPC | Polish/terms success, invalid input rejection, isolated settings persistence |
| Real upstream module loader, Cordis and SlotRegistry | Built client materialized; all 3 plugin slots registered and unloaded |
| Canary contract | 31/31 assertions passed |
| Canary workflow contract | 16/16 assertions passed |
| Diff and source-check script syntax | Exit 0 |

The smoke test uses actual upstream Connection, browser authentication, FileSettingsProvider, ClientModuleSystem and SlotRegistry. HTTP streams and LLM/session content are deterministic fixtures. UI primitives use the upstream's real icon exports. No live server or model is started, and no user profile is modified.

Review objection: does removing `authority: 'trusted-host'` weaken protection, or merely satisfy a mocked test? The new Connection API no longer accepts that argument and centrally enforces Host/Origin and browser-session checks. The smoke test exercises the real upstream implementation and verifies both rejection and authenticated success. It does not establish real microphone or model end-to-end behavior.

Confidence: high for the fixed-source API/loading checks and listed automated regressions only.

## Merge and release gates

- [ ] Resolve and lock the official `0.1.2-alpha.1` npm artifacts; pass a fresh frozen-lockfile install.
- [ ] Repeat the full isolated profile installation canary using official artifacts.
- [ ] Obtain real Composer/microphone/local-ASR acceptance in an explicitly authorized test profile.
- [ ] Update the release version and user documentation before publishing.

`pnpm-lock.yaml` deliberately remains the prior baseline and **does not match the new manifest**. Frozen-lockfile CI has not been claimed to pass. The older README also describes the prior release. Do not merge or publish this source-only candidate while those gates remain open.

This candidate raises the minimum DSH peer version to `0.1.2-alpha.1`; it does not claim continued compatibility with `0.1.1-rc.2`. Windows, real browser layout, microphone capture, actual model polishing and native ASR audio transcription are unverified in this run.
