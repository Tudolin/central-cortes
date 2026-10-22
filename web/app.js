// Dashboard da Central de Cortes — JS puro, sem build. Estado vem de /api/state e é atualizado via SSE.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hms = (s) => {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = (s % 60).toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};
const usd = (n) => `$${(n || 0).toFixed(n >= 1 ? 2 : 4)}`;
const fmtN = (n) => (n || 0).toLocaleString("pt-BR");
const when = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const PLATFORM = { youtube: "▶ YouTube", tiktok: "♪ TikTok" };

let state = { channels: [], jobs: [], clips: [], posts: [], costs: [], daily: [], workers: [], integrations: {} };
const ui = {
  tab: localStorage.getItem("tab") || "pipeline",
  channel: localStorage.getItem("channel") || "",
  studioFilter: "PENDING_REVIEW",
  clipId: null,
  channelId: null,
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `show${err ? " err" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ""), 4000);
}

const act = (fn) => async (...a) => {
  try {
    await fn(...a);
  } catch (e) {
    toast(e.message, true);
  }
};

async function refresh() {
  state = await api("/api/state");
  render();
}

const byChannel = (x) => !ui.channel || x.channel_id === ui.channel;
const jobsF = () => state.jobs.filter(byChannel);
const clipsF = () => state.clips.filter(byChannel);
const channelName = (id) => state.channels.find((c) => c.id === id)?.name ?? id;
const postsOf = (clipId) => state.posts.filter((p) => p.clip_id === clipId);

// ---------------- Pipeline / Kanban ----------------

const COLUMNS = [
  { key: "queue", title: "Na Fila", color: "#8d8d95", jobs: ["QUEUED", "DOWNLOADING"] },
  { key: "tx", title: "Transcrevendo", color: "#4da3ff", jobs: ["TRANSCRIBING"] },
  { key: "ai", title: "Análise de IA", color: "#b47cff", jobs: ["ANALYZING"] },
  { key: "render", title: "Renderizando FFmpeg", color: "#ff8a3d", clips: ["RENDER_QUEUED", "RENDERING"] },
  { key: "review", title: "Pendente de Aprovação", color: "#ffd700", clips: ["PENDING_REVIEW"] },
  { key: "sched", title: "Agendado", color: "#4dd8ff", clips: ["SCHEDULED", "PUBLISHING"] },
  { key: "done", title: "Publicado", color: "#3ddc84", clips: ["PUBLISHED"] },
];

function pct(detail) {
  const m = /(\d+)%/.exec(detail || "");
  return m ? +m[1] : null;
}

function jobCard(j) {
  const p = pct(j.detail);
  const label = j.detail || (j.status === "QUEUED" ? "" : j.status.toLowerCase());
  return `<div class="kcard">
    <div class="t">${esc(j.title || j.source)}</div>
    <div class="meta"><span class="tag">${esc(channelName(j.channel_id))}</span>#${j.id}${j.duration ? ` · ${hms(j.duration)}` : ""}${j.worker && j.status !== "QUEUED" ? ` · ${esc(j.worker)}` : ""}</div>
    ${label ? `<div class="detail"><span class="spin"></span> ${esc(label)}</div>` : ""}
    ${p != null ? `<div class="bar"><i style="width:${p}%"></i></div>` : ""}
  </div>`;
}

function clipCard(c) {
  const thumb = c.rendered_at ? `<img src="/media/clip/${c.id}.jpg?v=${encodeURIComponent(c.rendered_at)}" alt="" loading="lazy" />` : "";
  const p = pct(c.detail);
  const posts = postsOf(c.id);
  return `<div class="kcard clickable" data-clip="${c.id}">
    <div class="thumb">${thumb}<div style="display:grid;gap:6px;align-content:start">
      <div class="t">${esc(c.title)}</div>
      <div class="meta"><span class="score">${c.score}</span>${hms(c.end_s - c.start_s)}<span class="tag">${esc(c.layout_used || c.layout)}</span></div>
      ${c.status === "SCHEDULED" ? `<div class="meta">🗓 ${when(c.scheduled_at)}${c.schedule_locked ? " 🔒" : ""}</div>` : ""}
      ${c.status === "PUBLISHING" ? `<div class="detail"><span class="spin"></span> publicando…</div>` : ""}
      ${posts.length && c.status === "PUBLISHED" ? `<div class="meta">${posts.map((p) => `<span class="tag ${p.status === "FAILED" ? "bad" : ""}">${PLATFORM[p.platform]}${p.status === "INBOX" ? " (rascunho)" : ""}</span>`).join("")}</div>` : ""}
    </div></div>
    ${c.status === "RENDERING" ? `<div class="detail"><span class="spin"></span> ${esc(c.detail || "renderizando")}</div>` : ""}
    ${p != null && c.status === "RENDERING" ? `<div class="bar"><i style="width:${p}%"></i></div>` : ""}
    ${c.error && c.status === "SCHEDULED" ? `<div class="detail" style="color:var(--red)">nova tentativa: ${esc(c.error)}</div>` : ""}
  </div>`;
}

function renderPipeline() {
  const jobs = jobsF();
  const clips = clipsF();
  $("#kanban").innerHTML = COLUMNS.map((col) => {
    let items;
    if (col.jobs) items = jobs.filter((j) => col.jobs.includes(j.status)).reverse().map(jobCard);
    else {
      let list = clips.filter((c) => col.clips.includes(c.status));
      if (col.key === "sched") list.sort((a, b) => (a.scheduled_at || "").localeCompare(b.scheduled_at || ""));
      else if (col.key === "done") list.sort((a, b) => (b.published_at || "").localeCompare(a.published_at || "")).splice(30);
      else list.sort((a, b) => b.score - a.score);
      items = list.map(clipCard);
    }
    return `<div class="col" style="--c:${col.color}"><h3>${col.title}<b>${items.length}</b></h3><div class="cards">${items.join("")}</div></div>`;
  }).join("");

  const failedJobs = jobs.filter((j) => j.status === "FAILED");
  const failedClips = clips.filter((c) => c.status === "FAILED" || c.status === "PUBLISH_FAILED");
  $("#failures").innerHTML =
    failedJobs.length + failedClips.length
      ? `<div class="section-title">Falhas</div>` +
        failedJobs.map((j) => `<div class="card fail"><b>Job #${j.id}</b><span>${esc(j.title || j.source)}</span><div class="err">${esc(j.error)}</div>
          <button class="btn small" data-retry="${j.id}">Tentar de novo</button><button class="btn small danger" data-del="${j.id}">Excluir</button></div>`).join("") +
        failedClips.map((c) => `<div class="card fail"><b>${c.status === "FAILED" ? "Render" : "Publicação"} · corte #${c.id}</b><span>${esc(c.title)}</span><div class="err">${esc(c.error)}</div>
          ${c.status === "FAILED"
            ? `<button class="btn small" data-rerender="${c.id}">Renderizar de novo</button>`
            : `<button class="btn small" data-republish="${c.id}">Publicar de novo</button>`}
          <button class="btn small" data-clip-open="${c.id}">Abrir</button></div>`).join("")
      : "";
}

function renderWorkers() {
  const online = state.workers.filter((w) => Date.now() - Date.parse(w.last_seen) < 120_000);
  const el = $("#worker-status");
  el.className = `worker ${online.length ? "on" : "off"}`;
  el.title = state.workers.map((w) => `${w.name}: visto ${when(w.last_seen)} ${w.task ? "— " + w.task : ""}`).join("\n") || "Nenhum worker conectou ainda";
  el.innerHTML = online.length
    ? `<i></i>${online.map((w) => esc(w.name)).join(", ")}${online.some((w) => w.task) ? " · trabalhando" : " · ocioso"}`
    : `<i></i>worker offline`;
}

// ---------------- Estúdio ----------------

let studioCtx = null; // { clip, words, bounds, lo, hi, start, end, proxyStart }

function renderClipList() {
  const match = (c) =>
    ui.studioFilter === "ALL" ? true : ui.studioFilter === "SCHEDULED" ? ["SCHEDULED", "PUBLISHING", "PUBLISH_FAILED"].includes(c.status) : c.status === ui.studioFilter;
  const list = clipsF()
    .filter(match)
    .sort((a, b) =>
      ui.studioFilter === "PUBLISHED" ? (b.published_at || "").localeCompare(a.published_at || "")
      : ui.studioFilter === "SCHEDULED" ? (a.scheduled_at || "").localeCompare(b.scheduled_at || "")
      : b.score - a.score);
  $("#clip-list").innerHTML =
    list.map((c) => `<li data-clip="${c.id}" class="${c.id === ui.clipId ? "sel" : ""}">
      ${c.rendered_at ? `<img src="/media/clip/${c.id}.jpg?v=${encodeURIComponent(c.rendered_at)}" alt="" loading="lazy" />` : `<img alt="" />`}
      <div><div class="t">${esc(c.title)}</div><div class="meta muted" style="font-size:12px;margin-top:4px"><span class="score">${c.score}</span> ${hms(c.end_s - c.start_s)} · ${c.status === "SCHEDULED" ? "🗓 " + when(c.scheduled_at) : esc(c.status)}</div></div>
    </li>`).join("") || `<p class="empty">Nada aqui.</p>`;
  const pending = state.clips.filter((c) => c.status === "PENDING_REVIEW").length;
  const pill = $("#pending-count");
  pill.textContent = pending;
  pill.toggleAttribute("data-zero", !pending);
}

async function openClip(id) {
  ui.clipId = id;
  ui.tab = "studio";
  render();
  const clip = state.clips.find((c) => c.id === id);
  if (!clip) return;
  const hasProxy = clip.proxy_end > clip.proxy_start;
  const lo = Math.max(hasProxy ? clip.proxy_start : 0, clip.start_s - 45);
  const hi = Math.min(hasProxy ? clip.proxy_end : clip.end_s + 45, clip.end_s + 45);
  const tr = await api(`/api/clips/${id}/transcript?start=${lo}&end=${hi}`);
  studioCtx = { clip, words: tr.words, bounds: tr.sentenceBounds, lo, hi, start: clip.start_s, end: clip.end_s, proxyStart: clip.proxy_start, hasProxy };
  renderStudioMain();
}

function scheduleBlock(c) {
  const posts = postsOf(c.id);
  const postLines = posts.map((p) =>
    `<div>${PLATFORM[p.platform]}: ${p.status === "FAILED" ? `<span style="color:var(--red)">${esc(p.error)}</span>`
      : p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a>` : p.status === "INBOX" ? "rascunho na caixa de entrada do app" : "ok"}</div>`).join("");
  if (c.status === "PENDING_REVIEW") {
    return `<div class="schedule card">
      <button class="btn ok" id="b-approve">Aprovar → próximo horário</button>
      <button class="btn" id="b-now">Publicar agora</button>
      <label class="muted">ou em <input type="datetime-local" id="f-when"></label><button class="btn small" id="b-at">Agendar</button>
    </div>`;
  }
  if (["SCHEDULED", "PUBLISH_FAILED"].includes(c.status)) {
    return `<div class="schedule card">
      <div>${c.status === "SCHEDULED" ? `🗓 Agendado para <b>${when(c.scheduled_at)}</b>${c.schedule_locked ? " (horário fixo)" : " (próximo horário livre)"}` : "⚠️ Falha ao publicar"}</div>
      ${c.error ? `<div class="err">${esc(c.error)}</div>` : ""}
      ${postLines}
      <div class="actions">
        <button class="btn" id="b-now">Publicar agora</button>
        <label class="muted">mudar para <input type="datetime-local" id="f-when"></label><button class="btn small" id="b-at">Salvar horário</button>
        <button class="btn small" id="b-unschedule">Desagendar</button>
      </div>
    </div>`;
  }
  if (["PUBLISHED", "PUBLISHING"].includes(c.status)) {
    return `<div class="schedule card"><div>${c.status === "PUBLISHING" ? "Publicando…" : `✅ Publicado em ${when(c.published_at)}`}</div>${postLines}</div>`;
  }
  return "";
}

function renderStudioMain() {
  const box = $("#studio-main");
  if (!studioCtx) return;
  const { clip, lo, hi } = studioCtx;
  const fresh = state.clips.find((c) => c.id === clip.id) || clip;
  studioCtx.clip = fresh;
  const kw = JSON.parse(fresh.keywords || "[]");
  const rendered = fresh.rendered_at && !["RENDER_QUEUED", "RENDERING", "FAILED"].includes(fresh.status);
  const v = encodeURIComponent(fresh.rendered_at || "");

  box.innerHTML = `
    <div>
      <div class="phone">${rendered ? `<video src="/media/clip/${fresh.id}.mp4?v=${v}" controls playsinline></video>` : `<p class="empty">${fresh.status === "FAILED" ? "Falhou: " + esc(fresh.error) : "Renderizando…<br>" + esc(fresh.detail || "")}</p>`}</div>
      <div class="actions" style="margin-top:10px">
        ${!["PUBLISHED", "PUBLISHING"].includes(fresh.status) ? `<button class="btn danger" id="b-reject">Rejeitar</button>` : ""}
        ${rendered ? `<a class="btn" href="/media/clip/${fresh.id}.mp4?download">Baixar</a>` : ""}
      </div>
    </div>
    <div class="editor">
      <div class="status-line"><span class="score">${fresh.score}</span><span class="tag">${esc(fresh.status)}</span>
        <span class="muted">${esc(fresh.video_title)}</span>
        <a class="muted" href="/api/jobs/${fresh.job_id}/result" target="_blank">JSON do job</a></div>
      <h2>${esc(fresh.title)}</h2>
      <div class="muted">${esc(fresh.hook)}</div>
      ${scheduleBlock(fresh)}

      ${studioCtx.hasProxy
        ? `<video class="source-video" id="src-video" src="/media/clip/${fresh.id}.proxy.mp4?v=${v}#t=${(studioCtx.start - studioCtx.proxyStart).toFixed(2)}" preload="metadata" muted></video>`
        : `<div class="source-video empty">Prévia do original disponível após o primeiro render.</div>`}
      <div class="trim">
        <div class="trim-track" id="track"></div>
        <div class="trim-row">
          <label>Início <input type="number" step="0.1" id="in-start"></label>
          <button class="btn small" data-nudge="start:-0.5">−0.5s</button><button class="btn small" data-nudge="start:0.5">+0.5s</button>
          <label>Fim <input type="number" step="0.1" id="in-end"></label>
          <button class="btn small" data-nudge="end:-0.5">−0.5s</button><button class="btn small" data-nudge="end:0.5">+0.5s</button>
          <span class="mono" id="dur"></span>
          <button class="btn small" id="b-play" ${studioCtx.hasProxy ? "" : "disabled"}>▶ Tocar trecho</button>
        </div>
        <input type="range" id="r-start" min="${lo}" max="${hi}" step="0.05" aria-label="Início">
        <input type="range" id="r-end" min="${lo}" max="${hi}" step="0.05" aria-label="Fim">
        <div class="words" id="words"></div>
        <div class="muted" style="font-size:12px">Clique numa palavra para mover o início (clique) ou o fim (Shift+clique).</div>
      </div>

      <div class="fields">
        <label class="full">Título do corte<input id="f-title" value="${esc(fresh.title)}"></label>
        <label>Layout
          <select id="f-layout">
            ${["single_speaker", "split_screen", "screen_share_focus"].map((l) => `<option ${l === fresh.layout ? "selected" : ""}>${l}</option>`).join("")}
          </select></label>
        <label>Zoom em ênfases <select id="f-zoom"><option value="1" ${fresh.zoom ? "selected" : ""}>Sim</option><option value="0" ${fresh.zoom ? "" : "selected"}>Não</option></select></label>
        <label class="full">Palavras em destaque (vírgula)<input id="f-kw" value="${esc(kw.join(", "))}"></label>
        <label class="full">Legenda social (descrição no YouTube, legenda no TikTok) <textarea id="f-caption">${esc(fresh.caption)}</textarea></label>
      </div>
      <div class="actions">
        <button class="btn primary" id="b-save" ${["PUBLISHED", "PUBLISHING"].includes(fresh.status) ? "disabled" : ""}>Salvar e re-renderizar</button>
        <button class="btn" id="b-save-caption">Salvar só a legenda</button>
        <button class="btn" id="b-copy">Copiar legenda</button>
        <span class="muted" style="align-self:center">Layout usado no render: <b>${esc(fresh.layout_used || "—")}</b></span>
      </div>
    </div>`;
  drawTrim();
}

function drawTrim() {
  const c = studioCtx;
  const span = c.hi - c.lo;
  const pos = (t) => `${((t - c.lo) / span) * 100}%`;
  $("#track").innerHTML =
    c.bounds.filter(([s]) => s >= c.lo && s <= c.hi).map(([s]) => `<div class="sent" style="left:${pos(s)}"></div>`).join("") +
    `<div class="sel" style="left:${pos(c.start)};width:${((c.end - c.start) / span) * 100}%"></div><div class="head" id="head" style="left:${pos(c.start)}"></div>`;
  const kw = new Set(($("#f-kw")?.value || "").split(",").map(norm).filter(Boolean));
  $("#words").innerHTML = c.words
    .map((w, i) => `<span data-w="${i}" class="${w.e > c.start && w.s < c.end ? "in" : ""} ${kw.has(norm(w.w)) ? "kw" : ""}">${esc(w.w)}</span>`)
    .join(" ");
  $("#dur").textContent = `${(c.end - c.start).toFixed(1)}s`;
  $("#in-start").value = c.start.toFixed(2);
  $("#in-end").value = c.end.toFixed(2);
  $("#r-start").value = c.start;
  $("#r-end").value = c.end;
}

/** O proxy começa em proxyStart: o tempo do player é relativo a ele. */
function seek(t) {
  const v = $("#src-video");
  if (v && studioCtx.hasProxy) v.currentTime = Math.max(0, t - studioCtx.proxyStart);
}

function setRange(start, end) {
  const c = studioCtx;
  c.start = Math.max(c.lo, Math.min(start, c.end - 1));
  c.end = Math.min(c.hi, Math.max(end, c.start + 1));
  drawTrim();
  seek(c.start);
}

function wireStudio() {
  const box = $("#studio-main");
  box.addEventListener("input", (e) => {
    if (!studioCtx) return;
    if (e.target.id === "r-start") setRange(+e.target.value, studioCtx.end);
    if (e.target.id === "r-end") {
      setRange(studioCtx.start, +e.target.value);
      seek(studioCtx.end - 2);
    }
    if (e.target.id === "f-kw") drawTrim();
  });
  box.addEventListener("change", (e) => {
    if (e.target.id === "in-start") setRange(+e.target.value, studioCtx.end);
    if (e.target.id === "in-end") setRange(studioCtx.start, +e.target.value);
  });
  box.addEventListener("click", act(async (e) => {
    const t = e.target;
    if (t.dataset.nudge) {
      const [k, d] = t.dataset.nudge.split(":");
      if (k === "start") setRange(studioCtx.start + +d, studioCtx.end);
      else setRange(studioCtx.start, studioCtx.end + +d);
    }
    if (t.dataset.w) {
      const w = studioCtx.words[+t.dataset.w];
      if (e.shiftKey) setRange(studioCtx.start, w.e + 0.3);
      else setRange(w.s - 0.1, studioCtx.end);
    }
    const id = studioCtx?.clip.id;
    if (t.id === "b-play") {
      const v = $("#src-video");
      v.muted = false;
      seek(studioCtx.start);
      v.play();
    }
    if (t.id === "b-save") {
      await api(`/api/clips/${id}`, { method: "PATCH", body: {
        start_s: studioCtx.start, end_s: studioCtx.end, title: $("#f-title").value, layout: $("#f-layout").value,
        zoom: $("#f-zoom").value === "1", keywords: $("#f-kw").value, rerender: true,
      } });
      toast("Salvo — re-renderizando no worker");
    }
    if (t.id === "b-save-caption") {
      await api(`/api/clips/${id}`, { method: "PATCH", body: { caption: $("#f-caption").value } });
      toast("Legenda salva");
    }
    if (t.id === "b-copy") {
      await navigator.clipboard.writeText($("#f-caption").value);
      toast("Legenda copiada");
    }
    if (t.id === "b-approve") {
      const c = await api(`/api/clips/${id}/approve`, { method: "POST", body: {} });
      toast(`Agendado para ${when(c.scheduled_at)}`);
      nextPending(id);
    }
    if (t.id === "b-now") {
      await api(`/api/clips/${id}/approve`, { method: "POST", body: { when: "now" } });
      toast("Publicando agora");
    }
    if (t.id === "b-at") {
      const v = $("#f-when").value;
      if (!v) throw new Error("Escolha data e hora");
      const c = await api(`/api/clips/${id}/approve`, { method: "POST", body: { when: new Date(v).toISOString() } });
      toast(`Agendado para ${when(c.scheduled_at)}`);
    }
    if (t.id === "b-unschedule") await api(`/api/clips/${id}/unschedule`, { method: "POST" });
    if (t.id === "b-reject") {
      await api(`/api/clips/${id}/reject`, { method: "POST" });
      toast("Rejeitado");
      nextPending(id);
    }
  }));
  box.addEventListener("timeupdate", (e) => {
    if (e.target.id !== "src-video" || !studioCtx) return;
    const v = e.target;
    const abs = v.currentTime + studioCtx.proxyStart;
    const head = $("#head");
    if (head) head.style.left = `${((abs - studioCtx.lo) / (studioCtx.hi - studioCtx.lo)) * 100}%`;
    if (!v.paused && abs >= studioCtx.end) v.pause();
  }, true);
}

function nextPending(currentId) {
  const next = clipsF().filter((c) => c.status === "PENDING_REVIEW" && c.id !== currentId).sort((a, b) => b.score - a.score)[0];
  if (next) openClip(next.id);
  else {
    studioCtx = null;
    ui.clipId = null;
    $("#studio-main").innerHTML = `<p class="empty">Fila de revisão vazia. 🎉</p>`;
  }
}

// ---------------- Canais ----------------

const CH_FIELDS = [
  ["h", "Identidade"],
  ["name", "Nome"], ["id", "ID (slug)", { readonlyExisting: true }],
  ["niche", "Nicho / posicionamento", { area: true, full: true }],
  ["tone", "Tom de voz", { area: true, full: true }],
  ["extra_instructions", "Instruções extras para a IA", { area: true, full: true }],
  ["h", "Curadoria"],
  ["model", "Modelo Claude (vazio = padrão do worker)", { list: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] }],
  ["effort", "Esforço (low…max, vazio = padrão)", { list: ["low", "medium", "high", "xhigh", "max"] }],
  ["clips_target", "Máx. cortes por vídeo", { type: "number" }],
  ["min_duration", "Duração mínima (s)", { type: "number" }],
  ["max_duration", "Duração máxima (s)", { type: "number" }],
  ["h", "Legendas"],
  ["highlight_color", "Cor de destaque", { type: "color" }],
  ["max_words_per_frame", "Palavras por quadro (2–4)", { type: "number" }],
  ["caption_template", "Template de legenda social — {titulo_corte} {url_com_timestamp} {url_video_original} {timestamp_segundos}", { area: true, full: true, rows: 10 }],
  ["h", "Agenda e publicação"],
  ["schedule_slots", "Horários diários (HH:MM separados por vírgula)", { full: true }],
  ["publish_targets", "Publicar em", { targets: true, full: true }],
  ["youtube_privacy", "YouTube: visibilidade", { select: ["public", "unlisted", "private"] }],
  ["youtube_category", "YouTube: categoria", { select: [["25", "Notícias e política"], ["22", "Pessoas e blogs"], ["24", "Entretenimento"], ["27", "Educação"]] }],
  ["tiktok_mode", "TikTok: modo", { select: [["inbox", "Rascunho na caixa de entrada (sem auditoria)"], ["direct", "Publicação direta (requer app auditado)"]] }],
  ["tiktok_privacy", "TikTok: privacidade (modo direto)", { select: ["SELF_ONLY", "PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR"] }],
  ["webhook_url", "Webhook após publicar (opcional)", { full: true }],
];

function fieldInput(k, o, ch) {
  const raw = ch[k] ?? "";
  if (o.targets) {
    const sel = JSON.parse(raw || "[]");
    return `<div class="checks">${Object.entries(PLATFORM).map(([p, label]) => `<label><input type="checkbox" name="target_${p}" ${sel.includes(p) ? "checked" : ""}> ${label}</label>`).join("")}</div>`;
  }
  if (o.select) {
    return `<select name="${k}">${o.select.map((x) => {
      const [val, label] = Array.isArray(x) ? x : [x, x];
      return `<option value="${val}" ${String(raw) === val ? "selected" : ""}>${esc(label)}</option>`;
    }).join("")}</select>`;
  }
  if (o.area) return `<textarea name="${k}" rows="${o.rows || 3}">${esc(raw)}</textarea>`;
  const ro = o.readonlyExisting && ch.id ? "readonly" : "";
  const list = o.list ? `list="dl-${k}"` : "";
  return `<input name="${k}" value="${esc(raw)}" type="${o.type || "text"}" ${ro} ${list}>${o.list ? `<datalist id="dl-${k}">${o.list.map((x) => `<option value="${x}">`).join("")}</datalist>` : ""}`;
}

// ---------------- Contas conectadas (integrações do hub) ----------------

let settingsData = null;

async function loadSettings() {
  settingsData = await api("/api/settings");
  renderIntegrations();
}

/** Campo de configuração: segredos mostram só ••••1234 e ficam em branco (em branco = manter). */
function settingField(key, label, { secret = false, placeholder = "" } = {}) {
  const s = settingsData.values[key];
  const src = s.source === "env" ? ` <span class="muted">(vindo do .env)</span>` : "";
  return `<label>${label}${src}
    <input name="${key}" type="${secret ? "password" : "text"}" autocomplete="off"
      value="${secret ? "" : esc(s.value)}" placeholder="${secret && s.set ? `salvo ${esc(s.value)} — em branco mantém` : esc(placeholder)}">
  </label>`;
}

/** Guias passo a passo de cada integração (abre/fecha e lembra o estado entre re-renders). */
const openGuides = new Set();
const guide = (id, steps) =>
  `<details class="guide" data-guide="${id}" ${openGuides.has(id) ? "open" : ""}><summary>📖 Como obter as credenciais</summary><ol>${steps.map((s) => `<li>${s}</li>`).join("")}</ol></details>`;

const link = (url, label = url.replace(/^https:\/\//, "")) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;

const GUIDES = {
  public_url: () => [
    `No notebook, rode uma vez (pede a senha do sudo):<br><code>sudo tailscale serve --bg --https=10004 http://127.0.0.1:8095</code>`,
    `Abra <b>https://debian.hedgehog-parrotfish.ts.net:10004</b> no navegador. É um endereço https válido, mas só acessível por aparelhos no seu Tailscale.`,
    `Cole esse endereço aqui e salve (ou use o botão "Usar…" quando já estiver acessando por ele).`,
    `O login do YouTube/TikTok funciona mesmo sendo só-Tailscale: o redirecionamento acontece no seu navegador, que está na tailnet.`,
  ],
  telegram: () => [
    `No Telegram, abra ${link("https://t.me/BotFather", "@BotFather")} e envie <code>/newbot</code>.`,
    `Escolha um nome (ex.: <i>Central de Cortes</i>) e um username terminado em <code>bot</code> (ex.: <i>cortes_rafael_bot</i>).`,
    `O BotFather responde com o <b>token</b> (formato <code>123456789:AA…</code>). Cole no campo abaixo e clique em <b>Salvar token</b>.`,
    `Crie um bot novo só para isto: o bot do ig-agent já usa webhook e os dois disputariam as mensagens.`,
    `Abra o seu bot no Telegram e envie <code>/start</code>. Em alguns segundos o chat aparece aqui — clique em <b>Autorizar este chat</b>. Uma mensagem de teste chega no Telegram.`,
    `Quer aprovar em grupo? Adicione o bot ao grupo, mande uma mensagem lá e autorize o grupo em vez do chat privado.`,
  ],
  youtube: (redirect) => [
    `Acesse ${link("https://console.cloud.google.com/projectcreate")} e crie um projeto (ex.: <i>Central de Cortes</i>).`,
    `Em ${link("https://console.cloud.google.com/apis/library/youtube.googleapis.com", "APIs e serviços → Biblioteca → YouTube Data API v3")}, clique em <b>Ativar</b>.`,
    `Abra ${link("https://console.cloud.google.com/auth/overview", "Google Auth Platform")} (tela de consentimento OAuth): tipo <b>Externo</b>, nome do app, seu e-mail de suporte e de contato.`,
    `Em <b>Público-alvo → Usuários de teste</b>, adicione o e-mail da conta Google que é dona do canal do YouTube.`,
    `Em ${link("https://console.cloud.google.com/auth/clients", "Clientes")} → <b>Criar cliente</b> → tipo <b>Aplicativo da Web</b>. Em <b>URIs de redirecionamento autorizados</b>, cole:<br><code>${esc(redirect || "salve a URL pública primeiro")}</code>`,
    `Crie e copie o <b>ID do cliente</b> e a <b>Chave secreta do cliente</b> para os campos abaixo. Salve.`,
    `Clique em <b>Conectar conta</b>, entre com a conta do canal e permita o acesso. Se aparecer "o Google não verificou este app", clique em <b>Avançado → Acessar</b> (o app é seu).`,
    `Atenção: com o app em modo <b>Teste</b>, o Google expira a conexão a cada 7 dias (é só clicar em Reconectar). Para não expirar, em Público-alvo clique em <b>Publicar app</b>.`,
    `Cota padrão: 10.000 unidades/dia ≈ 6 uploads por dia por projeto. Para mais, peça aumento de cota no próprio console.`,
  ],
  tiktok: (redirect) => [
    `Acesse ${link("https://developers.tiktok.com/")}, entre com sua conta e vá em <b>Manage apps → Connect an app</b> (conta de desenvolvedor individual serve).`,
    `Preencha nome, ícone, categoria e descrição. O TikTok exige links de <b>Termos de uso</b> e <b>Política de privacidade</b> — pode ser uma página simples sua.`,
    `Em <b>Products</b>, adicione <b>Login Kit</b> e <b>Content Posting API</b>. No Login Kit, plataforma <b>Web</b>, em <b>Redirect URI</b> cole:<br><code>${esc(redirect || "salve a URL pública primeiro")}</code>`,
    `Em <b>Scopes</b>, marque <code>user.info.basic</code> e <code>video.upload</code> (rascunho na caixa de entrada). Marque também <code>video.publish</code> se for usar postagem direta.`,
    `Para usar já, sem esperar aprovação: crie um <b>Sandbox</b> no app, adicione sua conta do TikTok em <b>Target users</b> e use as chaves do sandbox.`,
    `Copie <b>Client key</b> e <b>Client secret</b> (da tela do app ou do sandbox) para os campos abaixo e salve. Depois clique em <b>Conectar conta</b>.`,
    `Para produção, envie o app para revisão (<b>Submit for review</b>) explicando o uso e com um vídeo curto de demonstração. Até ser auditado, postagens diretas saem privadas — por isso o padrão aqui é o rascunho na caixa de entrada.`,
  ],
};

const copyField = (value) =>
  `<div class="copy-row"><input readonly value="${esc(value)}"><button class="btn small" type="button" data-copy="${esc(value)}">Copiar</button></div>`;

function renderIntegrations() {
  const box = $("#integrations");
  if (!settingsData || box.contains(document.activeElement)) return;
  const v = settingsData.values;
  const ch = state.channels.find((c) => c.id === ui.channelId);
  const tg = settingsData.telegram;
  const redirects = settingsData.redirects;

  const platformCard = (p, keys, help) => {
    const ready = v[keys[0]].set && v[keys[1]].set && v.public_url.set;
    const acct = ch?.connections?.[p];
    return `<form class="integ" data-settings>
      <div class="integ-head"><b>${PLATFORM[p]}</b>
        ${ch ? (acct ? `<span class="ok-dot">${esc(ch.name)}: ${esc(acct)}</span>` : `<span class="muted">${esc(ch.name)}: não conectado</span>`) : ""}</div>
      <div class="muted help">${help}</div>
      ${guide(p, GUIDES[p](redirects?.[p]))}
      ${settingField(keys[0], p === "youtube" ? "Client ID" : "Client key")}
      ${settingField(keys[1], "Client secret", { secret: true })}
      ${redirects ? `<label>URI de redirecionamento (cole no console do ${p === "youtube" ? "Google" : "TikTok"})${copyField(redirects[p])}</label>` : ""}
      <div class="actions">
        <button class="btn small" type="submit">Salvar chaves</button>
        ${ch && ready ? `<a class="btn small primary" href="/oauth/${p}/start?channel=${encodeURIComponent(ch.id)}">${acct ? "Reconectar" : "Conectar"} conta de ${esc(ch.name)}</a>` : ""}
        ${ch && acct ? `<button class="btn small danger" type="button" data-disconnect="${p}">Desconectar</button>` : ""}
        ${!ready ? `<span class="muted" style="font-size:12px">preencha as chaves e a URL pública para conectar</span>` : ""}
      </div>
    </form>`;
  };

  const tgStatus = !tg.bot ? `<span class="muted">sem bot</span>`
    : tg.bot.error ? `<span style="color:var(--red)">token inválido: ${esc(tg.bot.error)}</span>`
    : `<span class="ok-dot">@${esc(tg.bot.username)}</span>`;

  box.innerHTML = `
    <h3 class="integ-title">Contas conectadas</h3>
    <div class="integ-grid">
      <form class="integ" data-settings>
        <div class="integ-head"><b>🌐 URL pública do hub</b></div>
        <div class="muted help">Endereço https pelo qual você abre este painel (Tailscale Serve). Usado no login do YouTube/TikTok e nos links do Telegram.</div>
        ${guide("public_url", GUIDES.public_url())}
        ${settingField("public_url", "URL", { placeholder: "https://debian.hedgehog-parrotfish.ts.net:10004" })}
        <div class="actions"><button class="btn small" type="submit">Salvar</button>
          ${!v.public_url.set && location.protocol === "https:" ? `<button class="btn small" type="button" data-use-origin>Usar ${esc(location.origin)}</button>` : ""}</div>
      </form>

      <form class="integ" data-settings>
        <div class="integ-head"><b>✈ Telegram</b>${tgStatus}${v.telegram_chat_id.set ? `<span class="ok-dot">chat ${esc(v.telegram_chat_id.value)}</span>` : ""}</div>
        <div class="muted help">Recebe cada corte pronto com botões Aprovar/Rejeitar e avisa quando publica ou falha.</div>
        ${guide("telegram", GUIDES.telegram())}
        ${settingField("telegram_bot_token", "Token do bot", { secret: true })}
        ${tg.bot && !tg.bot.error && !v.telegram_chat_id.set
          ? (tg.candidates.length
            ? tg.candidates.map((c) => `<div class="conn"><span>💬 ${esc(c.name)} <span class="muted mono">${esc(c.id)}</span></span><button class="btn small ok" type="button" data-authorize-chat="${esc(c.id)}">Autorizar este chat</button></div>`).join("")
            : `<div class="muted">Aguardando uma mensagem para @${esc(tg.bot.username)}… (a lista atualiza sozinha)</div>`)
          : ""}
        <div class="actions">
          <button class="btn small" type="submit">Salvar token</button>
          ${v.telegram_chat_id.set ? `<button class="btn small" type="button" data-tg-test>Enviar teste</button><button class="btn small danger" type="button" data-clear-settings="telegram_chat_id">Trocar chat</button>` : ""}
          ${v.telegram_bot_token.set ? `<button class="btn small danger" type="button" data-clear-settings="telegram_bot_token,telegram_chat_id">Remover bot</button>` : ""}
        </div>
      </form>

      ${platformCard("youtube", ["youtube_client_id", "youtube_client_secret"],
        "Publica os cortes como Shorts no canal conectado. As chaves do app servem para todos os canais; cada canal conecta a própria conta.")}
      ${platformCard("tiktok", ["tiktok_client_key", "tiktok_client_secret"],
        "Envia os cortes como rascunho para a caixa de entrada do app (ou posta direto, com app auditado). Cada canal conecta a própria conta.")}
    </div>
    ${ch ? "" : `<div class="muted">Selecione um canal à esquerda para conectar as contas dele.</div>`}`;
}

async function saveSettingsForm(form) {
  const body = {};
  for (const input of form.querySelectorAll("input[name]")) if (!input.readOnly) body[input.name] = input.value;
  await api("/api/settings", { method: "PUT", body });
  toast("Configuração salva");
  document.activeElement?.blur();
  await loadSettings();
  await refresh();
}

function renderChannels() {
  $("#channel-list").innerHTML = state.channels.map((c) => `<li data-ch="${esc(c.id)}" class="${c.id === ui.channelId ? "sel" : ""}"><b>${esc(c.name)}</b><div class="muted mono">${esc(c.id)}</div></li>`).join("");
  if (ui.channelId === null && state.channels[0]) ui.channelId = state.channels[0].id;
  const ch = state.channels.find((c) => c.id === ui.channelId) || (ui.channelId === "" ? { id: "", name: "", credentials: [], publish_targets: '["youtube","tiktok"]', schedule_slots: "12:00,18:30,21:00" } : null);
  const form = $("#channel-form");
  if (!ch) return (form.innerHTML = "");
  if (form.dataset.for === ch.id && form.contains(document.activeElement)) return; // não sobrescreve enquanto edita
  form.dataset.for = ch.id;
  form.innerHTML =
    CH_FIELDS.map(([k, label, o = {}]) => (k === "h" ? `<h3>${label}</h3>` : `<label class="${o.full ? "full" : ""}">${label}${fieldInput(k, o, ch)}</label>`)).join("") +
    `<h3>Outras credenciais (somente escrita)</h3>
     <div class="full muted" style="font-size:12px">Salvas: ${ch.credentials.length ? ch.credentials.map(esc).join(", ") : "nenhuma"}. Para remover, envie a chave com valor vazio.</div>
     <div class="full cred-row"><input name="cred_key" placeholder="chave"><input name="cred_val" placeholder="valor" type="password"></div>
     <div class="full actions"><button class="btn primary" type="submit">${ch.id ? "Salvar canal" : "Criar canal"}</button></div>`;
}

async function saveChannelForm(e) {
  e.preventDefault();
  const form = e.target;
  const fd = Object.fromEntries(new FormData(form));
  const body = {};
  for (const [k, , o = {}] of CH_FIELDS) {
    if (k === "h") continue;
    if (o.targets) body.publish_targets = JSON.stringify(Object.keys(PLATFORM).filter((p) => fd[`target_${p}`]));
    else if (fd[k] !== undefined) body[k] = o.type === "number" ? Number(fd[k]) : fd[k];
  }
  if (fd.cred_key) body.credentials = { [fd.cred_key]: fd.cred_val };
  const isNew = !form.dataset.for;
  const saved = await api(isNew ? "/api/channels" : `/api/channels/${encodeURIComponent(form.dataset.for)}`, { method: isNew ? "POST" : "PUT", body });
  ui.channelId = saved.id;
  form.dataset.for = "";
  toast("Canal salvo");
  await refresh();
}

// ---------------- Custos ----------------

function renderCosts() {
  const jobs = jobsF().filter((j) => j.model);
  const total = jobs.reduce((s, j) => s + j.cost_usd, 0);
  const tokens = jobs.reduce((s, j) => s + j.tokens_in + j.tokens_out + j.tokens_cache_read + j.tokens_cache_write, 0);
  const nClips = clipsF().length;
  const max = Math.max(...state.daily.map((d) => d.cost_usd), 0.0001);
  $("#costs").innerHTML = `
    <div class="kpis">
      <div class="card kpi"><div class="l">Custo total IA</div><div class="v">${usd(total)}</div></div>
      <div class="card kpi"><div class="l">Tokens</div><div class="v">${fmtN(tokens)}</div></div>
      <div class="card kpi"><div class="l">Vídeos analisados</div><div class="v">${jobs.length}</div></div>
      <div class="card kpi"><div class="l">Custo médio / corte</div><div class="v">${usd(nClips ? total / nClips : 0)}</div></div>
      <div class="card kpi"><div class="l">Custo médio / vídeo</div><div class="v">${usd(jobs.length ? total / jobs.length : 0)}</div></div>
    </div>
    <div class="card"><div class="section-title" style="margin-top:0">Últimos 30 dias</div>
      <div class="daily">${state.daily.map((d) => `<div style="height:${(d.cost_usd / max) * 100}%" data-tip="${d.day}: ${usd(d.cost_usd)} · ${fmtN(d.tokens)} tok"></div>`).join("") || `<span class="muted">Sem dados ainda.</span>`}</div>
    </div>
    <div class="section-title">Por canal</div>
    <div class="card"><table><thead><tr><th>Canal</th><th class="n">Vídeos</th><th class="n">Cortes</th><th class="n">Input</th><th class="n">Cache lido</th><th class="n">Output</th><th class="n">Custo</th></tr></thead><tbody>
      ${state.costs.filter(byChannel).map((c) => `<tr><td>${esc(channelName(c.channel_id))}</td><td class="n">${c.jobs}</td><td class="n">${c.clips}</td><td class="n">${fmtN(c.tokens_in + c.tokens_cache_write)}</td><td class="n">${fmtN(c.tokens_cache_read)}</td><td class="n">${fmtN(c.tokens_out)}</td><td class="n">${usd(c.cost_usd)}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="section-title">Por vídeo</div>
    <div class="card"><table><thead><tr><th>#</th><th>Vídeo</th><th>Modelo</th><th class="n">Duração</th><th class="n">Input</th><th class="n">Output</th><th class="n">Cortes</th><th class="n">Custo</th><th class="n">Custo/corte</th></tr></thead><tbody>
      ${jobs.slice(0, 100).map((j) => {
        const n = state.clips.filter((c) => c.job_id === j.id).length;
        return `<tr><td>${j.id}</td><td>${esc(j.title || j.source)}</td><td class="mono">${esc(j.model)}</td><td class="n">${hms(j.duration)}</td><td class="n">${fmtN(j.tokens_in + j.tokens_cache_write + j.tokens_cache_read)}</td><td class="n">${fmtN(j.tokens_out)}</td><td class="n">${n}</td><td class="n">${usd(j.cost_usd)}</td><td class="n">${usd(n ? j.cost_usd / n : 0)}</td></tr>`;
      }).join("")}
    </tbody></table></div>`;
}

// ---------------- Render geral ----------------

function render() {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === ui.tab));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${ui.tab}`));
  localStorage.setItem("tab", ui.tab);

  const opts = state.channels.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  const filter = $("#channel-filter");
  filter.innerHTML = `<option value="">Todos os canais</option>${opts}`;
  filter.value = ui.channel;
  const jobSel = $("#new-job select");
  const prev = jobSel.value;
  jobSel.innerHTML = opts;
  jobSel.value = prev || ui.channel || state.channels[0]?.id || "";

  renderWorkers();
  renderPipeline();
  renderClipList();
  if (ui.tab === "studio" && studioCtx) {
    const fresh = state.clips.find((c) => c.id === studioCtx.clip.id);
    const prev = studioCtx.clip;
    if (fresh && fresh.rendered_at !== prev.rendered_at) openClip(fresh.id); // novo render = novo proxy/intervalo
    else if (fresh && ["status", "detail", "scheduled_at", "error"].some((k) => fresh[k] !== prev[k]) && !$("#studio-main").contains(document.activeElement)) renderStudioMain();
  }
  if (ui.tab === "channels") {
    renderChannels();
    loadSettings().catch((e) => toast(e.message, true));
  }
  if (ui.tab === "costs") renderCosts();
}

// ---------------- Eventos ----------------

$(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  ui.tab = b.dataset.tab;
  render();
});
$("#channel-filter").addEventListener("change", (e) => {
  ui.channel = e.target.value;
  localStorage.setItem("channel", ui.channel);
  render();
});
$("#new-job").addEventListener("submit", act(async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  const { ids } = await api("/api/jobs", { method: "POST", body: fd });
  e.target.source.value = "";
  toast(`${ids.length} vídeo(s) na fila`);
}));
document.addEventListener("click", act(async (e) => {
  const t = e.target;
  const card = t.closest("[data-clip]");
  if (card && (card.closest("#kanban") || card.closest("#clip-list"))) return openClip(+card.dataset.clip);
  if (t.dataset.clipOpen) return openClip(+t.dataset.clipOpen);
  if (t.dataset.retry) await api(`/api/jobs/${t.dataset.retry}/retry`, { method: "POST" });
  if (t.dataset.del && confirm("Excluir o job e todos os arquivos dele?")) await api(`/api/jobs/${t.dataset.del}`, { method: "DELETE" });
  if (t.dataset.rerender) await api(`/api/clips/${t.dataset.rerender}/rerender`, { method: "POST" });
  if (t.dataset.republish) await api(`/api/clips/${t.dataset.republish}/approve`, { method: "POST", body: { when: "now" } });
  if (t.dataset.disconnect && confirm("Desconectar esta conta do canal?")) {
    await api(`/api/channels/${encodeURIComponent(ui.channelId)}/disconnect/${t.dataset.disconnect}`, { method: "POST" });
    $("#channel-form").dataset.for = "-";
    await refresh();
  }
  if (t.dataset.copy !== undefined) {
    await navigator.clipboard.writeText(t.dataset.copy);
    toast("Copiado");
  }
  if (t.dataset.useOrigin !== undefined) {
    await api("/api/settings", { method: "PUT", body: { public_url: location.origin } });
    await loadSettings();
    await refresh();
  }
  if (t.dataset.authorizeChat) {
    await api("/api/settings/telegram/authorize", { method: "POST", body: { chat_id: t.dataset.authorizeChat } });
    toast("Chat autorizado — enviando mensagem de teste");
    await api("/api/settings/telegram/test", { method: "POST" });
    await loadSettings();
  }
  if (t.dataset.tgTest !== undefined) {
    await api("/api/settings/telegram/test", { method: "POST" });
    toast("Mensagem de teste enviada");
  }
  if (t.dataset.clearSettings && confirm("Remover esta configuração?")) {
    await api("/api/settings", { method: "PUT", body: Object.fromEntries(t.dataset.clearSettings.split(",").map((k) => [k, null])) });
    await loadSettings();
    await refresh();
  }
  const chItem = t.closest("#channel-list li");
  if (chItem) {
    ui.channelId = chItem.dataset.ch;
    $("#channel-form").dataset.for = "-";
    renderChannels();
    renderIntegrations();
  }
  if (t.id === "new-channel") {
    ui.channelId = "";
    $("#channel-form").dataset.for = "-";
    renderChannels();
  }
}));
$("#studio-filter").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  ui.studioFilter = b.dataset.f;
  $$("#studio-filter button").forEach((x) => x.classList.toggle("active", x === b));
  renderClipList();
});
$("#channel-form").addEventListener("submit", act(saveChannelForm));
$("#integrations").addEventListener("toggle", (e) => {
  const id = e.target.dataset?.guide;
  if (!id) return;
  if (e.target.open) openGuides.add(id);
  else openGuides.delete(id);
}, true);
$("#integrations").addEventListener("submit", act(async (e) => {
  e.preventDefault();
  await saveSettingsForm(e.target);
}));
wireStudio();

/** Links vindos do Telegram (#clip=ID) e retorno do OAuth (#channels:plataforma:mensagem). */
function handleHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h) return;
  history.replaceState(null, "", location.pathname);
  const clip = h.match(/^clip=(\d+)$/);
  if (clip) return openClip(+clip[1]);
  const oauth = h.match(/^channels:(\w+):(.*)$/s);
  if (oauth) {
    ui.tab = "channels";
    render();
    toast(oauth[2] === "ok" ? `${PLATFORM[oauth[1]] ?? oauth[1]} conectado` : oauth[2], oauth[2] !== "ok");
  }
}

function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = () => refresh().catch(() => {});
  es.onerror = () => {}; // EventSource reconecta sozinho
}

refresh().then(() => {
  connect();
  handleHash();
  setInterval(renderWorkers, 30_000);
}).catch((e) => toast(e.message, true));
