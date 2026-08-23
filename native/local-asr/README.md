# dsh-dictate local ASR runtime

This directory contains the source for the native sidecar installed by
`dsh-dictate` on supported platforms. The sidecar binds only to IPv4 loopback,
keeps one SenseVoice session resident, and exposes the two endpoints consumed by
the plugin:

- `GET /v1/models`
- `POST /v1/audio/transcriptions`

Build the Apple Silicon runtime with:

```sh
cargo build --release --locked --manifest-path native/local-asr/Cargo.toml
```

The release binary copied into `native/darwin-arm64/` must be generated from the
checked-in lockfile. Package verification checks that the bundled executable is
present, executable, and matches the pinned SHA-256 used by the installer.

The runtime uses the MIT-licensed
[`transcribe.cpp`](https://github.com/handy-computer/transcribe.cpp) library.
The separately downloaded SenseVoice model is covered by the FunASR Model Open
Source License Agreement; see `THIRD_PARTY_NOTICES.md` at the repository root.
