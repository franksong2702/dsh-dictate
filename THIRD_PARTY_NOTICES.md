# Third-party notices

## transcribe.cpp

The bundled macOS Apple Silicon and Windows x64 local-ASR runtimes use
[`transcribe.cpp`](https://github.com/handy-computer/transcribe.cpp), licensed
under the MIT License. The runtime source and pinned Rust dependency lockfile are
included in this repository under `native/local-asr/`.

## SenseVoiceSmall

The optional model downloaded by the plugin is **SenseVoiceSmall Q8**, derived
from `FunAudioLLM/SenseVoiceSmall` and distributed by `handy-computer` as a GGUF
quantization. The model is not included in the npm package.

- Model source: https://huggingface.co/handy-computer/SenseVoiceSmall-gguf
- Original model: https://huggingface.co/FunAudioLLM/SenseVoiceSmall
- Model author: Alibaba Group / FunAudioLLM
- License: https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE

The installer retains the SenseVoice model name, pins the model revision, and
verifies its size and SHA-256 before use.
