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

function connectionsBlock(ch) {
  if (!ch.id) return "";
  const integ = state.integrations;
  const row = (p) => {
    const acct = ch.connections?.[p];
    const ready = integ[p];
    return `<div class="conn">
      <b>${PLATFORM[p]}</b>
      ${acct ? `<span class="ok-dot">conectado: ${esc(acct)}</span>` : `<span class="muted">não conectado</span>`}
      ${ready
        ? `<a class="btn small" href="/oauth/${p}/start?channel=${encodeURIComponent(ch.id)}">${acct ? "Reconectar" : "Conectar"}</a>`
        : `<span class="muted" style="font-size:12px">configure ${p === "youtube" ? "YOUTUBE_CLIENT_ID/SECRET" : "TIKTOK_CLIENT_KEY/SECRET"} e PUBLIC_URL no .env do hub</span>`}
      ${acct ? `<button class="btn small danger" type="button" data-disconnect="${p}">Desconectar</button>` : ""}
    </div>`;
  };
  return `<h3>Contas conectadas</h3><div class="full conns">${row("youtube")}${row("tiktok")}
    <div class="conn"><b>✈ Telegram</b>${integ.telegram ? `<span class="ok-dot">bot ativo</span>` : `<span class="muted">configure TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID no .env do hub</span>`}</div></div>`;
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
    connectionsBlock(ch) +
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
  if (ui.tab === "channels") renderChannels();
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
  const chItem = t.closest("#channel-list li");
  if (chItem) {
    ui.channelId = chItem.dataset.ch;
    $("#channel-form").dataset.for = "-";
    renderChannels();
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
