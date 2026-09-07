# Progressive Web Speech dictation

## Goal

Show provisional text inside Composer and start model polishing during pauses. Reduce stop-to-final latency by reusing a completed or running polish of the exact final raw transcript. UI changes alone do not satisfy this goal.

## Contract

- Web Speech only, including explicit browser fallback. Keep local SenseVoice's record-then-transcribe workflow.
- All text from the current recording stays dashed-underlined until finalization, including recognition-final segments and speculative polish.
- Use the existing polish toggle/model. Without polish, show recognition updates and commit the final transcript on stop.
- Retain raw recognition throughout. A new or corrected raw snapshot invalidates reuse; never polish a polished transcript in place of the original.
- Background requests process full stable recognition snapshots so later corrections and enumerations can be reconciled. Default quiet interval is 900 ms, minimum request spacing 4 s, minimum 8 characters, at most 12 speculative calls and 48,000 cumulative raw input characters per recording. Finalization has a separate mandatory call when needed. These are bounded initial tuning values, not measured optimal values.
- Stop waits for recognition to end. An exact completed match commits immediately; an exact in-flight match is awaited. Otherwise run a final whole-transcript polish using the original raw words. This retains existing global restructuring behavior.
- Preview is transient and is never written to the host's persisted/submittable draft. Only finalization or an explicit manual edit promotes text to the host draft. The status strip contains status only while the inline preview is mounted.
- Editing the preview ends dictation and preserves the edited text. External changes to the host draft or switching session cancel the recording and discard stale work without overwriting the host.
- Escape cancels and restores the pre-recording draft. Hold-to-talk never auto-sends; other triggers retain the existing explicit-stop auto-send setting. No failure path auto-sends provisional text.

## Acceptance

Automated replay must exercise completed and in-flight reuse, new words after a speculative result, self-correction, failure, abort, late results, manual editing, session switches, partial and whole selection, textarea and contenteditable hosts. Measure stop-to-final time and request/input-character counts against the previous stop-only flow with controlled model latency. Such replay demonstrates scheduling only, not real ASR accuracy or model speed.

Draft PR remains pending real Windows Chrome/Edge microphone acceptance and an A/B comparison with the same selected model and recordings. Include short utterances, long enumerations, mixed Chinese/English and late spoken corrections. Record omissions/repetitions and meaning changes along with timing and provider-reported usage. Do not publish transcript/audio or promise a speedup before these checks.

## Controlled replay evidence

`pnpm test -- tests/progressive-polish.spec.ts` uses fake time and an identity model fixture with an 800 ms response delay. Input characters exclude prompt/context overhead and are not provider tokens or billed usage.

| Scenario | Stop-only wait | Progressive wait | Calls, old → new | Raw characters, old → new |
| --- | ---: | ---: | ---: | ---: |
| Exact polish already completed | 800 ms | 0 ms | 1 → 1 | 14 → 14 |
| Exact polish still running | 800 ms | 500 ms | 1 → 1 | 14 → 14 |
| New words at stop | 800 ms | 800 ms | 1 → 2 | 19 → 33 |
| No eligible pause | 800 ms | 800 ms | 1 → 1 | 14 → 14 |

This demonstrates reuse and the extra-cost failure-to-reuse case, not actual end-to-end latency or text quality. Recognition's stop/end delay is outside this scheduler measurement.

## Host integration and browser check

The public Composer slot exposes draft replacement, not a transient Lexical range. This implementation mounts a temporary editable projection in the native textbox footprint and restores the resident editor on completion, cancellation or manual editing. It does not access private Lexical internals. Host DOM/geometry is therefore an integration dependency; real host and supported browser acceptance remain required before marking the PR ready.

An isolated Chromium fixture loading the actual `composerPreview.ts` verified matching 640 px native/preview widths, dashed provisional text, hidden placeholder, long-text growth capped at 200 px with scrolling, Enter suppression, Escape restoring the empty native draft and original height/opacity, and continued typing after manual promotion (`AB` remained in order at the caret). This fixture used synthetic text and a minimal host, not a live DSH session or real IME service. Automated component tests additionally cover textarea/contenteditable, synthetic IME composition, session switching and late model responses.
