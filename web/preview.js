// Prévia ao vivo da identidade do canal: desenha no navegador, em tempo real, o que o render vai queimar no vídeo.
// As posições e tempos espelham app/pipeline/render.ts e subtitles.ts (coordenadas no quadro 1080x1920).

const ZONES = {
  tiktok: { top: 130, bottom: 420, left: 40, right: 140 },
  youtube: { top: 120, bottom: 380, left: 40, right: 120 },
  reels: { top: 220, bottom: 420, left: 40, right: 110 },
};
// Margem da legenda e centro da faixa de título por layout (reframe.ts).
const PLAN = {
  single_speaker: { sub: 500, banner: 330 },
  split_screen: { sub: 230, banner: 960 },
  screen_share_focus: { sub: 230, banner: 830 },
  fit: { sub: 420, banner: 380 },
};
const BANNER_END = 2.5;
const SAMPLE = "A GENTE PRECISA FALAR SOBRE ISSO AGORA PORQUE NINGUÉM ESTÁ FALANDO DISSO NA TELEVISÃO".split(" ");
const SAMPLE_KW = new Set(["ISSO", "NINGUÉM", "TELEVISÃO"]);
const WORD_S = 0.38;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function ctaStart(at, duration, ctaDuration) {
  const s = String(at || "70%").trim().toLowerCase();
  let t;
  if (s === "fim" || s === "end") t = duration - ctaDuration - 0.3;
  else if (s.endsWith("%")) t = (duration * parseFloat(s)) / 100;
  else if (s.startsWith("-")) t = duration + parseFloat(s);
  else t = parseFloat(s);
  if (!Number.isFinite(t)) t = duration * 0.7;
  return Math.max(0, Math.min(t, Math.max(0, duration - 1)));
}

function wrap(title, max) {
  const lines = [];
  let cur = "";
  for (const w of title.trim().split(/\s+/)) {
    if (cur && (cur + " " + w).length > max) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}
function balanced(text, max) {
  const n = wrap(text, max).length;
  let lim = max;
  while (lim > 8 && wrap(text, lim - 1).length === n) lim--;
  return wrap(text, lim);
}

/**
 * Configuração efetiva a partir de canal + modelo + corte (mesma regra do resolveSpec do hub).
 * input: { ch, brand, tpl, use:Set, overrides, layout, title, speaker:{name,role}, credit, assets:[{id,ext,kind}], bg:{url,start}, main }
 */
export function previewConfig(i) {
  const b = i.brand || {};
  const tpl = i.tpl || {};
  const ov = i.overrides || {};
  const use = (k) => ov.use?.[k] ?? i.use.has(k);
  const asset = (id) => {
    const a = id ? i.assets.find((x) => x.id === Number(id)) : null;
    return a ? { url: `/media/asset/${a.id}`, ext: a.ext } : null;
  };
  const aspect = tpl.aspect || "9:16";
  const vertical = aspect === "9:16";
  const W = vertical ? 1080 : 1920;
  const H = vertical ? 1920 : 1080;
  const k = vertical ? 1 : 0.75;
  let safe = { top: 50, bottom: 50, left: 60, right: 60 };
  const zones = b.safe_zones ?? JSON.parse(i.ch.publish_targets || "[]").filter((z) => ZONES[z]);
  if (vertical && b.safe_insets) safe = { ...b.safe_insets };
  else if (vertical) {
    safe = { top: 60, bottom: 60, left: 50, right: 50 };
    for (const z of zones) for (const s of ["top", "bottom", "left", "right"]) safe[s] = Math.max(safe[s], ZONES[z][s]);
  }
  const layout = vertical ? (i.layout && i.layout !== "auto" ? i.layout : "single_speaker") : "fit";
  const plan = vertical ? PLAN[layout] : { sub: 70, banner: 170 };
  const split = layout === "split_screen";
  const subMarginV = split ? 0 : vertical ? Math.max(plan.sub, safe.bottom + 40) : plan.sub;
  const ctaAsset = use("cta") ? asset(b.cta?.asset) : null;
  const logoAsset = use("logo") ? asset(b.logo?.asset) : null;
  return {
    W, H, k, vertical, safe, zones: vertical ? (b.safe_insets ? ["margens do canal"] : zones) : [], layout, split, subMarginV,
    bannerY: vertical ? Math.max(plan.banner, safe.top + ((b.banner?.style ?? "brush") === "bar" && !split ? 330 : 170)) : plan.banner,
    zoomEvery: Number(tpl.zoom_every) || 0,
    main: i.main || 20,
    banner: !!Number(i.ch.title_banner ?? 1) && use("banner")
      ? {
          title: (i.title || "ESTE É O TÍTULO DO CORTE").toUpperCase(), color: i.ch.banner_color, text: i.ch.banner_text_color,
          style: b.banner?.style || "brush", font: b.banner?.font || "Impact",
          size: Number(b.banner?.size) || ((b.banner?.style || "brush") === "bar" ? 150 : 108), accent: i.ch.highlight_color || "#FFD700",
          persist: !!b.banner?.persist, fullWidth: !!b.banner?.full_width, top: !!b.banner?.top, tilt: Number(b.banner?.tilt ?? 2),
          shadowColor: b.banner?.shadow_color || "", shadowOffset: Number(b.banner?.shadow_offset ?? 10), wrap: Number(b.banner?.wrap) || 15,
          tag: i.pillar ?? (b.pillars ?? [])[0] ?? "", keywords: i.keywords ?? [],
        }
      : null,
    sub: {
      font: b.subtitle?.font || "Arial Black",
      size: Math.round((b.subtitle?.size || 84) * (Number(tpl.sub_scale) || 1)),
      color: b.subtitle?.color || "#FFFFFF",
      highlight: i.ch.highlight_color || "#FFD700",
      maxWords: Number(i.ch.max_words_per_frame) || 3,
      outline: Number(b.subtitle?.outline ?? 6),
      shadow: Number(b.subtitle?.shadow ?? 3),
      outlineColor: b.subtitle?.outline_color || "#000000",
      active: b.subtitle?.active || "color",
    },
    intro: use("intro") ? asset(b.intro) : null,
    outro: use("outro") ? asset(b.outro) : null,
    cta: ctaAsset ? { ...ctaAsset, at: ov.cta_at || tpl.cta_at || b.cta?.at || "70%", position: b.cta?.position || "bottom", scale: Number(b.cta?.scale) || 0.6, key: b.cta?.key || "none" } : null,
    logo: logoAsset ? { ...logoAsset, position: b.logo?.position || "top-right", opacity: Number(b.logo?.opacity ?? 0.85), scale: Number(b.logo?.scale) || 0.16 } : null,
    lt: use("lower_third") && i.speaker?.name
      ? { name: i.speaker.name, role: i.speaker.role || "", color: b.lower_third?.color || i.ch.banner_color, text: b.lower_third?.text_color || "#FFFFFF", dur: Number(b.lower_third?.duration) || 4 }
      : null,
    credit: use("credit")
      ? {
          text: (b.credit?.format || "Fonte: {fonte}").replaceAll("{fonte}", i.source || "@canaloriginal"),
          font: b.credit?.font || "", color: b.credit?.color || "#FFFFFF", box: b.credit?.box !== false,
        }
      : null,
    bg: i.bg || null,
  };
}

// ---------- Camadas ----------

// Tamanho do ASS → px de CSS: o libass usa a altura de linha da fonte (ascendente + descendente) como tamanho.
const FONT_RATIO = { anton: 1.733, "archivo semibold": 1.51, oswald: 1.702, "barlow semibold": 1.361 };
const fsOf = (font) => 1 / (FONT_RATIO[String(font || "").toLowerCase()] ?? 1.16);
const FS = fsOf("");

function bgLayer(c) {
  return `<div class="pv-bgwrap" data-bgwrap>${bgVideos(c)}</div>`;
}

function bgVideos(c) {
  const ph = `<div class="pv-ph">vídeo de exemplo indisponível</div>`;
  if (!c.bg) return ph;
  const v = (style) => `<video class="pv-bg" data-bg muted playsinline preload="auto" src="${esc(c.bg.url)}" style="${style}"></video>`;
  if (!c.vertical) return ph + v(`inset:0;width:100%;height:100%;object-fit:cover`);
  if (c.layout === "split_screen")
    return ph + v(`left:0;top:0;width:${c.W}px;height:${c.H / 2}px;object-fit:cover;object-position:25% 30%`) +
      v(`left:0;top:${c.H / 2}px;width:${c.W}px;height:${c.H / 2}px;object-fit:cover;object-position:75% 30%`);
  if (c.layout === "screen_share_focus")
    return ph + v(`inset:0;width:100%;height:100%;object-fit:cover;filter:blur(24px) brightness(.7)`) +
      v(`left:0;top:0;width:${c.W}px;height:810px;object-fit:cover;object-position:50% 30%`) +
      v(`left:0;top:840px;width:${c.W}px;height:${Math.round((c.W * 9) / 16)}px;object-fit:contain;background:#000`);
  return ph + v(`inset:0;width:100%;height:100%;object-fit:cover`);
}

/** Faixa estilo capa: quadro escurecido, tag do pilar, título com uma palavra em destaque e barra embaixo. */
function barBannerLayer(c) {
  const b = c.banner;
  let size = Math.round(b.size * c.k);
  let lines = balanced(b.title, 14);
  if (lines.length > 3) {
    size = Math.round(b.size * 0.8 * c.k);
    lines = balanced(b.title, 18);
  }
  const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const words = b.title.split(/\s+/);
  const keys = new Set(b.keywords.map(norm));
  const accent = words.find((w) => keys.has(norm(w))) ?? words.reduce((a, w) => (norm(w).length > norm(a).length ? w : a), "");
  let painted = false;
  const paint = (line) => line.split(" ").map((w) => {
    if (!painted && w === accent) {
      painted = true;
      return `<span style="color:${b.accent}">${esc(w)}</span>`;
    }
    return esc(w);
  }).join(" ");
  const lineH = size * 0.95;
  const blockH = lines.length * lineH;
  const top = Math.max(c.bannerY - blockH / 2, c.vertical ? c.safe.top + 250 : c.safe.top + 40);
  const f = fsOf(b.font);
  return `<div data-a="0" data-b="${BANNER_END}" data-fade="0.5" class="pv-abs" style="inset:0">
    <div class="pv-abs" style="inset:0;background:rgba(0,0,0,.6)"></div>
    ${b.tag ? `<div class="pv-tag" style="left:50%;bottom:${c.H - top + 28 * c.k}px;font-size:${40 * c.k * FS}px;padding:${10 * c.k}px ${14 * c.k}px">${esc(b.tag.toUpperCase())}</div>` : ""}
    <div class="pv-bartitle" style="top:${top}px;font-family:'${esc(b.font)}',Impact,sans-serif;font-size:${size * f}px;line-height:${lineH}px;color:${b.text};-webkit-text-stroke:${Math.round(16 * c.k)}px #0e0e0d">
      <span class="pv-barwrap">${lines.map(paint).join("<br>")}<i style="height:${14 * c.k}px;bottom:${-(24 + 14) * c.k}px;background:${b.accent}"></i></span></div>
  </div>`;
}

function bannerLayer(c) {
  const b = c.banner;
  if (b.style === "bar") return barBannerLayer(c);
  let size = Math.round(b.size * c.k);
  let lines = balanced(b.title, b.wrap);
  if (lines.length > 3) {
    size = Math.round(b.size * 0.8 * c.k);
    lines = balanced(b.title, Math.round(b.wrap * 1.4));
  }
  const textW = Math.max(...lines.map((l) => l.length)) * size * 0.5;
  const maxW = b.fullWidth ? c.W - c.safe.left - c.safe.right : Math.min(c.W - c.safe.left - c.safe.right, c.W * 0.89);
  const w = b.fullWidth ? maxW : Math.round(Math.min(maxW, Math.max(560 * c.k, textW + 90 * c.k)));
  const h = Math.round(lines.length * size + 50 * c.k);
  const cx = b.fullWidth ? (c.safe.left + c.W - c.safe.right) / 2 : c.W / 2;
  const top = b.top ? c.safe.top : c.bannerY - h / 2;
  // Borda de pincel: polígono com pequenas irregularidades, como no render.
  let s = 7;
  const rnd = (a) => ((s = (s * 9301 + 49297) % 233280) / 233280 - 0.5) * 2 * a;
  const pts = [];
  if (b.fullWidth) {
    // Papel rasgado em cima e embaixo, laterais retas (como no render).
    for (let x = 0; x <= 100; x += 2) pts.push(`${x}% ${(rnd(9) / h) * 100}%`);
    for (let x = 100; x >= 0; x -= 2) pts.push(`${x}% ${100 + (rnd(9) / h) * 100}%`);
  } else {
    for (let x = 0; x <= 100; x += 5) pts.push(`${x}% ${(rnd(7) / h) * 100 + 0}%`);
    for (let y = 10; y < 100; y += 15) pts.push(`${100 + (rnd(9) / w) * 100}% ${y}%`);
    for (let x = 100; x >= 0; x -= 5) pts.push(`${x}% ${100 + (rnd(7) / h) * 100}%`);
    for (let y = 90; y > 0; y -= 15) pts.push(`${(rnd(9) / w) * 100}% ${y}%`);
  }
  const clip = `clip-path:polygon(${pts.join(",")})`;
  const off = b.shadowOffset * c.k;
  const shadow = b.shadowColor
    ? `<div class="pv-banner-box" style="background:${b.shadowColor};${clip};transform:translate(${off}px,${off}px);box-shadow:none"></div>`
    : "";
  const when = b.persist ? `data-a="0" data-b="${c.main}"` : `data-a="0" data-b="${BANNER_END}" data-fade="0.5"`;
  return `<div ${when} class="pv-banner" style="left:${cx - w / 2}px;top:${top}px;width:${w}px;height:${h}px;transform:rotate(${-b.tilt}deg)">
    ${shadow}<div class="pv-banner-box" style="background:${c.banner.color};${clip}${b.shadowColor ? ";box-shadow:none" : ""}"></div>
    <div class="pv-banner-text" style="font-family:'${esc(b.font)}',Impact,sans-serif;font-weight:700;font-size:${size * fsOf(b.font) * (b.font === "Impact" ? 1.05 : 1)}px;line-height:${size}px;color:${b.text};-webkit-text-stroke:${Math.round(10 * c.k)}px #000">${lines.map(esc).join("<br>")}</div>
  </div>`;
}

function subLayer(c) {
  const s = c.sub;
  const shadow = s.shadow ? `text-shadow:${s.shadow * c.k}px ${s.shadow * c.k}px 0 rgba(0,0,0,.6)` : "text-shadow:none";
  const base = `left:80px;right:80px;font-family:'${esc(s.font)}',Arial Black,sans-serif;font-size:${s.size * c.k * fsOf(s.font)}px;color:${s.color};-webkit-text-stroke:${Math.round(2 * s.outline * c.k)}px ${s.outlineColor};${shadow}`;
  const pos = c.split ? `top:${c.H / 2}px;transform:translateY(-50%)` : `bottom:${c.subMarginV}px`;
  const alt = c.split && c.banner && !c.banner.top ? `<div class="pv-sub" data-sub data-a="0" data-b="${BANNER_END}" style="${base};top:${c.H / 2 + 190}px"></div>` : "";
  const from = alt ? BANNER_END : 0;
  return `${alt}<div class="pv-sub" data-sub data-a="${from}" data-b="${c.main}" style="${base};${pos}"></div>`;
}

function ltLayer(c) {
  const l = c.lt;
  const at = c.banner ? 2.6 : 0.5;
  const dur = Math.min(l.dur, Math.max(1, c.main - 3));
  const x = c.safe.left + 30;
  const y = c.split || !c.vertical ? c.H - c.safe.bottom - 40 : c.H - c.subMarginV - 240;
  return `<div class="pv-lt" data-a="${at}" data-b="${at + dur}" data-fade="0.3" style="left:${x}px;bottom:${c.H - y}px">
    <div style="background:${l.color};color:${l.text};font-size:${54 * c.k * FS}px;padding:${14 * c.k}px">${esc(l.name.toUpperCase())}</div>
    ${l.role ? `<div style="background:rgba(16,16,16,.88);color:#fff;font-size:${36 * c.k * FS}px;padding:${12 * c.k}px;font-weight:400">${esc(l.role)}</div>` : ""}
  </div>`;
}

/** Crédito: logo abaixo do logo/selo quando ele fica no canto superior esquerdo (como no render). */
function creditHtml(c) {
  const cr = c.credit;
  const look = cr.box ? "background:rgba(0,0,0,.62);padding:" + 10 * c.k + "px" : "text-shadow:0 0 3px #000,0 0 2px #000";
  return `<div class="pv-credit" style="position:static;font-family:'${esc(cr.font || c.sub.font)}',Arial,sans-serif;font-size:${(cr.box ? 32 : 30) * c.k * fsOf(cr.font || c.sub.font)}px;color:${cr.color};${look}">${esc(cr.text)}</div>`;
}

function logoLayer(c) {
  const l = c.logo;
  const w = Math.round(c.W * l.scale);
  const [vy, hx] = l.position.split("-");
  const m = 24;
  if (l.position === "top-left") {
    return `<div class="pv-abs" style="left:${c.safe.left + m}px;top:${c.safe.top + m}px;display:grid;gap:14px;justify-items:start">
      <img src="${esc(l.url)}" style="width:${w}px;opacity:${l.opacity}" alt="">${c.credit ? creditHtml(c) : ""}</div>`;
  }
  if (l.position === "bottom-left") {
    // Crédito logo acima do selo; a legenda sobe para não encostar (ajustado no tick pela altura real).
    return `<div class="pv-abs" data-logostack style="left:${c.safe.left + m}px;bottom:${c.safe.bottom + m}px;display:grid;gap:12px;justify-items:start">
      ${c.credit ? creditHtml(c) : ""}<img src="${esc(l.url)}" style="width:${w}px;opacity:${l.opacity}" alt=""></div>`;
  }
  const x = hx === "left" ? `left:${c.safe.left + m}px` : `right:${c.safe.right + m}px`;
  const y = vy === "top" ? `top:${c.safe.top + m}px` : `bottom:${c.safe.bottom + m}px`;
  return `<img class="pv-abs" data-logostack src="${esc(l.url)}" style="${x};${y};width:${w}px;opacity:${l.opacity}" alt="">`;
}

function ctaLayer(c) {
  const t = c.cta;
  const w = Math.round(c.W * t.scale);
  const y = t.position === "top" ? `top:${c.safe.top + 220}px` : t.position === "center" ? `top:50%;transform:translate(-50%,-50%)`
    : c.split || !c.vertical ? `bottom:${c.safe.bottom + 20}px` : `bottom:${c.subMarginV + 260}px`;
  const tx = t.position === "center" ? "" : ";transform:translateX(-50%)";
  const isImg = t.ext === "png" || t.ext === "gif";
  const media = isImg
    ? `<img src="${esc(t.url)}" style="width:100%" alt="">`
    : t.key === "green"
      ? `<video data-cta-src muted playsinline preload="auto" src="${esc(t.url)}" style="display:none"></video><canvas data-key style="width:100%"></canvas>`
      : `<video data-cta-src muted playsinline preload="auto" src="${esc(t.url)}" style="width:100%"></video>`;
  return `<div class="pv-abs" data-cta style="left:50%;${y};width:${w}px${tx}">${media}</div>`;
}

function creditLayer(c) {
  if (c.logo?.position === "top-left" || c.logo?.position === "bottom-left") return ""; // já vai junto do logo
  return `<div class="pv-abs" style="left:${c.safe.left + 20}px;top:${c.safe.top + 20}px">${creditHtml(c)}</div>`;
}

function zonesLayer(c) {
  if (!c.zones.length) return "";
  const s = c.safe;
  return `<div class="pv-zones" data-zones>
    <i style="left:0;right:0;top:0;height:${s.top}px"></i><i style="left:0;right:0;bottom:0;height:${s.bottom}px"></i>
    <i style="left:0;top:${s.top}px;bottom:${s.bottom}px;width:${s.left}px"></i><i style="right:0;top:${s.top}px;bottom:${s.bottom}px;width:${s.right}px"></i>
    <span style="bottom:${s.bottom / 2}px">interface ${c.zones.join(" + ")}</span></div>`;
}

// ---------- Componente ----------

const live = new Set();

/** Cria (uma vez) o player da prévia dentro de `el`. */
export function mountPreview(el) {
  if (el._pv) return el._pv;
  el.classList.add("pv");
  el.innerHTML = `<div class="pv-stage"><div class="pv-frame"></div></div>
    <div class="pv-bar"><button type="button" class="btn small" data-pv-play>❚❚</button><input type="range" min="0" max="1000" value="0" data-pv-seek aria-label="Posição"><span class="mono" data-pv-time></span></div>
    <div class="pv-track" data-pv-track></div>
    <label class="pv-opt"><input type="checkbox" data-pv-zones checked> mostrar zonas seguras</label>`;
  const pv = { el, cfg: null, key: "", t: 0, playing: true, durs: { intro: 3, outro: 3, cta: 4 } };
  el._pv = pv;
  el.querySelector("[data-pv-play]").addEventListener("click", () => {
    pv.playing = !pv.playing;
    el.querySelector("[data-pv-play]").textContent = pv.playing ? "❚❚" : "▶";
  });
  el.querySelector("[data-pv-seek]").addEventListener("input", (e) => {
    pv.t = (e.target.value / 1000) * total(pv);
    pv.seeked = true;
  });
  el.querySelector("[data-pv-zones]").addEventListener("change", (e) => el.classList.toggle("pv-nozones", !e.target.checked));
  new ResizeObserver(() => fit(pv)).observe(el.querySelector(".pv-stage"));
  live.add(pv);
  if (live.size === 1) next();
  return pv;
}

/** Encaixa o quadro (1080x1920 ou 1920x1080) na largura disponível. */
function fit(pv) {
  if (!pv.cfg) return;
  const stage = pv.el.querySelector(".pv-stage");
  const scale = stage.clientWidth / pv.cfg.W || 0.25;
  stage.style.height = `${pv.cfg.H * scale}px`;
  pv.el.querySelector(".pv-frame").style.cssText = `width:${pv.cfg.W}px;height:${pv.cfg.H}px;transform:scale(${scale})`;
}

const total = (pv) => (pv.cfg?.intro ? pv.durs.intro : 0) + (pv.cfg?.main ?? 20) + (pv.cfg?.outro ? pv.durs.outro : 0);

/** Atualiza a prévia; só reconstrói as camadas quando a configuração muda. */
export function updatePreview(el, cfg) {
  const pv = mountPreview(el);
  const key = JSON.stringify(cfg);
  if (key === pv.key) return;
  pv.key = key;
  pv.cfg = cfg;
  const frame = el.querySelector(".pv-frame");
  fit(pv);
  frame.innerHTML = `
    <div class="pv-phase" data-phase="main">${bgLayer(cfg)}${cfg.logo ? logoLayer(cfg) : ""}${subLayer(cfg)}${cfg.banner ? bannerLayer(cfg) : ""}
      ${cfg.lt ? ltLayer(cfg) : ""}${cfg.credit ? creditLayer(cfg) : ""}${cfg.cta ? ctaLayer(cfg) : ""}</div>
    ${cfg.intro ? `<div class="pv-phase" data-phase="intro"><video data-vin muted playsinline preload="auto" src="${esc(cfg.intro.url)}"></video></div>` : ""}
    ${cfg.outro ? `<div class="pv-phase" data-phase="outro"><video data-vin muted playsinline preload="auto" src="${esc(cfg.outro.url)}"></video></div>` : ""}
    ${zonesLayer(cfg)}`;
  drawTrack(pv);
}

function ctaWindow(pv) {
  const c = pv.cfg;
  if (!c.cta) return null;
  const d = c.cta.ext === "png" || c.cta.ext === "gif" ? 4 : Math.min(pv.durs.cta, c.main);
  const a = ctaStart(c.cta.at, c.main, d);
  return [a, a + d];
}

function drawTrack(pv) {
  const c = pv.cfg;
  const T = total(pv);
  const pct = (x) => `${(x / T) * 100}%`;
  const intro = c.intro ? pv.durs.intro : 0;
  const parts = [];
  if (c.intro) parts.push(`<i class="seg intro" style="left:0;width:${pct(intro)}" title="Vinheta de abertura"></i>`);
  parts.push(`<i class="seg main" style="left:${pct(intro)};width:${pct(c.main)}"></i>`);
  if (c.outro) parts.push(`<i class="seg outro" style="left:${pct(intro + c.main)};width:${pct(pv.durs.outro)}" title="Vinheta de encerramento"></i>`);
  if (c.banner) parts.push(`<i class="mark banner" style="left:${pct(intro)};width:${pct(BANNER_END)}" title="Faixa de título"></i>`);
  const cw = ctaWindow(pv);
  if (cw) parts.push(`<i class="mark cta" style="left:${pct(intro + cw[0])};width:${pct(cw[1] - cw[0])}" title="Pedido de inscrição"></i>`);
  if (c.lt) {
    const at = c.banner ? 2.6 : 0.5;
    parts.push(`<i class="mark lt" style="left:${pct(intro + at)};width:${pct(Math.min(c.lt.dur, c.main - at))}" title="Lower third"></i>`);
  }
  pv.el.querySelector("[data-pv-track]").innerHTML = parts.join("");
  pv.ctaWin = cw;
}

// ---------- Relógio ----------

let lastTs = 0;
// Timer (e não requestAnimationFrame): a prévia continua viva com a aba em segundo plano.
const next = () => setTimeout(() => loop(performance.now()), 33);
function loop(ts) {
  const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
  lastTs = ts;
  for (const pv of live) {
    if (!pv.el.isConnected) {
      live.delete(pv);
      continue;
    }
    if (pv.cfg && pv.el.offsetParent !== null) tick(pv, dt);
  }
  if (live.size) next();
  else lastTs = 0;
}

function sync(v, t, playing) {
  if (!v || !Number.isFinite(t)) return;
  const d = v.duration;
  const target = Number.isFinite(d) && d > 0 ? Math.min(t, d - 0.05) : t;
  if (Math.abs(v.currentTime - target) > 0.35) v.currentTime = Math.max(0, target);
  if (playing && v.paused) v.play().catch(() => {});
  if (!playing && !v.paused) v.pause();
}

function tick(pv, dt) {
  const c = pv.cfg;
  const T = total(pv);
  if (pv.playing && !pv.seeked) pv.t = (pv.t + dt) % T;
  pv.seeked = false;
  // Durações reais das vinhetas e do CTA assim que os metadados chegam (linha do tempo e momento "fim").
  const f = pv.el.querySelector(".pv-frame");
  let changed = false;
  f.querySelectorAll("[data-phase=intro] video, [data-phase=outro] video, [data-cta-src]").forEach((v) => {
    const which = v.matches("[data-cta-src]") ? "cta" : v.closest("[data-phase]").dataset.phase;
    if (Number.isFinite(v.duration) && v.duration > 0 && Math.abs(pv.durs[which] - v.duration) > 0.01) {
      pv.durs[which] = v.duration;
      changed = true;
    }
  });
  if (changed) drawTrack(pv);
  const intro = c.intro ? pv.durs.intro : 0;
  const t = pv.t;
  const phase = t < intro ? "intro" : t < intro + c.main ? "main" : "outro";
  const m = t - intro; // tempo dentro do corte
  f.querySelectorAll("[data-phase]").forEach((p) => {
    const on = p.dataset.phase === phase;
    p.style.visibility = on ? "visible" : "hidden";
    p.querySelectorAll("video[data-vin]").forEach((v) => (on ? sync(v, phase === "intro" ? t : t - intro - c.main, pv.playing) : v.pause()));
  });
  if (phase === "main") {
    f.querySelectorAll("video[data-bg]").forEach((v) => sync(v, (c.bg?.start ?? 0) + m, pv.playing));
    f.querySelectorAll("[data-a]").forEach((el) => {
      const a = +el.dataset.a;
      const b = +el.dataset.b;
      const fade = +(el.dataset.fade || 0);
      const on = m >= a && m < b;
      el.style.visibility = on ? "visible" : "hidden";
      if (on && fade) el.style.opacity = String(Math.min(1, (b - m) / fade, el.classList.contains("pv-lt") ? (m - a) / fade : 1));
    });
    // Legenda de exemplo: blocos de N palavras, palavra falada em destaque.
    const i = Math.floor(m / WORD_S) % SAMPLE.length;
    const n = c.sub.maxWords;
    const start = i - (i % n);
    const html = SAMPLE.slice(start, start + n).map((w, j) => {
      const active = start + j === i;
      const colored = SAMPLE_KW.has(w) || (active && c.sub.active !== "scale");
      const style = [colored ? `color:${c.sub.highlight}` : "", active ? "display:inline-block;transform:scale(1.12)" : ""].filter(Boolean).join(";");
      return style ? `<span style="${style}">${w}</span>` : w;
    }).join(" ");
    f.querySelectorAll("[data-sub]").forEach((s) => (s.innerHTML = html));
    // Logo embaixo: a legenda sobe acima do selo e do crédito, como no render.
    const stack = f.querySelector("[data-logostack]");
    if (stack && c.vertical && !c.split && c.logo?.position.startsWith("bottom")) {
      const minB = c.safe.bottom + 24 + stack.offsetHeight + 30;
      f.querySelectorAll("[data-sub]").forEach((s) => (s.style.bottom = `${Math.max(c.subMarginV, minB)}px`));
    }
    // Zoom de ritmo do modelo (leve, a cada N segundos), como o zoompan do render.
    const wrap = f.querySelector("[data-bgwrap]");
    if (wrap) {
      const n = c.zoomEvery;
      const beat = n > 0 && m >= n && m % n < 1.6 && m < c.main - 1;
      wrap.style.transform = beat ? "scale(1.06)" : "";
    }
    // CTA
    const box = f.querySelector("[data-cta]");
    if (box && pv.ctaWin) {
      const on = m >= pv.ctaWin[0] && m < pv.ctaWin[1];
      box.style.visibility = on ? "visible" : "hidden";
      const v = box.querySelector("[data-cta-src]");
      if (v) on ? sync(v, m - pv.ctaWin[0], pv.playing) : v.pause();
      const canvas = box.querySelector("canvas[data-key]");
      if (on && canvas && v && v.readyState >= 2) chromaKey(v, canvas);
    }
  } else f.querySelectorAll("video[data-bg], [data-cta-src]").forEach((v) => v.pause());
  pv.el.querySelector("[data-pv-seek]").value = String(Math.round((t / T) * 1000));
  pv.el.querySelector("[data-pv-time]").textContent = `${t.toFixed(1)}s / ${T.toFixed(1)}s`;
}

/** Remove o fundo verde do CTA no canvas (o render usa colorkey no ffmpeg). */
function chromaKey(v, canvas) {
  const w = Math.min(480, v.videoWidth);
  const h = Math.round((w * v.videoHeight) / v.videoWidth);
  if (!w || !h) return;
  if (canvas.width !== w) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let p = 0; p < d.length; p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    if (g > 90 && g > r * 1.35 && g > b * 1.35) d[p + 3] = 0;
  }
  ctx.putImageData(img, 0, 0);
}
