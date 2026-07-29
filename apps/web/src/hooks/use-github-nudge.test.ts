import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import {
  GITHUB_REPO_URL,
  openGitHubRepo,
} from "@/hooks/use-github-nudge";

afterEach(() => {
  mock.restore();
});

describe("GitHub nudge", () => {
  test("opens the public Worklin repository", () => {
    const openSpy = spyOn(window, "open").mockImplementation(() => null);

    openGitHubRepo();

    expect(GITHUB_REPO_URL).toBe("https://github.com/Logarn/Worklin-ai");
    expect(openSpy).toHaveBeenCalledWith(
      "https://github.com/Logarn/Worklin-ai",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
