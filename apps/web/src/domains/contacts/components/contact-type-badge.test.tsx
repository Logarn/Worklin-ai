import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@vellumai/design-library/components/tag", () => ({
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

const { ContactTypeBadge } = await import("./contact-type-badge");

describe("ContactTypeBadge", () => {
  test("presents the legacy owner role as the current user", () => {
    const html = renderToStaticMarkup(<ContactTypeBadge role="guardian" />);

    expect(html).toContain("You");
    expect(html).not.toContain("Guardian");
  });
});
