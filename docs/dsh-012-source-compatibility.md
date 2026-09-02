# DSH 0.1.2-alpha.3 compatibility status

The current `main` branch targets the official `@deepseek-ai/dsh@0.1.2-alpha.3` package graph and the immutable upstream source commit `dd6322d604e00eec1ba5e0c8541159906a21094a`. The compatibility work landed through [PR #8](https://github.com/franksong2702/dsh-dictate/pull/8) at merge commit `1d6a4a229ba631f8f886e4b038289c2db2dbc223`.

This document records the compatibility work shipped in `dsh-dictate@0.4.0-alpha.8`. The protected release workflow published the verified artifact to npm and created the corresponding [GitHub prerelease](https://github.com/franksong2702/dsh-dictate/releases/tag/v0.4.0-alpha.8).

## Compatibility scope

- Pin the development graph and minimum DSH peer floor to `0.1.2-alpha.3`.
- Keep Web Speech as the default, with optional local SenseVoice transcription.
- Preserve Host/Origin and browser-session authentication for plugin RPCs.
- Package native local-ASR runtimes for Apple Silicon and Windows x64.
- Monitor the DSH npm `latest`, `next`, and `alpha` channels independently.
- Exclude the removed persistent custom-dictionary experiment.
- Exclude Windows ARM64, macOS Intel, Linux native runtimes, code signing, system services, tray applications and hidden Windows background execution.

## Verification at the merged PR head

PR #8 was verified at exact head `5cea4386862e3ad6fa7fae81ee46b9ec4ee8838b` before merge.

| Check | Result |
|---|---|
| Frozen dependency install | Exit 0 with pnpm 9.15.9 |
| Typecheck | Exit 0 |
| Regression tests | Exit 0; 135 tests passed |
| Package verification | Exit 0; 43 entries and both native runtimes verified |
| Release workflow contract | Exit 0; 31/31 assertions passed |
| Canary contracts | Exit 0; 31/31 and 17/17 assertions passed |
| Isolated DSH profile installation | Exit 0; DSH `0.1.2-alpha.3`, plugin registered and host import passed |
| Pinned upstream source CI | Node 22.19 and 24.15 passed |
| Native runtime CI | macOS arm64 and Windows x64 passed |

The bundled unsigned Windows x64 runtime is 5,067,264 bytes with SHA-256 `92b727dbcd7f2edcb7b96bd6e012147480b9ef408c10ed343347e9722b09f5f2`. Package and release checks pin that exact artifact.

Windows x64 also received user acceptance on a real machine using an isolated DSH Alpha.3 Web profile. The user confirmed the resulting voice-input workflow passed. This is human acceptance evidence, not a reproducible automated microphone artifact; CI does not claim to have tested a real microphone, model download or Chinese audio transcription.

## Source-only CI boundary

`.github/workflows/dsh-source-compat.yml` checks out upstream commit `dd6322d604e00eec1ba5e0c8541159906a21094a`, installs and builds its frozen package graph, then runs `scripts/check-dsh-source.mjs` against that source tree on Node 22.19 and 24.15.

The workflow has read-only permissions, immutable action references, no persisted checkout credentials, no secrets, no publishing and no service startup. A green source-only check proves API and loading compatibility with the pinned source; it does not prove npm installability, browser layout, microphone capture or native ASR transcription. Those boundaries remain separate checks.

Local reproduction with an already built upstream checkout:

```sh
node scripts/check-source-workflow.mjs
node scripts/check-dsh-source.mjs \
  --source /path/to/built-upstream \
  --tools /path/to/locked-tools/node_modules \
  --report-dir /path/to/source-evidence
```

## DSH Web authentication

DSH Alpha.3 requires the startup token to establish the browser session. Opening the bare host and port before that bootstrap returns `401` and displays:

```text
DSHweb authentication required. Reopen the URL printed by DSHweb.
```

Reopen the complete URL printed by `dsh web`; do not publish, log or share its token. Once the normal token-to-cookie bootstrap completes, the clean root URL is available in the same browser profile.

## Publication result and continuing gates

- Alpha.8 was published from main commit `03838daaea2d85e8d1d2b4d8b1cff556486593aa` after the release workflow verified the packed artifact and npm digest.
- Future releases must rerun the full release workflow and verify their packed artifact before npm publication.
- Each future release must confirm its exact npm version, `next` dist-tag and registry digest before creating the GitHub prerelease.
- Keep the Windows executable explicitly unsigned and experimental in release notes.

Merging compatibility or documentation changes does not itself publish npm packages, create Git tags or create GitHub Releases.
