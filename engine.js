/* Relevance engine for the AI and Law in India repository.
   Field-weighted BM25 with rarity weighting, stemming, legal-citation handling, synonyms,
   prefix and typo tolerance, phrase and all-terms bonuses, and optional tier / recency boosts.
   Works in the browser (window.SearchEngine) and in Node (module.exports). */
(function (root) {
  "use strict";

  const DEFAULTS = {
    weights: { title: 12, keywords: 7, authors: 6, abstract: 4 },
    k1: 1.2,
    b: { title: 0.5, keywords: 0.3, authors: 0.3, abstract: 0.75 },
    bestFields: 2,          // count only the strongest N fields, so papers without keywords are not penalised
    synonymMult: 0.9,
    prefixMult: 0.3,
    fuzzyMult: 0.8,         // only used for words that appear nowhere in the repository, i.e. likely misspellings
    partialMult: 0.5,       // single words inside a matched multi-word synonym ("dispute resolution" inside "online dispute resolution")
    setPhraseMult: 0.5,     // bonus for a set phrase found in the papers; off while phraseMinDocs is 0
    phraseMinDocs: 0,       // 0 = off. Tested at 2 to 8: it lowered ranking quality on all three test sets
    phraseMult: 1.5,        // whole query appears as a phrase in the title or abstract
    allTermsBonus: 0.25,    // every search concept found somewhere in the paper
    // Journal quality is shown on every result but does not change the ranking (all 1). Set a tier
    // below 1 to push it down; tested values: C 0.85, D 0.75, P 0.85 (see the tuning notes).
    tierWeights: { A1: 1, A2: 1, B: 1, C: 1, D: 1, P: 1 },
    tierTieWindow: 5,       // papers within 5 match points: the more reliable journal goes first
    tierLevels: { A1: 0, A2: 0, B: 0, C: 1, P: 1, D: 2 },   // A1, A2 and B count as one level
    semanticWeight: 0,      // meaning-based re-ordering tested (BGE-small, +0.002 to +0.021 nDCG) and left off; see tuning notes
    recencyBoost: 0,        // 0 = off; up to 0.3
    cutoff: 15,             // hide results below this % of the top score
    synonyms: [
      "ai, artificial intelligence",
      "ml, machine learning",
      "llm, llms, large language model, generative ai, genai, chatgpt",
      "nlp, natural language processing => text classification, summarization, information retrieval, legal text, question answering, rhetorical role, language model",
      "ipr, intellectual property",
      "data protection => dpdp, digital personal data protection, gdpr, personal data",
      "gdpr, general data protection regulation",
      "fintech, financial technology => finance, financial, banking, lending, credit",
      "finance, financial => banking, fintech, insurance, credit, lending",
      "frt, facial recognition",
      "odr, online dispute resolution",
      "adr, alternative dispute resolution",
      "judiciary, courts, judicial",
      "judgment, judgement",
      "competition law, antitrust, anti-trust",
      "collusion, cartel",
      "deepfake, deep fake, synthetic media",
      "misinformation, disinformation, fake news",
      "election, elections, electoral",
      "cybercrime, cyber crime, cyber-crime",
      "labour, labor, employment => workers, workplace, gig, job",
      "gig work, platform work",
      "legal education, law school",
      "healthcare, medical",
      "inventorship, inventor",
      "administrative law => automated decision making, public sector, public administration, government decision, e-governance",
      "adm, automated decision making, automated decision-making, algorithmic decision making",
      "bail => pretrial, risk assessment, recidivism, undertrial",
      "voice cloning => digital replica, likeness, personality rights, deepfake",
      "personality rights, publicity rights",
      "surveillance, surveilance",
      "tort => negligence, civil liability, liability",
      "copyright, copywrite",
      "foundation model, foundation models, general purpose ai => large language model, generative ai, llm, frontier ai",
      "law firm, law firms => legal profession, lawyers, advocates, legal practice, legal industry, legal services",
      "big tech => digital markets, platforms, gatekeeper, dominant, competition",
      "safe harbour, safe harbor => intermediary liability, intermediaries, section 79",
      "bias => discrimination, discriminatory, fairness",
      "aadhar, aadhaar",
      "welfare => public services, benefits, social security, e-governance",
      "liable, liability",
    ].join("\n"),
  };

  const STOP = new Set(("a an and are as at be by for from has have in into is it its of on or that the this to with was were will can " +
    "could should would does do did who what when where which why how whether under any been being there their than then").split(" "));

  // ---------------------------------------------------------------- Porter stemmer
  const step2list = { ational: "ate", tional: "tion", enci: "ence", anci: "ance", izer: "ize", bli: "ble", alli: "al", entli: "ent", eli: "e", ousli: "ous", ization: "ize", ation: "ate", ator: "ate", alism: "al", iveness: "ive", fulness: "ful", ousness: "ous", aliti: "al", iviti: "ive", biliti: "ble", logi: "log" };
  const step3list = { icate: "ic", ative: "", alize: "al", iciti: "ic", ical: "ic", ful: "", ness: "" };
  const c = "[^aeiou]", v = "[aeiouy]", C = c + "[^aeiouy]*", V = v + "[aeiou]*";
  const mgr0 = new RegExp("^(" + C + ")?" + V + C), meq1 = new RegExp("^(" + C + ")?" + V + C + "(" + V + ")?$"),
    mgr1 = new RegExp("^(" + C + ")?" + V + C + V + C), s_v = new RegExp("^(" + C + ")?" + v);
  function stem(w) {
    if (w.length < 3 || /\d/.test(w)) return w;
    let stemv, suffix, re, re2, re3, re4;
    const firstch = w[0];
    if (firstch === "y") w = "Y" + w.slice(1);
    re = /^(.+?)(ss|i)es$/; re2 = /^(.+?)([^s])s$/;
    if (re.test(w)) w = w.replace(re, "$1$2"); else if (re2.test(w)) w = w.replace(re2, "$1$2");
    re = /^(.+?)eed$/; re2 = /^(.+?)(ed|ing)$/;
    if (re.test(w)) { const fp = re.exec(w); if (mgr0.test(fp[1])) w = w.slice(0, -1); }
    else if (re2.test(w)) {
      const fp = re2.exec(w); stemv = fp[1];
      if (s_v.test(stemv)) {
        w = stemv;
        re2 = /(at|bl|iz)$/; re3 = new RegExp("([^aeiouylsz])\\1$"); re4 = new RegExp("^" + C + v + "[^aeiouwxy]$");
        if (re2.test(w)) w += "e"; else if (re3.test(w)) w = w.slice(0, -1); else if (re4.test(w)) w += "e";
      }
    }
    re = /^(.+?)y$/;
    if (re.test(w)) { const fp = re.exec(w); stemv = fp[1]; if (s_v.test(stemv)) w = stemv + "i"; }
    re = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
    if (re.test(w)) { const fp = re.exec(w); stemv = fp[1]; suffix = fp[2]; if (mgr0.test(stemv)) w = stemv + step2list[suffix]; }
    re = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
    if (re.test(w)) { const fp = re.exec(w); stemv = fp[1]; suffix = fp[2]; if (mgr0.test(stemv)) w = stemv + step3list[suffix]; }
    re = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/; re2 = /^(.+?)(s|t)(ion)$/;
    if (re.test(w)) { const fp = re.exec(w); stemv = fp[1]; if (mgr1.test(stemv)) w = stemv; }
    else if (re2.test(w)) { const fp = re2.exec(w); stemv = fp[1] + fp[2]; if (mgr1.test(stemv)) w = stemv; }
    re = /^(.+?)e$/;
    if (re.test(w)) {
      const fp = re.exec(w); stemv = fp[1]; re2 = new RegExp("^" + C + v + "[^aeiouwxy]$");
      if (mgr1.test(stemv) || (meq1.test(stemv) && !re2.test(stemv))) w = stemv;
    }
    if (/ll$/.test(w) && mgr1.test(w)) w = w.slice(0, -1);
    if (firstch === "y") w = "y" + w.slice(1);
    return w;
  }

  // ---------------------------------------------------------------- tokenising
  function normalise(text) {
    return (text || "")
      .normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[‘’ʼ]/g, "'")
      // legal citations stay one token: "Section 3(k)" -> section3k, "Art. 21" -> article21
      .replace(/\bsec(?:tion|s?\.)?\s*(\d+[a-z]{0,2})\s*\(\s*([a-z0-9]{1,4})\s*\)/g, " section$1$2 ")
      .replace(/\bsec(?:tion|s?\.)\s*(\d+[a-z]{0,2})\b/g, " section$1 ")
      .replace(/\bsection\s+(\d+[a-z]{0,2})\b/g, " section$1 ")
      .replace(/\bart(?:icle|s?\.)\s*(\d+[a-z]?)\b/g, " article$1 ")
      .replace(/'s\b/g, "").replace(/'/g, "");
  }
  // returns { seq: [stems in order], extra: [joined hyphenated forms] }
  function tokens(text, opts) {
    const o = opts || {};
    const seq = [], extra = [], raw = [];
    const parts = normalise(text).split(/[^a-z0-9\-]+/);
    for (const p of parts) {
      if (!p) continue;
      const pieces = p.split("-").filter(Boolean);
      if (pieces.length > 1) extra.push(o.noStem ? pieces.join("") : stem(pieces.join("")));
      for (const t of pieces) {
        if (!o.keepStop && STOP.has(t)) continue;
        seq.push(o.noStem ? t : stem(t));
        raw.push(t);
      }
    }
    return { seq, extra, raw };
  }

  function editDistance1(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0, j = 0, diff = 0;
    while (i < la && j < lb) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++diff > 1) return false;
      if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
    }
    return diff + (la - i) + (lb - j) <= 1;
  }

  const FIELDS = ["title", "keywords", "authors", "abstract"];

  // ---------------------------------------------------------------- index
  function buildIndex(papers) {
    const docs = papers.map((p) => {
      const f = {
        title: tokens(p.title),
        keywords: tokens([].concat(p.keywords || []).join(" ; ").replace(/;/g, " ")),
        authors: tokens((p.authors || []).join(" "), { noStem: true }),
        abstract: tokens(p.abstract),
        journal: tokens(p.journal),
      };
      const tf = {}, len = {};
      for (const k of Object.keys(f)) {
        const m = new Map();
        for (const t of f[k].seq.concat(f[k].extra)) m.set(t, (m.get(t) || 0) + 1);
        tf[k] = m; len[k] = f[k].seq.length;
      }
      return { p, f, tf, len };
    });
    const avg = {}, df = new Map(), vocab = { stem: new Set(), name: new Set() }, surface = new Map();
    for (const d of docs) for (const k of FIELDS) d.f[k].raw.forEach((w, i) => { if (w.length >= 4 && !surface.has(w)) surface.set(w, d.f[k].seq[i]); });
    for (const k of FIELDS.concat(["journal"])) avg[k] = docs.reduce((s, d) => s + d.len[k], 0) / Math.max(1, docs.length) || 1;
    for (const d of docs) {
      const seen = new Set();
      for (const k of FIELDS) for (const t of d.tf[k].keys()) { seen.add(t); (k === "authors" ? vocab.name : vocab.stem).add(t); }
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }
    // how many papers contain each two- and three-word phrase (used to spot set phrases in a search)
    const ngramDf = new Map();
    for (const d of docs) {
      const seen = new Set();
      for (const k of ["title", "keywords", "abstract"]) {
        const q = d.f[k].seq;
        for (let i = 0; i + 1 < q.length; i++) {
          seen.add(q[i] + " " + q[i + 1]);
          if (i + 2 < q.length) seen.add(q[i] + " " + q[i + 1] + " " + q[i + 2]);
        }
      }
      for (const g of seen) ngramDf.set(g, (ngramDf.get(g) || 0) + 1);
    }
    return { docs, avg, df, N: docs.length, vocab: { stem: [...vocab.stem], name: [...vocab.name] }, surface, ngramDf };
  }

  function idf(index, t) {
    const n = index.df.get(t) || 0;
    return Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
  }

  // ---------------------------------------------------------------- query parsing
  // "a, b, c" = all equivalent. "a => b, c" = one-way: searching a also finds b and c,
  // but searching b or c does not bring in a.
  function parseSynonyms(text) {
    const groups = [];
    for (const line of (text || "").split("\n")) {
      const [left, right] = line.includes("=>") ? line.split("=>") : [line, ""];
      const mk = (part, trigger) => part.split(",").map((s) => s.trim()).filter(Boolean)
        .map((m) => ({ raw: m, seq: tokens(m).seq, trigger })).filter((m) => m.seq.length);
      const members = mk(left, true).concat(mk(right, false));
      if (members.length > 1) groups.push(members);
    }
    return groups;
  }

  const FIELD_ALIASES = { title: "title", ti: "title", keyword: "keywords", keywords: "keywords", kw: "keywords",
    author: "authors", authors: "authors", au: "authors", abstract: "abstract", ab: "abstract", journal: "journal", jo: "journal" };

  // A query becomes a list of concepts. Each concept has variants (stem sequences with a multiplier)
  // and may be required, excluded or limited to one field.
  function parseQuery(q, settings, index) {
    const groups = parseSynonyms(settings.synonyms);
    const concepts = [];
    const re = /(-?)(?:([a-z]+):)?(?:"([^"]+)"|(\S+))/gi;
    const plain = [];
    let m;
    while ((m = re.exec(q || ""))) {
      const neg = m[1] === "-", fieldRaw = (m[2] || "").toLowerCase(), phrase = m[3], word = m[4];
      const field = FIELD_ALIASES[fieldRaw];
      if (m[2] && !field) { plain.push({ text: m[0], neg }); continue; }
      if (/^(and|or)$/i.test(word || "")) continue;
      const text = phrase || word;
      if (field || phrase || neg) {
        const noStem = field === "authors";
        const seq = tokens(text, { noStem, keepStop: !!phrase }).seq;
        if (!seq.length) continue;
        concepts.push({ label: (field ? fieldRaw + ":" : "") + (phrase ? '"' + phrase + '"' : text), field: field || null,
          required: !neg, excluded: neg, phrase: !!phrase || seq.length > 1,
          variants: [{ seq, mult: 1, kind: "exact" }], expand: !phrase && seq.length === 1 });
      } else plain.push({ text, neg: false });
    }
    // hyphenated words ("anti-trust", "AI-generated") become their own concept: joined form or split phrase
    for (const x of plain.slice()) {
      if (!/\w-\w/.test(x.text)) continue;
      const joined = tokens(x.text.replace(/-/g, "")).seq, split = tokens(x.text, { keepStop: true }).seq;
      if (!joined.length) continue;
      concepts.push({ label: x.text, field: null, required: false, excluded: false, phrase: false,
        variants: [{ seq: joined, mult: 1, kind: "exact" }].concat(split.length > 1 ? [{ seq: split, mult: 1, kind: "exact", label: split.join(" ") }] : []),
        expand: joined.length === 1, raw: x.text.replace(/-/g, "").toLowerCase() });
      plain.splice(plain.indexOf(x), 1);
    }
    // plain words: group them, then match synonym members (longest first)
    const tk = tokens(plain.map((x) => x.text).join(" "));
    const words = tk.seq, rawWords = tk.raw;
    let i = 0;
    while (i < words.length) {
      let best = null;
      for (const g of groups) for (const mem of g) {
        if (!mem.trigger) continue;
        const L = mem.seq.length;
        if (L && words.slice(i, i + L).join(" ") === mem.seq.join(" ") && (!best || L > best.mem.seq.length)) best = { g, mem };
      }
      if (best) {
        concepts.push({ label: best.mem.raw, field: null, required: false, excluded: false, phrase: false,
          variants: best.g.map((mm) => ({ seq: mm.seq, mult: mm === best.mem ? 1 : settings.synonymMult, kind: mm === best.mem ? "exact" : "synonym", label: mm.raw })),
          expand: best.mem.seq.length === 1 });
        if (best.mem.seq.length > 1 && settings.partialMult > 0)
          for (let j = i; j < i + best.mem.seq.length; j++)
            concepts.push({ label: rawWords[j] || words[j], raw: rawWords[j], field: null, required: false, excluded: false, phrase: false, soft: true,
              variants: [{ seq: [words[j]], mult: settings.partialMult, kind: "part of phrase" }], expand: true });
        i += best.mem.seq.length;
      } else {
        // a set phrase: two or three adjacent words that appear together in enough papers
        let L = 1;
        if (index && index.ngramDf && settings.phraseMinDocs > 0) {
          for (const n of [3, 2]) {
            if (i + n > words.length) continue;
            const g = words.slice(i, i + n);
            if (g.some((w) => STOP.has(w))) continue;
            if ((index.ngramDf.get(g.join(" ")) || 0) >= settings.phraseMinDocs) { L = n; break; }
          }
        }
        if (L > 1) {
          // keep every word as a full search term, and add the phrase itself as a bonus
          const seq = words.slice(i, i + L), raw = rawWords.slice(i, i + L);
          concepts.push({ label: raw.join(" "), field: null, required: false, excluded: false, phrase: false, soft: true, setPhrase: true,
            variants: [{ seq, mult: settings.setPhraseMult, kind: "phrase" }], expand: false });
          for (let j = 0; j < L; j++)
            concepts.push({ label: raw[j] || seq[j], raw: raw[j], field: null, required: false, excluded: false, phrase: false,
              variants: [{ seq: [seq[j]], mult: 1, kind: "exact" }], expand: true });
          i += L;
        } else {
          concepts.push({ label: rawWords[i] || words[i], raw: rawWords[i], field: null, required: false, excluded: false, phrase: false,
            variants: [{ seq: [words[i]], mult: 1, kind: "exact" }], expand: true });
          i++;
        }
      }
    }
    return { concepts, plainSeq: words };
  }

  // ---------------------------------------------------------------- scoring
  function countPhrase(seq, phrase) {
    if (phrase.length === 1) return 0;
    let n = 0;
    outer: for (let i = 0; i + phrase.length <= seq.length; i++) {
      for (let j = 0; j < phrase.length; j++) if (seq[i + j] !== phrase[j]) continue outer;
      n++;
    }
    return n;
  }

  function expansions(index, concept, settings, cache) {
    // add prefix and typo variants for single-word concepts
    const key = JSON.stringify(concept.variants.map((v) => v.seq)) + concept.field;
    if (cache.has(key)) return cache.get(key);
    const out = concept.variants.slice();
    if (concept.expand) {
      const base = concept.variants.filter((v) => v.seq.length === 1).map((v) => v.seq[0]);
      const have = new Set(base);
      for (const t of base) {
        // word-start matches: regul -> regulatori, but not bank -> bankruptci (at most 5 more letters)
        if (concept.field !== "authors" && t.length >= 4 && settings.prefixMult > 0)
          for (const s of index.vocab.stem) if (!have.has(s) && s.startsWith(t) && s.length - t.length <= (settings.prefixMaxExtra ?? 5)) { have.add(s); out.push({ seq: [s], mult: settings.prefixMult, kind: "prefix", label: s }); }
        // typo matches only for words that never appear in the collection, i.e. probable misspellings
        const known = (index.df.get(t) || 0) > 0;
        if (!known && concept.raw && concept.raw.length >= 5 && settings.fuzzyMult > 0)
          for (const [w, st] of index.surface) if (!have.has(st) && Math.abs(w.length - concept.raw.length) <= 1 && editDistance1(w, concept.raw)) { have.add(st); out.push({ seq: [st], mult: settings.fuzzyMult, kind: "typo", label: w }); }
        if (!known && t.length >= 5 && settings.fuzzyMult > 0)
          for (const s of index.vocab.stem.concat(index.vocab.name)) if (!have.has(s) && Math.abs(s.length - t.length) <= 1 && editDistance1(s, t)) { have.add(s); out.push({ seq: [s], mult: settings.fuzzyMult, kind: "typo", label: s }); }
      }
    }
    cache.set(key, out);
    return out;
  }

  function bm25(index, d, field, tf, idfv, settings) {
    const k1 = settings.k1, b = settings.b[field] ?? 0.75;
    const norm = 1 - b + b * (d.len[field] / index.avg[field]);
    return idfv * (tf * (k1 + 1)) / (tf + k1 * norm);
  }

  // best variant of a concept in one field of one document
  function conceptField(index, d, field, variants, settings, conceptIdf) {
    let best = null;
    for (const v of variants) {
      if (field === "authors" && v.kind === "prefix") continue;
      let tf, idfv;
      if (v.seq.length === 1) { tf = d.tf[field].get(v.seq[0]) || 0; idfv = idf(index, v.seq[0]); }
      else { tf = countPhrase(d.f[field].seq, v.seq); idfv = v.seq.reduce((s, t) => s + idf(index, t), 0); }
      // A concept is priced once, by how many papers mention it in any of its forms, so a synonym
      // or phrase can never be worth more than the word that was typed.
      if (conceptIdf !== undefined && (v.kind === "exact" || v.kind === "synonym")) idfv = conceptIdf;
      if (!tf) continue;
      const s = bm25(index, d, field, tf, idfv, settings) * v.mult;
      if (!best || s > best.score) best = { score: s, kind: v.kind, term: v.label || v.seq.join(" "), tf };
    }
    return best;
  }

  function search(index, query, settings, filters) {
    const S = Object.assign({}, DEFAULTS, settings || {});
    S.weights = Object.assign({}, DEFAULTS.weights, (settings || {}).weights);
    S.b = Object.assign({}, DEFAULTS.b, (settings || {}).b);
    S.tierWeights = Object.assign({}, DEFAULTS.tierWeights, (settings || {}).tierWeights);
    const { concepts, plainSeq } = parseQuery(query, S, index);
    const scoring = concepts.filter((c) => !c.excluded);
    const hard = scoring.filter((c) => !c.soft);
    const cache = new Map();
    for (const c of concepts) c.all = expansions(index, c, S, cache);
    for (const c of concepts) {
      const core = c.all.filter((v) => v.kind === "exact" || v.kind === "synonym");
      if (core.length < 2 && !(core[0] && core[0].seq.length > 1)) continue;   // one plain word: its own idf already applies
      let n = 0;
      for (const d of index.docs) {
        let hit = false;
        for (const f of (c.field ? [c.field] : FIELDS)) {
          for (const v of core) {
            if (v.seq.length === 1 ? d.tf[f].get(v.seq[0]) : countPhrase(d.f[f].seq, v.seq)) { hit = true; break; }
          }
          if (hit) break;
        }
        if (hit) n++;
      }
      c.idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
    }
    const years = index.docs.map((d) => d.p.year).filter(Boolean);
    const minY = Math.min(...years), maxY = Math.max(...years);
    const TIER_RANK = { A1: 1, A2: 0.8, B: 0.6, C: 0.4, D: 0.2, P: 0.2 };
    const results = [];
    for (const d of index.docs) {
      const p = d.p;
      if (filters) {
        if (filters.tiers && filters.tiers.size && !filters.tiers.has(p.tier)) continue;
        if (filters.journals && filters.journals.size && !filters.journals.has(p.journal)) continue;
        if (filters.yearFrom && (!p.year || p.year < filters.yearFrom)) continue;
        if (filters.yearTo && (!p.year || p.year > filters.yearTo)) continue;
      }
      if (!scoring.length) { results.push({ p, score: 0, pct: 100, fields: {}, matched: [], notes: [] }); continue; }
      let excluded = false;
      for (const c of concepts.filter((c) => c.excluded))
        for (const f of FIELDS.concat(["journal"])) if (conceptField(index, d, f, c.all, S, c.idf)) { excluded = true; break; }
      if (excluded) continue;
      const fieldPts = { title: 0, keywords: 0, authors: 0, abstract: 0 };
      const detail = [];
      let found = 0, missingRequired = false;
      for (const c of scoring) {
        let hit = false;
        const fields = c.field ? [c.field] : FIELDS;
        for (const f of fields) {
          const r = conceptField(index, d, f, c.all, S, c.idf);
          if (!r) continue;
          hit = true;
          if (f === "journal") { fieldPts.title += 0; detail.push({ concept: c.label, field: f, pts: 0, kind: r.kind, term: r.term }); continue; }
          const pts = r.score * S.weights[f];
          fieldPts[f] += pts;
          detail.push({ concept: c.label, field: f, pts, kind: r.kind, term: r.term, tf: r.tf });
        }
        if (hit && !c.soft) found++; else if (!hit && c.required) missingRequired = true;
      }
      if (missingRequired || (!found && !detail.length)) continue;
      const ranked = Object.entries(fieldPts).sort((a, b) => b[1] - a[1]);
      const kept = ranked.slice(0, S.bestFields);
      let score = kept.reduce((s, [, v]) => s + v, 0);
      const notes = [];
      if (S.bestFields < 4 && ranked[S.bestFields] && ranked[S.bestFields][1] > 0)
        notes.push({ label: "weakest field not counted (" + ranked[S.bestFields][0] + ")", value: -ranked.slice(S.bestFields).reduce((s, [, v]) => s + v, 0) });
      if (hard.length > 1 && found === hard.length && S.allTermsBonus) { notes.push({ label: "all search terms found", mult: 1 + S.allTermsBonus }); score *= 1 + S.allTermsBonus; }
      if (plainSeq.length > 1 && S.phraseMult > 1 && (countPhrase(d.f.title.seq, plainSeq) || countPhrase(d.f.abstract.seq, plainSeq))) {
        notes.push({ label: "exact phrase in title or abstract", mult: S.phraseMult }); score *= S.phraseMult;
      }
      const tw = (S.tierWeights || {})[p.tier];
      if (tw !== undefined && tw !== 1) { notes.push({ label: "tier " + p.tier + " journal", mult: tw }); score *= tw; }
      if (S.recencyBoost && p.year && maxY > minY) { const m = 1 + S.recencyBoost * (p.year - minY) / (maxY - minY); notes.push({ label: "recency boost", mult: m }); score *= m; }
      results.push({ p, score, fields: fieldPts, kept: kept.map(([f]) => f), matched: detail, notes });
    }
    if (scoring.length) {
      results.sort((a, b) => b.score - a.score);
      const top = results.length ? results[0].score : 1;
      for (const r of results) r.pct = top ? (100 * r.score) / top : 0;
      // Close calls go to the more reliable journal: results within `tierTieWindow` points of the
      // first paper in their group are ordered by reliability level, then by score.
      const W = S.tierTieWindow || 0, lvl = S.tierLevels || {};
      if (W > 0) {
        const out = [];
        let i = 0;
        while (i < results.length) {
          let j = i;
          while (j < results.length && results[i].pct - results[j].pct <= W) j++;
          const group = results.slice(i, j).sort((a, b) => (lvl[a.p.tier] ?? 9) - (lvl[b.p.tier] ?? 9) || b.score - a.score);
          out.push(...group);
          i = j;
        }
        results.length = 0; results.push(...out);
      }
    }
    return { results, concepts };
  }

  const api = { DEFAULTS, stem, tokens, normalise, buildIndex, parseQuery, search };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SearchEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
