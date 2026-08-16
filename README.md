# dsh-voice-input

DeepSeek Harness Web 的手动语音输入插件。

- 单击麦克风开始录音，再次单击后结束识别并把文字写入原生输入框。
- 不会自动发送，不会朗读模型回复，也不会启动实时语音对话。
- 使用 Chrome 或 Edge 的 Web Speech API；音频会交给浏览器的语音服务，不经过 DSH 服务端。
- 在“设置 → 插件 → 语音输入”中选择识别语言；设置保存在当前浏览器中。
- 转写完成提示会在 3 秒后自动消失。

构建与打包：

```sh
pnpm install
pnpm test
pnpm run typecheck
pnpm pack
```

把生成的 `dsh-voice-input-0.2.0.tgz` 安装到 Web profile 后重启 `dsh web`。首次使用需要授予浏览器麦克风权限。
