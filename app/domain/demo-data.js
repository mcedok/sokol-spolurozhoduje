import { ROLE, USER_STATUS } from "./constants.js";

export const DEMO_CREDENTIALS = {
  superadmin: { email: "superadmin@sokol.demo", password: "SuperSokol!2026" },
  admin: { email: "administrator@sokol.demo", password: "AdminSokol!2026" },
  member: { email: "clen@sokol.demo", code: "260814" },
};

const DEMO_USERS = [
  {
    id: "user-superadmin-demo",
    firstName: "Petra",
    lastName: "Sokolová",
    email: DEMO_CREDENTIALS.superadmin.email,
    sokolUnit: "Česká obec sokolská",
    membershipId: "DEMO-SUPERADMIN-001",
    demoCredential: "superadmin",
    role: ROLE.SUPERADMIN,
    status: USER_STATUS.ACTIVE,
    emailVerifiedAt: "2026-01-01T00:00:00.000Z",
    passwordHash: null,
    passwordSalt: null,
  },
  {
    id: "user-admin-demo",
    firstName: "Martin",
    lastName: "Kovář",
    email: DEMO_CREDENTIALS.admin.email,
    sokolUnit: "TJ Sokol Praha",
    membershipId: "DEMO-ADMIN-001",
    demoCredential: "admin",
    role: ROLE.ADMIN,
    status: USER_STATUS.ACTIVE,
    emailVerifiedAt: "2026-01-01T00:00:00.000Z",
    passwordHash: null,
    passwordSalt: null,
  },
  {
    id: "user-member-demo",
    firstName: "Modelový",
    lastName: "Člen",
    email: DEMO_CREDENTIALS.member.email,
    sokolUnit: "TJ Sokol Demo",
    membershipId: "DEMO-CLEN-001",
    demoCredential: "member",
    role: ROLE.MEMBER,
    status: USER_STATUS.ACTIVE,
    emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  },
];

const DEMO_NORMS = [
  {
    id: "norm-001",
    number: "SOKOL-2026-001",
    title: "Členský a organizační řád",
    category: "Vnitřní předpis",
    version: "2.1",
    status: "K připomínkování",
    commentsOpen: true,
    publishedAt: "2026-06-12",
    deadline: "2026-08-15",
    submittedBy: "Předsednictvo České obce sokolské",
    responsible: "Odbor organizace ČOS",
    summary:
      "Návrh sjednocuje členská práva, digitální účast a pravidla rozhodování v tělocvičných jednotách.",
    reason:
      "Dosavadní úprava nepočítá s běžným využíváním elektronických nástrojů a vzdálenou účastí. Navrhované změny zpřesňují práva členů, lhůty pro vyřízení podnětů a způsob zveřejňování rozhodnutí. Cílem je srozumitelnější a jednotný postup napříč župami a tělocvičnými jednotami.",
    file: null,
    needVotes: { yes: 72, no: 28 },
    sections: [
      {
        id: "rights",
        label: "§ 4",
        title: "Práva člena",
        paragraphs: [
          "Člen Sokola má právo účastnit se činnosti jednoty, být informován o jejím hospodaření a podílet se na rozhodování v rozsahu stanoveném tímto řádem.",
          "Člen může předkládat návrhy a podněty orgánům jednoty. Orgán, kterému byl podnět doručen, jej projedná a o výsledku člena vyrozumí.",
          "Člen má právo nahlížet do zápisů z jednání orgánů jednoty, pokud tím nejsou dotčena práva třetích osob nebo povinnost mlčenlivosti.",
        ],
      },
      {
        id: "bodies",
        label: "§ 9",
        title: "Orgány jednoty",
        paragraphs: [
          "Orgány jednoty rozhodují transparentně a zveřejňují přijatá usnesení způsobem dostupným členům.",
          "Jednání orgánu může proběhnout prezenčně, distančně nebo kombinovanou formou.",
        ],
      },
    ],
    submissions: [
      {
        id: "sub-1",
        kind: "Návrh úpravy",
        section: "§ 4 odst. 2",
        title: "Doplnit možnost vzdálené účasti",
        text: "Doplnit právo účastnit se schůze prostřednictvím prostředků komunikace na dálku.",
        author: "Jana K.",
        unit: "TJ Sokol Brno I",
        createdAt: "2026-06-18",
        score: 28,
        resolutionStatus: "Nevypořádáno",
        resolution: "",
        adminComment: "",
        replies: [
          {
            id: "reply-1",
            author: "Petr N.",
            text: "Podporuji, zejména pro členy mimo místo jednoty.",
          },
        ],
      },
      {
        id: "sub-2",
        kind: "Návrh úpravy",
        section: "§ 4 odst. 2",
        title: "Stanovit lhůtu 30 dnů",
        text: "Navrhuji nahradit neurčitou formulaci konkrétní lhůtou 30 kalendářních dnů.",
        author: "Petr N.",
        unit: "Sokol Praha Vršovice",
        createdAt: "2026-06-20",
        score: 17,
        resolutionStatus: "Zapracováno",
        resolution: "Přijato do pracovní verze 2.2; lhůta byla doplněna.",
        adminComment: "Děkujeme za přesný a proveditelný návrh.",
        replies: [],
      },
      {
        id: "sub-3",
        kind: "Komentář",
        section: "§ 4 odst. 1",
        title: "Věková hranice členského práva",
        text: "Platí toto právo ve stejném rozsahu také pro členy mladší 18 let?",
        author: "Marek S.",
        unit: "TJ Sokol Liberec",
        createdAt: "2026-06-22",
        score: 6,
        resolutionStatus: "Nezapracováno",
        resolution:
          "Rozsah práv nezletilých členů upravují stanovy; do tohoto řádu bude doplněn odkaz.",
        adminComment: "",
        replies: [],
      },
    ],
    ownerAdminId: "user-admin-demo",
    visibilityMode: "public-detail",
  },
  {
    id: "norm-002",
    number: "SOKOL-2026-002",
    title: "Pravidla pro elektronické hlasování",
    category: "Metodický pokyn",
    version: "1.0",
    status: "Vypořádání",
    commentsOpen: false,
    publishedAt: "2026-05-04",
    deadline: "2026-06-30",
    submittedBy: "Výbor České obce sokolské",
    responsible: "Kancelář ČOS",
    summary:
      "Procesní pravidla pro ověření člena, bezpečné hlasování a zveřejnění výsledků.",
    reason:
      "Elektronické hlasování je používáno rozdílně a bez jednotných minimálních pravidel. Materiál stanovuje požadavky na identifikaci hlasujícího, auditní stopu, ochranu osobních údajů a řešení technických incidentů.",
    file: null,
    needVotes: { yes: 89, no: 11 },
    sections: [
      {
        id: "security",
        label: "Čl. 3",
        title: "Ověření a bezpečnost",
        paragraphs: [
          "Každý hlasující člen musí být před hlasováním jednoznačně ověřen.",
          "Systém uchovává auditní záznam bez zveřejnění obsahu tajného hlasování.",
        ],
      },
    ],
    submissions: [
      {
        id: "sub-4",
        kind: "Komentář",
        section: "Čl. 3 odst. 2",
        title: "Doba uchování auditního záznamu",
        text: "Doporučuji uvést konkrétní skartační lhůtu.",
        author: "Eva T.",
        unit: "Sokol Plzeň",
        createdAt: "2026-05-21",
        score: 13,
        resolutionStatus: "Zapracováno",
        resolution: "Doplněna lhůta 5 let od ukončení hlasování.",
        adminComment: "",
        replies: [],
      },
    ],
    ownerAdminId: "user-admin-demo",
    visibilityMode: "public-detail",
  },
  {
    id: "norm-003",
    number: "SOKOL-2026-003",
    title: "Zásady péče o sokolský majetek",
    category: "Směrnice",
    version: "0.8",
    status: "Koncept",
    commentsOpen: false,
    publishedAt: "",
    deadline: "",
    submittedBy: "Ekonomická komise ČOS",
    responsible: "Majetkový odbor ČOS",
    summary:
      "Připravovaná pravidla evidence, údržby a odpovědnosti za společný majetek.",
    reason:
      "Materiál reaguje na rozdílnou praxi při evidenci a plánování oprav sokolského majetku.",
    file: null,
    needVotes: { yes: 0, no: 0 },
    sections: [
      {
        id: "evidence",
        label: "Čl. 2",
        title: "Evidence majetku",
        paragraphs: [
          "Jednota vede průběžnou evidenci nemovitého a významného movitého majetku.",
        ],
      },
    ],
    submissions: [],
    ownerAdminId: "user-admin-demo",
    visibilityMode: "public-detail",
  },
];

export function deriveNormSequenceByYear(norms, stored = {}) {
  const sequenceByYear = {};
  for (const [year, value] of Object.entries(stored || {})) {
    const sequence = Number(value);
    if (/^\d{4}$/.test(year) && Number.isSafeInteger(sequence) && sequence >= 0) {
      sequenceByYear[year] = sequence;
    }
  }
  for (const norm of norms || []) {
    const match = /^SOKOL-(\d{4})-(\d+)$/.exec(norm?.number || "");
    if (!match) continue;
    const [, year, rawSequence] = match;
    const sequence = Number(rawSequence);
    if (Number.isSafeInteger(sequence)) {
      sequenceByYear[year] = Math.max(sequenceByYear[year] || 0, sequence);
    }
  }
  return sequenceByYear;
}

export function createInitialState() {
  return structuredClone({
    schemaVersion: 3,
    users: DEMO_USERS,
    challenges: [],
    sessions: [],
    auditEvents: [],
    norms: DEMO_NORMS,
    normSequenceByYear: deriveNormSequenceByYear(DEMO_NORMS),
    votes: {},
  });
}
