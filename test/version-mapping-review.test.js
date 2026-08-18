import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";

async function loadComponent() {
  const modulePath = "../app/components/admin/VersionMappingReview.js";
  return import(modulePath);
}

const mappingRun = {
  id: "0198f413-2a36-7000-8000-000000000201",
  documentId: "0198f413-2a36-7000-8000-000000000202",
  sourceVersionId: "0198f413-2a36-7000-8000-000000000203",
  targetVersionId: "0198f413-2a36-7000-8000-000000000204",
  algorithmVersion: "block-map-v1",
  status: "review_required",
  rowVersion: 1,
  mappings: [{
    id: "0198f413-2a36-7000-8000-000000000205",
    sourceRevisionIds: ["0198f413-2a36-7000-8000-000000000206"],
    targetRevisionIds: ["0198f413-2a36-7000-8000-000000000207"],
    sourceText: "Původní znění článku.",
    targetText: "Nové přesnější znění článku.",
    relation: "modified",
    confidence: 0.75,
    method: "text_similarity",
    reviewStatus: "needs_review",
    rowVersion: 1,
  }],
};

function apiDouble() {
  return {
    getVersionMappings: vi.fn().mockResolvedValue(mappingRun),
    decideVersionMapping: vi.fn().mockResolvedValue({
      ...mappingRun,
      status: "confirmed",
      rowVersion: 2,
      mappings: [{ ...mappingRun.mappings[0], reviewStatus: "confirmed", rowVersion: 2 }],
    }),
  };
}

describe("VersionMappingReview", () => {
  it("shows source and target context and requires a reason before confirmation", async () => {
    const { VersionMappingReview } = await loadComponent();
    const user = userEvent.setup();
    const api = apiDouble();
    render(h(VersionMappingReview, {
      versionId: mappingRun.targetVersionId,
      api,
      canManage: true,
    }));

    expect(await screen.findByRole("heading", { name: "Kontrola mapování verzí" })).toBeVisible();
    const item = screen.getByRole("article", { name: "Nejasná vazba 1" });
    expect(within(item).getByText("Původní znění článku.")).toBeVisible();
    expect(within(item).getByText("Nové přesnější znění článku.")).toBeVisible();
    expect(within(item).getByRole("status")).toHaveTextContent("75 %");
    const reason = within(item).getByRole("textbox", { name: "Odůvodnění rozhodnutí" });
    expect(reason).toBeRequired();
    await user.type(reason, "Porovnáno s oběma verzemi DOCX.");
    await user.click(within(item).getByRole("button", { name: "Potvrdit vazbu" }));

    await waitFor(() => expect(api.decideVersionMapping).toHaveBeenCalledWith(
      mappingRun.mappings[0].id,
      expect.objectContaining({
        decision: "confirm",
        reason: "Porovnáno s oběma verzemi DOCX.",
        rowVersion: 1,
        idempotencyKey: expect.any(String),
      }),
    ));
    expect(await screen.findByText("Všechna mapování jsou potvrzena.")).toBeVisible();
  });

  it("does not expose mapping administration without a manager capability", async () => {
    const { VersionMappingReview } = await loadComponent();
    const api = apiDouble();
    const { container } = render(h(VersionMappingReview, {
      versionId: mappingRun.targetVersionId,
      api,
      canManage: false,
    }));

    expect(container).toBeEmptyDOMElement();
    expect(api.getVersionMappings).not.toHaveBeenCalled();
  });
});
