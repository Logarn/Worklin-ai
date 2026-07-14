import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dir, "../../..");

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("campaign-copybook skill contract", () => {
  const skill = readRepoFile("skills/campaign-copybook/SKILL.md");
  const contract = readRepoFile(
    "skills/campaign-copybook/references/copybook-contract.md",
  );
  const template = readRepoFile(
    "skills/campaign-copybook/references/month-template.md",
  );
  const review = readRepoFile(
    "skills/campaign-copybook/references/review-and-qa.md",
  );
  const copySkill = readRepoFile("skills/write-brand-copy/SKILL.md");
  const copyContracts = readRepoFile(
    "skills/write-brand-copy/references/copy-contracts.md",
  );
  const channelPlaybooks = readRepoFile(
    "skills/write-brand-copy/references/channel-playbooks.md",
  );

  test("keeps copywriting as a leaf behind explicit review gates", () => {
    expect(skill).toContain('includes:\n      - "worklin-brand-brain"');
    expect(skill).toContain('- "worklin-copybook"');
    expect(skill).toContain('- "document-editor"');
    expect(skill).toContain('- "write-brand-copy"');
    expect(skill).toContain("Set the stage to `strategy_review` and stop");
    expect(skill).toContain("Do not write final copy for an unapproved brief");
    expect(skill).toContain("Human review is a boundary between runs");
    expect(copySkill).toContain("Campaign sequencing, approvals, comments");
  });

  test("uses structured copybook records without faking persistence", () => {
    expect(skill).toContain("included Copybook Records skill");
    expect(skill).toContain(
      "never claim a transition or approval was recorded when it was not",
    );
    expect(skill).toContain(
      "confirm the returned campaign state is `ready_for_design`",
    );
    expect(contract).toContain("Structured copybook records");
    expect(contract).toContain(
      "A failed or unavailable persistence call does not authorize a local-only state advance",
    );
  });

  test("writes every month through its existing document surface", () => {
    expect(skill).toContain("Capture the returned `month.documentSurfaceId`");
    expect(skill).toContain("Call `document_open` with that surface ID");
    expect(skill).toContain("multiple `document_update` calls");
    expect(skill).toContain(
      "Never call `document_create`, `file_write`, `host_file_write`",
    );
    expect(contract).toContain(
      "`copybook_month_create` returns the month record with `documentSurfaceId`",
    );
    expect(contract).toContain(
      "A failed document operation leaves the structured stage unchanged",
    );
    expect(contract).toContain("Do not save a parallel Markdown copy");
  });

  test("keeps persistence failures concise and out of chat", () => {
    expect(skill).toContain("do not dump the deliverable into chat");
    expect(skill).toContain("Never expose internal planning narration");
    expect(skill).toContain("or paste the full draft into chat");
    expect(skill).toContain("keep the generated section available for a retry");
  });

  test("defines revision-bound approvals and ready-for-design safety", () => {
    expect(contract).toContain(
      '"scope": "strategy | briefs | campaign_copy | month_copy"',
    );
    expect(contract).toContain('"externalActionTaken": false');
    expect(contract).toContain('"canGoLiveNow": false');
    expect(contract).toContain('"visual_design_generation"');
    expect(contract).toContain('"campaign_send"');
    expect(review).toContain("Direct edits, silence, resolved comments");
    expect(review).toContain("human designer handoff only");
  });

  test("requires targeted comment edits before resolution and repeated QA", () => {
    expect(review).toContain(
      "make a targeted edit before replying or resolving",
    );
    expect(review).toContain("Do not guess and do not resolve it");
    expect(review).toContain("Re-run affected copy and claim QA");
    expect(review).toContain(
      "open blocking comment prevents `ready_for_design`",
    );
  });

  test("supports detailed email and SMS copy without generating design", () => {
    expect(copyContracts).toContain("email | sms | organic_social");
    expect(copyContracts).toContain('"design_handoff"');
    expect(copyContracts).toContain('"estimated_segments": null');
    expect(channelPlaybooks).toContain("## SMS");
    expect(channelPlaybooks).toContain("Never invent opt-in status");
    expect(template).toContain("#### Designer Direction");
    expect(template).toContain("not a generated design");
  });
});
