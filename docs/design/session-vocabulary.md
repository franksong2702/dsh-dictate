# Session vocabulary for dictation

## Behavior

Terms no longer disappear just because their message leaves the polish model's six-message / 12 KB context window. Rule extraction reconstructs a bounded vocabulary from visible user/model history, newest first, and remembers source-grounded model terms per session. Lowercase English words adjacent to Chinese text (for example, `使用 whisper 识别`) are eligible without requiring quotation marks. Ordinary all-lowercase English prose is still left to optional model extraction.

The process keeps at most 128 terms for each of 32 recently used sessions. Rule reconstruction examines at most 128,000 characters of recent visible text and stops collecting at the vocabulary limit. Previously remembered terms are checked against visible history before retention, including history outside that reconstruction excerpt. Hidden plugin/tool/reasoning content and draft-only terms are not learned as session vocabulary. Terms whose spelling no longer appears in visible history are discarded. The cache is process-local; no new dictionary file or cross-session storage is created. Rule terms can be reconstructed after restart, but model-only entities that cannot be found by rules must be rediscovered by the model when in its input window.

The active list still contains at most 32 terms, prioritizing model-selected current entities and current Composer/recent rule terms before older vocabulary. Retention in the 128-term pool does not guarantee inclusion in every active 32-term list. This is a bounded contextual aid, not permanent vocabulary learning or automatic phonetic aliases.

## Availability and freshness

The client first requests rule/history terms without a model route and publishes them immediately. It then requests optional enrichment using the selected model. Recognition starts without waiting for either request, receives rules as soon as they arrive, and receives the enriched list later. Model failure keeps the rule list usable. Cancellation and session switching prevent late terms from reaching another session. Enrichment caches contain only model terms; history rules are recomputed so an unchanged recent-message window cannot bring back deleted older vocabulary or trigger redundant inference just because the vocabulary pool changed.

A changed hint list during speech invalidates completed or pending speculative polish made with the old list. Pending work receives an AbortSignal and late results cannot replace the current text. Replacement speculation stays inside the existing call/character budgets and request-spacing limits. Optional enrichment arriving after stop does not force another finalization round or delay a completed insertion. Prompt, model selection, and final whole-raw correctness rules are otherwise unchanged.

## Inspecting the result

The `词` disclosure next to the microphone lists the current active terms, indicates pending enrichment, and shows the browser's last hint status. A successful local assignment is described as “passed to the browser,” not proof that a remote recognition engine used the hints. Missing APIs, assignment failure and a subsequent `phrases-not-supported` event are visible. When browser hints are unavailable the list is still supplied to enabled model polishing. The local SenseVoice endpoint has no dynamic hint support; the UI states this separately. Escape closes the disclosure and returns focus to its summary.

## Verification boundaries

Automated checks cover vocabulary older than twelve subsequent messages, rule reconstruction after reset, model-only lowercase retention, deletion, session isolation, exclusion of hidden content and draft-only terms, pool bounds, fast rule delivery, model fallback/cancellation, browser hint submission/rejection, disclosure controls, stale-session results, and invalidation of old-hint polish. Empty-editor hold-to-talk also remains usable when selection was left in a disclosure or another control.

An isolated Chromium fixture renders the actual vocabulary component with synthetic terms to check disclosure layout and bounded scrolling; component tests exercise its React behavior. This does not prove real ASR accuracy. Real browser/service support and recognition of the user's previously missed words still need user acceptance on the deployed test build.
