import { createElement as h } from "react";

function deliveryLabel(delivery) {
  if (delivery.demoCode) return `Ověřovací kód ${delivery.demoCode}`;
  if (delivery.kind === "set_password") return "Odkaz pro první heslo";
  return "Odkaz pro obnovu hesla";
}

function recipientIdentity(delivery) {
  return [delivery.recipientLabel, delivery.recipientEmail].filter(Boolean).join(" · ");
}

export function DemoInbox({ deliveries = [], onUseCode, onOpenLink }) {
  if (process.env.NEXT_PUBLIC_DATA_BACKEND !== "browser" || process.env.NODE_ENV === "production") {
    return null;
  }
  if (!deliveries.length) return null;

  return h(
    "section",
    { className: "demoInbox", "aria-labelledby": "demo-inbox-title" },
    h("div", { className: "demoInboxHeading" },
      h("p", { className: "kicker" }, "Simulovaná schránka"),
      h("h3", { id: "demo-inbox-title" }, "Doručené údaje v tomto prohlížeči"),
    ),
    h(
      "ul",
      null,
      deliveries.map((delivery) => {
        const identity = recipientIdentity(delivery);
        const recipientName = delivery.recipientLabel || delivery.recipientEmail;
        const actionLabel = delivery.demoCode ? "Použít kód" : "Otevřít odkaz";
        return h(
          "li",
          { key: delivery.challengeId || `${delivery.kind}-${delivery.userId}` },
          h(
            "span",
            { className: "demoDeliveryInfo" },
            h("strong", null, deliveryLabel(delivery)),
            identity && h("small", null, identity),
          ),
          delivery.demoCode
            ? h("button", {
              type: "button",
              "aria-label": recipientName ? `${actionLabel} pro ${recipientName}` : undefined,
              onClick: () => onUseCode?.(delivery),
            }, actionLabel)
            : h("button", {
              type: "button",
              "aria-label": recipientName ? `${actionLabel} pro ${recipientName}` : undefined,
              onClick: () => onOpenLink?.(delivery),
            }, actionLabel),
        );
      }),
    ),
  );
}
