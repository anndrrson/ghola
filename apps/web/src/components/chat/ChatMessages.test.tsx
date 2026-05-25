import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RenderMarkdown } from "./ChatMessages";

describe("RenderMarkdown", () => {
  it("does not inject raw HTML from assistant content", () => {
    const html = renderToStaticMarkup(
      <RenderMarkdown content={`hello <img src=x onerror=alert(1)>`} />,
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("onerror");
    expect(html).toContain("hello");
  });

  it("renders inline markdown without using HTML sinks", () => {
    const html = renderToStaticMarkup(
      <RenderMarkdown content={"**bold** *italics* `code`"} />,
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italics</em>");
    expect(html).toContain("<code");
  });

  it("strips attacker controlled attributes from allowed tags", () => {
    const html = renderToStaticMarkup(
      <RenderMarkdown
        content={`hello <span class="fixed inset-0">overlay</span>`}
      />,
    );
    expect(html).toContain("<span>overlay</span>");
    expect(html).not.toContain("fixed");
    expect(html).not.toContain("class=");
  });
});
