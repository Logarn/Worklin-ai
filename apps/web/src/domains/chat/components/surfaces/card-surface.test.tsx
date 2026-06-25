import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CardSurface } from "@/domains/chat/components/surfaces/card-surface";
import type { Surface } from "@/domains/chat/types/types";

function surface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "surface-123",
    surfaceType: "card",
    title: "Response limit reached",
    data: {
      title: "Response limit reached",
      subtitle: "The partial response above was saved.",
      body: "I hit the response limit before I could finish.",
    },
    actions: [
      {
        id: "relay_prompt",
        label: "Continue",
        style: "primary",
        data: { prompt: "Continue from where you stopped." },
      },
    ],
    ...overrides,
  };
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("CardSurface", () => {
  test("does not duplicate the card title when the surface envelope has the same title", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface surface={surface()} onAction={() => undefined} />,
    );

    expect(countOccurrences(rendered, "Response limit reached")).toBe(1);
    expect(rendered).toContain("The partial response above was saved.");
    expect(rendered).toContain(
      "I hit the response limit before I could finish.",
    );
  });

  test("renders the card data title instead of the envelope title", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Envelope title",
          data: {
            title: "Card title",
            subtitle: "Card subtitle",
            body: "Card body",
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Card title");
    expect(rendered).not.toContain("Envelope title");
  });

  test("falls back to the envelope title when card data has no title", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Envelope fallback",
          data: {
            subtitle: "Card subtitle",
            body: "Card body",
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Envelope fallback");
    expect(countOccurrences(rendered, "Envelope fallback")).toBe(1);
  });

  test("does not render an error glyph for a failed step once the overall task completes", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Connect Gmail",
          data: {
            title: "Connect Gmail",
            body: "",
            template: "task_progress",
            templateData: {
              title: "Connect Gmail",
              status: "completed",
              steps: [
                { label: "Verifying Gmail connection", status: "failed" },
                { label: "Finishing setup", status: "completed" },
              ],
            },
          },
        })}
        onAction={() => undefined}
      />,
    );

    // lucide CircleX renders an `<svg>` with the `lucide-circle-x` class; a
    // recovered step must not surface it.
    expect(rendered).not.toContain("lucide-circle-x");
    expect(rendered).toContain("Verifying Gmail connection");
  });

  test("still renders an error glyph for a failed step while the task is in progress", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Connect Gmail",
          data: {
            title: "Connect Gmail",
            body: "",
            template: "task_progress",
            templateData: {
              title: "Connect Gmail",
              status: "in_progress",
              steps: [
                { label: "Verifying Gmail connection", status: "failed" },
              ],
            },
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("lucide-circle-x");
  });

  test("renders the counter progress bar when templateData has usable counters", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          data: {
            title: "Processing files",
            body: "",
            template: "task_progress",
            templateData: { completed: 2, total: 5 },
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("2 / 5 tasks");
    expect(rendered).toContain("40%");
  });

  test("degrades to the plain card body when task_progress steps is not an array", () => {
    // Shape observed from MiniMax M3: arrays wrapped as { item: [...] }.
    // This fails isTaskProgressSurface, and there are no counters either —
    // the card must not render a meaningless "0 / 0 tasks" bar.
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Building slide deck",
          data: {
            body: "Working on it.",
            template: "task_progress",
            templateData: {
              title: "Slide Deck",
              status: "in_progress",
              steps: { item: [{ label: "Research", status: "in_progress" }] },
            },
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).not.toContain("0 / 0 tasks");
    expect(rendered).not.toContain("tasks");
    expect(rendered).toContain("Building slide deck");
    expect(rendered).toContain("Working on it.");
  });

  test("does not render a counter bar when task_progress has neither steps nor counters", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          data: {
            title: "Task",
            body: "Details",
            template: "task_progress",
            templateData: { title: "Task", status: "in_progress" },
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).not.toContain("tasks");
    expect(rendered).not.toContain("%");
    expect(rendered).toContain("Details");
  });

  test("renders audit reasoning modules without truncating their details", () => {
    const rendered = renderToStaticMarkup(
      <CardSurface
        surface={surface({
          title: "Audit reasoning",
          data: {
            title: "Audit reasoning",
            body: "",
            template: "audit_reasoning",
            templateData: {
              title: "Dr. Rachael Institute Audit Reasoning",
              status: "in_progress",
              modules: [
                {
                  cardId: "audit_trace_campaign_performance",
                  title: "Campaign Report",
                  status: "complete",
                  analysisWindow:
                    "Last 365 days compared with previous 365 days",
                  dataRead: [
                    "Klaviyo campaigns, subject lines, send cadence, themes, sale posture, timing, and segment response",
                  ],
                  ruleApplied:
                    "Compare weekly send cadence, subject-line language, themes, sale posture, design posture, send timing, and segment response against a healthy retention operating rhythm.",
                  rationale:
                    "Campaign cadence and theme mix explain whether the brand is creating repeatable retention pressure or relying on sporadic promos.",
                  evidence: [
                    "Cadence is below the target band in multiple weeks.",
                    "Subject-line word bank leans too heavily on sale language.",
                  ],
                  recommendation:
                    "Build a 30-day calendar with product education as the evergreen backbone.",
                  caveats: [
                    "No external writes were attempted. Klaviyo sends and schedules remain blocked.",
                  ],
                },
              ],
            },
          },
        })}
        onAction={() => undefined}
      />,
    );

    expect(rendered).toContain("Dr. Rachael Institute Audit Reasoning");
    expect(rendered).toContain("Campaign Report");
    expect(rendered).toContain("Data read");
    expect(rendered).toContain("Rule applied");
    expect(rendered).toContain("Why it matters");
    expect(rendered).toContain("Evidence");
    expect(rendered).toContain("Recommendation");
    expect(rendered).toContain("not private");
    expect(rendered).toContain("healthy retention operating rhythm");
  });
});
