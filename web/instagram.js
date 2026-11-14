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
let ctx = { channels: [], channel: "" }; // canais do painel e o canal escolhido na barra lateral
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

const accountOf = (channelId) => data.accounts.find((a) => a.channel_id === channelId);
/** Contas que a aba mostra: a do canal escolhido na barra lateral, ou todas. */
const shownAccounts = () => data.accounts.filter((a) => !ctx.channel || a.channel_id === ctx.channel);

function statusChips() {
  const s = data.status;
  const chip = (ok, yes, no) => `<span class="${ok ? "ok-dot" : "muted"}">${ok ? yes : no}</span>`;
  const accounts = shownAccounts().map((a) => {
    const frame = [a.frame.FEED && "Feed", a.frame.STORIES && "Story"].filter(Boolean).join(" e ");
    const token = a.token?.error ? ` <span class="tag bad" title="${esc(a.token.error)}">token com problema</span>`
      : a.token?.expiresAt ? ` <span class="muted">· token até ${new Date(a.token.expiresAt).toLocaleDateString("pt-BR")}</span>` : "";
    return `<div class="ig-account"><span class="ok-dot"><b>${esc(a.name)}</b> ${esc(a.account)}</span>
      <span class="muted">${frame ? `moldura em ${frame}` : "sem moldura"}</span>${token}</div>`;
  }).join("");
  const none = ctx.channel
    ? `${esc(ctx.channels.find((c) => c.id === ctx.channel)?.name ?? "Este canal")} não tem conta do Instagram conectada.`
    : "Nenhum canal tem conta do Instagram conectada.";
  return `${accounts || `<div class="card ig-empty">${none} Conecte em <b>Configurações → Contas conectadas → Instagram</b>, com o canal selecionado.</div>`}
  <div class="ig-chips">
    ${chip(s.ai, "Legenda por IA", "Sem IA: a legenda é escrita à mão")}
    ${chip(!!s.mediaBase, "Endereço público definido", "Falta o endereço público das fotos")}
    ${chip(s.telegram, "Bot do Telegram ativo", "Bot do Telegram desligado")}
  </div>`;
}

function composer() {
  const accounts = shownAccounts();
  if (!accounts.length) return "";
  return `<form class="card ig-new" id="ig-new">
    <h3 class="integ-title">Novo post</h3>
    <div class="ig-new-grid">
      <label class="full">Conta<select name="channel">${accounts.map((a) => `<option value="${esc(a.channel_id)}">${esc(a.name)} · ${esc(a.account)}</option>`).join("")}</select></label>
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
      <div class="muted ig-who">${esc(accountOf(p.channel_id)?.name ?? ctx.channels.find((c) => c.id === p.channel_id)?.name ?? "sem conta")} ${esc(accountOf(p.channel_id)?.account ?? "")}</div>
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
  return `<details class="card ig-config" id="ig-config" ${configOpen ? "open" : ""}>
    <summary><b>Configuração geral</b> <span class="muted">IA da legenda, moldura, renovação de token e endereço público (vale para todas as contas)</span></summary>
    <form class="form" id="ig-settings">
      <div class="muted help full">A conta do Instagram e os modelos de moldura são de cada canal: ficam em <b>Configurações → Contas conectadas → Instagram</b>.
        A voz da legenda vem do nicho e do tom do canal.</div>
      <h3>Legenda por IA (opcional)</h3>
      ${field("deepseek_api_key", "Chave da API do DeepSeek", { secret: true })}
      <h3>Moldura pelo Templated.io (opcional)</h3>
      ${field("templated_api_key", "Chave da API do Templated", { secret: true })}
      <h3>App da Meta (renova os tokens sozinho)</h3>
      ${field("facebook_app_id", "ID do app da Meta")}
      ${field("facebook_app_secret", "Segredo do app da Meta", { secret: true })}
      <h3>Endereço público das fotos</h3>
      ${field("instagram_media_url", "URL pela qual a internet alcança este painel", { placeholder: data.status.mediaBase || "https://…" })}
      <div class="muted help full">A Meta (e o Templated) baixam a foto por URL, então o endereço precisa abrir de fora da sua rede, com https.
        Em uso agora: <code>${esc(data.status.mediaBase || "nenhum")}</code>. Em branco, vale a URL pública do hub; com o túnel
        <code>deploy/ig-media-tunnel.sh</code> rodando, vale o endereço do túnel. Só as fotos dos posts ficam abertas, em nomes impossíveis de adivinhar.</div>
      <div class="full ig-actions"><button class="btn primary" type="submit">Salvar configuração</button>
        <button class="btn" type="button" data-act="token">Conferir tokens agora</button></div>
    </form>
  </details>`;
}

/**
 * Cartão do Instagram em Configurações → Contas conectadas: a conta do canal, como YouTube e TikTok.
 * `ch` é o canal selecionado (com `connections.instagram` e `instagram` vindos de /api/state).
 */
export function instagramCard(ch) {
  const acct = ch?.connections?.instagram;
  const ig = ch?.instagram ?? {};
  return `<form class="integ" data-ig-account>
    <div class="integ-head"><b>◎ Instagram</b>
      ${ch ? (acct ? `<span class="ok-dot">${esc(ch.name)}: ${esc(acct)}</span>` : `<span class="muted">${esc(ch.name)}: não conectado</span>`) : ""}</div>
    <div class="muted help">Publica posts de foto (Feed e Story) na conta do canal, pela aba Instagram ou pelo bot do Telegram. Cada canal conecta a própria conta.</div>
    <details class="guide"><summary>📖 Como obter as credenciais</summary><ol>
      <li>A conta do Instagram precisa ser <b>profissional</b> (comercial ou criador) e estar ligada a uma <b>Página do Facebook</b>.</li>
      <li>Em <code>developers.facebook.com</code>, crie um app e gere um token de usuário com a permissão de publicar conteúdo (<code>instagram_content_publish</code>).</li>
      <li>Troque esse token por um de <b>longa duração</b> (vale cerca de 60 dias).</li>
      <li>O <b>ID do usuário do Instagram</b> aparece em <code>/me/accounts?fields=instagram_business_account</code>.</li>
      <li>Para o token se renovar sozinho, salve o ID e o segredo do app na aba Instagram → Configuração geral.</li>
    </ol></details>
    ${ch ? `
    <label>ID do usuário do Instagram (IG User ID)<input name="user_id" autocomplete="off" value="${esc(ig.user_id)}"></label>
    <label>Token de acesso de longa duração<input name="token" type="password" autocomplete="off" placeholder="${acct ? "salvo — em branco mantém" : ""}"></label>
    <label>Modelo de moldura do Feed no Templated (opcional)<input name="template_feed" autocomplete="off" value="${esc(ig.template_feed)}"></label>
    <label>Modelo de moldura do Story no Templated (opcional)<input name="template_story" autocomplete="off" value="${esc(ig.template_story)}"></label>
    <div class="actions">
      <button class="btn small primary" type="submit">${acct ? "Salvar" : "Conectar"} conta de ${esc(ch.name)}</button>
      ${acct ? `<button class="btn small danger" type="button" data-disconnect="instagram">Desconectar</button>` : ""}
    </div>` : ""}
  </form>`;
}

/** Envio do cartão acima: o hub confere ID e token na Meta e devolve o @ da conta. */
export async function saveInstagramAccount(form, channelId) {
  const body = Object.fromEntries([...form.querySelectorAll("input[name]")].map((i) => [i.name, i.value]));
  const r = await api(`/api/channels/${encodeURIComponent(channelId)}/instagram`, { method: "POST", body });
  toast(`Instagram conectado: ${r.account}`);
}

function draw() {
  const box = $("#instagram");
  if (!data || !box || box.contains(document.activeElement)) return;
  const posts = data.posts.filter((p) => FILTERS[filter].includes(p.status) && (!ctx.channel || p.channel_id === ctx.channel));
  box.innerHTML = `
    ${statusChips()}
    ${composer()}
    <div class="seg ig-filter">${[["ACTIVE", "Em andamento"], ["PUBLISHED", "Publicados"], ["ALL", "Todos"]]
      .map(([f, l]) => `<button type="button" data-filter="${f}" class="${f === filter ? "active" : ""}">${l}</button>`).join("")}</div>
    <div class="ig-list">${posts.map(postCard).join("") || `<p class="empty">Nenhum post aqui.</p>`}</div>
    ${configCard()}`;
}

export async function renderInstagram(context) {
  if (context) ctx = context;
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
    await api("/api/instagram/token/check", { method: "POST" });
    toast("Tokens conferidos");
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
    const q = new URLSearchParams({ channel: e.target.channel.value, name: file.name, type: e.target.type.value, briefing: e.target.briefing.value });
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
