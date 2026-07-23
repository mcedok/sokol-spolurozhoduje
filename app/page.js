"use client";

import { useMemo, useState } from "react";

const sections = [
  { id: "uvod", no: "01", title: "Úvodní ustanovení", comments: 2, proposals: 1 },
  { id: "clenstvi", no: "02", title: "Členství a práva členů", comments: 8, proposals: 3 },
  { id: "organy", no: "03", title: "Orgány jednoty", comments: 4, proposals: 2 },
  { id: "hospodareni", no: "04", title: "Hospodaření", comments: 1, proposals: 0 },
  { id: "zaver", no: "05", title: "Závěrečná ustanovení", comments: 0, proposals: 1 },
];

const initialProposals = [
  {
    id: 1,
    section: "§ 4 odst. 2",
    title: "Doplnit možnost vzdálené účasti",
    text: "Člen má právo účastnit se schůze také prostřednictvím prostředků komunikace na dálku, umožňuje-li to povaha jednání.",
    author: "Jana K.",
    unit: "TJ Sokol Brno I",
    score: 28,
    status: "V posouzení",
    tone: "orange",
    comments: 6,
  },
  {
    id: 2,
    section: "§ 4 odst. 3",
    title: "Zpřesnit lhůtu pro vyřízení podnětu",
    text: "Navrhuji nahradit neurčitou formulaci konkrétní lhůtou 30 kalendářních dnů.",
    author: "Petr N.",
    unit: "Sokol Praha Vršovice",
    score: 17,
    status: "Zapracováno",
    tone: "green",
    comments: 3,
  },
  {
    id: 3,
    section: "§ 4 odst. 1",
    title: "Rozšířit výčet členských práv",
    text: "Doplnit právo na přístup k zápisům a rozhodnutím orgánů jednoty v elektronické podobě.",
    author: "Alena H.",
    unit: "TJ Sokol Olomouc",
    score: 11,
    status: "Nezapracováno",
    tone: "gray",
    comments: 9,
  },
];

const initialComments = [
  { id: 1, author: "Marek S.", time: "před 2 h", text: "Platí toto právo i pro členy mladší 18 let?", likes: 4 },
  { id: 2, author: "Eva T.", time: "včera", text: "Bylo by dobré odkázat na konkrétní článek stanov.", likes: 7 },
];

function Icon({ children }) {
  return <span className="icon" aria-hidden="true">{children}</span>;
}

export default function Home() {
  const [activeSection, setActiveSection] = useState("clenstvi");
  const [panel, setPanel] = useState("navrhy");
  const [proposals, setProposals] = useState(initialProposals);
  const [votes, setVotes] = useState({});
  const [needVote, setNeedVote] = useState(null);
  const [comments, setComments] = useState(initialComments);
  const [commentText, setCommentText] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [showProposal, setShowProposal] = useState(false);
  const [toast, setToast] = useState("");
  const [mobileTab, setMobileTab] = useState("dokument");

  const active = useMemo(() => sections.find((s) => s.id === activeSection), [activeSection]);

  function flash(message) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }

  function voteProposal(id, direction) {
    setProposals((items) => items.map((item) => {
      if (item.id !== id) return item;
      const previous = votes[id] || 0;
      return { ...item, score: item.score - previous + direction };
    }));
    setVotes((current) => ({ ...current, [id]: direction }));
  }

  function addComment(event) {
    event.preventDefault();
    if (!commentText.trim()) return;
    setComments((items) => [
      ...items,
      { id: Date.now(), author: "Vy", time: "právě teď", text: commentText.trim(), likes: 0 },
    ]);
    setCommentText("");
    flash("Komentář byl přidán do ukázky.");
  }

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <div className="brandmark" aria-hidden="true"><span>S</span></div>
          <div>
            <strong>SOKOL</strong>
            <small>spolurozhoduje</small>
          </div>
        </div>
        <nav className="mainnav" aria-label="Hlavní navigace">
          <button className="active">Dokumenty</button>
          <button onClick={() => flash("Přehled procesů bude součástí další verze.")}>Rozhodování</button>
          <button onClick={() => flash("Otevírá se metodika participace.")}>Jak to funguje</button>
        </nav>
        <div className="headerActions">
          <button className="uploadButton" onClick={() => setShowUpload(true)}><Icon>＋</Icon> Nahrát dokument</button>
          <button className="avatar" title="Profil">MK</button>
        </div>
      </header>

      <section className="processHeader">
        <div className="backline"><span>Dokumenty</span><b>›</b><span>Vnitřní předpisy</span></div>
        <div className="processTitleRow">
          <div>
            <div className="eyebrow"><span className="liveDot" /> Připomínkování probíhá</div>
            <h1>Návrh členského a organizačního řádu</h1>
            <p>Verze 2.1 · zveřejněno 12. června 2026</p>
          </div>
          <div className="deadline">
            <small>Zbývá</small>
            <strong>12 dní</strong>
            <span>do 5. července 2026</span>
          </div>
        </div>
        <div className="phaseTrack" aria-label="Průběh procesu">
          <div className="phase done"><i>✓</i><span><b>1. Zveřejnění</b><small>12. 6.</small></span></div>
          <div className="phase current"><i>2</i><span><b>Připomínkování</b><small>právě probíhá</small></span></div>
          <div className="phase"><i>3</i><span><b>Vypořádání</b><small>od 6. 7.</small></span></div>
          <div className="phase"><i>4</i><span><b>Rozhodnutí</b><small>31. 8.</small></span></div>
        </div>
      </section>

      <div className="mobileSwitch">
        <button className={mobileTab === "obsah" ? "active" : ""} onClick={() => setMobileTab("obsah")}>Obsah</button>
        <button className={mobileTab === "dokument" ? "active" : ""} onClick={() => setMobileTab("dokument")}>Dokument</button>
        <button className={mobileTab === "diskuse" ? "active" : ""} onClick={() => setMobileTab("diskuse")}>Diskuse <span>8</span></button>
      </div>

      <div className="workspace">
        <aside className={`outline ${mobileTab === "obsah" ? "mobileVisible" : ""}`}>
          <div className="asideHead"><b>Obsah dokumentu</b><button title="Sbalit">‹</button></div>
          <div className="progressBox">
            <div><span>Přečteno</span><b>42 %</b></div>
            <div className="progress"><i /></div>
          </div>
          <div className="sectionList">
            {sections.map((section) => (
              <button
                key={section.id}
                className={activeSection === section.id ? "active" : ""}
                onClick={() => { setActiveSection(section.id); setMobileTab("dokument"); }}
              >
                <span className="sectionNo">{section.no}</span>
                <span className="sectionName">{section.title}<small>{section.comments} komentářů · {section.proposals} návrhy</small></span>
              </button>
            ))}
          </div>
          <div className="helpCard">
            <Icon>?</Icon>
            <div><b>Jak připomínkovat?</b><p>Označte odstavec nebo podejte konkrétní návrh úpravy.</p></div>
          </div>
        </aside>

        <article className={`document ${mobileTab === "dokument" ? "mobileVisible" : ""}`}>
          <div className="docToolbar">
            <button onClick={() => flash("Velikost textu byla upravena.")}>A<small>A</small></button>
            <button onClick={() => flash("Odkaz na tuto část je připraven ke sdílení.")}><Icon>↗</Icon> Sdílet část</button>
            <button><Icon>⌕</Icon> Hledat</button>
          </div>
          <div className="paper">
            <div className="paperLabel">ČÁST DRUHÁ</div>
            <h2>{active?.title}</h2>
            <div className="rule" />

            <section className="clause">
              <div className="clauseMeta"><b>§ 4</b><span>Práva člena</span></div>
              <div className="paragraph activeParagraph">
                <span className="paraNo">(1)</span>
                <p>Člen Sokola má právo účastnit se činnosti jednoty, být informován o jejím hospodaření a podílet se na rozhodování v rozsahu stanoveném tímto řádem.</p>
                <button className="annotationPin" onClick={() => { setPanel("komentare"); setMobileTab("diskuse"); }} aria-label="Zobrazit 5 komentářů">5</button>
              </div>
              <div className="paragraph">
                <span className="paraNo">(2)</span>
                <p>Člen může předkládat návrhy a podněty orgánům jednoty. Orgán, kterému byl podnět doručen, jej projedná a o výsledku člena vyrozumí.</p>
                <button className="annotationPin amber" onClick={() => { setPanel("navrhy"); setMobileTab("diskuse"); }} aria-label="Zobrazit 3 návrhy">3</button>
              </div>
              <div className="paragraph">
                <span className="paraNo">(3)</span>
                <p>Člen má právo nahlížet do zápisů z jednání orgánů jednoty, pokud tím nejsou dotčena práva třetích osob nebo povinnost mlčenlivosti.</p>
                <button className="addPin" onClick={() => { setPanel("komentare"); setMobileTab("diskuse"); }}>＋</button>
              </div>
            </section>

            <div className="needVote">
              <div className="needIcon">◎</div>
              <div><b>Je tato úprava potřebná?</b><p>Pomozte určit, zda má být tato část zařazena do finálního hlasování.</p></div>
              <div className="needButtons">
                <button className={needVote === "yes" ? "selected yes" : ""} onClick={() => setNeedVote("yes")}>Ano <span>{needVote === "yes" ? 73 : 72}%</span></button>
                <button className={needVote === "no" ? "selected no" : ""} onClick={() => setNeedVote("no")}>Ne <span>{needVote === "no" ? 29 : 28}%</span></button>
              </div>
            </div>

            <div className="outcomePreview">
              <span>Po ukončení připomínkování</span>
              <p>U každého návrhu uvidíte rozhodnutí, odůvodnění a vazbu na finální znění dokumentu.</p>
            </div>
          </div>
        </article>

        <aside className={`discussion ${mobileTab === "diskuse" ? "mobileVisible" : ""}`}>
          <div className="discussionTabs">
            <button className={panel === "navrhy" ? "active" : ""} onClick={() => setPanel("navrhy")}>Návrhy <span>3</span></button>
            <button className={panel === "komentare" ? "active" : ""} onClick={() => setPanel("komentare")}>Komentáře <span>{comments.length}</span></button>
          </div>

          {panel === "navrhy" ? (
            <>
              <div className="panelIntro">
                <div><b>Návrhy úprav</b><p>Řazeno podle podpory členů</p></div>
                <button className="primary" onClick={() => setShowProposal(true)}>＋ Nový návrh</button>
              </div>
              <div className="proposalList">
                {proposals.map((proposal) => (
                  <div className="proposalCard" key={proposal.id}>
                    <div className="proposalTop">
                      <span className={`status ${proposal.tone}`}>{proposal.status}</span>
                      <span className="sectionRef">{proposal.section}</span>
                    </div>
                    <h3>{proposal.title}</h3>
                    <p className="proposalText">{proposal.text}</p>
                    {proposal.status !== "V posouzení" && (
                      <div className={`resolution ${proposal.tone}`}>
                        <b>{proposal.status === "Zapracováno" ? "✓ Rozhodnutí předkladatele" : "— Odůvodnění"}</b>
                        <p>{proposal.status === "Zapracováno" ? "Přijato do verze 2.2; lhůta byla doplněna." : "Právo je již upraveno v § 11 stanov, duplicita není žádoucí."}</p>
                      </div>
                    )}
                    <div className="author"><span>{proposal.author.slice(0, 1)}</span><div><b>{proposal.author}</b><small>{proposal.unit}</small></div></div>
                    <div className="proposalFoot">
                      <div className="voteControl">
                        <button className={votes[proposal.id] === 1 ? "selected" : ""} onClick={() => voteProposal(proposal.id, 1)} aria-label="Podpořit">↑</button>
                        <b>{proposal.score}</b>
                        <button className={votes[proposal.id] === -1 ? "selected down" : ""} onClick={() => voteProposal(proposal.id, -1)} aria-label="Nepodpořit">↓</button>
                      </div>
                      <button className="commentsLink" onClick={() => setPanel("komentare")}>◯ {proposal.comments} reakcí</button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="commentsPanel">
              <div className="panelIntro">
                <div><b>K § 4 odst. 1</b><p>Věcná diskuse k vybrané části</p></div>
              </div>
              <form className="commentForm" onSubmit={addComment}>
                <textarea value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Přidejte věcný komentář…" />
                <div><small>{commentText.length}/500</small><button type="submit">Odeslat</button></div>
              </form>
              <div className="commentList">
                {comments.map((comment) => (
                  <div className="comment" key={comment.id}>
                    <div className="author"><span>{comment.author.slice(0, 1)}</span><div><b>{comment.author}</b><small>{comment.time}</small></div></div>
                    <p>{comment.text}</p>
                    <button onClick={() => flash("Reakce byla zaznamenána.")}>♡ Užitečné · {comment.likes}</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>

      {showUpload && (
        <div className="modalBackdrop" onClick={() => setShowUpload(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modalClose" onClick={() => setShowUpload(false)}>×</button>
            <div className="modalIcon">⇧</div>
            <h2>Nahrát dokument</h2>
            <p>Podporované formáty: DOCX, PDF a ODT. Strukturu kapitol a odstavců platforma připraví automaticky.</p>
            <label className="dropzone">
              <b>Přetáhněte soubor sem</b>
              <span>nebo klikněte pro výběr</span>
              <input type="file" accept=".pdf,.docx,.odt" onChange={() => { setShowUpload(false); flash("Dokument byl přijat ke zpracování."); }} />
            </label>
            <small className="privacy">Dokument bude dostupný jen registrovaným členům zvolené jednoty.</small>
          </div>
        </div>
      )}

      {showProposal && (
        <div className="modalBackdrop" onClick={() => setShowProposal(false)}>
          <form className="modal proposalModal" onSubmit={(e) => { e.preventDefault(); setShowProposal(false); flash("Návrh byl uložen jako koncept."); }}>
            <button type="button" className="modalClose" onClick={() => setShowProposal(false)}>×</button>
            <div className="eyebrow">NOVÝ NÁVRH · § 4 ODST. 2</div>
            <h2>Navrhněte konkrétní úpravu</h2>
            <label>Název návrhu<input required placeholder="Stručně pojmenujte změnu" /></label>
            <label>Navrhované znění<textarea required placeholder="Napište přesné nové znění…" /></label>
            <label>Odůvodnění<textarea required placeholder="Vysvětlete přínos nebo problém…" /></label>
            <div className="modalActions"><button type="button" onClick={() => setShowProposal(false)}>Zrušit</button><button className="primary" type="submit">Uložit koncept</button></div>
          </form>
        </div>
      )}

      {toast && <div className="toast">✓ {toast}</div>}
    </main>
  );
}
