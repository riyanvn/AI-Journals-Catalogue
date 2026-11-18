/* AI and Law in India: Research Repository. Static site; all search runs in the browser. */
(function () {
  "use strict";
  const E = window.SearchEngine;
  const SETTINGS = Object.assign({}, E.DEFAULTS);           // the tuned word-search settings
  const TIERS = ["A1", "A2", "B", "C", "D", "P"];
  const TIERVAR = { A1: "--t-a1", A2: "--t-a2", B: "--t-b", C: "--t-c", D: "--t-d", P: "--t-p" };
  const TIERNAME = { A1: "Indexed journal, top half", A2: "Indexed journal, lower half", B: "Established peer-reviewed",
    C: "Review unclear or student-run", D: "Low reliability", P: "Preprint, not peer reviewed" };
  const TIERSHORT = { A1: "Top indexed journal", A2: "Indexed journal", B: "Peer-reviewed journal", C: "Review unclear", D: "Low reliability", P: "Preprint" };
  const BARS = { A1: 5, A2: 4, B: 3, C: 2, P: 2, D: 1 };
  const SUGGEST = ["deepfakes", "copyright and generative AI", "facial recognition", "AI in courts", "data protection", "algorithmic bias", "competition law"];
  const PAGE = 25;

  let papers = [], journals = [], meta = {}, index = null;
  const byId = new Map(), jById = new Map(), authors = new Map();
  const state = { q: "", tiers: new Set(), journals: new Set(), yFrom: null, yTo: null, sort: "auto", limit: PAGE, jFilter: "" };

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tierStyle = (t) => `--tier:var(${TIERVAR[t] || "--t-p"})`;
  const framed = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();

  // ---------------------------------------------------------------- helpers
  function meter(t) {
    const n = BARS[t] || 0;
    return `<span class="meter" aria-hidden="true">${[1, 2, 3, 4, 5].map((i) => `<i${i <= n ? ' class="on"' : ""}></i>`).join("")}</span>`;
  }
  function badge(t, long) {
    // Reliability shown as a signal meter plus a plain label; the tier code sits in the tooltip.
    const label = long === "full" ? TIERNAME[t] : TIERSHORT[t];
    return `<span class="rely" style="${tierStyle(t)}" title="Tier ${t}: ${esc(TIERNAME[t] || "")}">${meter(t)}${long === false ? "" : esc(label || "")}</span>`;
  }
  function paperLink(p) { return p.link || (p.doi ? "https://doi.org/" + p.doi : ""); }
  function authorLinks(p, max) {
    const list = p.authors.map((a) => `<a href="#author-${esc(a.author_id)}">${esc(a.name_as_printed)}</a>`);
    if (max && list.length > max) return list.slice(0, max - 1).join(", ") + ` and ${list.length - max + 1} others`;
    return list.length > 1 ? list.slice(0, -1).join(", ") + " and " + list.at(-1) : list.join("");
  }
  function citeLine(p) {
    const bits = [`<i>${esc(p.journal)}</i>`];
    if (p.volume_issue) bits.push(esc(p.volume_issue));
    if (p.pages) bits.push("pp. " + esc(p.pages));
    bits.push(esc(p.publication_date || ""));
    return bits.filter(Boolean).join(", ");
  }
  function highlighter(concepts) {
    const words = new Set();
    for (const c of concepts || []) if (!c.excluded) for (const v of c.all || c.variants) for (const t of v.seq) words.add(t);
    return function (text, maxLen) {
      let t = text || "";
      if (maxLen && t.length > maxLen) {
        let pos = 0, at = -1;
        for (const w of t.split(/(\s+)/)) { const s = E.tokens(w).seq[0]; if (s && words.has(s)) { at = pos; break; } pos += w.length; }
        const start = Math.max(0, Math.min(at < 0 ? 0 : at - 90, t.length - maxLen));
        t = (start > 0 ? "…" : "") + t.slice(start, start + maxLen).trim() + (start + maxLen < t.length ? "…" : "");
      }
      if (!words.size) return esc(t);
      return t.split(/(\s+)/).map((w) => {
        if (!E.tokens(w.replace(/-/g, " ")).seq.some((x) => words.has(x))) return esc(w);
        const m = w.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);   // keep surrounding punctuation outside the highlight
        return esc(m[1]) + "<mark>" + esc(m[2]) + "</mark>" + esc(m[3]);
      }).join("");
    };
  }

  // ---------------------------------------------------------------- citations and export
  function surname(n) { const parts = n.replace(/\./g, ". ").trim().split(/\s+/); return parts.at(-1).replace(/[^A-Za-zÀ-ɏ-]/g, ""); }
  function bibkey(p) { return (surname(p.authors[0]?.name_as_printed || "anon") + (p.year || "") + (p.title.match(/[A-Za-z]{4,}/) || ["paper"])[0]).toLowerCase(); }
  function volIssue(p) {
    const v = (p.volume_issue || "").match(/vol\.?\s*([\w-]+)/i), i = (p.volume_issue || "").match(/(?:issue|no\.?)\s*([\w-]+)/i);
    return { vol: v ? v[1] : "", issue: i ? i[1] : "" };
  }
  function citePlain(p) {
    const names = p.authors.map((a) => a.name_as_printed);
    const au = names.length > 3 ? names[0] + " et al." : names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names.at(-1) : names[0] || "";
    const vi = p.volume_issue ? " " + p.volume_issue + "," : "";
    return `${au}, "${p.title}",${vi} ${p.journal}${p.pages ? ", pp. " + p.pages : ""} (${p.publication_date || p.year || "n.d."})${p.doi ? ", https://doi.org/" + p.doi : p.link ? ", " + p.link : ""}.`;
  }
  function citeBib(p) {
    const { vol, issue } = volIssue(p);
    const f = [["title", p.title], ["author", p.authors.map((a) => a.name_as_printed).join(" and ")], ["journal", p.journal], ["year", p.year],
      ["volume", vol], ["number", issue], ["pages", (p.pages || "").replace("-", "--")], ["doi", p.doi], ["url", p.link]];
    return `@article{${bibkey(p)},\n` + f.filter(([, v]) => v).map(([k, v]) => `  ${k} = {${String(v).replace(/[{}]/g, "")}}`).join(",\n") + "\n}";
  }
  function citeRis(p) {
    const { vol, issue } = volIssue(p);
    const [sp, ep] = (p.pages || "").split(/[-–]/);
    const L = ["TY  - JOUR", "TI  - " + p.title, ...p.authors.map((a) => "AU  - " + a.name_as_printed), "T2  - " + p.journal,
      p.year ? "PY  - " + p.year : "", vol ? "VL  - " + vol : "", issue ? "IS  - " + issue : "", sp ? "SP  - " + sp : "", ep ? "EP  - " + ep : "",
      p.doi ? "DO  - " + p.doi : "", p.link ? "UR  - " + p.link : "", ...(p.keywords || []).map((k) => "KW  - " + k), p.abstract ? "AB  - " + p.abstract : "", "ER  - "];
    return L.filter(Boolean).join("\n");
  }
  function csv(list) {
    const cols = ["id", "title", "authors", "journal", "tier", "publication_date", "volume_issue", "pages", "doi", "link", "keywords", "abstract"];
    const cell = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    return [cols.join(",")].concat(list.map((p) => cols.map((c) => cell(c === "authors" ? p.authors.map((a) => a.name_as_printed).join("; ") : c === "keywords" ? (p.keywords || []).join("; ") : p[c])).join(","))).join("\n");
  }
  function exportText(title, text, filename, mime) {
    // Download where the browser allows it; inside an embedded preview, show the text to copy instead.
    if (!framed && filename) {
      try {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([text], { type: mime || "text/plain" }));
        a.download = filename; document.body.appendChild(a); a.click(); a.remove();
        return;
      } catch (e) { /* fall through to the copy dialog */ }
    }
    $("#copyTitle").textContent = title; $("#copyText").value = text; $("#copyMsg").textContent = "";
    $("#copyDialog").showModal();
  }
  $("#copyBtn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#copyText").value); $("#copyMsg").textContent = "Copied."; }
    catch (e) { $("#copyText").select(); $("#copyMsg").textContent = "Press Ctrl+C or Cmd+C to copy."; }
  });
  $("#closeBtn").addEventListener("click", () => $("#copyDialog").close());

  // ---------------------------------------------------------------- search
  function runSearch() {
    const q = state.q.trim();
    const { results, concepts } = E.search(index, q, SETTINGS, null);
    let base = q ? results.filter((r) => r.pct >= SETTINGS.cutoff) : results;
    const yearOk = (p) => (!state.yFrom || (p.year && p.year >= state.yFrom)) && (!state.yTo || (p.year && p.year <= state.yTo));
    const tierOk = (p) => !state.tiers.size || state.tiers.has(p.tier);
    const jOk = (p) => !state.journals.size || state.journals.has(p.journal_id);
    const tierCounts = {}, jCounts = {};
    for (const r of base) {
      const p = r.p.ref;
      if (yearOk(p) && jOk(p)) tierCounts[p.tier] = (tierCounts[p.tier] || 0) + 1;
      if (yearOk(p) && tierOk(p)) jCounts[p.journal_id] = (jCounts[p.journal_id] || 0) + 1;
    }
    let list = base.filter((r) => yearOk(r.p.ref) && tierOk(r.p.ref) && jOk(r.p.ref));
    const sort = state.sort === "auto" ? (q ? "rel" : "new") : state.sort;
    if (sort === "new") list = list.slice().sort((a, b) => (b.p.ds || "").localeCompare(a.p.ds || "") || b.score - a.score);
    if (sort === "old") list = list.slice().sort((a, b) => (a.p.ds || "").localeCompare(b.p.ds || "") || b.score - a.score);
    if (sort === "tier") list = list.slice().sort((a, b) => TIERS.indexOf(a.p.tier) - TIERS.indexOf(b.p.tier) || b.score - a.score);
    return { list, concepts, tierCounts, jCounts, sort, q };
  }

  function syncUrl() {
    if (framed) return;                       // an embedded preview cannot carry query strings
    try {
      const u = new URL(location.href);
      state.q ? u.searchParams.set("q", state.q) : u.searchParams.delete("q");
      history.replaceState(null, "", u.pathname + (u.search ? u.search : "") + location.hash);
    } catch (e) { /* ignore */ }
  }

  function searchView() {
    const yrs = papers.map((p) => p.year).filter(Boolean);
    const minY = Math.min(...yrs), maxY = Math.max(...yrs);
    const total = papers.length;
    const tierTotals = {};
    for (const p of papers) tierTotals[p.tier] = (tierTotals[p.tier] || 0) + 1;
    $("#view").innerHTML = `
      <section class="hero${state.q ? " compact" : ""}" id="hero">
        <h1>Find Indian scholarship on AI and law, and know how far to trust it.</h1>
        <p class="lede">${total} papers from ${journals.length} journals and repositories, ${minY} to ${maxY}. Every paper shows how reliable its journal is, so you can tell a peer-reviewed article from a preprint before you rely on it.</p>
        <form class="searchbox" id="searchForm" role="search">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input type="search" id="q" placeholder="Try a topic, a statute or an author" aria-label="Search the repository" autocomplete="off" value="${esc(state.q)}">
          <button class="btn primary" type="submit">Search</button>
        </form>
        <div class="try"><span>Try</span>${SUGGEST.map((x) => `<button class="chip" type="button" data-suggest="${esc(x)}">${esc(x)}</button>`).join("")}</div>
        <details class="tips"><summary>Search tips</summary><ul>
          <li><code>"facial recognition"</code> finds the exact phrase, and <code>deepfake -election</code> leaves out a word.</li>
          <li><code>author:Ghosh</code>, <code>title:copyright</code>, <code>keywords:privacy</code> and <code>journal:"Indian Law Review"</code> search one field.</li>
          <li>Abbreviations such as DPDP, IPR, ODR and LLM, and spelling variants such as judgement, are understood.</li></ul></details>
      </section>
      <div class="layout">
        <aside class="rail" id="rail" aria-label="Filters">
          <div class="facet"><h3>Journal reliability</h3><div id="fTiers"></div></div>
          <div class="facet"><h3>Year</h3><div class="years"><input type="number" id="yFrom" placeholder="${minY}" aria-label="From year" value="${state.yFrom || ""}"> to <input type="number" id="yTo" placeholder="${maxY}" aria-label="To year" value="${state.yTo || ""}"></div></div>
          <div class="facet"><h3>Journal</h3><input type="search" id="jFilter" placeholder="Find a journal" aria-label="Find a journal" value="${esc(state.jFilter)}"><div class="jlist" id="fJournals"></div></div>
          <p class="note"><a href="#about">How reliability is rated</a></p>
        </aside>
        <section aria-label="Results">
          <div class="resultshead">
            <div class="n" id="count"></div>
            <div class="tools">
              <button class="btn filtertoggle" type="button" id="filterToggle" aria-expanded="false" aria-controls="rail">Filters</button>
              <select id="sort" aria-label="Sort results">
                <option value="auto">Best match</option><option value="new">Newest first</option><option value="old">Oldest first</option><option value="tier">Most reliable first</option>
              </select>
              <details class="menu" id="exportMenu"><summary class="btn">Export</summary><div class="items">
                <button type="button" data-export="csv">Spreadsheet (CSV)<small>Opens in Excel or Google Sheets</small></button>
                <button type="button" data-export="bib">BibTeX<small>For LaTeX and Zotero</small></button>
                <button type="button" data-export="ris">RIS<small>For Zotero, Mendeley and EndNote</small></button>
              </div></details>
            </div>
          </div>
          <div class="active" id="activeFilters"></div>
          <ol class="entries" id="entries"></ol>
          <div id="moreWrap"></div>
        </section>
      </div>`;
    $("#sort").value = state.sort;
    syncUrl();
    let timer = null;
    $("#q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { state.q = $("#q").value; state.limit = PAGE; refresh(); syncUrl(); }, 140); });
    $("#searchForm").addEventListener("submit", (e) => { e.preventDefault(); state.q = $("#q").value; state.limit = PAGE; refresh(); syncUrl(); });
    $("#hero").addEventListener("click", (e) => { const b = e.target.closest("[data-suggest]"); if (!b) return; $("#q").value = state.q = b.dataset.suggest; state.limit = PAGE; refresh(); syncUrl(); });
    $("#sort").addEventListener("change", () => { state.sort = $("#sort").value; refresh(); });
    for (const id of ["yFrom", "yTo"]) $("#" + id).addEventListener("input", () => { state.yFrom = Number($("#yFrom").value) || null; state.yTo = Number($("#yTo").value) || null; state.limit = PAGE; refresh(); });
    $("#jFilter").addEventListener("input", () => { state.jFilter = $("#jFilter").value; refresh(); });
    $("#filterToggle").addEventListener("click", () => { const r = $("#rail"); r.classList.toggle("open"); $("#filterToggle").setAttribute("aria-expanded", r.classList.contains("open")); });
    $("#rail").addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.tier) toggle(state.tiers, t.dataset.tier);
      if (t.dataset.journal) toggle(state.journals, t.dataset.journal);
    });
    $("#activeFilters").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.rmTier) state.tiers.delete(b.dataset.rmTier);
      if (b.dataset.rmJournal) state.journals.delete(b.dataset.rmJournal);
      if (b.dataset.rmYears) { state.yFrom = state.yTo = null; $("#yFrom").value = $("#yTo").value = ""; }
      if (b.dataset.clear !== undefined) { state.tiers.clear(); state.journals.clear(); state.yFrom = state.yTo = null; $("#yFrom").value = $("#yTo").value = ""; }
      refresh();
    });
    document.querySelector(".tools").addEventListener("click", (e) => {
      const b = e.target.closest("[data-export]"); if (!b) return;
      $("#exportMenu").open = false;
      const list = runSearch().list.map((r) => r.p.ref);
      const stamp = new Date().toISOString().slice(0, 10);
      if (b.dataset.export === "csv") exportText(`${list.length} results as CSV`, csv(list), `ai-law-india-${stamp}.csv`, "text/csv");
      if (b.dataset.export === "bib") exportText(`${list.length} results as BibTeX`, list.map(citeBib).join("\n\n"), `ai-law-india-${stamp}.bib`, "application/x-bibtex");
      if (b.dataset.export === "ris") exportText(`${list.length} results as RIS`, list.map(citeRis).join("\n\n"), `ai-law-india-${stamp}.ris`, "application/x-research-info-systems");
    });
    refresh();
  }
  document.addEventListener("click", (e) => { const m = $("#exportMenu"); if (m && m.open && !m.contains(e.target)) m.open = false; });
  function toggle(set, v) { set.has(v) ? set.delete(v) : set.add(v); state.limit = PAGE; refresh(); }

  function entryHtml(r, hl, showRel) {
    const p = r.p.ref;
    const url = paperLink(p);
    const when = p.year || (p.publication_date || "").slice(0, 4);
    return `<li class="entry" style="${tierStyle(p.tier)}">
      <div class="top">${badge(p.tier)}${showRel ? `<span class="match" title="Relevance compared with the best match">${Math.round(r.pct)}% match</span>` : ""}</div>
      <h2><a href="#${p.id}">${hl(p.title)}</a></h2>
      <div class="meta">${authorLinks(p, 3)}${p.authors.length ? ", in " : "In "}<i>${esc(p.journal)}</i>${when ? ", " + esc(when) : ""}</div>
      ${p.abstract ? `<p class="snippet">${hl(p.abstract, 260)}</p>` : ""}
      <div class="actions">${url ? `<a class="golink" href="${esc(url)}" target="_blank" rel="noopener">Link to paper <span aria-hidden="true">↗</span></a>` : ""}<a class="quiet" href="#${p.id}">Abstract and details</a></div>
    </li>`;
  }
  function entryClicks(e) {
    const k = e.target.closest("[data-kw]");
    if (k) {
      state.q = '"' + k.dataset.kw + '"'; state.limit = PAGE;
      if (location.hash && location.hash !== "#search") location.hash = "#search";
      else { $("#q").value = state.q; refresh(); syncUrl(); $("#q").scrollIntoView({ block: "center" }); }
      return;
    }
  }

  function refresh() {
    const res = runSearch();
    const hl = highlighter(res.concepts);
    // tier facet and bar
    $("#hero").classList.toggle("compact", !!res.q);
    $("#fTiers").innerHTML = TIERS.map((t) => `<label class="row${res.tierCounts[t] ? "" : " zero"}"><input type="checkbox" data-tier="${t}" ${state.tiers.has(t) ? "checked" : ""}><span>${badge(t)}</span><span class="count">${res.tierCounts[t] || 0}</span></label>`).join("");
    // journal facet (journals with results first)
    const f = state.jFilter.trim().toLowerCase();
    const js = journals.filter((j) => !f || j.name.toLowerCase().includes(f))
      .sort((a, b) => (res.jCounts[b.journal_id] || 0) - (res.jCounts[a.journal_id] || 0) || a.name.localeCompare(b.name));
    $("#fJournals").innerHTML = js.map((j) => `<label class="row${res.jCounts[j.journal_id] ? "" : " zero"}"><input type="checkbox" data-journal="${esc(j.journal_id)}" ${state.journals.has(j.journal_id) ? "checked" : ""}><span style="display:flex;gap:7px;align-items:flex-start"><span style="${tierStyle(j.tier)};margin-top:3px" title="${esc(TIERSHORT[j.tier])}">${meter(j.tier)}</span><span>${esc(j.name)}</span></span><span class="count">${res.jCounts[j.journal_id] || 0}</span></label>`).join("") || `<p class="note">No journal matches “${esc(state.jFilter)}”.</p>`;
    // active filters
    const pills = [...state.tiers].map((t) => `<button class="pill" type="button" data-rm-tier="${t}">${esc(TIERSHORT[t])} ×</button>`)
      .concat([...state.journals].map((id) => `<button class="pill" type="button" data-rm-journal="${esc(id)}">${esc(jById.get(id)?.name || id)} ×</button>`));
    if (state.yFrom || state.yTo) pills.push(`<button class="pill" type="button" data-rm-years="1">${state.yFrom || "…"} to ${state.yTo || "…"} ×</button>`);
    if (pills.length > 1) pills.push(`<button class="pill" type="button" data-clear>Clear all</button>`);
    $("#activeFilters").innerHTML = pills.join("");
    // results
    const n = res.list.length;
    $("#count").innerHTML = (res.q ? `<b>${n}</b> ${n === 1 ? "paper" : "papers"} for “${esc(res.q)}”` : `<b>${n}</b> papers${pills.length ? " with these filters" : ""}, newest first`) +
      (res.q && res.sort === "rel" && n > 1 ? `<div class="note">Close matches are listed with the more reliable journal first.</div>` : "");
    const showRel = !!res.q && res.sort === "rel";
    $("#entries").innerHTML = res.list.slice(0, state.limit).map((r) => entryHtml(r, hl, showRel)).join("") ||
      `<li class="empty">No papers match. Check the spelling, try fewer or broader words, or remove a filter.${state.tiers.size || state.journals.size || state.yFrom || state.yTo ? ' <button class="btn" type="button" data-clear-all>Clear filters</button>' : ""}</li>`;
    const ca = $("#entries [data-clear-all]");
    if (ca) ca.addEventListener("click", () => { state.tiers.clear(); state.journals.clear(); state.yFrom = state.yTo = null; searchView(); });
    $("#moreWrap").innerHTML = n > state.limit ? `<button class="btn more" type="button" id="more">Show ${Math.min(PAGE, n - state.limit)} more of ${n - state.limit} remaining</button>` : "";
    const more = $("#more");
    if (more) more.addEventListener("click", () => { state.limit += PAGE; refresh(); });
  }

  // ---------------------------------------------------------------- detail pages
  function paperView(p) {
    const j = jById.get(p.journal_id) || {};
    const sameAuthor = new Set(p.authors.map((a) => a.author_id));
    const others = papers.filter((x) => x.id !== p.id && x.authors.some((a) => sameAuthor.has(a.author_id))).slice(0, 6);
    const hl = highlighter([]);
    const url = paperLink(p);
    $("#view").innerHTML = `<article class="page" style="${tierStyle(p.tier)}">
      <div class="crumbs"><a href="#search">Search</a> / <a href="#journal-${esc(p.journal_id)}">${esc(p.journal)}</a></div>
      <h1>${esc(p.title)}</h1>
      <div class="meta" style="font-size:16px">${authorLinks(p)}${p.authors.length ? ", in " : "In "}<a href="#journal-${esc(p.journal_id)}"><i>${esc(p.journal)}</i></a>${p.publication_date ? ", " + esc(p.publication_date) : ""}</div>
      <div class="lead">${url ? `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">Link to paper <span aria-hidden="true">↗</span></a>` : `<span class="note">No public link recorded for this paper.</span>`}${badge(p.tier)}</div>
      <section class="panel"><h3>Abstract</h3><p class="abstract">${esc(p.abstract || "No abstract available.")}</p>
        ${(p.keywords || []).length ? `<div class="kw" id="pkw">${p.keywords.map((k) => `<button class="chip" type="button" data-kw="${esc(k)}" title="Search for this keyword">${esc(k)}</button>`).join("")}</div>` : `<p class="note">The authors did not supply keywords.</p>`}
      </section>
      <section class="panel" style="${tierStyle(p.tier)}">
        <h3>Where it was published</h3>
        <div>${badge(p.tier, "full")}</div>
        <dl class="facts">
          <dt>Journal</dt><dd><a href="#journal-${esc(p.journal_id)}">${esc(p.journal)}</a></dd>
          ${j.tier_basis ? `<dt>Why this rating</dt><dd>${esc(j.tier_basis)}</dd>` : ""}
          <dt>Published</dt><dd>${esc(p.publication_date || "Not stated")}</dd>
          ${p.volume_issue ? `<dt>Volume and issue</dt><dd>${esc(p.volume_issue)}</dd>` : ""}
          ${p.pages ? `<dt>Pages</dt><dd>${esc(p.pages)}</dd>` : ""}
          ${p.doi ? `<dt>DOI</dt><dd>${esc(p.doi)}</dd>` : ""}
          <dt>Repository ID</dt><dd>${p.id}</dd>
        </dl>
      </section>
      <section class="panel"><h3>Authors</h3><ul class="authors">${p.authors.map((a) => `<li><a href="#author-${esc(a.author_id)}">${esc(a.name_as_printed)}</a>${[a.designation, a.institution, a.location].filter(Boolean).length ? ", " + esc([a.designation, a.institution, a.location].filter(Boolean).join(", ")) : ""}</li>`).join("")}</ul>
        <p class="note">Affiliations as printed in this paper.</p></section>
      <details class="panel cites"><summary>Cite this paper</summary><div class="body">
        <p class="note" style="margin:0">Built from the details above. Check them against the published version before you rely on them.</p>
        ${[["Citation", citePlain(p)], ["BibTeX", citeBib(p)], ["RIS", citeRis(p)]].map(([lab, txt], i) => `<div><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:14.5px">${lab}</b><button class="btn" type="button" data-copy="${i}">Copy</button></div><pre id="cite${i}">${esc(txt)}</pre></div>`).join("")}
        <span class="ok" id="citeMsg" role="status"></span></div>
      </details>
      ${others.length ? `<section><h2 class="section-title">More by these authors</h2><ol class="entries">${others.map((x) => entryHtml({ p: { ref: x } }, hl, false)).join("")}</ol></section>` : ""}
    </article>`;
  }
  async function detailClicks(e) {
    const c = e.target.closest("[data-copy]");
    if (c) {
      const txt = $("#cite" + c.dataset.copy).textContent;
      try { await navigator.clipboard.writeText(txt); $("#citeMsg").textContent = "Copied."; }
      catch (err) { const r = document.createRange(); r.selectNodeContents($("#cite" + c.dataset.copy)); const s = getSelection(); s.removeAllRanges(); s.addRange(r); $("#citeMsg").textContent = "Selected: press Ctrl+C or Cmd+C to copy."; }
      return;
    }
    entryClicks(e);
  }

  function linkify(text) { return esc(text).replace(/https?:\/\/[^\s;,)]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`); }

  function journalView(j) {
    const list = papers.filter((p) => p.journal_id === j.journal_id).sort((a, b) => (b.date_sort || "").localeCompare(a.date_sort || ""));
    const hl = highlighter([]);
    const fact = (k, v) => (v ? `<dt>${k}</dt><dd>${linkify(v)}</dd>` : "");
    $("#view").innerHTML = `<article class="page">
      <div class="crumbs"><a href="#journals">Journals</a></div>
      <h1>${esc(j.name)}</h1>
      <div class="panel" style="${tierStyle(j.tier)}"><h3>Reliability rating</h3><div>${badge(j.tier, "full")}</div>
        <dl class="facts">${fact("Why this rating", j.tier_basis)}${fact("Publisher", j.publisher)}${fact("Scopus", j.scopus)}${fact("Web of Science", j.web_of_science)}${fact("Peer review", j.peer_review)}${fact("Publication fee", j.publication_fee)}${fact("Sources checked", j.tier_sources)}${fact("Last verified", j.last_verified)}</dl>
      </div>
      <section><h2 class="section-title">${list.length} ${list.length === 1 ? "paper" : "papers"} in the repository</h2><ol class="entries">${list.map((p) => entryHtml({ p: { ref: p } }, hl, false)).join("")}</ol></section>
    </article>`;
  }

  function authorView(a) {
    const list = a.papers.slice().sort((x, y) => (y.date_sort || "").localeCompare(x.date_sort || ""));
    const affs = [];
    for (const p of list) for (const x of p.authors) if (x.author_id === a.id) { const s = [x.designation, x.institution, x.location].filter(Boolean).join(", "); if (s && !affs.some((y) => y.s === s)) affs.push({ s, year: p.year }); }
    const hl = highlighter([]);
    $("#view").innerHTML = `<article class="page">
      <div class="crumbs"><a href="#authors">Authors</a></div>
      <h1>${esc(a.name)}</h1>
      ${affs.length ? `<div class="panel"><h3>Affiliations, as printed in their papers</h3><ul class="authors">${affs.map((x) => `<li>${esc(x.s)}${x.year ? ` <span class="note">(${x.year})</span>` : ""}</li>`).join("")}</ul></div>` : ""}
      <section><h2 class="section-title">${list.length} ${list.length === 1 ? "paper" : "papers"}</h2><ol class="entries">${list.map((p) => entryHtml({ p: { ref: p } }, hl, false)).join("")}</ol></section>
    </article>`;
  }

  function journalsView() {
    $("#view").innerHTML = `<section class="page" style="max-width:1000px">
      <h1>Journals and their ratings</h1>
      <p class="prose">Each journal is rated once, from checked facts: indexing in Scopus or Web of Science and its quartile, stated peer review, the publisher, and publication fees. Open a journal to see the evidence. <a href="#about">How the tiers work</a>.</p>
      <input type="search" id="jSearch" placeholder="Find a journal" aria-label="Find a journal" class="finder">
      <div id="jTables"></div></section>`;
    const draw = () => {
      const f = $("#jSearch").value.trim().toLowerCase();
      $("#jTables").innerHTML = TIERS.map((t) => {
        const js = journals.filter((j) => j.tier === t && (!f || j.name.toLowerCase().includes(f) || (j.publisher || "").toLowerCase().includes(f))).sort((a, b) => b.paper_count - a.paper_count || a.name.localeCompare(b.name));
        if (!js.length) return "";
        return `<h2 style="font-size:20px;margin:26px 0 10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span style="${tierStyle(t)}">${meter(t)}</span>${esc(TIERNAME[t])} <span class="note" style="font-family:var(--font-body);font-weight:400">${js.length} journals</span></h2>
          <div class="scroll"><table class="list"><thead><tr><th>Journal</th><th>Publisher</th><th class="num">Papers</th></tr></thead><tbody>
          ${js.map((j) => `<tr><td><a href="#journal-${esc(j.journal_id)}">${esc(j.name)}</a></td><td>${esc(j.publisher || "")}</td><td class="num">${j.paper_count}</td></tr>`).join("")}</tbody></table></div>`;
      }).join("") || `<p class="empty">No journal matches.</p>`;
    };
    $("#jSearch").addEventListener("input", draw); draw();
  }

  function authorsView() {
    const list = [...authors.values()].sort((a, b) => a.name.localeCompare(b.name));
    $("#view").innerHTML = `<section class="page" style="max-width:1000px">
      <h1>Authors</h1>
      <p class="prose">${list.length} authors. Each author's institution is recorded as printed in each paper, so the record stays accurate when people move.</p>
      <input type="search" id="aSearch" placeholder="Find an author or institution" aria-label="Find an author or institution" class="finder">
      <div class="scroll"><table class="list"><thead><tr><th>Author</th><th>Latest affiliation</th><th class="num">Papers</th></tr></thead><tbody id="aRows"></tbody></table></div></section>`;
    const draw = () => {
      const f = $("#aSearch").value.trim().toLowerCase();
      const hits = list.filter((a) => !f || a.name.toLowerCase().includes(f) || a.latest.toLowerCase().includes(f));
      $("#aRows").innerHTML = hits.slice(0, 400)
        .map((a) => `<tr><td><a href="#author-${esc(a.id)}">${esc(a.name)}</a></td><td>${esc(a.latest)}</td><td class="num">${a.papers.length}</td></tr>`).join("") +
        (hits.length > 400 ? `<tr><td colspan="3" class="note">Showing 400 of ${hits.length}. Type a name to narrow the list.</td></tr>` : "");
    };
    $("#aSearch").addEventListener("input", draw); draw();
  }

  function aboutView() {
    const tierRows = (meta.tiers || []).map((t) => `<tr style="${tierStyle(t.tier)}"><td>${badge(t.tier, false)} ${t.tier}</td><td><b>${esc(TIERNAME[t.tier])}</b><br><span class="note">${esc(t.criteria)}</span></td><td class="num">${papers.filter((p) => p.tier === t.tier).length}</td></tr>`).join("");
    $("#view").innerHTML = `<article class="page prose">
      <h1>About the repository</h1>
      <p>This repository collects academic writing on artificial intelligence and law with an Indian connection: journal articles, book chapters, working papers and preprints that treat AI, machine learning or algorithmic decision-making as a real subject, and Indian law, institutions or context as part of the analysis.</p>
      <p>Each paper carries a reliability meter. Five bars means an indexed journal in the top half of its field; one bar means a journal with signs of low reliability. Hover over a meter to see the exact tier.</p>
      <p>Each entry records the paper's title, every author with the affiliation printed in the paper, the publication details, the official abstract, the authors' own keywords, and a stable link. Nothing is summarised or rewritten: abstracts are copied word for word from the paper or the publisher.</p>
      <h2>How journals are rated</h2>
      <p>The rating describes the venue, not the individual paper. Each journal is assessed once from checked facts, with the evidence shown on its page. Where the facts point both ways, the lower tier is given.</p>
      <div class="scroll"><table class="list"><thead><tr><th>Tier</th><th>Meaning and criteria</th><th class="num">Papers</th></tr></thead><tbody>${tierRows}</tbody></table></div>
      <p class="note">The rating is shown on every result so readers can decide how much weight a paper can bear. In search it only breaks close calls between papers of similar relevance (see below).</p>
      <h2>How search works</h2>
      <p>Search looks at titles, author keywords, author names and abstracts, in that order of weight. Words that appear in nearly every paper (such as "India" or "artificial intelligence") count for little, so the distinctive words in a search decide the ranking. Plural and verb forms match ("regulate" finds "regulation" and "regulatory"), common abbreviations and spelling variants are linked (DPDP and data protection, IPR and intellectual property, judgment and judgement), and misspelt words are corrected where the intended word is clear.</p>
      <ul>
        <li><code>"facial recognition"</code> finds the exact phrase.</li>
        <li><code>deepfake -election</code> leaves out papers that mention elections.</li>
        <li><code>author:Ghosh</code>, <code>title:copyright</code>, <code>keywords:privacy</code> and <code>journal:"Indian Law Review"</code> search one field.</li>
        <li>Statutory references such as <code>Section 3(k)</code> and <code>Article 21</code> are matched as written.</li>
      </ul>
      <p>Journal reliability does not change a paper's match score. It decides close calls: when two papers are within ${SETTINGS.tierTieWindow} points of each other, the one from the more reliable journal is listed first (A1, A2 and B count as one level, then C and preprints, then D).</p>
      <p>Search quality was tuned and tested against 183 judged searches, including 150 written independently of the repository.</p>
      <h2>Data</h2>
      <p>The data is free to reuse. The full database is published as a single SQLite file and as CSV tables (papers, authors, authorships, journals, tiers), with a description of every field. </p>
      <p><a class="btn" href="data/downloads/repository.sqlite" download>Download the database (SQLite)</a> <a class="btn" href="data/downloads/repository-csv.zip" download>Download the tables (CSV)</a></p>
      <p class="note">The site is rebuilt from the master database every time papers are added or corrected, so these files always match what you see here.</p>
      <p class="note">Last updated ${esc(meta.generated || "")}. ${papers.length} papers, ${authors.size} authors, ${journals.length} journals.</p>
      <h2>Gaps</h2>
      <p>Some subjects have little or no coverage so far, including AI in taxation, autonomous weapons, biometric surveillance of protest, and AI risk tools in bail decisions. Suggestions of papers to add are welcome.</p>
    </article>`;
  }

  // ---------------------------------------------------------------- routing
  function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    let nav = "search";
    if (/^P\d{4,}$/.test(h) && byId.has(h)) { paperView(byId.get(h)); nav = ""; }
    else if (h.startsWith("journal-") && jById.has(h.slice(8))) { journalView(jById.get(h.slice(8))); nav = "journals"; }
    else if (h.startsWith("author-") && authors.has(h.slice(7))) { authorView(authors.get(h.slice(7))); nav = "authors"; }
    else if (h === "journals") { journalsView(); nav = "journals"; }
    else if (h === "authors") { authorsView(); nav = "authors"; }
    else if (h === "about") { aboutView(); nav = "about"; }
    else searchView();
    for (const a of document.querySelectorAll("nav a")) {
      if (a.dataset.nav === nav) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
    if (h && h !== "search") window.scrollTo({ top: 0 });
  }

  // ---------------------------------------------------------------- start
  Promise.all(["data/papers.json", "data/journals.json", "data/meta.json"].map((u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ": HTTP " + r.status); return r.json(); })))
    .then(([P, J, M]) => {
      papers = P; journals = J; meta = M;
      for (const p of papers) byId.set(p.id, p);
      for (const j of journals) jById.set(j.journal_id, j);
      for (const p of papers) for (const a of p.authors) {
        if (!authors.has(a.author_id)) authors.set(a.author_id, { id: a.author_id, name: a.name_as_printed, papers: [], latest: "", latestDs: "" });
        const rec = authors.get(a.author_id);
        rec.papers.push(p);
        if ((p.date_sort || "") >= rec.latestDs && (a.institution || a.designation)) { rec.latestDs = p.date_sort || ""; rec.latest = [a.institution, a.location].filter(Boolean).join(", ") || a.designation; }
      }
      index = E.buildIndex(papers.map((p) => ({ id: p.id, title: p.title, keywords: p.keywords, authors: p.authors.map((a) => a.name_as_printed),
        abstract: p.abstract, journal: p.journal, tier: p.tier, year: p.year, ds: p.date_sort, ref: p })));
      try { const q = new URL(location.href).searchParams.get("q"); if (q) state.q = q; } catch (e) { /* ignore */ }
      $("#footer").innerHTML = `${papers.length} papers, ${journals.length} journals and ${authors.size} authors. Updated ${esc((meta.generated || "").slice(0, 10))}. <a href="#about">About the repository and its data</a>.`;
      window.addEventListener("hashchange", route);
      $("#view").addEventListener("click", detailClicks);   // one delegated handler for every view
      route();
    })
    .catch((err) => { $("#view").innerHTML = `<div class="page"><h1>The repository could not load</h1><p>${esc(err.message)}. Reload the page to try again.</p></div>`; });
})();
