import { expect, test } from "bun:test";
import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import { createStreamDelivery } from "./stream-delivery";

function delta(seq: number, conversationId = "conv-test"): AssistantEventEnvelope {
  return { id: `event-${seq}`, seq, conversationId, emittedAt: new Date(0).toISOString(),
    message: { type: "assistant_text_delta", messageId: "msg-test", text: `${seq} ` } };
}

test("first text is immediate; a burst flushes in order on the timer", async () => {
  const received: AssistantEventEnvelope[] = [];
  const delivery = createStreamDelivery(e => received.push(e));
  for (let i = 1; i <= 100; i++) delivery.push(delta(i));
  expect(received.map(e => e.seq)).toEqual([1]);
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(received.map(e => e.seq)).toEqual(Array.from({length: 100}, (_, i) => i + 1));
  delivery.cancel();
});

test("non-delta boundaries flush all preceding text synchronously", () => {
  const received: AssistantEventEnvelope[] = [];
  const delivery = createStreamDelivery(e => received.push(e));
  delivery.push(delta(1)); delivery.push(delta(2)); delivery.push(delta(3));
  const boundary: AssistantEventEnvelope = { ...delta(4), message: { type: "sync_changed", tags: [] } };
  delivery.push(boundary);
  expect(received.map(e => e.seq)).toEqual([1,2,3,4]);
  expect(received[3]).toBe(boundary);
  delivery.cancel();
});

test("conversation and message changes cannot reorder pending text", () => {
  const received: AssistantEventEnvelope[] = [];
  const delivery = createStreamDelivery(e => received.push(e));
  delivery.push(delta(1)); delivery.push(delta(2));
  delivery.push(delta(3, "conv-other"));
  delivery.push(delta(4, "conv-other"));
  const next = delta(5, "conv-other");
  next.message = { type: "assistant_text_delta", messageId: "msg-next", text: "next" };
  delivery.push(next);
  expect(received.map(e => e.seq)).toEqual([1,2,3,4,5]);
  delivery.cancel();
});

test("cancellation discards only undelivered events and stops the timer", async () => {
  const received: number[] = [];
  const delivery = createStreamDelivery(e => received.push(e.seq!));
  delivery.push(delta(1)); delivery.push(delta(2));
  delivery.cancel(); delivery.flush(); delivery.push(delta(3));
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(received).toEqual([1]);
});

test("event count bounds memory even when timers cannot run", () => {
  const received: number[] = [];
  const delivery = createStreamDelivery(e => received.push(e.seq!));
  for (let i = 1; i <= 1000; i++) delivery.push(delta(i));
  expect(received).toHaveLength(769);
  delivery.flush();
  expect(received).toEqual(Array.from({length:1000}, (_, i) => i + 1));
  delivery.cancel();
});

test("large deltas flush at the character bound", () => {
  const received: number[] = [];
  const delivery = createStreamDelivery(e => received.push(e.seq!));
  delivery.push(delta(1));
  const large = delta(2);
  large.message = { type: "assistant_text_delta", messageId: "msg-test", text: "x".repeat(65536) };
  delivery.push(large);
  expect(received).toEqual([1,2]);
  delivery.cancel();
});
