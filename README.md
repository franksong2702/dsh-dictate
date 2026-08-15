# dsh-voice-input

DeepSeek Harness Web 的手动语音输入插件。

- 按住麦克风说话，松手后把识别文字写入原生输入框。
- 不会自动发送，不会朗读模型回复，也不会启动实时语音对话。
- 使用 Chrome 或 Edge 的 Web Speech API；音频会交给浏览器的语音服务，不经过 DSH 服务端。
- 当前固定识别语言为中文普通话（`zh-CN`）。

构建与打包：

```sh
pnpm install
pnpm run typecheck
pnpm pack
```

把生成的 `dsh-voice-input-0.1.0.tgz` 安装到 Web profile 后重启 `dsh web`。首次使用需要授予浏览器麦克风权限。
