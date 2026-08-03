"use client";

import { useMemo, useState } from "react";
import { AuthDialog } from "./components/auth/AuthDialog.js";
import { UserMenu } from "./components/auth/UserMenu.js";
import { Feedback } from "./components/shared/Feedback.js";
import * as fileRepository from "./data/file-repository.js";
import { createInitialState } from "./domain/demo-data.js";
import { useAppController } from "./hooks/use-app-controller.js";

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

const initialNorms = createInitialState().norms;

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
  const controller = useAppController();
  const { state, session, currentUser, view, actions, feedback, authMode, services } = controller;
  const norms = state.norms;
  const sessionId = session?.id || null;
  const setView = actions.setView;
  const flash = actions.flash;
  const [selectedId, setSelectedId] = useState(initialNorms[0].id);
  const [adminId, setAdminId] = useState(initialNorms[0].id);
  const [filter, setFilter] = useState("Aktivní");
  const [submissionMode, setSubmissionMode] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [votes, setVotes] = useState({});
  const [needVote, setNeedVote] = useState(null);

  const publicNorms = useMemo(
    () => (services ? services.normService.listPublicNorms("Všechny") : initialNorms),
    [norms, services],
  );
  const manageableNorms = useMemo(() => {
    if (!services || !sessionId) return [];
    try {
      return services.normService.listManageable(sessionId);
    } catch {
      return [];
    }
  }, [norms, services, sessionId]);
  const selectedNorm = useMemo(
    () => publicNorms.find((norm) => norm.id === selectedId) || publicNorms[0],
    [publicNorms, selectedId],
  );
  const adminNorm = useMemo(
    () => manageableNorms.find((norm) => norm.id === adminId) || manageableNorms[0],
    [manageableNorms, adminId],
  );
  const filteredNorms = useMemo(() => {
    if (services) return services.normService.listPublicNorms(filter);
    if (filter === "Všechny") return initialNorms;
    if (filter === "Uzavřené") {
      return initialNorms.filter((norm) =>
        ["Schváleno", "Neschváleno", "Archivováno"].includes(norm.status),
      );
    }
    return initialNorms.filter((norm) =>
      ["K připomínkování", "Vypořádání", "Ke schválení"].includes(norm.status),
    );
  }, [filter, norms, services]);

  function refreshNorms() {
    if (!services) return [];
    return actions.refresh()?.norms || [];
  }

  function currentSessionId() {
    return session?.id || null;
  }

  async function runMutation(operation) {
    if (!services) {
      flash("Aplikace se ještě připravuje.");
      return null;
    }
    if (!currentSessionId()) {
      actions.openLogin();
      flash("Pro aktivní účast se nejprve přihlaste.");
      return null;
    }
    return actions.mutate(() => operation(services.normService, currentSessionId()));
  }

  function updateNorm(id, patch) {
    return runMutation((normService, sessionId) => normService.update(sessionId, id, patch));
  }

  function openNorm(id) {
    setSelectedId(id);
    setView("detail");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openAdmin(id = adminId) {
    if (!currentSessionId()) {
      actions.openLogin();
      flash("Administrace je dostupná po přihlášení správce.");
      return;
    }
    if (id) setAdminId(id);
    setView("admin");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function castVote(normId, submissionId, direction) {
    const voteKey = `${normId}:${submissionId}`;
    const result = await runMutation((normService, sessionId) =>
      normService.voteSubmission(sessionId, normId, submissionId, direction),
    );
    if (result) setVotes((current) => ({ ...current, [voteKey]: result.vote }));
  }

  async function downloadDocument(norm) {
    if (!norm.file?.id) {
      flash("K této normě zatím nebyl nahrán soubor.");
      return;
    }
    try {
      const file = await fileRepository.readFile(norm.file.id);
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
    await runMutation((normService, sessionId) =>
      normService.replaceDocument(sessionId, norm.id, file),
    );
  }

  async function deleteNorm(norm) {
    if (!window.confirm(`Opravdu smazat normu ${norm.number} – ${norm.title}?`)) return;
    const result = await runMutation((normService, sessionId) =>
      normService.remove(sessionId, norm.id),
    );
    if (!result) return;
    const fallback = services.repository.read().norms[0];
    setAdminId(fallback?.id || "");
    setSelectedId(fallback?.id || "");
  }

  async function createNorm(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    const input = {
      title: form.get("title").trim(),
      category: form.get("category").trim(),
      version: form.get("version").trim(),
      status: form.get("status"),
      deadline: form.get("deadline"),
      submittedBy: form.get("submittedBy").trim(),
      responsible: form.get("responsible").trim(),
      summary: form.get("summary").trim(),
      reason: form.get("reason").trim(),
    };
    const result = await runMutation((normService, sessionId) =>
      normService.create(
        sessionId,
        input,
        file instanceof File && file.size > 0 ? file : undefined,
      ),
    );
    if (!result) return;
    setAdminId(result.norm.id);
    setSelectedId(result.norm.id);
    setShowCreate(false);
  }

  async function submitContribution(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const kind = submissionMode === "proposal" ? "Návrh úpravy" : "Komentář";
    const result = await runMutation((normService, sessionId) =>
      normService.addContribution(sessionId, selectedNorm.id, {
      kind,
      section: form.get("section").trim() || "Obecně",
      title: form.get("title").trim(),
      text: form.get("text").trim(),
      }),
    );
    if (result) setSubmissionMode(null);
  }

  async function addReply(event, normId, submissionId) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = form.get("reply").trim();
    if (!text) return;
    const result = await runMutation((normService, sessionId) =>
      normService.reply(sessionId, normId, submissionId, text),
    );
    if (result) event.currentTarget.reset();
  }

  async function resolveSubmission(event, normId, submissionId) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await runMutation((normService, sessionId) =>
      normService.resolveSubmission(sessionId, normId, submissionId, {
        resolutionStatus: form.get("resolutionStatus"),
        resolution: form.get("resolution").trim(),
        adminComment: form.get("adminComment").trim(),
      }),
    );
  }

  async function castNeedVote(normId, value) {
    const result = await runMutation((normService, sessionId) =>
      normService.voteNeed(sessionId, normId, value),
    );
    if (result) setNeedVote(result.vote);
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
        <UserMenu
          currentUser={currentUser}
          onLogin={() => actions.openLogin()}
          onProfile={() => flash("Profil uživatele bude dostupný v navazující části aplikace.")}
          onLogout={actions.logout}
        />
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
              {filteredNorms.length ? filteredNorms.map((norm) =>
                norm.visibilityMode === "title-only" ? (
                  <article className="normCard" key={norm.id}>
                    <h3>{norm.title}</h3>
                    <p className="summary">Detail této normy je dostupný po přihlášení.</p>
                    <div className="cardFooter"><button onClick={() => openNorm(norm.id)}>Otevřít materiál →</button></div>
                  </article>
                ) : (
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
                ),
              ) : <EmptyState>V této skupině zatím nejsou žádné normy.</EmptyState>}
            </div>
          </section>
        </>
      )}

      {view === "detail" && selectedNorm?.visibilityMode === "title-only" && (
        <section className="detailPage">
          <button className="backButton" onClick={() => setView("landing")}>← Zpět na seznam norem</button>
          <div className="detailHeader">
            <div><h1>{selectedNorm.title}</h1><p>Detail této normy je dostupný po přihlášení.</p></div>
          </div>
        </section>
      )}

      {view === "detail" && selectedNorm && selectedNorm.visibilityMode !== "title-only" && (
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
                    <button className={needVote === "yes" ? "selected yes" : ""} onClick={() => castNeedVote(selectedNorm.id, "yes")}>Ano {selectedNorm.needVotes.yes}</button>
                    <button className={needVote === "no" ? "selected no" : ""} onClick={() => castNeedVote(selectedNorm.id, "no")}>Ne {selectedNorm.needVotes.no}</button>
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
                    {selectedNorm.commentsOpen && <form className="replyForm" onSubmit={(event) => addReply(event, selectedNorm.id, item.id)}><input name="reply" aria-label="Odpověď" placeholder="Odpovědět…" required /><button>Odeslat</button></form>}
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
              {manageableNorms.map((norm) => <button key={norm.id} className={norm.id === adminNorm?.id ? "active" : ""} onClick={() => setAdminId(norm.id)}><span>{norm.number}</span><b>{norm.title}</b><StatusBadge value={norm.status} /></button>)}
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
            <p>Jméno a jednota se bezpečně převezmou z přihlášeného účtu.</p>
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
      {authMode && services?.auth && (
        <AuthDialog
          authMode={authMode}
          authService={services.auth}
          onAuthenticated={actions.authenticated}
          onClose={actions.closeLogin}
        />
      )}
      <Feedback feedback={feedback} />
    </main>
  );
}
