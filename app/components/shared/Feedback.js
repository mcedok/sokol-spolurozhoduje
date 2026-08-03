import { createElement as h } from "react";

export function Feedback({ feedback }) {
  if (!feedback?.message) return null;
  return h(
    "div",
    {
      className: `toast ${feedback.kind === "error" ? "error" : ""}`,
      role: feedback.kind === "error" ? "alert" : "status",
    },
    feedback.message,
  );
}
