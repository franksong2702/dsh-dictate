# Progressive Web Speech dictation

## Goal

Show provisional text inside Composer and start model polishing during pauses. Reduce stop-to-final latency by reusing a completed or running polish of the exact final raw transcript. UI changes alone do not satisfy this goal.

## Contract

- Web Speech only, including explicit browser fallback. Keep local SenseVoice's record-then-transcribe workflow.
- All text from the current recording stays dashed-underlined until finalization, including recognition-final segments and speculative polish.
- Use the existing polish toggle/model. Without polish, show recognition updates and commit the final transcript on stop.
- Retain raw recognition throughout. A new or corrected raw snapshot invalidates reuse; never polish a polished transcript in place of the original.
- Background requests process the full current raw snapshot, including interim words unchanged through the quiet interval, so later corrections and enumerations can be reconciled. The current quiet interval is 350 ms, chosen to start on a natural breath before an explicit stop; the minimum request spacing is 2 s, with a minimum 8 characters, at most 12 speculative calls and 48,000 cumulative raw input characters per recording. Quiet time is measured from the last text change, including time spent waiting for a previous model request. Only the latest snapshot is retained while a request runs; recognition-final promotion without text changes does not reset the debounce. These are bounded tuning values, not measured optimal values.
- Stop immediately starts or reuses one speculative full-snapshot pass in parallel with recognition shutdown. This single stop pass bypasses quiet/spacing/minimum-length gates but stays within the speculative count/character budget. `stopCalls` is a subset of `backgroundCalls`, not an additional call count. A changed pending snapshot is cancelled rather than queued. Nothing commits until recognition ends: an exact completed final-raw match commits immediately; an exact in-flight match is awaited. Otherwise run a mandatory final whole-transcript polish using the original raw words, even if the speculative budget is exhausted. This retains existing global restructuring behavior and never promotes an unconfirmed interim spelling.
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

### Stop-latency follow-up

A regression replay found that an entire utterance left in Web Speech's interim state caused zero speculative calls, even after an unchanged quiet interval. The scheduler now admits that full provisional snapshot, but reuses it only if recognition's eventual final raw text matches exactly. The pause threshold was then reduced from 900 ms to 350 ms so a natural breath can begin the same full-snapshot request earlier; the 4-second spacing and existing call/character budgets are unchanged. A second replay covers immediate stop: with an 800 ms model and 500 ms simulated recognition drain, the old serial wait is 1300 ms; the new overlap completes at 800 ms with one call. The Composer integration test verifies no draft write before final recognition, the resulting timing breakdown, and absence of transcript/session content in diagnostics.

Four bounded requests used synthetic Chinese correction/enumeration samples through the user's selected `openai-codex/gpt-5.6-luna` route on 3081, in a dedicated empty test session (no user dictation or conversation context). Initial model-only requests took 3837 and 6328 ms. New-scheduler requests with a simulated 500 ms recognition drain took 2802 and 2552 ms from stop, each reusing its one in-flight request and making zero additional final calls. This is not a controlled real-ASR before/after speedup: separate live model calls vary and may benefit from warm caches. The attributable scheduling gain is demonstrated by the fixed-delay replay, not by subtracting these independent request times. The sampled outputs retained the corrected Friday time, budget and enumerated tasks; this is not a general quality guarantee. Provider token/billing usage was not collected; character counts exclude prompts and context.

Completed Web Speech insertions emit one browser-console `[dsh-dictate:performance]` report with numeric `stopToFinalMs`, `recognitionDrainMs`, `postRecognitionWaitMs`, call/input-character counts, reuse outcome and polish-failure flag. A completed model response additionally reports `serverPolish.contextMs`, `modelFirstOutputMs`, `modelGenerationMs`, `modelTotalMs`, and `totalMs`. This separates host context/input preparation, provider queue or time-to-first-output, and remaining generation without recording the transcript, audio, session identity, model route, credentials or conversation. `abortSignals` counts superseded or cancelled speculative browser requests for which an AbortSignal was sent through the RPC chain; it is not a claim that a remote provider had already stopped billing or computation. These local diagnostics are neither uploaded nor persisted. They distinguish future real microphone drain from model/RPC waiting without asking the user to time each phase manually. Model latency is still a lower bound when speech ends without a reusable speculation; no instant-completion claim is made.

## Latest-snapshot scheduling follow-up

`node scripts/benchmark-progressive-polish.mjs` compares the candidate with immutable merged PR #20 commit `74ef255b79203f516954419262fadb5f764c19df`. It runs both actual scheduler sources under the same virtual clock and identity model. It also isolates the quiet-time fix with a 4-second interval. Each scenario includes 100 ms simulated recognition drain; none measures real microphone or model performance.

| Scenario | Model delay | Previous stop-to-final | Quiet-time fix, 4 s interval | Candidate, 2 s interval | Calls, previous → candidate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Last sentence waiting for request spacing | 800 ms | 800 ms | 800 ms | 100 ms | 2 → 2 |
| Stable tail waiting behind a slow request | 5000 ms | 4200 ms | 3850 ms | 3850 ms | 2 → 2 |
| Continuous enumeration, 22-second recording | 800 ms | 100 ms | 100 ms | 100 ms | 6 → 9 |

The first case starts the last snapshot at 2350 ms instead of stop at 3200 ms. The second eliminates an unnecessary additional 350 ms pause after the older request completes. The third shows the cost tradeoff: raw input characters increase from 172 to 270 with no final-wait improvement. The 12-call/48,000-character speculative budgets remain unchanged and can be exhausted earlier; mandatory final whole-raw polishing remains available. No stale in-flight request is repeatedly cancelled during speech, and no intermediate-snapshot queue is introduced.

Four live requests on 3081 used two synthetic correction/enumeration samples in a new empty test session with `openai-codex/gpt-5.6-luna`. Context preparation was 0 ms at rounded millisecond resolution in all four requests; model-first-chunk times were 2123/1751/1749/1427 ms, remaining stream times 5196/1670/6846/1313 ms, and RPC times 7324/3427/8600/2746 ms. Checks for retained technical identifiers, names, version, time and corrected amount, and removal of retracted values, passed for both samples in both rounds. These limited samples do not establish general quality, real-speech latency, or performance with a long conversation. The first chunk may contain provider metadata or reasoning rather than visible text. No model route, prompt, context policy, or local ASR change is included: this evidence does not justify adding a preparation cache.

## Host integration and browser check

The public Composer slot exposes draft replacement, not a transient Lexical range. This implementation mounts a temporary editable projection in the native textbox footprint and restores the resident editor on completion, cancellation or manual editing. It does not access private Lexical internals. Host DOM/geometry is therefore an integration dependency; real host and supported browser acceptance remain required before marking the PR ready.

An isolated Chromium fixture loading the actual `composerPreview.ts` verified matching 640 px native/preview widths, dashed provisional text, hidden placeholder, long-text growth capped at 200 px with scrolling, Enter suppression, Escape restoring the empty native draft and original height/opacity, and continued typing after manual promotion (`AB` remained in order at the caret). This fixture used synthetic text and a minimal host, not a live DSH session or real IME service. Automated component tests additionally cover textarea/contenteditable, synthetic IME composition, session switching and late model responses.

### Fractional-width scrollbar regression

The first minimal-host check did not reproduce the real host's outer `overflow: auto` wrapper. A subsequent user screenshot showed a horizontal gray scrollbar during polishing. Replaying the observed host layout (789.59375 px width, outer auto-scroll wrapper and 8 px custom scrollbars) reproduced an 8 px horizontal scrollbar even for a short line: `offsetWidth` rounded the overlay to 790 px. Using the fractional bounding-rectangle width removes that overflow without hiding the host's scrollbars.

The same browser replay after the fix measured a 0 px horizontal scrollbar gutter. Long text retained a 320 px preview, 700 px scrollable content and an 8 px vertical scrollbar, with no horizontal bar or outer nested scrollbar. `tests/composer-preview.spec.ts` locks down fractional-width containment for both contenteditable and textarea hosts at mount and after resize. These checks validate this layout regression, not real ASR/model performance.
