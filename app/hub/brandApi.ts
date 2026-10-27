import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";
import { config } from "../config.ts";
import { parseJson, resolveSpec, USE_KEYS, type Asset, type AssetKind, type Brand, type Template } from "../brand.ts";
import { all, ensureTemplates, get, getChannel, getJob, getTemplate, run, updateChannel, type Clip } from "../db.ts";
import { bus } from "../events.ts";
import { HttpError, must, route, serveFile } from "../http.ts";

// ---------- Assets do canal (vinhetas, CTA, logo, trilha) ----------

const KINDS: Record<AssetKind, string[]> = {
  intro: ["mp4", "mov", "webm", "mkv"],
  outro: ["mp4", "mov", "webm", "mkv"],
  cta: ["webm", "mov", "mp4", "png", "gif"],
  logo: ["png", "jpg", "jpeg", "webp"],
  music: ["mp3", "m4a", "wav", "ogg", "aac", "flac"],
};
const MAX_ASSET = 300 * 1024 * 1024;

export const assetDir = () => {
  const dir = join(config.mediaDir, "assets");
  mkdirSync(dir, { recursive: true });
  return dir;
};
export const assetPath = (a: Pick<Asset, "id" | "ext">) => join(assetDir(), `${a.id}.${a.ext}`);
export const getAsset = (id: number) => get<Asset>("SELECT * FROM assets WHERE id = ?", id);

async function receiveLimited(req: IncomingMessage, dest: string) {
  if (Number(req.headers["content-length"] ?? 0) > MAX_ASSET) throw new HttpError(413, "Arquivo maior que 300 MB");
  const tmp = `${dest}.part`;
  await pipeline(req, createWriteStream(tmp));
  renameSync(tmp, dest);
}

route("POST", "/api/channels/:id/assets", async (req, _r, [id]) => {
  const ch = must(getChannel(id), "Canal");
  const q = new URL(req.url!, "http://x").searchParams;
  const kind = q.get("kind") as AssetKind;
  const name = (q.get("name") ?? "").slice(0, 200);
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (!KINDS[kind]) throw new HttpError(400, "Tipo de asset inválido");
  if (!KINDS[kind].includes(ext)) throw new HttpError(400, `Formato .${ext} não aceito para ${kind} (use ${KINDS[kind].join(", ")})`);
  const assetId = Number(run("INSERT INTO assets (channel_id, kind, name, ext) VALUES (?, ?, ?, ?)", ch.id, kind, name, ext).lastInsertRowid);
  const path = assetPath({ id: assetId, ext });
  try {
    await receiveLimited(req, path);
  } catch (e) {
    run("DELETE FROM assets WHERE id = ?", assetId);
    rmSync(path, { force: true });
    throw e;
  }
  run("UPDATE assets SET size = ? WHERE id = ?", statSync(path).size, assetId);
  // Asset novo já vira o ativo daquele tipo no canal.
  const brand = parseJson<Brand>(ch.brand, {});
  if (kind === "intro" || kind === "outro") brand[kind] = assetId;
  else brand[kind] = { ...(brand[kind] as object), asset: assetId };
  updateChannel(ch.id, { brand: JSON.stringify(brand) });
  return getAsset(assetId);
});

route("DELETE", "/api/assets/:id", (_q, _r, [id]) => {
  const a = must(getAsset(+id), "Asset");
  const ch = getChannel(a.channel_id);
  if (ch) {
    const brand = parseJson<Brand>(ch.brand, {});
    if (brand.intro === a.id) brand.intro = null;
    if (brand.outro === a.id) brand.outro = null;
    for (const k of ["cta", "logo", "music"] as const) if (brand[k]?.asset === a.id) brand[k]!.asset = null;
    updateChannel(ch.id, { brand: JSON.stringify(brand) });
  }
  run("DELETE FROM assets WHERE id = ?", a.id);
  rmSync(assetPath(a), { force: true });
  bus.emit("change", { table: "channels" });
  return { ok: true };
});

route("GET", "/media/asset/:id", (req, res, [id]) => {
  const a = must(getAsset(+id), "Asset");
  serveFile(req, res, assetPath(a));
});

route("GET", "/api/worker/assets/:id", (req, res, [id]) => {
  const a = must(getAsset(+id), "Asset");
  if (!existsSync(assetPath(a))) throw new HttpError(404, "Arquivo do asset sumiu do hub");
  serveFile(req, res, assetPath(a));
}, "worker");

// ---------- Identidade (configuração dos assets) ----------

const num = (v: unknown, lo: number, hi: number, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
const color = (v: unknown) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined);

/** Normaliza o JSON vindo do dashboard (só campos conhecidos, números dentro de limites). */
function cleanBrand(b: Brand, channelId: string): Brand {
  const mine = new Set(all<{ id: number }>("SELECT id FROM assets WHERE channel_id = ?", channelId).map((a) => a.id));
  const asset = (v: unknown) => (mine.has(Number(v)) ? Number(v) : null);
  const pick = <T extends string>(v: unknown, opts: readonly T[], def: T): T => (opts.includes(v as T) ? (v as T) : def);
  return {
    intro: asset(b.intro),
    outro: asset(b.outro),
    cta: {
      asset: asset(b.cta?.asset),
      at: String(b.cta?.at ?? "70%").slice(0, 10) || "70%",
      position: pick(b.cta?.position, ["top", "center", "bottom"] as const, "bottom"),
      scale: num(b.cta?.scale, 0.1, 1, 0.6),
      key: pick(b.cta?.key, ["none", "green"] as const, "none"),
    },
    logo: {
      asset: asset(b.logo?.asset),
      position: pick(b.logo?.position, ["top-left", "top-right", "bottom-left", "bottom-right"] as const, "top-right"),
      opacity: num(b.logo?.opacity, 0.1, 1, 0.85),
      scale: num(b.logo?.scale, 0.05, 0.5, 0.16),
    },
    music: { asset: asset(b.music?.asset), volume: num(b.music?.volume, 0, 1, 0.1) },
    subtitle: {
      font: String(b.subtitle?.font ?? "").slice(0, 80),
      size: num(b.subtitle?.size, 40, 160, 84),
      color: color(b.subtitle?.color) ?? "#FFFFFF",
      outline: num(b.subtitle?.outline, 0, 20, 6),
      shadow: num(b.subtitle?.shadow, 0, 20, 3),
      outline_color: color(b.subtitle?.outline_color) ?? "#000000",
      active: pick(b.subtitle?.active, ["color", "scale"] as const, "color"),
    },
    banner: {
      style: pick(b.banner?.style, ["brush", "bar"] as const, "brush"),
      font: String(b.banner?.font ?? "").slice(0, 80),
      size: b.banner?.size ? num(b.banner.size, 60, 400, 150) : undefined,
      persist: !!b.banner?.persist,
      full_width: !!b.banner?.full_width,
      top: !!b.banner?.top,
      tilt: num(b.banner?.tilt, -10, 10, 2),
      shadow_color: color(b.banner?.shadow_color) ?? "",
      shadow_offset: num(b.banner?.shadow_offset, 0, 40, 10),
      wrap: num(b.banner?.wrap, 8, 40, 15),
    },
    credit: {
      format: String(b.credit?.format ?? "Fonte: {fonte}").slice(0, 80) || "Fonte: {fonte}",
      font: String(b.credit?.font ?? "").slice(0, 80),
      color: color(b.credit?.color) ?? "#FFFFFF",
      box: b.credit?.box !== false,
    },
    safe_insets: b.safe_insets && [b.safe_insets.top, b.safe_insets.bottom, b.safe_insets.left, b.safe_insets.right].every((v) => Number.isFinite(Number(v)) && String(v) !== "")
      ? { top: num(b.safe_insets.top, 0, 800, 0), bottom: num(b.safe_insets.bottom, 0, 900, 0), left: num(b.safe_insets.left, 0, 400, 0), right: num(b.safe_insets.right, 0, 400, 0) }
      : null,
    pillars: Array.isArray(b.pillars) ? b.pillars.map((p) => String(p).trim().toUpperCase().slice(0, 24)).filter(Boolean).slice(0, 8) : [],
    lower_third: {
      color: color(b.lower_third?.color),
      text_color: color(b.lower_third?.text_color) ?? "#FFFFFF",
      duration: num(b.lower_third?.duration, 1, 15, 4),
    },
    safe_zones: Array.isArray(b.safe_zones) ? b.safe_zones.filter((z) => ["tiktok", "youtube", "reels"].includes(z)) : undefined,
  };
}

route("PUT", "/api/channels/:id/brand", (_q, _r, [id], body: Brand) => {
  const ch = must(getChannel(id), "Canal");
  updateChannel(ch.id, { brand: JSON.stringify(cleanBrand(body ?? {}, ch.id)) });
  bus.emit("change", { table: "channels" });
  return { ok: true };
});

// ---------- Modelos de corte ----------

const TEMPLATE_FIELDS = ["name", "aspect", "min_duration", "max_duration", "layout", "remove_silence", "hook", "use_items", "cta_at", "sub_scale", "instructions", "zoom_every"] as const;

function cleanTemplate(b: Partial<Template> & { use?: string[] }) {
  const f: Record<string, string | number> = {};
  if (b.name != null) f.name = String(b.name).slice(0, 60) || "Modelo";
  if (b.aspect != null) f.aspect = b.aspect === "16:9" ? "16:9" : "9:16";
  if (b.min_duration != null) f.min_duration = num(b.min_duration, 5, 600, 30);
  if (b.max_duration != null) f.max_duration = num(b.max_duration, 10, 900, 90);
  if (b.layout != null) f.layout = ["auto", "single_speaker", "split_screen", "screen_share_focus"].includes(b.layout) ? b.layout : "auto";
  if (b.remove_silence != null) f.remove_silence = b.remove_silence ? 1 : 0;
  if (b.hook != null) f.hook = b.hook === "teaser" ? "teaser" : "inicio";
  if (b.use != null) f.use_items = JSON.stringify(b.use.filter((k) => (USE_KEYS as string[]).includes(k)));
  if (b.cta_at != null) f.cta_at = String(b.cta_at).slice(0, 10);
  if (b.sub_scale != null) f.sub_scale = num(b.sub_scale, 0.5, 2, 1);
  if (b.instructions != null) f.instructions = String(b.instructions).slice(0, 2000);
  if (b.zoom_every != null) f.zoom_every = num(b.zoom_every, 0, 30, 0);
  if (f.min_duration != null && f.max_duration != null && f.min_duration >= f.max_duration) throw new HttpError(400, "Duração mínima deve ser menor que a máxima");
  return f;
}

route("POST", "/api/channels/:id/templates", (_q, _r, [id], body: Partial<Template> & { use?: string[] }) => {
  const ch = must(getChannel(id), "Canal");
  const pos = (get<{ p: number }>("SELECT MAX(position) AS p FROM templates WHERE channel_id = ?", ch.id)?.p ?? 0) + 1;
  const tid = Number(run("INSERT INTO templates (channel_id, name, position) VALUES (?, ?, ?)", ch.id, "Novo modelo", pos).lastInsertRowid);
  return saveTemplate(tid, body);
});

route("PUT", "/api/templates/:id", (_q, _r, [id], body: Partial<Template> & { use?: string[] }) => {
  must(getTemplate(+id), "Modelo");
  return saveTemplate(+id, body);
});

function saveTemplate(id: number, body: Partial<Template> & { use?: string[] }) {
  const f = cleanTemplate(body);
  const keys = Object.keys(f).filter((k) => (TEMPLATE_FIELDS as readonly string[]).includes(k));
  if (keys.length) run(`UPDATE templates SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => f[k]), id);
  bus.emit("change", { table: "templates" });
  return getTemplate(id);
}

route("DELETE", "/api/templates/:id", (_q, _r, [id]) => {
  const t = must(getTemplate(+id), "Modelo");
  if (all("SELECT 1 FROM templates WHERE channel_id = ?", t.channel_id).length <= 1) throw new HttpError(409, "O canal precisa de ao menos um modelo");
  run("DELETE FROM templates WHERE id = ?", t.id);
  const ch = getChannel(t.channel_id);
  if (ch?.default_template === t.id) {
    const first = get<{ id: number }>("SELECT id FROM templates WHERE channel_id = ? ORDER BY position, id LIMIT 1", t.channel_id);
    updateChannel(t.channel_id, { default_template: first?.id ?? 0 });
  }
  bus.emit("change", { table: "templates" });
  return { ok: true };
});

// ---------- Resolução para o worker ----------

/** Modelo do job (ou o padrão do canal, para jobs criados antes dos modelos existirem). */
export function templateOf(jobTemplate: number, channelId: string): { tpl: Template | undefined; legacy: boolean } {
  const own = jobTemplate ? getTemplate(jobTemplate) : undefined;
  if (own) return { tpl: own, legacy: false };
  ensureTemplates(channelId);
  return { tpl: getTemplate(getChannel(channelId)?.default_template ?? 0), legacy: true };
}

export function specFor(clip: Clip) {
  const job = getJob(clip.job_id)!;
  const ch = getChannel(job.channel_id)!;
  const { tpl, legacy } = templateOf(job.template_id, ch.id);
  const assets = all<Asset>("SELECT * FROM assets WHERE channel_id = ?", ch.id);
  return resolveSpec(ch, job, clip, tpl, assets, legacy);
}
