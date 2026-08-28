import { createElement as h } from "react";

export function Feedback({ feedback, actionLabel, onAction }) {
  if (!feedback?.message) return null;
  return h(
    "div",
    {
      className: `toast ${feedback.kind === "error" ? "error" : ""}`,
      role: feedback.kind === "error" ? "alert" : "status",
    },
    h("span", null, feedback.message),
    actionLabel && onAction
      ? h("button", { type: "button", onClick: onAction }, actionLabel)
      : null,
  );
}
