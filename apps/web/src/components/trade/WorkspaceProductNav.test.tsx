import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkspaceProductNav } from "./WorkspaceProductNav";

describe("WorkspaceProductNav", () => {
  it("exposes Carry as a direct trading workspace", () => {
    const html = renderToStaticMarkup(
      <WorkspaceProductNav value="spot" onChange={() => undefined} />,
    );

    expect(html).toContain('aria-label="Trading workspace"');
    expect(html).toContain('href="/carry"');
    expect(html).toContain('aria-label="Open cross-venue Carry"');
    expect(html).toContain(">Carry</a>");
  });

  it("keeps the existing product workspaces intact", () => {
    const html = renderToStaticMarkup(
      <WorkspaceProductNav value="perps" onChange={() => undefined} />,
    );

    for (const label of ["Spot", "Perps", "Swap", "Automate"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toContain('aria-current="page"');
  });
});
