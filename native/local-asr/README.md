# dsh-dictate local ASR runtime

This directory contains the source for the native sidecar installed by
`dsh-dictate` on supported platforms. The sidecar binds only to IPv4 loopback,
keeps one SenseVoice session resident, and exposes the two endpoints consumed by
the plugin:

- `GET /v1/models`
- `POST /v1/audio/transcriptions`

Build the runtime on its target platform with:

```sh
cargo build --release --locked --manifest-path native/local-asr/Cargo.toml
```

Windows CI also sets `RUSTFLAGS=-C target-feature=+crt-static` and
`TRANSCRIBE_CMAKE_ARGS=-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded` so the x64
runtime does not depend on a separately installed MSVC runtime. Release binaries
copied into `native/darwin-arm64/` and `native/win32-x64/` must be generated from
the checked-in lockfile. Package verification checks that both bundled
executables are present and match the SHA-256 values pinned by the installer.

The Windows executable is intentionally unsigned and opens a visible console
named `DSH Dictate Local ASR`. Closing that console stops the local service. No
Windows service, tray application, installer, or administrator privilege is
required by the plugin.

Windows x64 support is included in the `dsh-dictate@0.4.0-alpha.8` release
candidate and will be available after npm `next` resolves to that version. It
is not included in npm `latest` at `0.4.0-alpha.7`. User installation, DSH Web
authentication and troubleshooting are documented in
[`docs/windows-x64-local-asr.md`](../../docs/windows-x64-local-asr.md).

The runtime uses the MIT-licensed
[`transcribe.cpp`](https://github.com/handy-computer/transcribe.cpp) library.
The separately downloaded SenseVoice model is covered by the FunASR Model Open
Source License Agreement; see `THIRD_PARTY_NOTICES.md` at the repository root.
