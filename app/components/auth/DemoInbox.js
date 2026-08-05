import { createElement as h } from "react";

function deliveryLabel(delivery) {
  if (delivery.demoCode) return `Ověřovací kód ${delivery.demoCode}`;
  if (delivery.kind === "set_password") return "Odkaz pro první heslo";
  return "Odkaz pro obnovu hesla";
}

export function DemoInbox({ deliveries = [], onUseCode, onOpenLink }) {
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
      deliveries.map((delivery) =>
        h(
          "li",
          { key: delivery.challengeId || `${delivery.kind}-${delivery.demoCode || delivery.demoToken}` },
          h("span", null, deliveryLabel(delivery)),
          delivery.demoCode
            ? h("button", { type: "button", onClick: () => onUseCode?.(delivery) }, "Použít kód")
            : h("button", { type: "button", onClick: () => onOpenLink?.(delivery) }, "Otevřít odkaz"),
        ),
      ),
    ),
  );
}
