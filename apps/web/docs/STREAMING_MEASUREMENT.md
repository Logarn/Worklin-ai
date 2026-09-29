# Streaming delivery measurement — 2026-09-29

The browser was falling behind while rendering each streamed delta. Bounded
delivery batches eliminated the large client-side backlog in this live test.

## Method

Both runs used the same browser, existing conversation, and prompt:

> Streaming measurement test: write exactly 40 short numbered sentences about
> renewable energy. Start immediately with item 1 and do not use tools.

The first build contained the corrected opt-in instrumentation with direct
event delivery. The second added 40 ms delta delivery batches. Each run used
`?streamTrace=1`; deployment/build processes completed before testing. The
second run had an additional completed response in its conversation history.
Model output was not deterministic, so event and character counts differ.

## Results

| Measurement | Direct delivery | Batched delivery |
|---|---:|---:|
| Text events parsed | 490 | 508 |
| Text characters received and committed | 2,486 | 2,681 |
| Server first-to-last emission | 4.098 s | 5.821 s |
| Browser first-to-last parsed event | 132.219 s | 5.848 s |
| Observed raw-read span during text | 12.875 s | 5.815 s |
| Final parsed event after latest observed raw read | 119.398 s | 0.078 s |
| Synchronous text-handler time, total | 0.172 s | 0.115 s |
| Transcript commits with changed text | 490 | 21 |
| Final transcript commit after final parsed event | 0.295 s | 0.588 s |

The completed comparison response contained all 40 numbered items. Received
character counts matched committed transcript lengths in both runs. The fixed
build parsed text across 24 observed read chunks, while server emission and
browser parsing spans closely matched. This supports live incremental delivery
without the long client-side drain seen in the baseline.

The baseline spent roughly two minutes draining text already observed by the
browser. Direct handlers accounted for only a fraction of a second, while
each text event caused a transcript commit. Grouping event delivery into the
same task reduced commits by about 96% and removed that backlog. Individual
envelopes and sequence numbers remain intact; the first delta is immediate,
and non-delta boundaries and reconnect flush queued delivery.

## Interpretation limits

This is one before/after comparison, not a latency guarantee for every device
or workload. It does not measure prompt-to-first-token latency. The byte-read
probe observes JavaScript reads, not network-stack packet arrival; decoder
read-ahead prevents exact event-to-packet matching. Server `emittedAt` is an
event timestamp, not a provider-level timing probe. Server/client absolute
timestamps are not subtracted. Layout-effect commits do not measure paint.
The final commit still took about 0.6 seconds after the final parsed event in
the fixed run, so rendering cost remains an area for future optimization.

## Verification and shutdown

- 50 scoped streaming tests passed, including order, cancellation, queue bounds,
  reconnect drain, watchdog behavior, and whole-message trace counters.
- Web TypeScript, scoped ESLint, and the production build passed.
- The batching fix was deployed and promoted to the existing web domain.
- The test tab was reloaded without `streamTrace` to disable instrumentation.

See [Event bus timing](EVENT_BUS.md#streaming-timing) for enabling diagnostics.
