// Aba Instagram: posts de foto (foto + briefing → legenda → moldura → aprovação → agenda). Ver app/hub/instagram.ts.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const pad2 = (n) => String(n).padStart(2, "0");
const localInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

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

let toast = (msg) => console.log(msg);
let data = null;
let filter = "ACTIVE";
let configOpen = false;

const STATUS = {
  DRAFT: ["Preparando", ""],
  PENDING: ["Para aprovar", "warn"],
  SCHEDULED: ["Agendado", "ok"],
  PUBLISHING: ["Publicando", "ok"],
  PUBLISHED: ["Publicado", "ok"],
  FAILED: ["Falhou", "bad"],
  REJECTED: ["Rejeitado", ""],
};
const TYPE = { FEED: "Feed", STORIES: "Story" };
const FILTERS = { ACTIVE: ["DRAFT", "PENDING", "SCHEDULED", "PUBLISHING", "FAILED"], PUBLISHED: ["PUBLISHED"], ALL: Object.keys(STATUS) };

function statusChips() {
  const s = data.status;
  const chip = (ok, yes, no) => `<span class="${ok ? "ok-dot" : "muted"}">${ok ? yes : no}</span>`;
  let token = "";
  if (s.token.error) token = `<span class="tag bad" title="${esc(s.token.error)}">token com problema</span>`;
  else if (s.token.expiresAt) token = `<span class="muted">token vale até ${new Date(s.token.expiresAt).toLocaleDateString("pt-BR")} (renova sozinho)</span>`;
  return `<div class="ig-chips">
    ${chip(s.account, "Conta conectada", "Conta não conectada")}
    ${chip(s.ai, "Legenda por IA", "Sem IA: a legenda é escrita à mão")}
    ${chip(s.frame.FEED || s.frame.STORIES, `Moldura: ${[s.frame.FEED && "Feed", s.frame.STORIES && "Story"].filter(Boolean).join(" e ")}`, "Sem moldura: a foto vai como está")}
    ${chip(!!s.mediaBase, "Endereço público definido", "Falta o endereço público das fotos")}
    ${chip(s.telegram, "Bot do Telegram ativo", "Bot do Telegram desligado")}
    ${token}
  </div>`;
}

function composer() {
  return `<form class="card ig-new" id="ig-new">
    <h3 class="integ-title">Novo post</h3>
    <div class="ig-new-grid">
      <label>Foto (JPEG, até 8 MB)<input type="file" name="photo" accept="image/jpeg" required></label>
      <label>Formato<select name="type"><option value="FEED">Feed</option><option value="STORIES">Story</option></select></label>
      <label class="full">Briefing${data.status.ai ? " (a IA escreve a legenda a partir dele)" : " (vira a legenda; edite depois)"}
        <textarea name="briefing" rows="3" placeholder="Tema, contexto e objetivo do post. Ex.: almoço de domingo com massa fresca, foco no sabor caseiro, objetivo é trazer gente no fim de semana."></textarea></label>
    </div>
    <div><button class="btn primary" type="submit">Criar post</button>
      <span class="muted help">Também dá para mandar a foto ao bot do Telegram com o briefing na legenda.</span></div>
  </form>`;
}

function postCard(p) {
  const [label, cls] = STATUS[p.status] ?? [p.status, ""];
  const img = p.final_url || (p.has_photo ? `/media/ig/${p.id}` : "");
  const locked = p.status === "PUBLISHED" || p.status === "PUBLISHING";
  const story = p.media_type === "STORIES";
  const info = [
    p.status === "SCHEDULED" && `Sai ${when(p.scheduled_at)}`,
    p.status === "PUBLISHED" && `Publicado ${when(p.published_at)}`,
    p.detail,
  ].filter(Boolean).join(" · ");
  const decide = ["PENDING", "FAILED", "SCHEDULED"].includes(p.status);
  return `<article class="card ig-post" data-ig="${p.id}">
    <div class="ig-img ${story ? "story" : ""}">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : `<span class="muted">foto removida</span>`}</div>
    <div class="ig-body">
      <div class="ig-head"><b>#${p.id} · ${TYPE[p.media_type] ?? p.media_type}</b><span class="tag ${cls}">${label}</span>
        ${p.permalink ? `<a href="${esc(p.permalink)}" target="_blank" rel="noopener">abrir no Instagram</a>` : ""}</div>
      ${info ? `<div class="muted help">${esc(info)}</div>` : ""}
      ${p.error ? `<div class="ig-error">${esc(p.error)}</div>` : ""}
      ${story ? `<div class="muted help">Story não leva legenda.</div>` : `<textarea name="caption" rows="6" ${locked ? "readonly" : ""} placeholder="Legenda">${esc(p.caption)}</textarea>`}
      ${p.briefing ? `<details class="muted help"><summary>Briefing</summary>${esc(p.briefing)}</details>` : ""}
      ${locked ? "" : `<div class="ig-actions">
        ${story ? "" : `<button class="btn small" data-act="save">Salvar legenda</button>`}
        ${data.status.ai && !story && p.has_photo ? `<button class="btn small" data-act="ai" title="Reescreve a legenda; você pode dizer o que ajustar">Refazer com IA</button>` : ""}
        ${p.has_photo ? `<button class="btn small" data-act="switch" title="Refaz a moldura no outro formato">Mudar para ${story ? "Feed" : "Story"}</button>` : ""}
      </div>`}
      ${decide ? `<div class="ig-actions">
        <button class="btn small ok" data-act="now">Publicar agora</button>
        <input type="datetime-local" name="when" value="${localInput(p.scheduled_at && p.status === "SCHEDULED" ? new Date(p.scheduled_at) : new Date(Date.now() + 3600_000))}">
        <button class="btn small" data-act="schedule">${p.status === "SCHEDULED" ? "Reagendar" : "Agendar"}</button>
        <button class="btn small danger" data-act="reject">Rejeitar</button>
      </div>` : ""}
      ${p.status === "PUBLISHING" ? "" : `<div class="ig-actions"><button class="btn small danger" data-act="delete">Excluir</button></div>`}
    </div>
  </article>`;
}

function field(key, label, { secret = false, placeholder = "", area = false } = {}) {
  const s = data.settings[key];
  const src = s.source === "env" ? ` <span class="muted">(vindo do .env)</span>` : "";
  if (area) return `<label class="full">${label}${src}<textarea name="${key}" rows="4" placeholder="${esc(placeholder)}">${esc(s.value)}</textarea></label>`;
  return `<label>${label}${src}<input name="${key}" type="${secret ? "password" : "text"}" autocomplete="off"
    value="${secret ? "" : esc(s.value)}" placeholder="${secret && s.set ? `salvo ${esc(s.value)} — em branco mantém` : esc(placeholder)}"></label>`;
}

function configCard() {
  return `<details class="card ig-config" id="ig-config" ${configOpen || !data.status.account ? "open" : ""}>
    <summary><b>Configuração</b> <span class="muted">conta, IA da legenda, moldura e endereço público</span></summary>
    <form class="form" id="ig-settings">
      <h3>Conta do Instagram (Meta)</h3>
      ${field("instagram_user_id", "ID do usuário do Instagram (IG User ID)")}
      ${field("instagram_access_token", "Token de acesso de longa duração", { secret: true })}
      ${field("facebook_app_id", "ID do app da Meta (para renovar o token sozinho)")}
      ${field("facebook_app_secret", "Segredo do app da Meta", { secret: true })}
      <h3>Legenda por IA (opcional)</h3>
      ${field("deepseek_api_key", "Chave da API do DeepSeek", { secret: true })}
      ${field("instagram_brand", "Marca e voz (a IA segue isto em toda legenda)", { area: true, placeholder: "Nome da marca, o que vende, tom de voz, o que nunca dizer. Ex.: Casa das Massas — massas frescas artesanais; tom caseiro e direto, sem formalidade." })}
      <h3>Moldura pelo Templated.io (opcional)</h3>
      ${field("templated_api_key", "Chave da API do Templated", { secret: true })}
      ${field("templated_template_feed", "ID do modelo de Feed (1080×1080)")}
      ${field("templated_template_story", "ID do modelo de Story (1080×1920)")}
      <div class="muted help full">A foto entra na camada chamada <code>photo</code> do modelo.</div>
      <h3>Endereço público das fotos</h3>
      ${field("instagram_media_url", "URL pela qual a internet alcança este painel", { placeholder: data.status.mediaBase || "https://…" })}
      <div class="muted help full">A Meta (e o Templated) baixam a foto por URL, então o endereço precisa abrir de fora da sua rede, com https.
        Em uso agora: <code>${esc(data.status.mediaBase || "nenhum")}</code>. Em branco, vale a URL pública do hub; com o túnel
        <code>deploy/ig-media-tunnel.sh</code> rodando, vale o endereço do túnel. Só as fotos dos posts ficam abertas, em nomes impossíveis de adivinhar.</div>
      <div class="full ig-actions"><button class="btn primary" type="submit">Salvar configuração</button>
        <button class="btn" type="button" data-act="token">Conferir token agora</button></div>
    </form>
  </details>`;
}

function draw() {
  const box = $("#instagram");
  if (!data || !box || box.contains(document.activeElement)) return;
  const posts = data.posts.filter((p) => FILTERS[filter].includes(p.status));
  box.innerHTML = `
    ${statusChips()}
    ${composer()}
    <div class="seg ig-filter">${[["ACTIVE", "Em andamento"], ["PUBLISHED", "Publicados"], ["ALL", "Todos"]]
      .map(([f, l]) => `<button type="button" data-filter="${f}" class="${f === filter ? "active" : ""}">${l}</button>`).join("")}</div>
    <div class="ig-list">${posts.map(postCard).join("") || `<p class="empty">Nenhum post aqui.</p>`}</div>
    ${configCard()}`;
}

export async function renderInstagram() {
  data = await api("/api/instagram");
  const pending = data.posts.filter((p) => p.status === "PENDING").length;
  const pill = $("#ig-count");
  if (pill) pill.textContent = pending || "";
  draw();
}

async function reload() {
  document.activeElement?.blur();
  await renderInstagram();
}

async function onClick(e) {
  const f = e.target.closest("[data-filter]");
  if (f) {
    filter = f.dataset.filter;
    document.activeElement?.blur();
    return draw();
  }
  const b = e.target.closest("[data-act]");
  if (!b) return;
  e.preventDefault();
  if (b.dataset.act === "token") {
    const t = await api("/api/instagram/token/check", { method: "POST" });
    toast(t.error ? `Token: ${t.error}` : t.expiresAt ? `Token válido até ${new Date(t.expiresAt).toLocaleDateString("pt-BR")}` : "Token válido (sem data de expiração)", !!t.error);
    return reload();
  }
  const card = b.closest("[data-ig]");
  const id = card.dataset.ig;
  const base = `/api/instagram/posts/${id}`;
  const caption = $("textarea[name=caption]", card)?.value;
  const saveCaption = () => (caption === undefined ? null : api(base, { method: "PUT", body: { caption } }));
  switch (b.dataset.act) {
    case "save":
      await saveCaption();
      toast("Legenda salva");
      break;
    case "ai": {
      const feedback = prompt("O que ajustar na legenda? (em branco = escrever de novo a partir do briefing)");
      if (feedback === null) return;
      await saveCaption();
      await api(`${base}/prepare`, { method: "POST", body: { feedback } });
      toast("Reescrevendo a legenda…");
      break;
    }
    case "switch": {
      const p = data.posts.find((x) => x.id === +id);
      await api(`${base}/prepare`, { method: "POST", body: { caption: false, media_type: p.media_type === "STORIES" ? "FEED" : "STORIES" } });
      toast("Refazendo no outro formato…");
      break;
    }
    case "now":
      if (!confirm(`Publicar o post #${id} no Instagram agora?`)) return;
      await saveCaption();
      await api(`${base}/approve`, { method: "POST", body: { when: "now" } });
      toast("Publicando agora…");
      break;
    case "schedule": {
      const v = $("input[name=when]", card).value;
      if (!v) throw new Error("Escolha a data e a hora");
      await saveCaption();
      await api(`${base}/approve`, { method: "POST", body: { when: new Date(v).toISOString() } });
      toast(`Agendado para ${when(new Date(v).toISOString())}`);
      break;
    }
    case "reject":
      await api(`${base}/reject`, { method: "POST" });
      toast("Post rejeitado");
      break;
    case "delete":
      if (!confirm(`Excluir o post #${id}? Isso não apaga nada do Instagram.`)) return;
      await api(base, { method: "DELETE" });
      toast("Post excluído");
      break;
  }
  await reload();
}

async function onSubmit(e) {
  e.preventDefault();
  if (e.target.id === "ig-new") {
    const file = e.target.photo.files[0];
    if (!file) return;
    const q = new URLSearchParams({ name: file.name, type: e.target.type.value, briefing: e.target.briefing.value });
    toast("Enviando a foto…");
    const r = await fetch(`/api/instagram/posts?${q}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
    toast(`Post #${out.id} criado`);
  }
  if (e.target.id === "ig-settings") {
    const body = {};
    for (const input of e.target.querySelectorAll("input[name], textarea[name]")) body[input.name] = input.value;
    await api("/api/settings", { method: "PUT", body });
    toast("Configuração salva");
  }
  await reload();
}

/** Liga os eventos da aba uma vez. `notify` é o toast do painel. */
export function wireInstagram(notify) {
  toast = notify;
  const box = $("#instagram");
  const guard = (fn) => (e) => fn(e).catch((err) => toast(err.message, true));
  box.addEventListener("click", guard(onClick));
  box.addEventListener("submit", guard(onSubmit));
  box.addEventListener("toggle", (e) => {
    if (e.target.id === "ig-config") configOpen = e.target.open;
  }, true);
}
