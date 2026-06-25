import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const tempDir = process.env.VELLUM_WORKSPACE_DIR!;

const {
  isWakeUpGreeting,
  getCannedFirstGreeting,
  buildScanFirstMessage,
  buildSelfIntroMessage,
  CANNED_FIRST_GREETING,
} = await import("../daemon/first-greeting.js");
import type { OnboardingGreetingContext } from "../daemon/first-greeting.js";

describe("first-greeting", () => {
  describe("isWakeUpGreeting", () => {
    it("returns true for wake-up greeting with 0 messages and BOOTSTRAP.md present", () => {
      writeFileSync(join(tempDir, "BOOTSTRAP.md"), "bootstrap content");
      expect(isWakeUpGreeting("Wake up, my friend.", 0)).toBe(true);
    });

    it("returns true for case variations", () => {
      writeFileSync(join(tempDir, "BOOTSTRAP.md"), "bootstrap content");
      expect(isWakeUpGreeting("wake up, my friend.", 0)).toBe(true);
      expect(isWakeUpGreeting("WAKE UP, MY FRIEND.", 0)).toBe(true);
      expect(isWakeUpGreeting("Wake Up, My Friend.", 0)).toBe(true);
    });

    it("returns true for punctuation variations", () => {
      writeFileSync(join(tempDir, "BOOTSTRAP.md"), "bootstrap content");
      expect(isWakeUpGreeting("Wake up, my friend!", 0)).toBe(true);
      expect(isWakeUpGreeting("Wake up, my friend?", 0)).toBe(true);
      expect(isWakeUpGreeting("Wake up, my friend", 0)).toBe(true);
    });

    it("returns false when content doesn't match wake-up greeting", () => {
      writeFileSync(join(tempDir, "BOOTSTRAP.md"), "bootstrap content");
      expect(isWakeUpGreeting("Hello", 0)).toBe(false);
      expect(isWakeUpGreeting("Hey there", 0)).toBe(false);
      expect(isWakeUpGreeting("Wake up", 0)).toBe(false);
    });

    it("returns false when conversationMessageCount > 0", () => {
      writeFileSync(join(tempDir, "BOOTSTRAP.md"), "bootstrap content");
      expect(isWakeUpGreeting("Wake up, my friend.", 1)).toBe(false);
      expect(isWakeUpGreeting("Wake up, my friend.", 5)).toBe(false);
    });

    it("returns false when BOOTSTRAP.md doesn't exist", () => {
      rmSync(join(tempDir, "BOOTSTRAP.md"), { force: true });
      expect(existsSync(join(tempDir, "BOOTSTRAP.md"))).toBe(false);
      expect(isWakeUpGreeting("Wake up, my friend.", 0)).toBe(false);
    });
  });

  describe("no-onboarding branch", () => {
    it("returns no-onboarding greeting when context is undefined", () => {
      expect(getCannedFirstGreeting(undefined)).toBe(CANNED_FIRST_GREETING);
    });

    it("returns no-onboarding greeting when everything is empty", () => {
      const greeting = getCannedFirstGreeting({
        tools: [],
        tasks: [],
        tone: "",
      });
      expect(greeting).toBe(CANNED_FIRST_GREETING);
    });

    it("no-onboarding greeting uses two-paragraph structure", () => {
      expect(CANNED_FIRST_GREETING).toContain("\n\n");
      const paragraphs = CANNED_FIRST_GREETING.split("\n\n");
      expect(paragraphs.length).toBe(2);
    });

    it("no-onboarding greeting does not contain old self-deprecation text", () => {
      expect(CANNED_FIRST_GREETING).not.toContain("no name, no memories");
      expect(CANNED_FIRST_GREETING).not.toContain("Brand new");
      expect(CANNED_FIRST_GREETING).not.toContain("I can ask");
      expect(CANNED_FIRST_GREETING).not.toContain("get sharper");
    });
  });

  describe("personalized greeting", () => {
    const base: OnboardingGreetingContext = {
      tools: [],
      tasks: [],
      tone: "grounded",
    };

    it("grounded + name + assistantName", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "grounded",
        userName: "Alice",
        assistantName: "Pax",
      });
      expect(greeting).toBe(
        `Hey Alice, I'm Pax.\n\nI'll guide setup one simple question at a time. First question: what is the brand website?`,
      );
    });

    it("warm + name + assistantName", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "warm",
        userName: "Alice",
        assistantName: "Remy",
      });
      expect(greeting).toBe(
        `Hey Alice, I'm Remy. Good to meet you.\n\nI'll keep setup simple and ask one question at a time. First question: paste the brand website and I'll take it from there.`,
      );
    });

    it("energetic + no names", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "energetic",
        assistantName: "Pax",
      });
      expect(greeting).toBe(
        `Hey, I'm Pax. Let's map the account.\n\nLet's set up the brand without making you figure out what I need. First question: drop the brand website and I'll start mapping the account.`,
      );
    });

    it("poetic + name + assistantName", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "poetic",
        userName: "Alice",
        assistantName: "Pax",
      });
      expect(greeting).toBe(
        `Hey Alice, I'm Pax.\n\nWe'll turn the blank start into one simple next question. First question: what is the brand website? That gives us a clean place to start.`,
      );
    });

    it("name only (no assistantName)", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "grounded",
        userName: "Alice",
      });
      expect(greeting).toBe(
        `Hey Alice,\n\nI'll guide setup one simple question at a time. First question: what is the brand website?`,
      );
    });

    it("assistantName only (no userName)", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "grounded",
        assistantName: "Pax",
      });
      expect(greeting).toBe(
        `Hey, I'm Pax.\n\nI'll guide setup one simple question at a time. First question: what is the brand website?`,
      );
    });

    it("no name, no assistantName, no tone returns CANNED_FIRST_GREETING", () => {
      const greeting = getCannedFirstGreeting({
        tools: [],
        tasks: [],
        tone: "",
      });
      expect(greeting).toBe(CANNED_FIRST_GREETING);
    });

    it("no names but valid tone uses tone-aware greeting", () => {
      const greeting = getCannedFirstGreeting({
        tools: [],
        tasks: [],
        tone: "warm",
      });
      expect(greeting).toBe(
        `Hey,\n\nI'll keep setup simple and ask one question at a time. First question: paste the brand website and I'll take it from there.`,
      );
    });

    it("each valid tone with no names produces distinct invite", () => {
      const greetings = ["grounded", "warm", "energetic", "poetic"].map(
        (tone) => getCannedFirstGreeting({ tools: [], tasks: [], tone }),
      );
      const unique = new Set(greetings);
      expect(unique.size).toBe(4);
    });

    it("connected-data greeting points to retention data sources only", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "grounded",
        googleConnected: true,
      });
      expect(greeting).toContain("Klaviyo or Shopify");
      expect(greeting).not.toContain("Gmail");
      expect(greeting).not.toContain("calendar");
      expect(greeting).not.toContain("drive");
    });

    it("unknown tone falls back to grounded defaults", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "mysterious-future-tone",
        userName: "Alice",
        assistantName: "Pax",
      });
      expect(greeting).toBe(
        `Hey Alice, I'm Pax.\n\nI'll guide setup one simple question at a time. First question: what is the brand website?`,
      );
    });

    it("two-paragraph structure preserved", () => {
      const greeting = getCannedFirstGreeting({
        ...base,
        tone: "grounded",
        userName: "Alice",
        assistantName: "Pax",
      });
      const paragraphs = greeting.split("\n\n");
      expect(paragraphs.length).toBe(2);
    });
  });

  describe("tone-specific greetings", () => {
    const base: OnboardingGreetingContext = {
      tools: [],
      tasks: [],
      tone: "grounded",
      userName: "Bob",
      assistantName: "Pax",
    };

    it("grounded intro close is empty, invite is grounded", () => {
      const greeting = getCannedFirstGreeting({ ...base, tone: "grounded" });
      const [intro, invite] = greeting.split("\n\n");
      expect(intro).toBe("Hey Bob, I'm Pax.");
      expect(invite).toBe(
        `I'll guide setup one simple question at a time. First question: what is the brand website?`,
      );
    });

    it("warm intro close is 'Good to meet you.', invite is warm", () => {
      const greeting = getCannedFirstGreeting({ ...base, tone: "warm" });
      const [intro, invite] = greeting.split("\n\n");
      expect(intro).toBe("Hey Bob, I'm Pax. Good to meet you.");
      expect(invite).toBe(
        `I'll keep setup simple and ask one question at a time. First question: paste the brand website and I'll take it from there.`,
      );
    });

    it("energetic intro close is account-specific, invite is energetic", () => {
      const greeting = getCannedFirstGreeting({ ...base, tone: "energetic" });
      const [intro, invite] = greeting.split("\n\n");
      expect(intro).toBe("Hey Bob, I'm Pax. Let's map the account.");
      expect(invite).toBe(
        `Let's set up the brand without making you figure out what I need. First question: drop the brand website and I'll start mapping the account.`,
      );
    });

    it("poetic intro close is empty, invite is poetic", () => {
      const greeting = getCannedFirstGreeting({ ...base, tone: "poetic" });
      const [intro, invite] = greeting.split("\n\n");
      expect(intro).toBe("Hey Bob, I'm Pax.");
      expect(invite).toBe(
        `We'll turn the blank start into one simple next question. First question: what is the brand website? That gives us a clean place to start.`,
      );
    });

    it("each tone produces a distinct full greeting", () => {
      const tones = ["grounded", "warm", "energetic", "poetic"];
      const greetings = tones.map((tone) => {
        return getCannedFirstGreeting({ ...base, tone });
      });
      const unique = new Set(greetings);
      expect(unique.size).toBe(tones.length);
    });

    it("each tone produces distinct invite text", () => {
      const tones = ["grounded", "warm", "energetic", "poetic"];
      const invites = tones.map((tone) => {
        const greeting = getCannedFirstGreeting({ ...base, tone });
        return greeting.split("\n\n")[1];
      });
      const unique = new Set(invites);
      expect(unique.size).toBe(tones.length);
    });
  });

  describe("guided onboarding first step is present in every variant", () => {
    const ONBOARDING_MARKER = "brand website";

    it("no-onboarding greeting includes the first setup question", () => {
      expect(getCannedFirstGreeting(undefined)).toContain(ONBOARDING_MARKER);
      expect(CANNED_FIRST_GREETING).toContain(ONBOARDING_MARKER);
    });

    it("minimal onboarding (falls back to CANNED) includes the first setup question", () => {
      expect(
        getCannedFirstGreeting({ tools: [], tasks: [], tone: "" }),
      ).toContain(ONBOARDING_MARKER);
    });

    it("every tone variant includes the first setup question", () => {
      for (const tone of ["grounded", "warm", "energetic", "poetic"]) {
        const greeting = getCannedFirstGreeting({
          tools: [],
          tasks: [],
          tone,
          userName: "Alice",
          assistantName: "Pax",
        });
        expect(greeting).toContain(ONBOARDING_MARKER);
        expect(greeting).not.toContain("ChatGPT or Claude");
      }
    });

    it("connected-data greeting still includes the first setup question", () => {
      const greeting = getCannedFirstGreeting({
        tools: [],
        tasks: [],
        tone: "warm",
        googleConnected: true,
      });
      expect(greeting).toContain(ONBOARDING_MARKER);
    });
  });

  describe("buildScanFirstMessage", () => {
    it("website variant includes 'my website' and the URL", () => {
      const msg = buildScanFirstMessage("https://acme.com", "website");
      expect(msg).toContain("my website");
      expect(msg).toContain("https://acme.com");
    });

    it("content-source variant includes 'content' and the URL", () => {
      const msg = buildScanFirstMessage(
        "https://blog.acme.com/post",
        "content-source",
      );
      expect(msg).toContain("content");
      expect(msg).toContain("https://blog.acme.com/post");
    });
  });

  describe("tasks and tools fields are ignored", () => {
    it("tasks do not appear in output", () => {
      const greeting = getCannedFirstGreeting({
        tools: ["github", "linear"],
        tasks: ["code-building", "project-management"],
        tone: "grounded",
        userName: "Alice",
        assistantName: "Pax",
      });
      expect(greeting).not.toContain("GitHub");
      expect(greeting).not.toContain("Linear");
      expect(greeting).not.toContain("code");
      expect(greeting).not.toContain("shipping");
      expect(greeting).not.toContain("You mentioned using");
      expect(greeting).not.toContain("wear a lot of hats");
      expect(greeting).not.toContain("Am I on the right track");
    });

    it("tools do not appear in output", () => {
      const greeting = getCannedFirstGreeting({
        tools: ["gmail", "google-calendar", "slack", "notion"],
        tasks: ["scheduling", "personal", "writing", "research"],
        tone: "warm",
        userName: "Bob",
        assistantName: "Remy",
      });
      expect(greeting).not.toContain("Gmail");
      expect(greeting).not.toContain("Google Calendar");
      expect(greeting).not.toContain("Slack");
      expect(greeting).not.toContain("Notion");
      expect(greeting).not.toContain("scheduling");
      expect(greeting).not.toContain("personal");
    });
  });

  describe("buildSelfIntroMessage", () => {
    const ctx = (
      over: Partial<OnboardingGreetingContext> = {},
    ): OnboardingGreetingContext => ({
      tools: [],
      tasks: [],
      tone: "grounded",
      ...over,
    });

    it("uses both names when present", () => {
      expect(
        buildSelfIntroMessage(ctx({ assistantName: "Vela", userName: "alex" })),
      ).toBe("Hi Vela, I'm alex. Nice to meet you.");
    });

    it("drops the missing user name", () => {
      expect(buildSelfIntroMessage(ctx({ assistantName: "Vela" }))).toBe(
        "Hi Vela. Nice to meet you.",
      );
    });

    it("drops the missing assistant name", () => {
      expect(buildSelfIntroMessage(ctx({ userName: "alex" }))).toBe(
        "Hi, I'm alex. Nice to meet you.",
      );
    });

    it("treats whitespace-only names as missing", () => {
      expect(
        buildSelfIntroMessage(ctx({ assistantName: "  ", userName: "  " })),
      ).toBeUndefined();
    });

    it("returns undefined when neither name is known (caller keeps canned greeting)", () => {
      expect(buildSelfIntroMessage(ctx())).toBeUndefined();
      expect(buildSelfIntroMessage(undefined)).toBeUndefined();
    });
  });
});
