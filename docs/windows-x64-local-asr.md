# Windows x64 local ASR

Windows x64 local SenseVoice support is available beginning with `dsh-dictate@0.4.0-alpha.8`. That version was published through the protected release workflow and is available from npm and [GitHub Releases](https://github.com/franksong2702/dsh-dictate/releases/tag/v0.4.0-alpha.8).

## Requirements

- Windows x64; Windows ARM64 is not supported.
- DeepSeek Harness `0.1.2-alpha.3`.
- Chrome or Edge with microphone permission.
- `dsh-dictate@0.4.0-alpha.8` or a later compatible release that includes the Windows x64 runtime.
- Network access for the initial SenseVoice Q8 model download, approximately 253 MB.

The bundled `dsh-dictate-asr.exe` is unsigned. It does not require administrator privileges and does not install a Windows service, tray application, Python runtime or global package. Windows may show a security confirmation according to local policy.

## Install and start

1. Run `npm view dsh-dictate dist-tags --json` to inspect the current channels, then install `dsh-dictate@latest` into the same Web profile that DSH uses. To reproduce the original Windows release exactly, install `dsh-dictate@0.4.0-alpha.8`.
2. Restart the matching `dsh web` process.
3. Open the complete URL printed by DSH. Alpha.3 uses that URL to establish the browser's authenticated session.
4. Go to “设置 → 插件 → 插件配置 → 上下文语音输入”.
5. Select “本地语音识别（实验性）” and start installation.
6. Wait for runtime verification, model download, SHA-256 verification and first model load to complete.

Starting local ASR opens a visible console titled `DSH Dictate Local ASR`. Keep it open while using local transcription. Closing the window stops the service; use the plugin settings to start it again.

“随 DSH 自动启动” is off by default. Enable it only after the first manual installation and startup succeed. The setting applies to the current `DSH_HOME` and Web profile.

## Web authentication prompt

If the browser shows:

```text
DSHweb authentication required. Reopen the URL printed by DSHweb.
```

do not keep refreshing the bare host and port. Return to the DSH startup output and open its complete `http://127.0.0.1:<port>/?token=...` URL in the same browser profile. Treat that token as a local credential: do not paste it into an issue, chat, screenshot or log.

## Expected behavior

- Web Speech remains the default and requires no local model.
- Local mode records in the browser and sends 16 kHz PCM WAV only to the plugin-managed IPv4 loopback endpoint.
- The Windows console remains visible while the local service runs.
- Right Control can toggle recording when the Composer has focus and the shortcut is enabled. Right Command is the macOS shortcut.
- Stopping local recording produces final text rather than Web Speech-style live interim text.

## Troubleshooting

- **Authentication required:** reopen the complete URL printed by DSH, as described above.
- **Local option missing:** confirm the installed Dictate package is `0.4.0-alpha.8` or a later release that includes the Windows x64 runtime. Alpha.7 predates Windows support.
- **Peer dependency warnings:** confirm the Web profile uses DSH Alpha.3 packages throughout. A profile that still contains rc.2 or Alpha.2 plugins is a mixed dependency graph; update those plugins to compatible builds or test in a separate Alpha.3 profile instead of ignoring the warnings.
- **Runtime blocked:** review Windows Security history and local execution policy. Do not disable system-wide protection merely to run the plugin.
- **Model download interrupted:** retry from the plugin settings; the installer revalidates reusable cached data before continuing.
- **Service stopped after closing a window:** this is expected. Return to the plugin settings and start local ASR again.
- **Right Control does nothing:** enable the Composer shortcut and keep focus inside the current Composer text box.

## Known limits

- The executable is unsigned and experimental.
- Windows ARM64, background services, tray operation and hidden-console execution are not supported.
- Real microphone behavior depends on the browser, microphone device and Windows privacy permissions.
- Automated CI validates the native executable, package contents and startup path; it does not simulate the user's real microphone or acoustic environment.
