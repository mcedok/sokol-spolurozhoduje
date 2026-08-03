"use client";

import { useEffect, useMemo, useState } from "react";
import { readFile, removeFile, storeFile } from "./data/file-repository.js";

const STORAGE_KEY = "sokol-spolurozhoduje-pilot-v2";

const STATUS_OPTIONS = [
  "Koncept",
  "K připomínkování",
  "Vypořádání",
  "Ke schválení",
  "Schváleno",
  "Neschváleno",
  "Archivováno",
];

const statusClass = {
  Koncept: "neutral",
  "K připomínkování": "open",
  Vypořádání: "review",
  "Ke schválení": "review",
  Schváleno: "approved",
  Neschváleno: "rejected",
  Archivováno: "neutral",
};

const initialNorms = [
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
  },
];

function dateLabel(value) {
  if (!value) return "neuvedeno";
  return new Intl.DateTimeFormat("cs-CZ", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function StatusBadge({ value }) {
  return <span className={`statusBadge ${statusClass[value] || "neutral"}`}>{value}</span>;
}

function EmptyState({ children }) {
  return <div className="emptyState">{children}</div>;
}

export default function Home() {
  const [norms, setNorms] = useState(initialNorms);
  const [hydrated, setHydrated] = useState(false);
  const [view, setView] = useState("landing");
  const [selectedId, setSelectedId] = useState(initialNorms[0].id);
  const [adminId, setAdminId] = useState(initialNorms[0].id);
  const [filter, setFilter] = useState("Aktivní");
  const [submissionMode, setSubmissionMode] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [toast, setToast] = useState("");
  const [votes, setVotes] = useState({});
  const [needVote, setNeedVote] = useState(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setNorms(JSON.parse(saved));
    } catch {
      // Pilot remains usable with the bundled demo data.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(norms));
  }, [hydrated, norms]);

  const selectedNorm = useMemo(
    () => norms.find((norm) => norm.id === selectedId) || norms[0],
    [norms, selectedId],
  );
  const adminNorm = useMemo(
    () => norms.find((norm) => norm.id === adminId) || norms[0],
    [norms, adminId],
  );
  const filteredNorms = useMemo(() => {
    if (filter === "Všechny") return norms;
    if (filter === "Uzavřené") {
      return norms.filter((norm) =>
        ["Schváleno", "Neschváleno", "Archivováno"].includes(norm.status),
      );
    }
    return norms.filter((norm) =>
      ["K připomínkování", "Vypořádání", "Ke schválení"].includes(norm.status),
    );
  }, [filter, norms]);

  function flash(message) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  function updateNorm(id, patch) {
    setNorms((items) =>
      items.map((norm) =>
        norm.id === id
          ? { ...norm, ...(typeof patch === "function" ? patch(norm) : patch) }
          : norm,
      ),
    );
  }

  function openNorm(id) {
    setSelectedId(id);
    setView("detail");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openAdmin(id = adminId) {
    if (id) setAdminId(id);
    setView("admin");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function castVote(normId, submissionId, direction) {
    const voteKey = `${normId}:${submissionId}`;
    const previous = votes[voteKey] || 0;
    updateNorm(normId, (norm) => ({
      submissions: norm.submissions.map((item) =>
        item.id === submissionId
          ? { ...item, score: item.score - previous + direction }
          : item,
      ),
    }));
    setVotes((current) => ({ ...current, [voteKey]: direction }));
  }

  async function downloadDocument(norm) {
    if (!norm.file?.id) {
      flash("K této normě zatím nebyl nahrán soubor.");
      return;
    }
    try {
      const file = await readFile(norm.file.id);
      if (!file) throw new Error("Soubor nebyl nalezen");
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = norm.file.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      flash("Soubor je uložen v jiném prohlížeči nebo byl odstraněn.");
    }
  }

  async function replaceDocument(norm, file) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      flash("Soubor může mít nejvýše 15 MB.");
      return;
    }
    const fileId = `file-${norm.id}-${Date.now()}`;
    try {
      await storeFile(fileId, file);
      await removeFile(norm.file?.id);
      updateNorm(norm.id, {
        file: { id: fileId, name: file.name, size: file.size, type: file.type },
      });
      flash("Dokument byl bezpečně uložen pro pilotní test.");
    } catch {
      flash("Soubor se nepodařilo uložit v tomto prohlížeči.");
    }
  }

  async function deleteNorm(norm) {
    if (!window.confirm(`Opravdu smazat normu ${norm.number} – ${norm.title}?`)) return;
    await removeFile(norm.file?.id);
    setNorms((items) => items.filter((item) => item.id !== norm.id));
    const fallback = norms.find((item) => item.id !== norm.id);
    setAdminId(fallback?.id || "");
    setSelectedId(fallback?.id || "");
    flash("Norma byla smazána.");
  }

  function createNorm(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const year = new Date().getFullYear();
    const sequence =
      Math.max(
        0,
        ...norms.map((norm) => Number.parseInt(norm.number.split("-").at(-1), 10) || 0),
      ) + 1;
    const id = `norm-${Date.now()}`;
    const file = form.get("file");
    const newNorm = {
      id,
      number: `SOKOL-${year}-${String(sequence).padStart(3, "0")}`,
      title: form.get("title").trim(),
      category: form.get("category").trim(),
      version: form.get("version").trim(),
      status: form.get("status"),
      commentsOpen: form.get("status") === "K připomínkování",
      publishedAt:
        form.get("status") === "K připomínkování"
          ? new Date().toISOString().slice(0, 10)
          : "",
      deadline: form.get("deadline"),
      submittedBy: form.get("submittedBy").trim(),
      responsible: form.get("responsible").trim(),
      summary: form.get("summary").trim(),
      reason: form.get("reason").trim(),
      file: null,
      needVotes: { yes: 0, no: 0 },
      sections: [
        {
          id: "document",
          label: "Dokument",
          title: "Text nahraného materiálu",
          paragraphs: [
            "Pro pilotní test je původní soubor dostupný ke stažení. Strukturovaný převod dokumentu bude doplněn v navazující integrační fázi.",
          ],
        },
      ],
      submissions: [],
    };
    setNorms((items) => [...items, newNorm]);
    setAdminId(id);
    setSelectedId(id);
    setShowCreate(false);
    if (file instanceof File && file.size > 0) {
      window.setTimeout(() => replaceDocument(newNorm, file), 0);
    }
    flash(`Norma ${newNorm.number} byla založena.`);
  }

  function submitContribution(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const kind = submissionMode === "proposal" ? "Návrh úpravy" : "Komentář";
    const contribution = {
      id: `sub-${Date.now()}`,
      kind,
      section: form.get("section").trim() || "Obecně",
      title: form.get("title").trim(),
      text: form.get("text").trim(),
      author: form.get("author").trim(),
      unit: form.get("unit").trim(),
      createdAt: new Date().toISOString().slice(0, 10),
      score: 0,
      resolutionStatus: "Nevypořádáno",
      resolution: "",
      adminComment: "",
      replies: [],
    };
    updateNorm(selectedNorm.id, (norm) => ({
      submissions: [...norm.submissions, contribution],
    }));
    setSubmissionMode(null);
    flash(`${kind} byl zveřejněn.`);
  }

  function addReply(event, normId, submissionId, author = "Předkladatel") {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = form.get("reply").trim();
    if (!text) return;
    updateNorm(normId, (norm) => ({
      submissions: norm.submissions.map((item) =>
        item.id === submissionId
          ? {
              ...item,
              replies: [
                ...(item.replies || []),
                { id: `reply-${Date.now()}`, author, text },
              ],
            }
          : item,
      ),
    }));
    event.currentTarget.reset();
    flash("Odpověď byla přidána.");
  }

  function resolveSubmission(event, normId, submissionId) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    updateNorm(normId, (norm) => ({
      submissions: norm.submissions.map((item) =>
        item.id === submissionId
          ? {
              ...item,
              resolutionStatus: form.get("resolutionStatus"),
              resolution: form.get("resolution").trim(),
              adminComment: form.get("adminComment").trim(),
            }
          : item,
      ),
    }));
    flash("Vypořádání bylo uloženo a je viditelné členům.");
  }

  return (
    <main>
      <header className="topbar">
        <button className="brand" onClick={() => setView("landing")}>
          <img src="/brand/sokol-symbol.png" alt="" />
          <span><strong>SOKOL</strong> spolurozhoduje</span>
        </button>
        <nav aria-label="Hlavní navigace">
          <button className={view === "landing" ? "active" : ""} onClick={() => setView("landing")}>Normy</button>
          <button className={view === "detail" ? "active" : ""} onClick={() => openNorm(selectedNorm?.id)}>Připomínkování</button>
          <button className={view === "admin" ? "active" : ""} onClick={() => openAdmin()}>Administrace</button>
        </nav>
        <div className="userBox"><span>MK</span><small>pilotní účet</small></div>
      </header>

      {view === "landing" && (
        <>
          <section className="hero">
            <div>
              <p className="kicker">Participativní tvorba sokolských norem</p>
              <h1>Rozhodujme společně.</h1>
              <p>Připomínkujte návrhy, podávejte konkrétní úpravy a sledujte, jak předkladatel každý podnět vypořádal.</p>
              <button className="primaryButton" onClick={() => document.getElementById("normy")?.scrollIntoView({ behavior: "smooth" })}>Zobrazit normy</button>
            </div>
            <aside>
              <b>Jak to probíhá</b>
              <ol>
                <li><span>1</span>Přečtete si materiál a důvodovou zprávu.</li>
                <li><span>2</span>Přidáte komentář nebo přesný návrh změny.</li>
                <li><span>3</span>Hlasováním podpoříte důležité podněty.</li>
                <li><span>4</span>Uvidíte rozhodnutí a odůvodnění předkladatele.</li>
              </ol>
            </aside>
          </section>

          <section className="normListSection" id="normy">
            <div className="sectionHeading">
              <div><p className="kicker">Evidence materiálů</p><h2>Normy k připomínkování</h2></div>
              <div className="filterTabs">
                {["Aktivní", "Uzavřené", "Všechny"].map((item) => (
                  <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item}</button>
                ))}
              </div>
            </div>
            <div className="normGrid">
              {filteredNorms.length ? filteredNorms.map((norm) => (
                <article className="normCard" key={norm.id}>
                  <div className="cardTop"><span className="normNumber">{norm.number}</span><StatusBadge value={norm.status} /></div>
                  <p className="category">{norm.category} · verze {norm.version}</p>
                  <h3>{norm.title}</h3>
                  <p className="summary">{norm.summary}</p>
                  <dl>
                    <div><dt>Předkládá</dt><dd>{norm.submittedBy}</dd></div>
                    <div><dt>Odpovídá</dt><dd>{norm.responsible}</dd></div>
                    <div><dt>Připomínky</dt><dd>{norm.commentsOpen ? `do ${dateLabel(norm.deadline)}` : "uzavřeny"}</dd></div>
                  </dl>
                  <div className="cardFooter"><span>{norm.submissions.length} podnětů</span><button onClick={() => openNorm(norm.id)}>Otevřít materiál →</button></div>
                </article>
              )) : <EmptyState>V této skupině zatím nejsou žádné normy.</EmptyState>}
            </div>
          </section>
        </>
      )}

      {view === "detail" && selectedNorm && (
        <section className="detailPage">
          <button className="backButton" onClick={() => setView("landing")}>← Zpět na seznam norem</button>
          <div className="detailHeader">
            <div>
              <div className="detailMeta"><span className="normNumber">{selectedNorm.number}</span><StatusBadge value={selectedNorm.status} /></div>
              <h1>{selectedNorm.title}</h1>
              <p>{selectedNorm.summary}</p>
            </div>
            <div className="detailActions">
              <button onClick={() => downloadDocument(selectedNorm)}>{selectedNorm.file ? `Stáhnout ${selectedNorm.file.name}` : "Soubor není přiložen"}</button>
              <button className="primaryButton small" onClick={() => openAdmin(selectedNorm.id)}>Spravovat</button>
            </div>
          </div>

          <div className="detailFacts">
            <div><span>Předkládá</span><b>{selectedNorm.submittedBy}</b></div>
            <div><span>Za normu odpovídá</span><b>{selectedNorm.responsible}</b></div>
            <div><span>Zveřejněno</span><b>{dateLabel(selectedNorm.publishedAt)}</b></div>
            <div><span>Termín</span><b>{dateLabel(selectedNorm.deadline)}</b></div>
          </div>

          <div className="detailLayout">
            <div className="documentColumn">
              <section className="reasonBox">
                <p className="kicker">Průvodní informace / důvodová zpráva</p>
                <h2>Proč se norma mění</h2>
                <p>{selectedNorm.reason}</p>
              </section>
              <div className="documentPaper">
                <p className="documentLabel">{selectedNorm.category} · verze {selectedNorm.version}</p>
                <h2>{selectedNorm.title}</h2>
                {selectedNorm.sections.map((section) => (
                  <section className="documentSection" key={section.id}>
                    <div><b>{section.label}</b><h3>{section.title}</h3></div>
                    {section.paragraphs.map((paragraph, index) => (
                      <p key={`${section.id}-${index}`}><span>({index + 1})</span>{paragraph}</p>
                    ))}
                  </section>
                ))}
                <div className="needVote">
                  <div><b>Je přijetí této normy potřebné?</b><p>Orientační hlasování členů není konečným schválením normy.</p></div>
                  <div>
                    <button className={needVote === "yes" ? "selected yes" : ""} onClick={() => {
                      if (needVote) return;
                      setNeedVote("yes");
                      updateNorm(selectedNorm.id, (norm) => ({ needVotes: { ...norm.needVotes, yes: norm.needVotes.yes + 1 } }));
                    }}>Ano {selectedNorm.needVotes.yes}</button>
                    <button className={needVote === "no" ? "selected no" : ""} onClick={() => {
                      if (needVote) return;
                      setNeedVote("no");
                      updateNorm(selectedNorm.id, (norm) => ({ needVotes: { ...norm.needVotes, no: norm.needVotes.no + 1 } }));
                    }}>Ne {selectedNorm.needVotes.no}</button>
                  </div>
                </div>
              </div>
            </div>

            <aside className="contributions">
              <div className="contributionHeader">
                <div><p className="kicker">Diskuse</p><h2>Podněty členů</h2></div>
                {selectedNorm.commentsOpen && <div><button onClick={() => setSubmissionMode("comment")}>Komentář</button><button className="primaryButton small" onClick={() => setSubmissionMode("proposal")}>Návrh změny</button></div>}
              </div>
              {!selectedNorm.commentsOpen && <div className="closedNotice">Připomínkování je uzavřeno. Výsledky zůstávají veřejné.</div>}
              {selectedNorm.submissions.length ? selectedNorm.submissions.slice().sort((a, b) => b.score - a.score).map((item) => {
                const voteKey = `${selectedNorm.id}:${item.id}`;
                return (
                  <article className="submissionCard" key={item.id}>
                    <div className="submissionTop"><span>{item.kind}</span><small>{item.section}</small></div>
                    <h3>{item.title}</h3><p>{item.text}</p>
                    <div className="authorLine"><b>{item.author}</b><span>{item.unit} · {dateLabel(item.createdAt)}</span></div>
                    {item.resolutionStatus !== "Nevypořádáno" && (
                      <div className={`resolutionBox ${item.resolutionStatus === "Zapracováno" ? "accepted" : "declined"}`}>
                        <b>{item.resolutionStatus}</b><p>{item.resolution}</p>{item.adminComment && <small>Předkladatel: {item.adminComment}</small>}
                      </div>
                    )}
                    {(item.replies || []).map((reply) => <div className="reply" key={reply.id}><b>{reply.author}</b><p>{reply.text}</p></div>)}
                    {selectedNorm.commentsOpen && <form className="replyForm" onSubmit={(event) => addReply(event, selectedNorm.id, item.id, "Člen")}><input name="reply" aria-label="Odpověď" placeholder="Odpovědět…" required /><button>Odeslat</button></form>}
                    <div className="voteRow"><span>Je tento podnět důležitý?</span><div><button className={votes[voteKey] === 1 ? "selected" : ""} onClick={() => castVote(selectedNorm.id, item.id, 1)}>↑</button><b>{item.score}</b><button className={votes[voteKey] === -1 ? "selected down" : ""} onClick={() => castVote(selectedNorm.id, item.id, -1)}>↓</button></div></div>
                  </article>
                );
              }) : <EmptyState>Zatím nebyl přidán žádný podnět.</EmptyState>}
            </aside>
          </div>
        </section>
      )}

      {view === "admin" && (
        <section className="adminPage">
          <div className="adminHeading">
            <div><p className="kicker">Rozhraní předkladatele</p><h1>Správa norem</h1><p>Publikace materiálů, řízení připomínkování a transparentní vypořádání podnětů.</p></div>
            <button className="primaryButton" onClick={() => setShowCreate(true)}>+ Předložit novou normu</button>
          </div>
          <div className="adminLayout">
            <aside className="adminNormList">
              {norms.map((norm) => <button key={norm.id} className={norm.id === adminNorm?.id ? "active" : ""} onClick={() => setAdminId(norm.id)}><span>{norm.number}</span><b>{norm.title}</b><StatusBadge value={norm.status} /></button>)}
            </aside>
            {adminNorm ? (
              <div className="adminWorkspace">
                <div className="adminToolbar">
                  <div><span className="normNumber">{adminNorm.number}</span><h2>{adminNorm.title}</h2></div>
                  <div><button onClick={() => openNorm(adminNorm.id)}>Veřejný náhled</button><button className="dangerButton" onClick={() => deleteNorm(adminNorm)}>Smazat</button></div>
                </div>
                <section className="adminSection">
                  <div className="adminSectionTitle"><div><h3>Stav a připomínkování</h3><p>Změny se ihned projeví ve veřejném náhledu.</p></div><StatusBadge value={adminNorm.status} /></div>
                  <div className="adminControls">
                    <label>Status normy<select value={adminNorm.status} onChange={(event) => updateNorm(adminNorm.id, { status: event.target.value })}>{STATUS_OPTIONS.map((status) => <option key={status}>{status}</option>)}</select></label>
                    <label>Termín připomínek<input type="date" value={adminNorm.deadline || ""} onChange={(event) => updateNorm(adminNorm.id, { deadline: event.target.value })} /></label>
                    <div className="toggleControl"><span>Připomínky jsou <b>{adminNorm.commentsOpen ? "otevřené" : "uzavřené"}</b></span><button className={adminNorm.commentsOpen ? "closeButton" : "primaryButton small"} onClick={() => updateNorm(adminNorm.id, { commentsOpen: !adminNorm.commentsOpen })}>{adminNorm.commentsOpen ? "Uzavřít připomínky" : "Otevřít připomínky"}</button></div>
                  </div>
                </section>
                <section className="adminSection">
                  <div className="adminSectionTitle"><div><h3>Dokument a odpovědnost</h3><p>Údaje, které členové uvidí u normy.</p></div></div>
                  <div className="adminControls twoColumns">
                    <label>Předkladatel<input value={adminNorm.submittedBy} onChange={(event) => updateNorm(adminNorm.id, { submittedBy: event.target.value })} /></label>
                    <label>Odpovídá za normu<input value={adminNorm.responsible} onChange={(event) => updateNorm(adminNorm.id, { responsible: event.target.value })} /></label>
                    <label className="wide">Průvodní informace / důvodová zpráva<textarea value={adminNorm.reason} onChange={(event) => updateNorm(adminNorm.id, { reason: event.target.value })} /></label>
                    <label className="fileField wide"><span>{adminNorm.file ? `Nahráno: ${adminNorm.file.name}` : "Nahrát PDF, DOCX nebo ODT"}</span><input type="file" accept=".pdf,.docx,.odt" onChange={(event) => replaceDocument(adminNorm, event.target.files?.[0])} /></label>
                  </div>
                </section>
                <section className="adminSection">
                  <div className="adminSectionTitle"><div><h3>Vypořádání podnětů</h3><p>{adminNorm.submissions.filter((item) => item.resolutionStatus === "Nevypořádáno").length} čeká na rozhodnutí.</p></div></div>
                  <div className="resolutionList">
                    {adminNorm.submissions.length ? adminNorm.submissions.map((item) => (
                      <article className="resolutionItem" key={item.id}>
                        <div><span>{item.kind} · {item.section}</span><h4>{item.title}</h4><p>{item.text}</p><small>{item.author}, {item.unit} · podpora {item.score}</small></div>
                        <form onSubmit={(event) => resolveSubmission(event, adminNorm.id, item.id)}>
                          <label>Výsledek<select name="resolutionStatus" defaultValue={item.resolutionStatus}><option>Nevypořádáno</option><option>Zapracováno</option><option>Nezapracováno</option></select></label>
                          <label>Odůvodnění rozhodnutí<textarea name="resolution" defaultValue={item.resolution} placeholder="Popište, jak a proč byl podnět vypořádán." /></label>
                          <label>Komentář předkladatele<input name="adminComment" defaultValue={item.adminComment} placeholder="Volitelná doplňující odpověď" /></label>
                          <button className="primaryButton small">Uložit vypořádání</button>
                        </form>
                        <form className="adminReply" onSubmit={(event) => addReply(event, adminNorm.id, item.id)}><input name="reply" placeholder="Okomentovat podnět jako předkladatel…" required /><button>Odeslat komentář</button></form>
                      </article>
                    )) : <EmptyState>U této normy zatím nejsou žádné podněty.</EmptyState>}
                  </div>
                </section>
              </div>
            ) : <EmptyState>Nejprve založte novou normu.</EmptyState>}
          </div>
        </section>
      )}

      {submissionMode && selectedNorm && (
        <div className="modalBackdrop" onMouseDown={() => setSubmissionMode(null)}>
          <form className="modal" onSubmit={submitContribution} onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" className="modalClose" onClick={() => setSubmissionMode(null)}>×</button>
            <p className="kicker">{selectedNorm.number}</p><h2>{submissionMode === "proposal" ? "Nový návrh změny" : "Nový komentář"}</h2>
            <label>Jméno<input name="author" required placeholder="Jan Novák" /></label>
            <label>Jednota / župa<input name="unit" required placeholder="TJ Sokol…" /></label>
            <label>Část dokumentu<input name="section" placeholder="např. § 4 odst. 2" /></label>
            <label>Název<input name="title" required placeholder="Stručné pojmenování podnětu" /></label>
            <label>{submissionMode === "proposal" ? "Navrhované znění a odůvodnění" : "Komentář"}<textarea name="text" required /></label>
            <div className="modalActions"><button type="button" onClick={() => setSubmissionMode(null)}>Zrušit</button><button className="primaryButton">Zveřejnit</button></div>
          </form>
        </div>
      )}

      {showCreate && (
        <div className="modalBackdrop" onMouseDown={() => setShowCreate(false)}>
          <form className="modal wideModal" onSubmit={createNorm} onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" className="modalClose" onClick={() => setShowCreate(false)}>×</button>
            <p className="kicker">Nový materiál</p><h2>Předložit normu</h2>
            <div className="formGrid">
              <label className="wide">Název normy<input name="title" required /></label>
              <label>Druh dokumentu<input name="category" required placeholder="Směrnice" /></label>
              <label>Verze<input name="version" required defaultValue="1.0" /></label>
              <label>Předkladatel<input name="submittedBy" required /></label>
              <label>Odpovídá za normu<input name="responsible" required /></label>
              <label>Status<select name="status" defaultValue="Koncept">{STATUS_OPTIONS.map((status) => <option key={status}>{status}</option>)}</select></label>
              <label>Termín připomínek<input name="deadline" type="date" /></label>
              <label className="wide">Krátké shrnutí<textarea name="summary" required /></label>
              <label className="wide">Průvodní informace / důvodová zpráva<textarea name="reason" required /></label>
              <label className="fileField wide"><span>Přiložit dokument (max. 15 MB)</span><input name="file" type="file" accept=".pdf,.docx,.odt" /></label>
            </div>
            <div className="modalActions"><button type="button" onClick={() => setShowCreate(false)}>Zrušit</button><button className="primaryButton">Předložit normu</button></div>
          </form>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
