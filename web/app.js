// Dashboard da Central de Cortes — JS puro, sem build. Estado vem de /api/state e é atualizado via SSE.
import { previewConfig, updatePreview } from "./preview.js";

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

let state = { channels: [], jobs: [], clips: [], posts: [], costs: [], daily: [], workers: [], templates: [], assets: [], integrations: {} };
const ui = {
  tab: localStorage.getItem("tab") || "home",
  channel: localStorage.getItem("channel") || "",
  studioFilter: "PENDING_REVIEW",
  clipId: null,
  pvTpl: null, // modelo mostrado na prévia do canal
  pvLayout: "auto",
  kcol: localStorage.getItem("kcol") || "",
  channelId: null,
  sel: new Set(), // cortes marcados para aprovar em lote
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
/** Cortes escolhidos pela IA local (Ollama) quando o Claude estava sem crédito: revisar com mais atenção. */
const isLocalAi = (c) => (state.jobs.find((j) => j.id === c.job_id)?.model || "").startsWith("local/");
const localTag = (c) => (isLocalAi(c) ? `<span class="tag local-ai" title="Escolhido pelo modelo local no PC (o Claude estava sem crédito). Revise com mais atenção.">IA local</span>` : "");
const clipsF = () => state.clips.filter(byChannel);
const channelName = (id) => state.channels.find((c) => c.id === id)?.name ?? id;
const postsOf = (clipId) => state.posts.filter((p) => p.clip_id === clipId && !["PLANNED", "SKIPPED"].includes(p.status));
/** Plataformas com fila própria no canal (ex.: { youtube: "18:30" }) e as que seguem os horários do canal. */
const ownSlotsOf = (ch) => {
  const conf = JSON.parse(ch?.platform_slots || "{}"), targets = JSON.parse(ch?.publish_targets || "[]");
  const own = Object.fromEntries(targets.filter((p) => (conf[p] || "").trim()).map((p) => [p, conf[p].trim()]));
  return Object.keys(own).length >= targets.length ? {} : own;
};
const mainTargetsOf = (ch) => JSON.parse(ch?.publish_targets || "[]").filter((p) => !(p in ownSlotsOf(ch)));
const PICON = { youtube: "▶", tiktok: "♪" };

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
      <div class="meta"><span class="score">${c.score}</span>${hms(c.end_s - c.start_s)}<span class="tag">${esc(c.layout_used || c.layout)}</span>${localTag(c)}</div>
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
    return `<div class="col" data-col="${col.key}" style="--c:${col.color}"><h3>${col.title}<b>${items.length}</b></h3><div class="cards">${items.join("")}</div></div>`;
  }).join("");

  // Celular: uma coluna por vez, escolhida nas abas acima do quadro.
  const counts = COLUMNS.map((col) => $(`#kanban .col[data-col="${col.key}"] h3 b`)?.textContent ?? "0");
  if (!COLUMNS.some((c) => c.key === ui.kcol)) ui.kcol = +counts[4] ? "review" : COLUMNS.find((c, i) => +counts[i])?.key ?? "queue";
  $("#kchips").innerHTML = COLUMNS.map((col, i) =>
    `<button data-kcol="${col.key}" style="--c:${col.color}" class="${col.key === ui.kcol ? "active" : ""}">${col.title.replace(" FFmpeg", "")} <b>${counts[i]}</b></button>`).join("");
  $$("#kanban .col").forEach((el) => el.classList.toggle("on", el.dataset.col === ui.kcol));
  const chip = $("#kchips .active"); // só rola a faixa de abas na horizontal (scrollIntoView mexeria na página)
  if (chip) chip.parentElement.scrollLeft = chip.offsetLeft - chip.parentElement.clientWidth / 2 + chip.clientWidth / 2;

  const failedJobs = jobs.filter((j) => j.status === "FAILED");
  const failedClips = clips.filter((c) => c.status === "FAILED" || c.status === "PUBLISH_FAILED");
  $("#failures").innerHTML =
    failedJobs.length + failedClips.length
      ? `<div class="section-title">Falhas ${failedJobs.length > 1 ? `<button class="btn small" data-retry-all>Tentar todos de novo (${failedJobs.length})</button>` : ""}</div>` +
        failedJobs.map((j) => `<div class="card fail"><b>Job #${j.id}</b><span>${esc(j.title || j.source)}</span><div class="err">${esc(j.error)}</div>
          <button class="btn small" data-retry="${j.id}">Tentar de novo</button><button class="btn small danger" data-del="${j.id}">Excluir</button></div>`).join("") +
        failedClips.map((c) => `<div class="card fail"><b>${c.status === "FAILED" ? "Render" : "Publicação"} · corte #${c.id}</b><span>${esc(c.title)}</span><div class="err">${esc(c.error)}</div>
          ${c.status === "FAILED"
            ? `<button class="btn small" data-rerender="${c.id}">Renderizar de novo</button>`
            : `<button class="btn small" data-republish="${c.id}">Publicar de novo</button>`}
          <button class="btn small" data-clip-open="${c.id}">Abrir</button></div>`).join("")
      : "";
}

// ---------------- Barra lateral e Início ----------------

const logoOf = (ch) => brandOf(ch).logo?.asset;
const avatar = (ch) => (logoOf(ch) ? `<img src="/media/asset/${logoOf(ch)}" alt="" />` : `<b>${esc((ch?.name || "?")[0])}</b>`);

function renderSide() {
  const pend = (id) => state.clips.filter((c) => c.status === "PENDING_REVIEW" && (!id || c.channel_id === id)).length;
  const row = (id, name, av) => {
    const n = pend(id);
    return `<li><button data-channel="${esc(id)}" class="${ui.channel === id ? "active" : ""}"><span class="av">${av}</span><span class="nm">${esc(name)}</span>${n ? `<span class="cnt">${n}</span>` : ""}</button></li>`;
  };
  $("#side-channels").innerHTML = state.channels.map((ch) => row(ch.id, ch.name, avatar(ch))).join("")
    + row("", "Todos os canais", `<b>∗</b>`);
}

/** Anel de score (estilo "progresso"): verde ≥ 85, âmbar ≥ 70, cinza abaixo. */
function ring(score) {
  const r = 15, c = 2 * Math.PI * r, col = score >= 85 ? "#16a34a" : score >= 70 ? "#f59e0b" : "#9ca3af";
  return `<span class="ring" title="Score viral ${score}"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="${r}" class="rbg"/><circle cx="18" cy="18" r="${r}" stroke="${col}" stroke-dasharray="${(c * score) / 100} ${c}" transform="rotate(-90 18 18)"/></svg><b>${score}</b></span>`;
}

function tile(c, { select = false, sub = "" } = {}) {
  const img = c.rendered_at ? `<img src="/media/clip/${c.id}.jpg?v=${encodeURIComponent(c.rendered_at)}" alt="" loading="lazy" />` : `<div class="ph">${c.status === "RENDERING" ? "renderizando…" : ""}</div>`;
  const on = ui.sel.has(c.id);
  return `<div class="tile${on ? " on" : ""}" data-clip="${c.id}">
    <div class="tile-img">${img}${ring(c.score)}
      ${select ? `<label class="pick" title="Selecionar"><input type="checkbox" data-pick="${c.id}" ${on ? "checked" : ""}></label>` : ""}
      <span class="dur">${hms(c.end_s - c.start_s).replace(/\.\d$/, "")}</span></div>
    <div class="tile-t">${esc(c.title)}</div>
    <div class="tile-m">${sub}${localTag(c)}</div>
  </div>`;
}

function renderHome() {
  const ch = state.channels.find((c) => c.id === ui.channel);
  const h = new Date().getHours();
  $("#home-hello").textContent = h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
  $("#home-sub").textContent = ch ? `${ch.name} · cole um vídeo longo e receba cortes prontos para postar.` : "Todos os canais · cole um vídeo longo e receba cortes prontos para postar.";
  $("#new-job select[name=channel_id]").hidden = !!ch;

  const jobs = jobsF(), clips = clipsF();
  const running = jobs.filter((j) => !["DONE", "FAILED"].includes(j.status));
  const rendering = clips.filter((c) => ["RENDER_QUEUED", "RENDERING"].includes(c.status));
  const pending = clips.filter((c) => c.status === "PENDING_REVIEW").sort((a, b) => b.score - a.score);
  const sched = clips.filter((c) => ["SCHEDULED", "PUBLISHING"].includes(c.status)).sort((a, b) => (a.scheduled_at || "").localeCompare(b.scheduled_at || ""));
  const pub = clips.filter((c) => c.status === "PUBLISHED").sort((a, b) => (b.published_at || "").localeCompare(a.published_at || ""));
  for (const id of ui.sel) if (!pending.some((c) => c.id === id)) ui.sel.delete(id);

  $("#home-stats").innerHTML = [
    ["Em andamento", running.length + rendering.length, "pipeline"],
    ["Para aprovar", pending.length, "studio"],
    ["Agendados", sched.length, "agenda"],
    ["Publicados", pub.length, "pipeline"],
  ].map(([l, n, tab]) => `<button data-goto="${tab}"><b>${n}</b>${l}</button>`).join("");

  const section = (title, actions, body) => `<section class="hsec"><div class="hsec-h"><h2>${title}</h2><div class="hsec-a">${actions}</div></div>${body}</section>`;
  let html = "";
  if (running.length) {
    html += section("Em andamento", "", `<div class="runs">${running.map((j) => {
      const p = pct(j.detail);
      return `<div class="run"><div class="run-t">${esc(j.title || j.source)}</div><div class="run-m muted">${ui.channel ? "" : esc(channelName(j.channel_id)) + " · "}${esc(j.detail || j.status.toLowerCase())}</div><div class="bar"><i style="width:${p ?? (j.status === "QUEUED" ? 0 : 35)}%"></i></div></div>`;
    }).join("")}</div>`);
  }
  html += section(`Para aprovar <span class="muted">${pending.length}</span>`,
    pending.length ? `<span id="sel-actions" class="hsec-a">${selActions()}</span><button class="btn small primary" data-approve-all>Aprovar todos (${pending.length})</button>` : "",
    pending.length ? `<div class="grid">${pending.map((c) => tile(c, { select: true, sub: ui.channel ? "" : `<span class="tag">${esc(channelName(c.channel_id))}</span>` })).join("")}</div>`
      : `<p class="empty">Nenhum corte esperando revisão.${rendering.length ? ` ${rendering.length} renderizando.` : ""}</p>`);
  if (sched.length) html += section("Próximos posts", `<button class="btn small" data-goto="agenda">Ver agenda</button>`,
    `<div class="grid">${sched.slice(0, 6).map((c) => tile(c, { sub: `<span class="when">${c.status === "PUBLISHING" ? "publicando…" : when(c.scheduled_at)}${c.schedule_locked ? " 🔒" : ""}</span>` })).join("")}</div>`);
  if (pub.length) html += section("Publicados recentemente", "",
    `<div class="grid">${pub.slice(0, 6).map((c) => tile(c, { sub: postsOf(c.id).map((p) => `<span class="tag ${p.status === "FAILED" ? "bad" : ""}">${PLATFORM[p.platform]}</span>`).join("") })).join("")}</div>`);
  $("#home-body").innerHTML = html;
}

function selActions() {
  const n = ui.sel.size;
  return n
    ? `<button class="btn small" data-sel-clear>Limpar seleção</button><button class="btn small ok" data-approve-sel>Aprovar ${n} selecionado${n > 1 ? "s" : ""}</button>`
    : `<button class="btn small" data-sel-all>Selecionar todos</button>`;
}

async function approveMany(ids) {
  if (!ids.length) return;
  if (!confirm(`Aprovar ${ids.length} corte${ids.length > 1 ? "s" : ""}? Cada um vai para o próximo horário livre do canal.`)) return;
  const r = await api("/api/clips/approve-many", { method: "POST", body: { ids } });
  ui.sel.clear();
  if (r.failed.length) toast(`${r.approved} aprovado(s); ${r.failed.length} não: ${r.failed[0].error}`, true);
  else toast(`${r.approved} corte(s) aprovado(s) e agendado(s)`);
  await refresh();
}

function renderWorkers() {
  const online = state.workers.filter((w) => Date.now() - Date.parse(w.last_seen) < 120_000);
  const el = $("#worker-status");
  el.className = `worker ${online.length ? "on" : "off"}`;
  el.title = state.workers.map((w) => `${w.name}: visto ${when(w.last_seen)} ${w.task ? "— " + w.task : ""}`).join("\n") || "Nenhum worker conectou ainda";
  const d = state.disk;
  const disk = d ? ` · <span class="${d.critical ? "disk-crit" : d.low ? "disk-low" : ""}" title="Espaço livre no notebook${d.critical ? " — worker pausado até liberar espaço" : ""}">💾 ${d.freeGb} GB</span>` : "";
  el.innerHTML = (online.length
    ? `<i></i>${online.map((w) => esc(w.name)).join(", ")}${online.some((w) => w.task) ? " · trabalhando" : " · ocioso"}`
    : `<i></i>worker offline`) + disk;
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
  const nPend = clipsF().filter((c) => c.status === "PENDING_REVIEW").length;
  $("#studio-batch").innerHTML = ui.studioFilter === "PENDING_REVIEW" && nPend > 1
    ? `<div class="studio-batch"><button class="btn small primary" data-approve-all>Aprovar todos (${nPend})</button></div>` : "";
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
  $(".studio").classList.add("open");
  if (matchMedia("(max-width: 900px)").matches) scrollTo(0, 0);
}

function scheduleBlock(c) {
  const posts = postsOf(c.id);
  const postLines = posts.map((p) =>
    `<div>${PLATFORM[p.platform]}: ${p.status === "FAILED" ? `<span style="color:var(--red)">${esc(p.error)}</span>`
      : p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a>` : p.status === "INBOX" ? "rascunho na caixa de entrada do app" : "ok"}</div>`).join("");
  if (c.status === "PENDING_REVIEW") {
    return `<div id="tt-panel"></div><div class="schedule card">
      <button class="btn ok" id="b-approve">Aprovar → próximo horário</button>
      <button class="btn" id="b-now">Publicar agora</button>
      <label class="muted">ou em <input type="datetime-local" id="f-when"></label><button class="btn small" id="b-at">Agendar</button>
    </div>`;
  }
  if (["SCHEDULED", "PUBLISH_FAILED"].includes(c.status)) {
    return `<div id="tt-panel"></div><div class="schedule card">
      <div>${c.status === "SCHEDULED" ? `🗓 Agendado para <b>${when(c.scheduled_at)}</b>${c.schedule_locked ? " (horário fixo)" : " (próximo horário livre)"}` : "⚠️ Falha ao publicar"}</div>
      ${c.error ? `<div class="err">${esc(c.error)}</div>` : ""}
      ${postLines}
      <div class="actions">
        <button class="btn" id="b-now">Publicar agora</button>
        <label class="muted">mudar para <input type="datetime-local" id="f-when"></label><button class="btn small" id="b-at">Salvar horário</button>
        <button class="btn small" id="b-unschedule">Desagendar</button>
        <button class="btn small" id="b-tt-save" hidden>Salvar opções do TikTok</button>
      </div>
    </div>`;
  }
  if (["PUBLISHED", "PUBLISHING"].includes(c.status)) {
    return `<div class="schedule card"><div>${c.status === "PUBLISHING" ? "Publicando…" : `✅ Publicado em ${when(c.published_at)}`}</div>${postLines}</div>`;
  }
  return "";
}

// ---------------- Publicação direta no TikTok (diretrizes do Content Posting API) ----------------
// Conta consultada ao vivo, privacidade sem padrão, interações desmarcadas, divulgação comercial,
// declaração de consentimento e aviso de processamento — o que a auditoria do TikTok verifica.

const TT_PRIVACY = {
  PUBLIC_TO_EVERYONE: "Todos (Everyone)",
  MUTUAL_FOLLOW_FRIENDS: "Amigos (Friends)",
  FOLLOWER_OF_CREATOR: "Seguidores (Followers)",
  SELF_ONLY: "Somente eu (Only me)",
};
const TT_MUSIC = "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en";
const TT_BRANDED = "https://www.tiktok.com/legal/page/global/bc-policy/en";
let tt = null; // { clipId, required, info, error, duration }

async function loadTikTokPanel(clipId) {
  const box = $("#tt-panel");
  if (!box) return;
  const data = await api(`/api/clips/${clipId}/tiktok`).catch((e) => ({ required: true, error: e.message }));
  if (!studioCtx || studioCtx.clip.id !== clipId || !$("#tt-panel")) return;
  tt = { clipId, ...data };
  if (!data.required) {
    box.innerHTML = "";
    return updateApproveButtons();
  }
  const clip = studioCtx.clip;
  const s = data.saved;
  const info = data.info;
  if (!info) {
    box.innerHTML = `<div class="tt card"><b>♪ Publicar no TikTok</b><div class="err">${esc(data.error || "Não foi possível consultar a conta.")}</div>
      <div class="muted">Sem os dados da conta não dá para publicar agora. Tente de novo em alguns minutos.</div></div>`;
    return updateApproveButtons();
  }
  const tooLong = info.max_video_post_duration_sec && data.duration > info.max_video_post_duration_sec;
  const interaction = (key, label, disabled) =>
    `<label class="${disabled ? "off" : ""}" title="${disabled ? "Desativado nas configurações de privacidade da conta do TikTok" : ""}">
      <input type="checkbox" id="tt-${key}" ${disabled ? "disabled" : s?.[`allow_${key}`] ? "checked" : ""}> ${label}</label>`;
  box.innerHTML = `
    <div class="tt card">
      <div class="tt-head">
        ${info.creator_avatar_url ? `<img src="${esc(info.creator_avatar_url)}" alt="">` : ""}
        <div>Publicar no TikTok como <span class="en">Post to TikTok as</span> <b>${esc(info.creator_nickname)}</b> <span class="muted">@${esc(info.creator_username)}</span></div>
      </div>
      ${tooLong ? `<div class="err">Este corte tem ${Math.round(data.duration)} s e a conta aceita vídeos de até ${info.max_video_post_duration_sec} s. Encurte o corte para publicar.</div>` : ""}
      <label>Legenda no TikTok <span class="en">Caption</span>
        <textarea id="tt-title" maxlength="2200" rows="4">${esc(s?.title ?? clip.caption)}</textarea></label>
      <label>Quem pode ver este vídeo <span class="en">Who can view this video</span>
        <select id="tt-privacy">
          <option value="" ${s ? "" : "selected"} disabled>Selecione… (Select)</option>
          ${info.privacy_level_options.map((p) => `<option value="${p}" ${s?.privacy_level === p ? "selected" : ""}>${TT_PRIVACY[p] ?? p}</option>`).join("")}
        </select></label>
      <div class="tt-row">Permitir <span class="en">Allow users to</span>:
        ${interaction("comment", "Comentários (Comment)", info.comment_disabled)}
        ${interaction("duet", "Dueto (Duet)", info.duet_disabled)}
        ${interaction("stitch", "Stitch", info.stitch_disabled)}
      </div>
      <label class="tt-switch"><input type="checkbox" id="tt-commercial" ${s?.brand_organic || s?.brand_content ? "checked" : ""}>
        Divulgar conteúdo comercial <span class="en">Disclose video content</span> <span class="muted">— indique se este vídeo promove uma marca, produto ou serviço</span></label>
      <div id="tt-commercial-box" class="tt-commercial">
        <label><input type="checkbox" id="tt-brand-organic" ${s?.brand_organic ? "checked" : ""}> <b>Sua marca</b> <span class="en">Your brand</span> <span class="muted">— você está promovendo você mesmo ou o seu próprio negócio</span></label>
        <label><input type="checkbox" id="tt-brand-content" ${s?.brand_content ? "checked" : ""}> <b>Conteúdo de marca</b> <span class="en">Branded content</span> <span class="muted">— você está promovendo outra marca ou um terceiro</span></label>
        <div id="tt-label-hint" class="tt-hint"></div>
      </div>
      <p id="tt-decl" class="tt-decl"></p>
      <p class="muted" style="font-size:12px;margin:0">Depois de publicado, o vídeo pode levar alguns minutos para ser processado e aparecer no perfil. <span class="en">After posting, it may take a few minutes for the content to process and be visible on your profile.</span></p>
    </div>`;
  syncTikTokPanel();
}

/** Aplica as regras de divulgação comercial e atualiza declaração, rótulo e botões. */
function syncTikTokPanel() {
  if (!tt?.info || !$("#tt-panel .tt")) return updateApproveButtons();
  const commercial = $("#tt-commercial").checked;
  $("#tt-commercial-box").hidden = !commercial;
  if (!commercial) {
    $("#tt-brand-organic").checked = false;
    $("#tt-brand-content").checked = false;
  }
  const organic = $("#tt-brand-organic").checked;
  const branded = $("#tt-brand-content").checked;
  const privacy = $("#tt-privacy");
  const selfOnly = privacy.querySelector('option[value="SELF_ONLY"]');
  if (selfOnly) {
    selfOnly.disabled = branded;
    selfOnly.title = branded ? "A visibilidade de conteúdo de marca não pode ser privada. / Branded content visibility cannot be set to private." : "";
  }
  if (branded && privacy.value === "SELF_ONLY") {
    privacy.value = "";
    toast("A visibilidade de conteúdo de marca não pode ser privada. / Branded content visibility cannot be set to private.", true);
  }
  $("#tt-label-hint").textContent = !commercial ? ""
    : branded ? "Seu vídeo será rotulado como 'Parceria paga'. / Your video will be labeled as 'Paid partnership'."
    : organic ? "Seu vídeo será rotulado como 'Conteúdo promocional'. / Your video will be labeled as 'Promotional content'."
    : "Você precisa indicar se o conteúdo promove você mesmo, um terceiro ou ambos. / You need to indicate if your content promotes yourself, a third party, or both.";
  $("#tt-decl").innerHTML = branded
    ? `Ao publicar, você concorda com a <a href="${TT_BRANDED}" target="_blank" rel="noopener">Branded Content Policy</a> e a <a href="${TT_MUSIC}" target="_blank" rel="noopener">Music Usage Confirmation</a> do TikTok.<br><span class="en">By posting, you agree to TikTok's <a href="${TT_BRANDED}" target="_blank" rel="noopener">Branded Content Policy</a> and <a href="${TT_MUSIC}" target="_blank" rel="noopener">Music Usage Confirmation</a>.</span>`
    : `Ao publicar, você concorda com a <a href="${TT_MUSIC}" target="_blank" rel="noopener">Music Usage Confirmation</a> do TikTok.<br><span class="en">By posting, you agree to TikTok's <a href="${TT_MUSIC}" target="_blank" rel="noopener">Music Usage Confirmation</a>.</span>`;
  updateApproveButtons();
}

/** null = válido; string = motivo para bloquear o envio. */
function tiktokProblem() {
  if (!tt?.required) return null;
  if (!tt.info) return tt.error || "Conta do TikTok indisponível";
  if (tt.info.max_video_post_duration_sec && tt.duration > tt.info.max_video_post_duration_sec) return "Corte mais longo que o permitido pela conta";
  if (!$("#tt-privacy")?.value) return "Escolha quem pode ver o vídeo no TikTok";
  if ($("#tt-commercial").checked && !$("#tt-brand-organic").checked && !$("#tt-brand-content").checked) {
    return "Você precisa indicar se o conteúdo promove você mesmo, um terceiro ou ambos.";
  }
  if (!$("#tt-title").value.trim()) return "Escreva a legenda do TikTok";
  return null;
}

function tiktokChoices() {
  if (!tt?.required) return undefined;
  return {
    title: $("#tt-title").value,
    privacy_level: $("#tt-privacy").value,
    allow_comment: !!$("#tt-comment")?.checked,
    allow_duet: !!$("#tt-duet")?.checked,
    allow_stitch: !!$("#tt-stitch")?.checked,
    brand_organic: $("#tt-brand-organic").checked,
    brand_content: $("#tt-brand-content").checked,
  };
}

function updateApproveButtons() {
  const problem = tiktokProblem();
  const save = $("#b-tt-save");
  if (save) save.hidden = !tt?.required;
  for (const b of $$("#b-approve, #b-now, #b-at")) {
    b.disabled = !!problem;
    b.title = problem || "";
  }
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
    <button class="btn m-only back" id="b-back">← Lista de cortes</button>
    <div>
      <div class="phone">${rendered ? `<video src="/media/clip/${fresh.id}.mp4?v=${v}" controls playsinline></video>` : `<p class="empty">${fresh.status === "FAILED" ? "Falhou: " + esc(fresh.error) : "Renderizando…<br>" + esc(fresh.detail || "")}</p>`}</div>
      <div class="actions" style="margin-top:10px">
        ${!["PUBLISHED", "PUBLISHING"].includes(fresh.status) ? `<button class="btn danger" id="b-reject">Rejeitar</button>` : ""}
        ${rendered ? `<a class="btn" href="/media/clip/${fresh.id}.mp4?download">Baixar</a>` : ""}
      </div>
    </div>
    <div class="editor">
      <div class="status-line"><span class="score">${fresh.score}</span><span class="tag">${esc(fresh.status)}</span>${localTag(fresh)}
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
      ${montageBlock(fresh)}
      <div class="actions">
        <button class="btn primary" id="b-save" ${["PUBLISHED", "PUBLISHING"].includes(fresh.status) ? "disabled" : ""}>Salvar e re-renderizar</button>
        <button class="btn" id="b-save-caption">Salvar só a legenda</button>
        <button class="btn" id="b-copy">Copiar legenda</button>
        <span class="muted" style="align-self:center">Layout usado no render: <b>${esc(fresh.layout_used || "—")}</b></span>
      </div>
    </div>`;
  drawTrim();
  refreshClipPreview();
  tt = null;
  if ($("#tt-panel")) loadTikTokPanel(fresh.id);
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
    if (e.target.id?.startsWith("tt-")) syncTikTokPanel();
  });
  box.addEventListener("change", (e) => {
    if (e.target.id?.startsWith("tt-")) syncTikTokPanel();
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
        overrides: collectOverrides(studioCtx.clip), speaker_name: $("#o-name").value.trim(), speaker_role: $("#o-role").value.trim(),
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
    // O clique em Aprovar/Publicar é o consentimento explícito do envio ao TikTok, com as opções escolhidas acima.
    if (["b-approve", "b-now", "b-at", "b-tt-save"].includes(t.id)) {
      const problem = tiktokProblem();
      if (problem) throw new Error(problem);
    }
    if (t.id === "b-approve") {
      const c = await api(`/api/clips/${id}/approve`, { method: "POST", body: { tiktok: tiktokChoices() } });
      toast(`Agendado para ${when(c.scheduled_at)}`);
      nextPending(id);
    }
    if (t.id === "b-now") {
      await api(`/api/clips/${id}/approve`, { method: "POST", body: { when: "now", tiktok: tiktokChoices() } });
      toast(tt?.required ? "Publicando agora — pode levar alguns minutos para aparecer no perfil do TikTok" : "Publicando agora");
    }
    if (t.id === "b-at") {
      const v = $("#f-when").value;
      if (!v) throw new Error("Escolha data e hora");
      const c = await api(`/api/clips/${id}/approve`, { method: "POST", body: { when: new Date(v).toISOString(), tiktok: tiktokChoices() } });
      toast(`Agendado para ${when(c.scheduled_at)}`);
    }
    if (t.id === "b-tt-save") {
      const c = studioCtx.clip;
      await api(`/api/clips/${id}/approve`, { method: "POST", body: { when: c.schedule_locked ? c.scheduled_at : undefined, tiktok: tiktokChoices() } });
      toast("Opções do TikTok salvas");
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
    $(".studio").classList.remove("open");
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
  ["min_duration", "Duração mínima sem modelo (s)", { type: "number" }],
  ["max_duration", "Duração máxima sem modelo (s)", { type: "number" }],
  ["h", "Legendas"],
  ["highlight_color", "Cor de destaque", { type: "color" }],
  ["max_words_per_frame", "Palavras por quadro (2–4)", { type: "number" }],
  ["title_banner", "Faixa com o título no vídeo (vira a capa)", { select: [["1", "Sim"], ["0", "Não"]] }],
  ["title_style", "Títulos dos posts", { select: [["upper", "CAIXA ALTA"], ["sentence", "Caixa normal (só a primeira letra)"]] }],
  ["banner_color", "Cor da faixa", { type: "color" }],
  ["banner_text_color", "Cor do texto da faixa", { type: "color" }],
  ["caption_template", "Template de legenda social — {titulo_corte} {url_com_timestamp} {url_video_original} {timestamp_segundos} {fonte} {titulo_video} {pilar} {hashtags_assunto}", { area: true, full: true, rows: 10 }],
  ["h", "Agenda e publicação"],
  ["schedule_slots", "Horários diários (HH:MM separados por vírgula)", { full: true }],
  ["platform_slots_youtube", "Horários só do YouTube (vazio = os mesmos acima). Com horários próprios, o YouTube recebe os melhores cortes aprovados, um por horário", { full: true }],
  ["publish_targets", "Publicar em", { targets: true, full: true }],
  ["youtube_privacy", "YouTube: visibilidade", { select: ["public", "unlisted", "private"] }],
  ["youtube_category", "YouTube: categoria", { select: [["25", "Notícias e política"], ["22", "Pessoas e blogs"], ["24", "Entretenimento"], ["27", "Educação"], ["17", "Esportes"], ["26", "Estilo e dicas"]] }],
  ["tiktok_mode", "TikTok: modo", { select: [["inbox", "Rascunho na caixa de entrada (sem auditoria)"], ["direct", "Publicação direta — visibilidade e interações escolhidas a cada aprovação (app auditado; reconecte a conta após trocar)"], ["browser", "Navegador (robô no TikTok Studio — publica direto, sem app aprovado)"]] }],
  ["webhook_url", "Webhook após publicar (opcional)", { full: true }],
];

function fieldInput(k, o, ch) {
  const raw = k.startsWith("platform_slots_") ? JSON.parse(ch.platform_slots || "{}")[k.slice(15)] ?? "" : ch[k] ?? "";
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
    `Os escopos só aparecem depois que o produto correspondente é adicionado: <code>video.upload</code> e <code>video.publish</code> vêm do <b>Content Posting API</b>. Se a busca em "Add scopes" não achar, adicione o produto primeiro e clique em <b>Apply changes</b>.`,
    `Para usar já, sem esperar aprovação: crie um <b>Sandbox</b>. Ele tem configuração própria — repita nele <b>Products</b> (Login Kit + Content Posting API, com o mesmo Redirect URI) e <b>Scopes</b>, adicione sua conta em <b>Add account</b> (target users) e use as chaves do sandbox.`,
    `Copie <b>Client key</b> e <b>Client secret</b> (da tela do app ou do sandbox) para os campos abaixo e salve. Depois clique em <b>Conectar conta</b>.`,
    `<b>Publicação automática (sem tocar no celular):</b> o TikTok exige auditoria do app. O Estúdio e o Telegram já têm as telas que a revisão cobra. Siga <code>docs/tiktok-auditoria.md</code> no projeto: páginas públicas de termos/privacidade, app de produção com Direct Post, roteiro do vídeo de demonstração e os textos do formulário. Até ser auditado, postagens diretas saem privadas — por isso o padrão é o rascunho na caixa de entrada.`,
  ],
};

/** Robô do TikTok (modo Navegador): login próprio de cada canal, feito pela tela remota. */
function robotBlock(ch) {
  const r = ch.robot ?? {};
  const screen = esc(state.integrations.robotScreen);
  const status = r.pending
    ? `<span class="tt-hint">Janela de login aberta: entre na conta de ${esc(ch.name)} na <a href="${screen}" target="_blank" rel="noopener">tela remota do robô</a> e clique em Concluir.</span>`
    : r.saved
      ? `<span class="ok-dot">login salvo em ${when(r.saved)}${ch.tiktok_mode === "browser" ? " · publicando pelo robô" : " · modo atual não é o robô"}</span>`
      : `<span class="muted">sem login neste canal</span>`;
  return `<div class="robot-box">
    <div class="integ-head"><b>🤖 Robô do TikTok</b> ${status}</div>
    <div class="muted help">Publica direto pelo TikTok Studio, sem app aprovado. Cada canal tem a própria sessão; o robô nunca mistura contas.</div>
    <div class="actions">
      ${r.pending
        ? `<a class="btn small" href="${screen}" target="_blank" rel="noopener">Abrir tela remota</a>
           <button class="btn small primary" type="button" data-robot="finish">Concluir login</button>
           <button class="btn small" type="button" data-robot="cancel">Cancelar</button>`
        : `<button class="btn small primary" type="button" data-robot="login">${r.saved ? "Refazer login" : "Entrar no TikTok pelo robô"}</button>
           ${r.saved ? "" : `<button class="btn small" type="button" data-robot="adopt-main" title="Para quem já fez login na janela principal da tela remota">Usar a conta da janela principal</button>`}
           ${r.saved ? `<button class="btn small danger" type="button" data-robot="logout">Sair</button>` : ""}`}
    </div>
  </div>`;
}

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
      ${p === "tiktok" && ch ? robotBlock(ch) : ""}
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

      <div class="integ">
        <div class="integ-head"><b>⬇ YouTube para downloads</b>
          ${settingsData.youtubeDownload?.loggedIn ? '<span class="ok-dot">conta logada no robô</span>' : '<span class="muted">sem conta</span>'}</div>
        <div class="muted help">Quando o YouTube bloqueia os downloads ("confirme que você não é um robô"), o worker baixa com uma sessão logada do YouTube. Use uma conta secundária: ela só é usada para assistir vídeos públicos.</div>
        ${guide("ytcookies", `<ol>
          <li>No Chrome do seu PC, instale a extensão <b>Get cookies.txt LOCALLY</b> e, nos detalhes dela, ative <b>Permitir no modo anônimo</b>.</li>
          <li>Abra uma <b>janela anônima</b>, entre em <code>youtube.com</code> com a conta secundária.</li>
          <li>Na mesma aba, abra <code>youtube.com/robots.txt</code>, clique na extensão e em <b>Export</b> (formato Netscape).</li>
          <li><b>Feche a janela anônima</b> sem sair da conta (assim a sessão exportada não é trocada).</li>
          <li>Clique em <b>Enviar cookies.txt</b> aqui e escolha o arquivo baixado.</li>
        </ol>`)}
        ${settingsData.youtubeDownload?.uploaded ? `<div class="muted" style="font-size:12px">cookies.txt enviado em ${when(settingsData.youtubeDownload.uploaded)}</div>` : ""}
        <div class="actions">
          <label class="btn small primary">Enviar cookies.txt<input type="file" hidden accept=".txt,text/plain" data-yt-cookies></label>
          ${settingsData.youtubeDownload?.uploaded ? `<button class="btn small danger" type="button" data-yt-cookies-remove>Remover</button>` : ""}
          <button class="btn small" type="button" data-yt-login title="O Google pode recusar login em navegador automatizado">Tentar login pelo robô</button>
        </div>
      </div>

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
  if (ch.id) {
    renderBrand();
    renderTemplates();
    schedulePreview();
  }
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
    else if (k.startsWith("platform_slots_")) {
      const cur = JSON.parse(state.channels.find((c) => c.id === form.dataset.for)?.platform_slots || "{}");
      body.platform_slots = JSON.stringify({ ...cur, [k.slice(15)]: (fd[k] || "").trim() });
    }
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

// ---------------- Identidade do canal e modelos de corte ----------------

const USE_LABELS = {
  banner: "Faixa de título", intro: "Vinheta de abertura", outro: "Vinheta de encerramento", cta: "Pedido de inscrição",
  logo: "Logo", music: "Trilha de fundo", lower_third: "Lower third (nome e cargo)", credit: "Crédito da fonte",
};
const LAYOUTS = [["auto", "Automático (a IA decide)"], ["single_speaker", "Uma pessoa"], ["split_screen", "Tela dividida"], ["screen_share_focus", "Conteúdo + quem comenta"]];
const ASSET_SLOTS = [
  ["intro", "Vinheta de abertura", "video/*,.mkv"],
  ["outro", "Vinheta de encerramento", "video/*,.mkv"],
  ["cta", "Pedido de inscrição (animação)", "video/*,.webm,.mov,image/png,image/gif"],
  ["logo", "Logo / marca d'água", "image/png,image/jpeg,image/webp"],
  ["music", "Trilha de fundo", "audio/*"],
];
const FONTS = ["Oswald", "Barlow SemiBold", "Anton", "Archivo SemiBold", "Arial Black", "Montserrat ExtraBold", "Impact", "Bebas Neue"];
const useOf = (t) => new Set(JSON.parse(t?.use_items || '["banner"]'));
const brandOf = (ch) => JSON.parse(ch?.brand || "{}");
const opt = (pairs, cur) => pairs.map(([v, l]) => `<option value="${v}" ${String(cur) === v ? "selected" : ""}>${esc(l)}</option>`).join("");
const openTpls = new Set();

function fillTemplateSelect() {
  const chId = $("#new-job select[name=channel_id]").value;
  const sel = $("#new-job select[name=template_id]");
  const ch = state.channels.find((c) => c.id === chId);
  const prev = sel.dataset.ch === chId ? sel.value : "";
  sel.innerHTML = state.templates.filter((t) => t.channel_id === chId)
    .map((t) => `<option value="${t.id}">${esc(t.name)}${t.id === ch?.default_template ? " (padrão)" : ""}</option>`).join("");
  sel.value = prev || String(ch?.default_template || "");
  sel.dataset.ch = chId;
}

/** Modelo usado pelo corte: o do job, ou o padrão do canal para jobs antigos. */
function tplOf(c) {
  const job = state.jobs.find((j) => j.id === c.job_id);
  const ch = state.channels.find((x) => x.id === c.channel_id);
  return state.templates.find((t) => t.id === (job?.template_id || ch?.default_template));
}

function montageBlock(c) {
  const t = tplOf(c);
  const base = useOf(t);
  const ov = JSON.parse(c.overrides || "{}");
  const on = (k) => ov.use?.[k] ?? base.has(k);
  const silence = ov.remove_silence ?? !!t?.remove_silence;
  const teaserOk = c.teaser_end > c.teaser_start;
  const teaser = (ov.teaser ?? t?.hook === "teaser") && teaserOk;
  return `<details class="card montage" open>
    <summary><b>Montagem deste corte</b> <span class="muted">modelo ${esc(t?.name ?? "—")} · ${esc(c.aspect || "9:16")} · mude só o que for diferente aqui</span></summary>
    <div class="montage-grid"><div><div id="pv-clip"></div><div class="muted pv-note">Prévia ao vivo: legenda de exemplo; o vídeo final usa as falas reais.</div></div><div>
    <div class="checks wrap">
      ${Object.entries(USE_LABELS).map(([k, l]) => `<label><input type="checkbox" data-use="${k}" ${on(k) ? "checked" : ""}> ${l}</label>`).join("")}
      <label><input type="checkbox" id="o-silence" ${silence ? "checked" : ""}> Remover silêncios</label>
      <label class="${teaserOk ? "" : "muted"}"><input type="checkbox" id="o-teaser" ${teaser ? "checked" : ""} ${teaserOk ? "" : "disabled"}>
        Teaser no início ${teaserOk ? `(${(c.teaser_end - c.teaser_start).toFixed(1)}s)` : "(a IA não sugeriu)"}</label>
    </div>
    <div class="fields">
      <label>Pedido de inscrição em <input id="o-cta" value="${esc(ov.cta_at ?? "")}" placeholder="${esc(t?.cta_at || "padrão do canal")} (70%, fim, -5, 12)"></label>
      <label>Nome no lower third <input id="o-name" value="${esc(c.speaker_name || "")}" placeholder="vazio = sem lower third"></label>
      <label class="full">Cargo / função <input id="o-role" value="${esc(c.speaker_role || "")}"></label>
    </div>
    </div></div>
  </details>`;
}

/** Só guarda o que difere do modelo: mudar o modelo depois continua valendo para o resto. */
function collectOverrides(c) {
  const t = tplOf(c);
  const base = useOf(t);
  const ov = {};
  for (const el of $$("[data-use]")) if (el.checked !== base.has(el.dataset.use)) (ov.use ??= {})[el.dataset.use] = el.checked;
  const s = $("#o-silence").checked;
  if (s !== !!t?.remove_silence) ov.remove_silence = s;
  const te = $("#o-teaser");
  if (!te.disabled && te.checked !== (t?.hook === "teaser")) ov.teaser = te.checked;
  const cta = $("#o-cta").value.trim();
  if (cta) ov.cta_at = cta;
  return ov;
}

function renderBrand() {
  const box = $("#brand");
  const ch = state.channels.find((c) => c.id === ui.channelId);
  if (!ch) return (box.innerHTML = "");
  const assets = state.assets.filter((a) => a.channel_id === ch.id);
  const sig = ch.id + ch.brand + assets.map((a) => a.id).join();
  if (box.dataset.sig === sig || (box.dataset.for === ch.id && box.contains(document.activeElement))) return;
  box.dataset.sig = sig;
  box.dataset.for = ch.id;
  const b = brandOf(ch);
  const active = { intro: b.intro, outro: b.outro, cta: b.cta?.asset, logo: b.logo?.asset, music: b.music?.asset };
  const zones = b.safe_zones ?? JSON.parse(ch.publish_targets || "[]").filter((z) => z !== "reels");
  const extra = {
    cta: `<label>Momento <input name="cta_at" value="${esc(b.cta?.at ?? "70%")}" placeholder="70%, fim, -5 ou 12"></label>
      <label>Posição <select name="cta_position">${opt([["bottom", "Acima da legenda"], ["center", "Centro"], ["top", "Topo"]], b.cta?.position ?? "bottom")}</select></label>
      <label>Largura (fração da tela) <input name="cta_scale" type="number" step="0.05" min="0.1" max="1" value="${b.cta?.scale ?? 0.6}"></label>
      <label>Fundo <select name="cta_key">${opt([["none", "Transparente (.webm/.mov/.png)"], ["green", "Verde (chroma key)"]], b.cta?.key ?? "none")}</select></label>`,
    logo: `<label>Posição <select name="logo_position">${opt([["top-right", "Topo direita"], ["top-left", "Topo esquerda"], ["bottom-right", "Baixo direita"], ["bottom-left", "Baixo esquerda"]], b.logo?.position ?? "top-right")}</select></label>
      <label>Opacidade (0–1) <input name="logo_opacity" type="number" step="0.05" min="0.1" max="1" value="${b.logo?.opacity ?? 0.85}"></label>
      <label>Largura (fração da tela) <input name="logo_scale" type="number" step="0.01" min="0.05" max="0.5" value="${b.logo?.scale ?? 0.16}"></label>`,
    music: `<label>Volume (0–1) <input name="music_volume" type="number" step="0.01" min="0" max="1" value="${b.music?.volume ?? 0.1}"></label>`,
  };
  box.innerHTML = `<form id="brand-form">
    <h3 class="integ-title">Identidade visual e assets</h3>
    <p class="muted help">Configure uma vez e todo corte novo já sai no padrão. Cada modelo de corte escolhe quais destes itens entram, e cada corte pode mudar isso no Estúdio.</p>
    <div class="asset-grid">${ASSET_SLOTS.map(([kind, label, accept]) => {
      const mine = assets.filter((a) => a.kind === kind);
      const cur = active[kind];
      return `<div class="asset"><b>${label}</b>
        <select name="a_${kind}"><option value="">— nenhum —</option>${mine.map((a) => `<option value="${a.id}" ${a.id === cur ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select>
        <div class="actions"><label class="btn small">Enviar arquivo<input type="file" hidden data-upload="${kind}" accept="${accept}"></label>
          ${cur ? `<a class="btn small" href="/media/asset/${cur}" target="_blank">Ver</a><button type="button" class="btn small danger" data-del-asset="${cur}">Apagar</button>` : ""}</div>
        ${extra[kind] ?? ""}</div>`;
    }).join("")}</div>
    <div class="form">
      <h3>Faixa de título (capa nos primeiros 2 s)</h3>
      <label>Estilo <select name="banner_style">${opt([["brush", "Tarja de pincel (cor da faixa + texto)"], ["bar", "Capa: título grande, uma palavra em destaque e barra embaixo"]], b.banner?.style ?? "brush")}</select></label>
      <label>Fonte do título <input name="banner_font" value="${esc(b.banner?.font ?? "")}" placeholder="padrão (Impact)" list="dl-fonts"></label>
      <label>Tamanho do título <input name="banner_size" type="number" min="60" max="400" value="${b.banner?.size ?? ""}" placeholder="padrão"></label>
      <label>Letras por linha <input name="banner_wrap" type="number" min="8" max="40" value="${b.banner?.wrap ?? 15}"></label>
      <label>Inclinação (graus) <input name="banner_tilt" type="number" step="0.5" min="-10" max="10" value="${b.banner?.tilt ?? 2}"></label>
      <label>Sombra chapada (cor) <input name="banner_shadow" type="color" value="${b.banner?.shadow_color || "#000000"}"></label>
      <label>Deslocamento da sombra (px) <input name="banner_shadow_offset" type="number" min="0" max="40" value="${b.banner?.shadow_offset ?? 10}"></label>
      <div class="full checks wrap">
        <label><input type="checkbox" name="banner_persist" ${b.banner?.persist ? "checked" : ""}> Fica o vídeo inteiro</label>
        <label><input type="checkbox" name="banner_full" ${b.banner?.full_width ? "checked" : ""}> Largura total, bordas rasgadas</label>
        <label><input type="checkbox" name="banner_top" ${b.banner?.top ? "checked" : ""}> Colada na margem do topo</label>
        <label><input type="checkbox" name="banner_solid_shadow" ${b.banner?.shadow_color ? "checked" : ""}> Usar sombra chapada</label>
      </div>
      <h3>Legendas</h3>
      <label>Fonte <input name="sub_font" value="${esc(b.subtitle?.font ?? "")}" placeholder="padrão do worker" list="dl-fonts"><datalist id="dl-fonts">${FONTS.map((f) => `<option value="${f}">`).join("")}</datalist></label>
      <label>Tamanho <input name="sub_size" type="number" min="40" max="160" value="${b.subtitle?.size ?? 84}"></label>
      <label>Cor do texto <input name="sub_color" type="color" value="${b.subtitle?.color ?? "#FFFFFF"}"></label>
      <label>Cor de destaque <input type="color" value="${ch.highlight_color}" disabled title="Edite em Legendas, no formulário do canal abaixo"></label>
      <label>Contorno (px) <input name="sub_outline" type="number" min="0" max="20" value="${b.subtitle?.outline ?? 6}"></label>
      <label>Cor do contorno <input name="sub_outline_color" type="color" value="${b.subtitle?.outline_color ?? "#000000"}"></label>
      <label>Sombra (px) <input name="sub_shadow" type="number" min="0" max="20" value="${b.subtitle?.shadow ?? 3}"></label>
      <label>Palavra falada <select name="sub_active">${opt([["color", "Cor de destaque + aumento"], ["scale", "Só aumento (cor só na palavra-chave)"]], b.subtitle?.active ?? "color")}</select></label>
      <h3>Crédito da fonte</h3>
      <label>Texto <input name="credit_format" value="${esc(b.credit?.format ?? "Fonte: {fonte}")}" placeholder="via {fonte}"></label>
      <label>Fonte <input name="credit_font" value="${esc(b.credit?.font ?? "")}" placeholder="a da legenda" list="dl-fonts"></label>
      <label>Cor <input name="credit_color" type="color" value="${b.credit?.color ?? "#FFFFFF"}"></label>
      <label class="checks"><input type="checkbox" name="credit_box" ${b.credit?.box !== false ? "checked" : ""}> Caixa escura atrás</label>
      <div class="full muted" style="font-size:12px">{fonte} vira o @ do canal de onde o vídeo veio. Com o logo no canto superior esquerdo, o crédito fica logo abaixo dele.</div>
      <h3>Pilares de conteúdo</h3>
      <label class="full">Pilares (separados por vírgula) <input name="pillars" value="${esc((b.pillars ?? []).join(", "))}" placeholder="ex.: TREINO, MENTALIDADE"></label>
      <div class="full muted" style="font-size:12px">A IA classifica cada corte em um pilar: ele aparece como tag na capa e vira {pilar} na legenda social.</div>
      <h3>Lower third</h3>
      <label>Cor da caixa do nome <input name="lt_color" type="color" value="${b.lower_third?.color ?? ch.banner_color}"></label>
      <label>Cor do texto <input name="lt_text" type="color" value="${b.lower_third?.text_color ?? "#FFFFFF"}"></label>
      <label>Duração na tela (s) <input name="lt_duration" type="number" min="1" max="15" value="${b.lower_third?.duration ?? 4}"></label>
      <h3>Zonas seguras</h3>
      <div class="full checks wrap">${[["tiktok", "TikTok"], ["youtube", "YouTube Shorts"], ["reels", "Instagram Reels"]].map(([z, l]) => `<label><input type="checkbox" name="zone_${z}" ${zones.includes(z) ? "checked" : ""}> ${l}</label>`).join("")}</div>
      <div class="full muted" style="font-size:12px">Legenda, logo, CTA e lower third ficam fora das áreas cobertas pela interface das plataformas marcadas.</div>
      <label>Margens exatas: topo <input name="safe_top" type="number" min="0" value="${b.safe_insets?.top ?? ""}" placeholder="auto"></label>
      <label>base <input name="safe_bottom" type="number" min="0" value="${b.safe_insets?.bottom ?? ""}" placeholder="auto"></label>
      <label>esquerda <input name="safe_left" type="number" min="0" value="${b.safe_insets?.left ?? ""}" placeholder="auto"></label>
      <label>direita <input name="safe_right" type="number" min="0" value="${b.safe_insets?.right ?? ""}" placeholder="auto"></label>
      <div class="full actions"><button class="btn primary" type="submit">Salvar identidade</button></div>
    </div>
  </form>`;
}

function brandFromForm(form) {
  const fd = Object.fromEntries(new FormData(form));
  const id = (k) => (fd[`a_${k}`] ? Number(fd[`a_${k}`]) : null);
  return {
    intro: id("intro"), outro: id("outro"),
    cta: { asset: id("cta"), at: fd.cta_at, position: fd.cta_position, scale: Number(fd.cta_scale), key: fd.cta_key },
    logo: { asset: id("logo"), position: fd.logo_position, opacity: Number(fd.logo_opacity), scale: Number(fd.logo_scale) },
    music: { asset: id("music"), volume: Number(fd.music_volume) },
    subtitle: {
      font: fd.sub_font, size: Number(fd.sub_size), color: fd.sub_color, outline: Number(fd.sub_outline), shadow: Number(fd.sub_shadow),
      outline_color: fd.sub_outline_color, active: fd.sub_active,
    },
    lower_third: { color: fd.lt_color, text_color: fd.lt_text, duration: Number(fd.lt_duration) },
    safe_zones: ["tiktok", "youtube", "reels"].filter((z) => fd[`zone_${z}`]),
    safe_insets: ["top", "bottom", "left", "right"].every((k) => fd[`safe_${k}`] !== "")
      ? { top: Number(fd.safe_top), bottom: Number(fd.safe_bottom), left: Number(fd.safe_left), right: Number(fd.safe_right) }
      : null,
    banner: {
      style: fd.banner_style, font: fd.banner_font, size: Number(fd.banner_size) || undefined, wrap: Number(fd.banner_wrap) || 15,
      tilt: Number(fd.banner_tilt), persist: !!fd.banner_persist, full_width: !!fd.banner_full, top: !!fd.banner_top,
      shadow_color: fd.banner_solid_shadow ? fd.banner_shadow : "", shadow_offset: Number(fd.banner_shadow_offset),
    },
    credit: { format: fd.credit_format, font: fd.credit_font, color: fd.credit_color, box: !!fd.credit_box },
    pillars: String(fd.pillars || "").split(",").map((p) => p.trim().toUpperCase()).filter(Boolean),
  };
}

async function saveBrand(e) {
  e.preventDefault();
  await api(`/api/channels/${encodeURIComponent(ui.channelId)}/brand`, { method: "PUT", body: brandFromForm(e.target) });
  $("#brand").dataset.sig = "";
  toast("Identidade salva — vale para os próximos renders");
  await refresh();
}

async function uploadAsset(input) {
  const file = input.files[0];
  if (!file) return;
  toast(`Enviando ${file.name}…`);
  const r = await fetch(`/api/channels/${encodeURIComponent(ui.channelId)}/assets?kind=${input.dataset.upload}&name=${encodeURIComponent(file.name)}`, {
    method: "POST", headers: { "content-type": "application/octet-stream" }, body: file,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  $("#brand").dataset.sig = "";
  toast(`${file.name} enviado e ativado`);
  await refresh();
}

function renderTemplates() {
  const box = $("#templates");
  const ch = state.channels.find((c) => c.id === ui.channelId);
  if (!ch) return (box.innerHTML = "");
  const list = state.templates.filter((t) => t.channel_id === ch.id);
  const sig = ch.id + ch.default_template + JSON.stringify(list);
  if (box.dataset.sig === sig || (box.dataset.for === ch.id && box.contains(document.activeElement))) return;
  box.dataset.sig = sig;
  box.dataset.for = ch.id;
  box.innerHTML = `<h3 class="integ-title">Modelos de corte</h3>
    <p class="muted help">Cada vídeo enviado no Pipeline usa um modelo. Ele define formato, duração, layout, se corta silêncios, como abre e quais itens da identidade entram.</p>
    ${list.map((t) => {
      const use = useOf(t);
      const layout = LAYOUTS.find(([v]) => v === t.layout)?.[1] ?? t.layout;
      return `<details class="tpl" data-tpl-open="${t.id}" ${openTpls.has(t.id) ? "open" : ""}>
        <summary><b>${esc(t.name)}</b> ${t.id === ch.default_template ? '<span class="tag">padrão</span>' : ""} <span class="muted">${t.aspect} · ${t.min_duration}–${t.max_duration}s · ${esc(layout)}</span></summary>
        <form class="form tpl-form" data-tpl="${t.id}">
          <label>Nome <input name="name" value="${esc(t.name)}"></label>
          <label>Proporção <select name="aspect">${opt([["9:16", "9:16 (vertical)"], ["16:9", "16:9 (horizontal)"]], t.aspect)}</select></label>
          <label>Duração mínima (s) <input name="min_duration" type="number" value="${t.min_duration}"></label>
          <label>Duração máxima (s) <input name="max_duration" type="number" value="${t.max_duration}"></label>
          <label>Layout <select name="layout">${opt(LAYOUTS, t.layout)}</select></label>
          <label>Abertura <select name="hook">${opt([["inicio", "Começa no gancho"], ["teaser", "Teaser: repete a fala mais forte no início"]], t.hook)}</select></label>
          <label>Tamanho da legenda (×) <input name="sub_scale" type="number" step="0.05" min="0.5" max="2" value="${t.sub_scale}"></label>
          <label>Zoom de ritmo a cada (s, 0 = só nas ênfases) <input name="zoom_every" type="number" step="0.5" min="0" max="30" value="${t.zoom_every ?? 0}"></label>
          <label>Pedido de inscrição em <input name="cta_at" value="${esc(t.cta_at)}" placeholder="padrão do canal"></label>
          <div class="full checks wrap">
            <label><input type="checkbox" name="remove_silence" ${t.remove_silence ? "checked" : ""}> Remover silêncios</label>
            ${Object.entries(USE_LABELS).map(([k, l]) => `<label><input type="checkbox" name="use_${k}" ${use.has(k) ? "checked" : ""}> ${l}</label>`).join("")}
          </div>
          <label class="full">Instruções para a IA neste formato <textarea name="instructions" rows="3">${esc(t.instructions)}</textarea></label>
          <div class="full actions"><button class="btn primary" type="submit">Salvar modelo</button>
            ${t.id !== ch.default_template ? `<button type="button" class="btn" data-tpl-default="${t.id}">Tornar padrão</button>` : ""}
            <button type="button" class="btn danger" data-tpl-del="${t.id}">Apagar</button></div>
        </form></details>`;
    }).join("")}
    <button class="btn" type="button" id="new-template">+ Novo modelo</button>`;
}

function tplFromForm(form) {
  const fd = Object.fromEntries(new FormData(form));
  return {
    name: fd.name, aspect: fd.aspect, min_duration: Number(fd.min_duration), max_duration: Number(fd.max_duration), layout: fd.layout,
    hook: fd.hook, sub_scale: Number(fd.sub_scale), cta_at: fd.cta_at, instructions: fd.instructions,
    remove_silence: !!fd.remove_silence, use: Object.keys(USE_LABELS).filter((k) => fd[`use_${k}`]),
    zoom_every: Number(fd.zoom_every) || 0,
  };
}

async function saveTemplate(form) {
  await api(`/api/templates/${form.dataset.tpl}`, { method: "PUT", body: tplFromForm(form) });
  $("#templates").dataset.sig = "";
  toast("Modelo salvo — vale para os próximos vídeos");
  await refresh();
}

// ---------- Prévia ao vivo ----------

/** Vídeo de exemplo: proxy de um corte recente do canal (pendentes primeiro, que ainda têm proxy no hub). */
function sampleBg(channelId) {
  const withProxy = state.clips.filter((c) => c.channel_id === channelId && c.proxy_end > c.proxy_start);
  const c = withProxy.find((x) => x.status === "PENDING_REVIEW") ?? withProxy[0];
  return c ? { url: `/media/clip/${c.id}.proxy.mp4`, start: c.start_s - c.proxy_start + 5 } : null;
}

let pvQueued = false;
function schedulePreview() {
  if (pvQueued) return;
  pvQueued = true;
  setTimeout(() => {
    pvQueued = false;
    if (ui.tab === "channels") refreshChannelPreview();
    if (ui.tab === "studio") refreshClipPreview();
  }, 30);
}

/** Prévia da tela do canal: usa os valores dos formulários como estão (antes de salvar). */
function refreshChannelPreview() {
  const wrap = $("#pv-channel-wrap");
  const ch = state.channels.find((c) => c.id === ui.channelId);
  if (!ch) return (wrap.innerHTML = "");
  const tpls = state.templates.filter((t) => t.channel_id === ch.id);
  if (!tpls.some((t) => t.id === ui.pvTpl)) ui.pvTpl = ch.default_template || tpls[0]?.id;
  if (wrap.dataset.ch !== ch.id || wrap.dataset.tpls !== tpls.map((t) => t.id + t.name).join()) {
    wrap.dataset.ch = ch.id;
    wrap.dataset.tpls = tpls.map((t) => t.id + t.name).join();
    wrap.innerHTML = `<h3 class="integ-title">Prévia ao vivo</h3>
      <div class="pv-ctl"><label>Modelo <select data-pv-tpl>${tpls.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>
      <label>Layout <select data-pv-layout>${opt(LAYOUTS, ui.pvLayout)}</select></label></div>
      <div id="pv-channel"></div>
      <div class="muted pv-note">Mostra as mudanças antes de salvar. Legenda e nomes são de exemplo.</div>`;
  }
  $("[data-pv-tpl]", wrap).value = String(ui.pvTpl);
  const tplForm = $(`.tpl-form[data-tpl="${ui.pvTpl}"]`);
  const tpl = tplForm ? tplFromForm(tplForm) : (() => {
    const t = state.templates.find((x) => x.id === ui.pvTpl);
    return t && { ...t, use: [...useOf(t)] };
  })();
  const chForm = $("#channel-form");
  const live = chForm?.dataset.for === ch.id ? Object.fromEntries(new FormData(chForm)) : {};
  updatePreview($("#pv-channel"), previewConfig({
    ch: { ...ch, ...live },
    brand: $("#brand-form") && $("#brand").dataset.for === ch.id ? brandFromForm($("#brand-form")) : brandOf(ch),
    tpl,
    use: new Set(tpl?.use ?? ["banner"]),
    layout: ui.pvLayout !== "auto" ? ui.pvLayout : tpl?.layout,
    title: "Ninguém esperava essa resposta no meio do debate",
    speaker: { name: "Nome do Convidado", role: "Cargo ou função" },
    source: "@canaloriginal",
    keywords: ["ninguém"],
    assets: state.assets.filter((a) => a.channel_id === ch.id),
    bg: sampleBg(ch.id),
    main: 20,
  }));
}

/** Prévia do corte aberto no Estúdio, com as sobrescritas ainda não salvas. */
function refreshClipPreview() {
  const el = $("#pv-clip");
  if (!el || !studioCtx) return;
  const c = studioCtx.clip;
  const ch = state.channels.find((x) => x.id === c.channel_id);
  if (!ch) return;
  const t = tplOf(c);
  const job = state.jobs.find((j) => j.id === c.job_id);
  updatePreview(el, previewConfig({
    ch,
    brand: brandOf(ch),
    tpl: { ...t, aspect: c.aspect || t?.aspect },
    use: useOf(t),
    overrides: collectOverrides(c),
    layout: $("#f-layout")?.value || c.layout,
    title: $("#f-title")?.value || c.title,
    speaker: { name: $("#o-name")?.value.trim() ?? "", role: $("#o-role")?.value.trim() ?? "" },
    source: job?.uploader || job?.title || c.video_title,
    pillar: c.pillar,
    keywords: JSON.parse(c.keywords || "[]"),
    assets: state.assets.filter((a) => a.channel_id === ch.id),
    bg: studioCtx.hasProxy ? { url: `/media/clip/${c.id}.proxy.mp4?v=${encodeURIComponent(c.rendered_at || "")}`, start: studioCtx.start - studioCtx.proxyStart } : null,
    main: Math.max(3, studioCtx.end - studioCtx.start),
  }));
}

for (const sel of ["#brand", "#templates", "#channel-form"]) {
  $(sel).addEventListener("input", schedulePreview);
  $(sel).addEventListener("change", schedulePreview);
}
$("#templates").addEventListener("focusin", (e) => {
  const f = e.target.closest(".tpl-form");
  if (f && Number(f.dataset.tpl) !== ui.pvTpl) {
    ui.pvTpl = Number(f.dataset.tpl);
    schedulePreview();
  }
});
$("#pv-channel-wrap").addEventListener("change", (e) => {
  if (e.target.matches("[data-pv-tpl]")) ui.pvTpl = Number(e.target.value);
  if (e.target.matches("[data-pv-layout]")) ui.pvLayout = e.target.value;
  schedulePreview();
});
$("#studio-main").addEventListener("input", schedulePreview);
$("#studio-main").addEventListener("change", schedulePreview);

$("#brand").addEventListener("submit", act(saveBrand));
$("#brand").addEventListener("change", act(async (e) => {
  if (e.target.dataset.upload) await uploadAsset(e.target);
}));
$("#brand").addEventListener("click", act(async (e) => {
  const del = e.target.dataset.delAsset;
  if (del && confirm("Apagar este arquivo? Ele sai de todos os próximos renders.")) {
    await api(`/api/assets/${del}`, { method: "DELETE" });
    $("#brand").dataset.sig = "";
    await refresh();
  }
}));
$("#templates").addEventListener("submit", act(async (e) => {
  e.preventDefault();
  await saveTemplate(e.target);
}));
$("#templates").addEventListener("toggle", (e) => {
  const id = Number(e.target.dataset?.tplOpen);
  if (!id) return;
  if (e.target.open) openTpls.add(id);
  else openTpls.delete(id);
}, true);
$("#templates").addEventListener("click", act(async (e) => {
  const t = e.target;
  if (t.id === "new-template") {
    const tpl = await api(`/api/channels/${encodeURIComponent(ui.channelId)}/templates`, { method: "POST", body: { name: "Novo modelo", use: ["banner", "logo"] } });
    openTpls.add(tpl.id);
  }
  if (t.dataset.tplDefault) {
    await api(`/api/channels/${encodeURIComponent(ui.channelId)}`, { method: "PUT", body: { default_template: Number(t.dataset.tplDefault) } });
    toast("Modelo padrão alterado");
  }
  if (t.dataset.tplDel && confirm("Apagar este modelo? Vídeos já processados com ele passam a usar o modelo padrão.")) {
    await api(`/api/templates/${t.dataset.tplDel}`, { method: "DELETE" });
  }
  if (t.id === "new-template" || t.dataset.tplDefault || t.dataset.tplDel) {
    $("#templates").dataset.sig = "";
    await refresh();
  }
}));

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
        return `<tr><td>${j.id}</td><td>${esc(j.title || j.source)}</td><td class="mono">${j.model.startsWith("local/") ? "🖥 " + esc(j.model.slice(6)) : esc(j.model)}</td><td class="n">${hms(j.duration)}</td><td class="n">${fmtN(j.tokens_in + j.tokens_cache_write + j.tokens_cache_read)}</td><td class="n">${fmtN(j.tokens_out)}</td><td class="n">${n}</td><td class="n">${usd(j.cost_usd)}</td><td class="n">${usd(n ? j.cost_usd / n : 0)}</td></tr>`;
      }).join("")}
    </tbody></table></div>`;
}

// ---------------- Render geral ----------------

function render() {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === ui.tab));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${ui.tab}`));
  localStorage.setItem("tab", ui.tab);

  const opts = state.channels.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  const jobSel = $("#new-job select[name=channel_id]");
  const prev = jobSel.value;
  jobSel.innerHTML = opts;
  jobSel.value = ui.channel || prev || state.channels[0]?.id || "";
  fillTemplateSelect();

  renderSide();
  renderWorkers();
  renderHome();
  renderPipeline();
  renderClipList();
  $(".studio").classList.toggle("open", !!(ui.clipId && studioCtx));
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
  if (ui.tab === "perf") renderPerf();
  if (ui.tab === "agenda") renderAgenda();
}

// ---------------- Agenda (calendário) ----------------

const CH_COLORS = ["#2563eb", "#db2777", "#0d9488", "#f59e0b", "#7c3aed"];
const chColor = (id) => CH_COLORS[Math.max(0, state.channels.findIndex((c) => c.id === id)) % CH_COLORS.length];
const DOW = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const pad2 = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const startOfWeek = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // semana começa na segunda
  return x;
};
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const localInput = (d) => `${dayKey(d)}T${hhmm(d)}`;

ui.cal = { view: localStorage.getItem("calView") || "week", anchor: new Date() };

/** Itens da agenda: agendados (movíveis) e publicados (histórico, fixos). */
function calItems() {
  const clips = clipsF();
  const byId = new Map(clips.map((c) => [c.id, c]));
  const chOf = (c) => state.channels.find((x) => x.id === c.channel_id);
  const items = clips.flatMap((c) => {
    const at = c.status === "PUBLISHED" ? c.published_at : ["SCHEDULED", "PUBLISHING", "PUBLISH_FAILED"].includes(c.status) ? c.scheduled_at : null;
    if (!at) return [];
    const plats = mainTargetsOf(chOf(c));
    const views = postsOf(c.id).filter((p) => plats.includes(p.platform)).reduce((a, p) => a + (p.views || 0), 0);
    return [{ c, at: new Date(at), movable: c.status === "SCHEDULED" || c.status === "PUBLISH_FAILED", views, plats }];
  });
  // Posts das filas próprias (ex.: YouTube 1x/dia): planejados (movíveis), publicados e com falha.
  for (const p of state.posts) {
    const c = byId.get(p.clip_id);
    if (!c || !p.scheduled_at || p.status === "SKIPPED" || !(p.platform in ownSlotsOf(chOf(c)))) continue;
    items.push({ c, post: p, at: new Date(p.scheduled_at), movable: p.status === "PLANNED", views: p.views || 0, plats: [p.platform] });
  }
  return items;
}

function evChip(it, compact = false) {
  const { c, post } = it;
  const cls = post
    ? (post.status === "PLANNED" ? "" : post.status === "FAILED" ? "bad" : "done")
    : c.status === "PUBLISHED" ? "done" : c.status === "PUBLISH_FAILED" ? "bad" : c.status === "PUBLISHING" ? "busy" : "";
  const locked = post ? post.locked : c.schedule_locked;
  const icons = (it.plats || []).map((p) => PICON[p]).join("");
  return `<div class="ev ${cls}${post ? " ev-post" : ""}" ${post ? `data-post="${post.id}"` : `data-ev="${c.id}"`} ${it.movable ? 'draggable="true"' : ""} style="--c:${chColor(c.channel_id)}" title="${icons} ${esc(c.title)}${!ui.channel ? " · " + esc(channelName(c.channel_id)) : ""}">
    ${!compact && c.rendered_at ? `<img src="/media/clip/${c.id}.jpg?v=${encodeURIComponent(c.rendered_at)}" alt="" loading="lazy">` : ""}
    <span class="ev-b">${compact
      ? `<span class="ev-n"><b>${icons} ${hhmm(it.at)}${locked && it.movable ? "🔒" : ""}</b>${esc(c.title)}</span>`
      : `<span class="ev-t">${icons} ${hhmm(it.at)}${locked && it.movable ? " 🔒" : ""}${!it.movable && it.views ? ` · ${kfmt(it.views)} views` : ""}</span><span class="ev-n">${esc(c.title)}</span>`}</span>
  </div>`;
}

function renderAgenda() {
  const { view } = ui.cal;
  const items = calItems();
  const now = new Date();
  const selCh = state.channels.find((c) => c.id === ui.channel);
  const slots = selCh ? [selCh.schedule_slots, ...Object.values(ownSlotsOf(selCh))].join(",").split(/[,\s]+/).filter(Boolean) : [];
  let label, body;

  if (view === "week") {
    const start = startOfWeek(ui.cal.anchor);
    const days = [...Array(7)].map((_, i) => addDays(start, i));
    const end = addDays(start, 7);
    const inWeek = items.filter((it) => it.at >= start && it.at < end);
    const h0 = Math.min(6, ...inWeek.map((it) => it.at.getHours()));
    label = `${days[0].toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })} – ${days[6].toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" })}`;
    const byCell = new Map();
    for (const it of inWeek) {
      const k = `${dayKey(it.at)}|${it.at.getHours() * 60 + (it.at.getMinutes() >= 30 ? 30 : 0)}`;
      byCell.set(k, [...(byCell.get(k) ?? []), it]);
    }
    let cells = `<div class="wk-h"></div>` + days.map((d) => `<div class="wk-h ${dayKey(d) === dayKey(now) ? "today" : ""}">${DOW[d.getDay()]} <b>${d.getDate()}</b></div>`).join("");
    for (let m = h0 * 60; m < 24 * 60; m += 30) {
      cells += `<div class="wk-t">${m % 60 ? "" : pad2(m / 60) + ":00"}</div>`;
      for (const d of days) {
        const t = new Date(d);
        t.setHours(0, m, 0, 0);
        const its = (byCell.get(`${dayKey(d)}|${m}`) ?? []).sort((a, b) => a.at - b.at);
        const slot = slots.includes(`${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`);
        cells += `<div class="wk-c ${m % 60 ? "half" : ""} ${t < now ? "past" : ""} ${slot ? "slot" : ""}" data-drop="${t.toISOString()}">${its.map((it) => evChip(it)).join("")}</div>`;
      }
    }
    body = `<div class="wk-wrap"><div class="wk">${cells}</div></div>`;
  } else {
    const first = new Date(ui.cal.anchor.getFullYear(), ui.cal.anchor.getMonth(), 1);
    const start = startOfWeek(first);
    label = first.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
    const byDay = new Map();
    for (const it of items) byDay.set(dayKey(it.at), [...(byDay.get(dayKey(it.at)) ?? []), it]);
    let cells = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"].map((d) => `<div class="mo-h">${d}</div>`).join("");
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const its = (byDay.get(dayKey(d)) ?? []).sort((a, b) => a.at - b.at);
      const endOfDay = addDays(d, 1);
      cells += `<div class="mo-c ${d.getMonth() !== first.getMonth() ? "out" : ""} ${dayKey(d) === dayKey(now) ? "today" : ""} ${endOfDay < now ? "past" : ""}" data-drop-day="${dayKey(d)}">
        <span class="mo-d">${d.getDate()}</span>${its.slice(0, 4).map((it) => evChip(it, true)).join("")}${its.length > 4 ? `<button class="mo-more" data-cal-day="${dayKey(d)}">+${its.length - 4}</button>` : ""}</div>`;
    }
    body = `<div class="mo">${cells}</div>`;
  }

  const upcoming = items.filter((it) => it.movable && !it.post && it.at >= now).sort((a, b) => a.at - b.at);
  const last = upcoming.at(-1);
  $("#agenda").innerHTML = `
    <div class="cal-bar">
      <div class="cal-nav"><button class="btn small" data-cal="prev" aria-label="Anterior">‹</button><button class="btn small" data-cal="today">Hoje</button><button class="btn small" data-cal="next" aria-label="Próximo">›</button></div>
      <h1>${esc(label)}</h1>
      <div class="seg cal-view"><button data-cal-view="week" class="${view === "week" ? "active" : ""}">Semana</button><button data-cal-view="month" class="${view === "month" ? "active" : ""}">Mês</button></div>
      ${ui.channel ? `<button class="btn small" data-cal-rebalance title="Reorganiza nos horários do canal os cortes que não foram movidos à mão (🔒 ficam onde estão)">Redistribuir</button>` : ""}
    </div>
    ${selCh && Object.keys(ownSlotsOf(selCh)).length ? `<p class="muted cal-sub">${Object.entries(ownSlotsOf(selCh)).map(([p, s]) => `${PICON[p]} ${PLATFORM[p].slice(2)}: fila própria às ${esc(s)}`).join(" · ")} · ${mainTargetsOf(selCh).map((p) => PICON[p] + " " + PLATFORM[p].slice(2)).join(", ")}: ${esc(selCh.schedule_slots)}</p>` : ""}
    <p class="muted cal-sub">${upcoming.length} agendado${upcoming.length === 1 ? "" : "s"}${last ? ` · fila até ${last.at.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}` : ""} · arraste um corte para outro horário ou clique nele para ajustar.${ui.channel ? " As faixas marcadas são os horários do canal." : ""}</p>
    ${!ui.channel ? `<div class="cal-legend">${state.channels.map((c) => `<span><i style="background:${chColor(c.id)}"></i>${esc(c.name)}</span>`).join("")}</div>` : ""}
    ${body}`;
}

function openEvDialog(id) {
  const c = state.clips.find((x) => x.id === id);
  if (!c) return;
  const at = new Date(c.status === "PUBLISHED" ? c.published_at : c.scheduled_at);
  const movable = ["SCHEDULED", "PUBLISH_FAILED"].includes(c.status);
  const dlg = $("#ev-dialog");
  dlg.innerHTML = `<form method="dialog" class="ev-dlg">
    <div class="ev-dlg-top">${c.rendered_at ? `<img src="/media/clip/${c.id}.jpg?v=${encodeURIComponent(c.rendered_at)}" alt="">` : ""}
      <div><b>${esc(c.title)}</b><div class="muted" style="font-size:12px;margin-top:4px">${esc(channelName(c.channel_id))} · ${c.status === "PUBLISHED" ? "publicado " + when(c.published_at) : when(c.scheduled_at)}${c.schedule_locked ? " · 🔒 horário fixado à mão" : ""}</div>
      ${c.error && movable ? `<div class="err" style="margin-top:6px;font-size:12px;color:var(--red)">${esc(c.error)}</div>` : ""}</div></div>
    ${movable ? `<label>Horário <input type="datetime-local" name="at" value="${localInput(at)}" step="300"></label>` : ""}
    <div class="actions">
      ${movable ? `<button class="btn primary" value="save" data-ev-act="save" data-id="${c.id}">Salvar horário</button>` : ""}
      ${movable && c.schedule_locked ? `<button class="btn" data-ev-act="auto" data-id="${c.id}" title="Volta para a fila automática nos horários do canal">Horário automático</button>` : ""}
      ${movable ? `<button class="btn" data-ev-act="now" data-id="${c.id}">Publicar agora</button>` : ""}
      <button class="btn" data-ev-act="open" data-id="${c.id}">Abrir no Estúdio</button>
      ${movable ? `<button class="btn danger" data-ev-act="unschedule" data-id="${c.id}">Tirar da agenda</button>` : ""}
      <button class="btn" value="cancel" formnovalidate>Fechar</button>
    </div></form>`;
  dlg.showModal();
}

function openPostDialog(postId) {
  const p = state.posts.find((x) => x.id === postId);
  const c = p && state.clips.find((x) => x.id === p.clip_id);
  if (!c) return;
  const planned = p.status === "PLANNED";
  const dlg = $("#ev-dialog");
  dlg.innerHTML = `<form method="dialog" class="ev-dlg">
    <div class="ev-dlg-top">${c.rendered_at ? `<img src="/media/clip/${c.id}.jpg?v=${encodeURIComponent(c.rendered_at)}" alt="">` : ""}
      <div><b>${esc(c.title)}</b><div class="muted" style="font-size:12px;margin-top:4px">${PLATFORM[p.platform]} · ${esc(channelName(c.channel_id))} · ${when(p.scheduled_at)}${p.locked ? " · 🔒 horário fixado à mão" : ""}${planned ? "" : " · " + (p.status === "FAILED" ? "falhou" : "publicado")}</div>
      ${p.error ? `<div style="margin-top:6px;font-size:12px;color:var(--red)">${esc(p.error)}</div>` : ""}</div></div>
    ${planned ? `<label>Horário no ${PLATFORM[p.platform].slice(2)} <input type="datetime-local" name="at" value="${localInput(new Date(p.scheduled_at))}" step="300"></label>` : ""}
    <div class="actions">
      ${planned ? `<button class="btn primary" data-post-act="save" data-id="${p.id}">Salvar horário</button>` : ""}
      ${planned && p.locked ? `<button class="btn" data-post-act="auto" data-id="${p.id}">Horário automático</button>` : ""}
      ${planned ? `<button class="btn" data-post-act="now" data-id="${p.id}">Publicar agora</button>` : ""}
      <button class="btn" data-post-act="open" data-id="${p.id}">Abrir no Estúdio</button>
      ${planned ? `<button class="btn danger" data-post-act="skip" data-id="${p.id}">Não postar no ${PLATFORM[p.platform].slice(2)}</button>` : ""}
      <button class="btn" value="cancel" formnovalidate>Fechar</button>
    </div></form>`;
  dlg.showModal();
}

async function movePost(id, body, msg) {
  if (body.when && body.when !== "now" && Date.parse(body.when) < Date.now() + 5 * 60_000) throw new Error("Escolha um horário no futuro");
  await api(`/api/posts/${id}/move`, { method: "POST", body });
  toast(msg);
  await refresh();
}

async function moveClip(id, at) {
  if (at.getTime() < Date.now() + 5 * 60_000) throw new Error("Escolha um horário no futuro");
  await api(`/api/clips/${id}/approve`, { method: "POST", body: { when: at.toISOString() } });
  toast(`Movido para ${when(at.toISOString())} 🔒`);
  await refresh();
}

// ---------------- Desempenho ----------------

const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(".", ",") + " mi" : n >= 1e4 ? Math.round(n / 1e3) + " mil" : fmtN(Math.round(n)));
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
ui.perfPlat = "all";

/** Cortes publicados do filtro atual com as métricas da plataforma escolhida. */
function perfRows() {
  const plat = ui.perfPlat === "all" ? null : ui.perfPlat;
  return clipsF().filter((c) => c.status === "PUBLISHED").map((c) => {
    const ps = postsOf(c.id).filter((p) => p.metrics_at && (!plat || p.platform === plat));
    const sum = (k, pl) => ps.filter((p) => !pl || p.platform === pl).reduce((a, p) => a + (p[k] || 0), 0);
    const views = sum("views");
    const job = state.jobs.find((j) => j.id === c.job_id);
    return {
      c, job, measured: ps.length > 0, views, yt: sum("views", "youtube"), tt: sum("views", "tiktok"),
      v48: ps.length && ps.every((p) => p.views48 != null) ? ps.reduce((a, p) => a + p.views48, 0) : null,
      likes: sum("likes"), comments: sum("comments"), shares: sum("shares"), saves: sum("saves"),
      eng: views ? (sum("likes") + sum("comments") + sum("shares")) / views : 0,
      age: (Date.now() - Date.parse(c.published_at || 0)) / 86400_000,
    };
  });
}

const LAYOUT_PT = { single_speaker: "1 pessoa", split_screen: "tela dividida", screen_share_focus: "tela/slide" };
const durBucket = (d) => (d < 30 ? "até 30s" : d < 45 ? "30–45s" : d < 60 ? "45–60s" : d < 75 ? "60–75s" : "75s+");

/** Fatores avaliados: [nome, função que dá o grupo do corte, tipo]. */
const FACTORS = [
  ["Dia da semana", (r) => DOW[new Date(r.c.published_at).getDay()], "quando"],
  ["Horário", (r) => pad2(new Date(r.c.published_at).getHours()) + "h", "quando"],
  ["Período do dia", (r) => { const h = new Date(r.c.published_at).getHours(); return h < 6 ? "madrugada" : h < 12 ? "manhã" : h < 18 ? "tarde" : "noite"; }, "quando"],
  ["Pilar", (r) => r.c.pillar, "conteúdo"],
  ["Modelo de corte", (r) => state.templates.find((t) => t.id === r.job?.template_id)?.name ?? "", "conteúdo"],
  ["Vídeo de origem", (r) => r.job?.uploader || "", "conteúdo"],
  ["Duração", (r) => durBucket(r.c.end_s - r.c.start_s), "formato"],
  ["Layout", (r) => LAYOUT_PT[r.c.layout_used || r.c.layout] ?? "", "formato"],
  ["Tamanho do título", (r) => (r.c.title.length < 40 ? "curto (<40)" : r.c.title.length <= 60 ? "médio (40–60)" : "longo (60+)"), "formato"],
  ["Falante identificado", (r) => (r.c.speaker_name ? "sim" : "não"), "formato"],
  ["Teaser no início", (r) => (r.c.teaser_end > r.c.teaser_start ? "sim" : "não"), "formato"],
  ["Score da IA", (r) => (r.c.score >= 90 ? "90+" : r.c.score >= 80 ? "80–89" : "até 79"), "IA"],
];

/**
 * Quanto cada fator explica da variação das views (ε², sobre log das views: um viral não domina tudo).
 * ε² desconta o acaso de ter muitos grupos pequenos; 0 = não explica nada.
 */
function factorEffects(rows, val) {
  const ys = rows.map((r) => Math.log10(1 + val(r)));
  return FACTORS.map(([name, keyOf, kind]) => {
    const groups = new Map();
    rows.forEach((r, i) => {
      const k = keyOf(r);
      if (k === "" || k == null) return;
      const g = groups.get(k) ?? { ys: [], vs: [] };
      g.ys.push(ys[i]); g.vs.push(val(r)); groups.set(k, g);
    });
    const list = [...groups].map(([k, g]) => ({ k, n: g.ys.length, med: median(g.vs), mean: g.ys.reduce((a, b) => a + b, 0) / g.ys.length }))
      .sort((a, b) => b.med - a.med);
    const all = [...groups.values()].flatMap((g) => g.ys);
    const N = all.length, k = list.length;
    let eff = 0;
    if (k >= 2 && N > k && list.filter((g) => g.n >= 2).length >= 2) {
      const mu = all.reduce((a, b) => a + b, 0) / N;
      const sst = all.reduce((a, y) => a + (y - mu) ** 2, 0);
      const ssb = list.reduce((a, g) => a + g.n * (g.mean - mu) ** 2, 0);
      const msw = (sst - ssb) / (N - k);
      eff = sst ? Math.max(0, (ssb - (k - 1) * msw) / sst) : 0;
    }
    return { name, kind, groups: list, eff, n: N, ok: k >= 2 && list.filter((g) => g.n >= 2).length >= 2 };
  }).sort((a, b) => b.eff - a.eff || (b.ok ? 1 : 0) - (a.ok ? 1 : 0));
}

function groupBars(groups) {
  const max = Math.max(1, ...groups.map((g) => g.med));
  return `<div class="hbars">${groups.map((g, i) => `<div class="hbar ${i === 0 && groups.length > 1 ? "best" : ""}"><span class="hl" title="${esc(g.k)}">${esc(g.k)}</span><span class="ht"><i style="width:${(g.med / max) * 100}%"></i></span><b>${kfmt(g.med)}</b><span class="muted">${g.n} corte${g.n > 1 ? "s" : ""}</span></div>`).join("")}</div>`;
}

function heatmap(rows, val) {
  const hours = [...new Set(rows.map((r) => new Date(r.c.published_at).getHours()))].sort((a, b) => a - b);
  if (!hours.length) return "";
  const cell = new Map();
  for (const r of rows) {
    const d = new Date(r.c.published_at);
    const k = `${(d.getDay() + 6) % 7}|${d.getHours()}`;
    cell.set(k, [...(cell.get(k) ?? []), val(r)]);
  }
  const meds = [...cell.values()].map(median);
  const max = Math.max(1, ...meds);
  const days = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];
  return `<div class="heat" style="grid-template-columns: 44px repeat(${hours.length}, minmax(44px, 1fr))">
    <span></span>${hours.map((h) => `<span class="heat-h">${pad2(h)}h</span>`).join("")}
    ${days.map((d, di) => `<span class="heat-d">${d}</span>${hours.map((h) => {
      const vs = cell.get(`${di}|${h}`);
      if (!vs) return `<span class="heat-c empty"></span>`;
      const m = median(vs);
      return `<span class="heat-c" style="--a:${0.12 + 0.88 * Math.sqrt(m / max)}" title="${d} ${pad2(h)}h — mediana ${fmtN(Math.round(m))} views em ${vs.length} corte(s)">${kfmt(m)}<small>${vs.length}</small></span>`;
    }).join("")}`).join("")}
  </div>`;
}

const strength = (e) => (e >= 0.25 ? "forte" : e >= 0.1 ? "moderado" : e > 0.02 ? "fraco" : "nenhum claro");

function renderPerf() {
  const rows = perfRows();
  const m = rows.filter((r) => r.measured);
  const tot = (k) => m.reduce((a, r) => a + r[k], 0);
  const views = tot("views");
  const ms = state.metrics || {};
  const errs = Object.entries(ms.errors || {}).filter(([k]) => !ui.channel || k.startsWith(ui.channel + ":"));
  const ch = state.channels.find((c) => c.id === ui.channel);

  // Base da comparação: só cortes com 48 h+ (os novos ainda estão crescendo). Com histórico suficiente,
  // usa as views de cada corte aos 48 h, que é a comparação mais justa.
  const sample = m.filter((r) => r.age >= 2);
  const use48 = sample.length >= 6 && sample.filter((r) => r.v48 != null).length / sample.length >= 0.8;
  const base = use48 ? sample.filter((r) => r.v48 != null) : sample;
  const val = use48 ? (r) => r.v48 : (r) => r.views;
  const effects = base.length >= 4 ? factorEffects(base, val) : [];
  const ranked = effects.filter((f) => f.ok);
  const insights = ranked.filter((f) => f.eff > 0.02).slice(0, 3).map((f) => {
    const best = f.groups[0], worst = f.groups.at(-1);
    return `<li><b>${esc(f.name)}</b> pesa ${strength(f.eff)} (explica ~${Math.round(f.eff * 100)}% da variação): melhor <b>${esc(best.k)}</b> (mediana ${kfmt(best.med)}, ${best.n} corte${best.n > 1 ? "s" : ""}), pior <b>${esc(worst.k)}</b> (${kfmt(worst.med)}, ${worst.n}).</li>`;
  });
  // Sugestão de horários: os 3 melhores horários com 2+ cortes.
  const hourF = effects.find((f) => f.name === "Horário");
  const bestHours = hourF ? hourF.groups.filter((g) => g.n >= 2).slice(0, 3).map((g) => g.k) : [];

  const tiles = [
    ["Views", kfmt(views), `YouTube ${kfmt(tot("yt"))} · TikTok ${kfmt(tot("tt"))}`],
    ["Mediana por corte", kfmt(median(m.map((r) => r.views))), `média ${kfmt(m.length ? views / m.length : 0)} · ${m.length} de ${rows.length} medidos`],
    ["Curtidas", kfmt(tot("likes")), `${kfmt(tot("comments"))} comentários · ${kfmt(tot("shares"))} compart.`],
    ["Engajamento", views ? ((tot("likes") + tot("comments") + tot("shares")) / views * 100).toFixed(1).replace(".", ",") + "%" : "—", "curtidas + comentários + compart. ÷ views"],
  ];
  const timeline = [...m].sort((a, b) => (a.c.published_at || "").localeCompare(b.c.published_at || "")).slice(-40);
  const tmax = Math.max(1, ...timeline.map((r) => r.views));
  const top = [...m].sort((a, b) => b.views - a.views);

  $("#perf").innerHTML = `
    <div class="perf-h">
      <div><h1>Desempenho</h1><p class="muted">${ch ? esc(ch.name) : "Todos os canais"} · ${ms.running ? "atualizando…" : ms.at ? "atualizado " + when(ms.at) : "ainda não coletado"}</p></div>
      <div class="perf-tools">
        <div class="seg">${[["all", "Total"], ["youtube", "YouTube"], ["tiktok", "TikTok"]].map(([k, l]) => `<button data-perf-plat="${k}" class="${ui.perfPlat === k ? "active" : ""}">${l}</button>`).join("")}</div>
        <button class="btn" data-metrics-refresh ${ms.running ? "disabled" : ""}>Atualizar agora</button>
      </div>
    </div>
    ${errs.length ? `<div class="card perf-err">${errs.map(([k, v]) => `<div><b>${esc(k.replace(":", " · "))}</b>: ${esc(v)}</div>`).join("")}</div>` : ""}
    <div class="kpis">${tiles.map(([l, v, s]) => `<div class="kpi"><span>${l}</span><b>${v}</b><small class="muted">${s}</small></div>`).join("")}</div>

    <section class="card perf-card insight">
      <h3>O que mais faz diferença</h3>
      ${base.length < 4 ? `<p class="muted">Ainda poucos cortes com 48 h ou mais de publicados (${base.length}). A análise aparece a partir de 4.</p>` : `
      <p class="muted small">Comparando ${use48 ? "as views de cada corte aos 48 h de publicado" : "as views totais dos cortes com 48 h ou mais"} (${base.length} cortes${ui.perfPlat !== "all" ? ", só " + (ui.perfPlat === "youtube" ? "YouTube" : "TikTok") : ""}). Medianas, para um viral não distorcer.${base.length < 20 ? " <b>Amostra pequena: trate como pista, não como conclusão.</b>" : ""}</p>
      ${insights.length ? `<ul class="ins">${insights.join("")}</ul>` : `<p>Nenhum fator se destaca ainda: as diferenças entre grupos estão dentro do que o acaso explica.</p>`}
      ${bestHours.length ? `<p class="small">Horários com melhor mediana: <b>${bestHours.join(", ")}</b>${ch ? ` · horários atuais do canal: ${esc(ch.schedule_slots)}` : ""}.</p>` : ""}
      <div class="fx">${ranked.map((f) => `<div class="fx-r"><span>${esc(f.name)} <small class="muted">${f.kind}</small></span><span class="ht"><i style="width:${Math.min(100, f.eff * 200)}%"></i></span><b>${f.eff > 0.02 ? Math.round(f.eff * 100) + "%" : "—"}</b><small class="muted">${strength(f.eff)}</small></div>`).join("")}</div>`}
    </section>

    ${base.length >= 4 ? `<section class="card perf-card"><h3>Dia × horário <span class="muted">mediana de views (número pequeno = cortes)</span></h3>${heatmap(base, val)}</section>
    <div class="perf-2">${effects.filter((f) => f.groups.length >= 2).map((f) => `<section class="card perf-card"><h3>${esc(f.name)} <span class="muted">${f.ok && f.eff > 0.02 ? "pesa " + strength(f.eff) : "sem efeito claro"}</span></h3>${groupBars(f.groups)}</section>`).join("")}</div>` : ""}

    ${timeline.length ? `<section class="card perf-card"><h3>Views por corte <span class="muted">por data de publicação</span></h3>
      <div class="vbars">${timeline.map((r) => `<div class="vbar" data-clip="${r.c.id}" title="${esc(r.c.title)} — ${fmtN(r.views)} views (${when(r.c.published_at)})"><i style="height:${Math.max(2, (r.views / tmax) * 100)}%"></i></div>`).join("")}</div></section>` : ""}
    <section class="card perf-card"><h3>Ranking</h3>
      ${top.length ? `<div class="table-wrap"><table class="rank"><thead><tr><th></th><th>Corte</th><th>Publicado</th><th class="n">YouTube</th><th class="n">TikTok</th><th class="n">Total</th><th class="n">Curtidas</th><th class="n">Coment.</th><th class="n">Engaj.</th></tr></thead><tbody>
      ${top.map((r, i) => `<tr data-clip="${r.c.id}"><td class="muted">${i + 1}</td><td class="rt">${r.c.rendered_at ? `<img src="/media/clip/${r.c.id}.jpg?v=${encodeURIComponent(r.c.rendered_at)}" alt="" loading="lazy">` : ""}<span>${esc(r.c.title)}${r.c.pillar ? ` <span class="tag">${esc(r.c.pillar)}</span>` : ""}</span></td><td class="muted">${when(r.c.published_at)}</td><td class="n">${fmtN(r.yt)}</td><td class="n">${fmtN(r.tt)}</td><td class="n"><b>${fmtN(r.views)}</b></td><td class="n">${fmtN(r.likes)}</td><td class="n">${fmtN(r.comments)}</td><td class="n">${(r.eng * 100).toFixed(1).replace(".", ",")}%</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">Nenhum corte publicado com métricas ainda. A coleta roda a cada 6 h; clique em Atualizar agora para buscar já.</p>`}
    </section>
    <p class="muted perf-note">Os cortes que mais e menos renderam (48 h+) e os padrões de duração e pilar entram como referência na análise da IA de cada canal, a partir de 8 cortes medidos.</p>`;
}

// ---------------- Eventos ----------------

$(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  ui.tab = b.dataset.tab;
  render();
});
$("#side-channels").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-channel]");
  if (!b) return;
  ui.channel = b.dataset.channel;
  localStorage.setItem("channel", ui.channel);
  ui.sel.clear();
  if (!["home", "studio", "pipeline", "costs", "perf", "agenda"].includes(ui.tab)) ui.tab = "home";
  render();
});
$("#agenda").addEventListener("dragstart", (e) => {
  const ev = e.target.closest?.("[data-ev][draggable], [data-post][draggable]");
  if (!ev) return;
  e.dataTransfer.setData("text/plain", ev.dataset.post ? `post:${ev.dataset.post}` : `clip:${ev.dataset.ev}`);
  e.dataTransfer.effectAllowed = "move";
  ev.classList.add("dragging");
});
$("#agenda").addEventListener("dragend", () => $$("#agenda .dragging, #agenda .over").forEach((x) => x.classList.remove("dragging", "over")));
$("#agenda").addEventListener("dragover", (e) => {
  const cell = e.target.closest("[data-drop], [data-drop-day]");
  if (!cell || cell.classList.contains("past")) return;
  e.preventDefault();
  $$("#agenda .over").forEach((x) => x !== cell && x.classList.remove("over"));
  cell.classList.add("over");
});
$("#agenda").addEventListener("drop", act(async (e) => {
  const cell = e.target.closest("[data-drop], [data-drop-day]");
  const [kind, raw] = e.dataTransfer.getData("text/plain").split(":");
  const id = +raw;
  if (!cell || !id) return;
  e.preventDefault();
  cell.classList.remove("over");
  const cur = kind === "post" ? state.posts.find((p) => p.id === id)?.scheduled_at : state.clips.find((x) => x.id === id)?.scheduled_at;
  let at;
  if (cell.dataset.drop) at = new Date(cell.dataset.drop);
  else { // mês: mantém a hora, muda o dia
    const old = new Date(cur);
    at = new Date(cell.dataset.dropDay + "T00:00");
    at.setHours(old.getHours(), old.getMinutes(), 0, 0);
  }
  if (cur && Date.parse(cur) === at.getTime()) return;
  if (kind === "post") await movePost(id, { when: at.toISOString() }, `Movido para ${when(at.toISOString())} 🔒`);
  else await moveClip(id, at);
}));
$("#ev-dialog").addEventListener("click", act(async (e) => {
  const pb = e.target.closest("[data-post-act]");
  if (pb) {
    e.preventDefault();
    const id = +pb.dataset.id, dlg = $("#ev-dialog"), a = pb.dataset.postAct;
    if (a === "save") {
      const v = dlg.querySelector("[name=at]").value;
      if (v) await movePost(id, { when: new Date(v).toISOString() }, "Horário salvo 🔒");
    } else if (a === "auto") await movePost(id, { when: null }, "De volta à fila automática");
    else if (a === "now") {
      if (!confirm("Publicar agora nesta plataforma?")) return;
      await movePost(id, { when: "now" }, "Publicando…");
    } else if (a === "skip") {
      if (!confirm("Não postar este corte nesta plataforma? O próximo melhor corte entra no lugar.")) return;
      await movePost(id, { skip: true }, "Removido da fila — o próximo corte entra no lugar");
    } else if (a === "open") {
      dlg.close();
      return openClip(state.posts.find((p) => p.id === id).clip_id);
    }
    dlg.close();
    return;
  }
  const b = e.target.closest("[data-ev-act]");
  if (!b) return;
  e.preventDefault();
  const id = +b.dataset.id, dlg = $("#ev-dialog"), act2 = b.dataset.evAct;
  if (act2 === "save") {
    const v = dlg.querySelector("[name=at]").value;
    if (!v) return;
    await moveClip(id, new Date(v));
  } else if (act2 === "auto") {
    await api(`/api/clips/${id}/approve`, { method: "POST", body: {} });
    toast("De volta à fila automática");
    await refresh();
  } else if (act2 === "now") {
    if (!confirm("Publicar este corte agora?")) return;
    await api(`/api/clips/${id}/approve`, { method: "POST", body: { when: "now" } });
    toast("Publicando…");
    await refresh();
  } else if (act2 === "unschedule") {
    if (!confirm("Tirar da agenda? O corte volta para Pendentes no Estúdio.")) return;
    await api(`/api/clips/${id}/unschedule`, { method: "POST" });
    await refresh();
  } else if (act2 === "open") {
    dlg.close();
    return openClip(id);
  }
  dlg.close();
}));

$("#side-new").addEventListener("click", () => {
  ui.tab = "home";
  render();
  $("#new-job textarea").focus();
});
$("#new-job textarea").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.target.value.includes("\n") && e.target.value.trim()) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});
$("#tab-home").addEventListener("change", (e) => {
  const id = +e.target.dataset.pick;
  if (!id) return;
  if (e.target.checked) ui.sel.add(id);
  else ui.sel.delete(id);
  e.target.closest(".tile").classList.toggle("on", e.target.checked); // sem redesenhar a grade (as miniaturas piscariam)
  $("#sel-actions").innerHTML = selActions();
});
$("#new-job select[name=channel_id]").addEventListener("change", fillTemplateSelect);
$("#new-job").addEventListener("submit", act(async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  const { ids } = await api("/api/jobs", { method: "POST", body: fd });
  e.target.source.value = "";
  toast(`${ids.length} vídeo(s) na fila`);
}));
document.addEventListener("click", act(async (e) => {
  const t = e.target;
  if (t.closest(".pick")) return; // checkbox de seleção, tratado no change
  if (t.closest("[data-goto]")) {
    ui.tab = t.closest("[data-goto]").dataset.goto;
    return render();
  }
  const calBtn = t.closest("[data-cal]");
  if (calBtn) {
    const dir = calBtn.dataset.cal, c = ui.cal;
    if (dir === "today") c.anchor = new Date();
    else if (c.view === "week") c.anchor = addDays(c.anchor, dir === "next" ? 7 : -7);
    else c.anchor = new Date(c.anchor.getFullYear(), c.anchor.getMonth() + (dir === "next" ? 1 : -1), 1);
    return renderAgenda();
  }
  if (t.closest("[data-cal-view]")) {
    ui.cal.view = t.closest("[data-cal-view]").dataset.calView;
    localStorage.setItem("calView", ui.cal.view);
    return renderAgenda();
  }
  if (t.closest("[data-cal-day]")) {
    ui.cal.view = "week";
    ui.cal.anchor = new Date(t.closest("[data-cal-day]").dataset.calDay + "T12:00");
    return renderAgenda();
  }
  if (t.closest("[data-cal-rebalance]") && confirm("Reorganizar os cortes agendados nos horários do canal? Os que você moveu à mão (🔒) ficam onde estão.")) {
    await api(`/api/channels/${ui.channel}/rebalance`, { method: "POST" });
    toast("Agenda reorganizada");
    return refresh();
  }
  if (t.closest("#agenda [data-ev]")) return openEvDialog(+t.closest("[data-ev]").dataset.ev);
  if (t.closest("#agenda [data-post]")) return openPostDialog(+t.closest("[data-post]").dataset.post);
  if (t.closest("[data-perf-plat]")) {
    ui.perfPlat = t.closest("[data-perf-plat]").dataset.perfPlat;
    return renderPerf();
  }
  if (t.closest("[data-metrics-refresh]")) {
    t.disabled = true;
    toast("Buscando números no YouTube e no TikTok (o robô leva ~20 s por canal)…");
    const r = await api("/api/metrics/refresh", { method: "POST" });
    toast(Object.keys(r.errors).length ? `Atualizado com avisos: ${Object.values(r.errors)[0]}` : "Métricas atualizadas", !!Object.keys(r.errors).length);
    return refresh();
  }
  if (t.closest("[data-approve-all]")) return approveMany(clipsF().filter((c) => c.status === "PENDING_REVIEW").map((c) => c.id));
  if (t.closest("[data-approve-sel]")) return approveMany([...ui.sel]);
  if (t.closest("[data-sel-all]")) {
    clipsF().filter((c) => c.status === "PENDING_REVIEW").forEach((c) => ui.sel.add(c.id));
    return renderHome();
  }
  if (t.closest("[data-sel-clear]")) {
    ui.sel.clear();
    return renderHome();
  }
  const card = t.closest("[data-clip]");
  if (card && (card.closest("#kanban") || card.closest("#clip-list") || card.closest("#home-body") || card.closest("#perf"))) return openClip(+card.dataset.clip);
  if (t.dataset.clipOpen) return openClip(+t.dataset.clipOpen);
  if (t.dataset.retry) await api(`/api/jobs/${t.dataset.retry}/retry`, { method: "POST" });
  if (t.dataset.del && confirm("Excluir o job e todos os arquivos dele?")) await api(`/api/jobs/${t.dataset.del}`, { method: "DELETE" });
  if (t.dataset.rerender) await api(`/api/clips/${t.dataset.rerender}/rerender`, { method: "POST" });
  if (t.dataset.republish) await api(`/api/clips/${t.dataset.republish}/approve`, { method: "POST", body: { when: "now" } });
  if (t.dataset.ytLogin !== undefined) {
    t.blur();
    const r = await api("/api/youtube-download/login", { method: "POST" });
    window.open(r.screen, "_blank", "noopener");
    toast("Login do Google aberto na tela remota do robô — entre com a conta e depois volte aqui");
    setTimeout(() => loadSettings().catch(() => {}), 60_000);
  }
  if (t.dataset.ytCookiesRemove !== undefined && confirm("Remover o cookies.txt do YouTube?")) {
    t.blur();
    await api("/api/youtube-download/cookies", { method: "DELETE" });
    await loadSettings();
  }
  if (t.dataset.retryAll !== undefined) {
    const r = await api("/api/jobs/retry-failed", { method: "POST" });
    toast(`${r.retried} job(s) de volta para a fila`);
  }
  if (t.dataset.robot) {
    const action = t.dataset.robot;
    if (action === "logout" && !confirm("Apagar o login do robô deste canal? Os posts pelo robô param até entrar de novo.")) return;
    if (action === "adopt-main" && !confirm("Salvar como deste canal a conta do TikTok que está logada na janela principal da tela remota?")) return;
    t.disabled = true;
    t.blur(); // o cartão não se redesenha enquanto o foco está nele
    const r = await api(`/api/channels/${encodeURIComponent(ui.channelId)}/robot/${action}`, { method: "POST" }).finally(() => (t.disabled = false));
    if (action === "login") {
      window.open(r.screen, "_blank", "noopener");
      toast("Janela de login aberta na tela remota do robô — entre na conta e depois clique em Concluir login");
    }
    if (action === "finish" || action === "adopt-main") toast("Login do robô salvo — este canal agora publica no TikTok pelo robô");
    await loadSettings();
    await refresh();
  }
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
  if (t.dataset.kcol) {
    ui.kcol = t.dataset.kcol;
    localStorage.setItem("kcol", ui.kcol);
    renderPipeline();
  }
  if (t.id === "b-back") {
    studioCtx = null;
    ui.clipId = null;
    $(".studio").classList.remove("open");
    $("#studio-main").innerHTML = `<p class="empty">Selecione um corte para revisar.</p>`;
    renderClipList();
    scrollTo(0, 0);
  }
  const chItem = t.closest("#channel-list li");
  if (chItem) {
    ui.channelId = chItem.dataset.ch;
    $("#channel-form").dataset.for = "-";
    renderChannels();
    renderIntegrations();
  }
  if (t.id === "new-channel") {
    const d = $("#new-channel-dialog");
    d.querySelector("form").reset();
    d.showModal();
  }
}));
// Novo canal: só o essencial; identidade, modelos e contas ficam na tela do canal, já criada com padrões.
$("#new-channel-dialog form").addEventListener("input", (e) => {
  const f = e.currentTarget;
  if (e.target.name === "name" && !f.id_edited) f.elements.id.value = slug(f.elements.name.value);
  if (e.target.name === "id") f.id_edited = true;
});
$("#new-channel-dialog form").addEventListener("submit", act(async (e) => {
  if (e.submitter?.value === "cancel") return;
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  const ch = await api("/api/channels", { method: "POST", body: {
    id: slug(fd.id || fd.name), name: fd.name, niche: fd.niche, tone: fd.tone, schedule_slots: fd.schedule_slots,
    publish_targets: JSON.stringify(["youtube", "tiktok"].filter((p) => fd[`t_${p}`])), title_style: fd.title_style,
  } });
  $("#new-channel-dialog").close();
  ui.channelId = ch.id;
  $("#channel-form").dataset.for = "";
  await refresh();
  scrollTo(0, 0);
  toast(`Canal ${ch.name} criado — agora conecte as contas e ajuste a identidade`);
}));
const slug = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

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
$("#integrations").addEventListener("change", act(async (e) => {
  if (e.target.dataset.ytCookies === undefined || !e.target.files[0]) return;
  const r = await fetch("/api/youtube-download/cookies", { method: "POST", headers: { "content-type": "text/plain" }, body: await e.target.files[0].text() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  e.target.blur();
  toast("cookies.txt do YouTube salvo — os próximos downloads já usam");
  await loadSettings();
}));
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
  // Ao reconectar, busca o que mudou enquanto a conexão estava caída.
  es.onopen = () => refresh().catch(() => {});
  // Se o hub reinicia e responde erro (502), o navegador desiste de vez: reabre na mão.
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 5000);
  };
}

refresh().then(() => {
  connect();
  handleHash();
  setInterval(renderWorkers, 30_000);
  // Rede de segurança: aba em segundo plano ou evento perdido não deixam o painel parado.
  setInterval(() => refresh().catch(() => {}), 60_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh().catch(() => {});
  });
}).catch((e) => toast(e.message, true));
