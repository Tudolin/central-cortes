/**
 * Identidade do canal em três camadas:
 *   canal (assets fixos: vinhetas, CTA, logo, trilha, estilo de legenda, zonas seguras)
 *   → modelo de corte (regras do formato: proporção, duração, layout, silêncios, gancho, quais assets entram)
 *   → corte (sobrescritas só daquele corte).
 * O hub resolve as três camadas num RenderSpec e manda pronto para o worker.
 */
import type { Channel, Clip, Job, Layout } from "./db.ts";

export type Aspect = "9:16" | "16:9";
export type UseKey = "banner" | "intro" | "outro" | "cta" | "logo" | "music" | "lower_third" | "credit";
export const USE_KEYS: UseKey[] = ["banner", "intro", "outro", "cta", "logo", "music", "lower_third", "credit"];
export type SafeZone = "tiktok" | "youtube" | "reels";
export type AssetKind = "intro" | "outro" | "cta" | "logo" | "music";

export interface Asset {
  id: number;
  channel_id: string;
  kind: AssetKind;
  name: string;
  ext: string;
  size: number;
  created_at: string;
}

export interface Brand {
  intro?: number | null;
  outro?: number | null;
  cta?: { asset?: number | null; at?: string; position?: "top" | "center" | "bottom"; scale?: number; key?: "none" | "green" };
  logo?: { asset?: number | null; position?: "top-left" | "top-right" | "bottom-left" | "bottom-right"; opacity?: number; scale?: number };
  music?: { asset?: number | null; volume?: number };
  subtitle?: { font?: string; size?: number; color?: string; outline?: number; shadow?: number; outline_color?: string; active?: "color" | "scale" };
  lower_third?: { color?: string; text_color?: string; duration?: number };
  safe_zones?: SafeZone[];
  /** Margens exatas (px no quadro 1080x1920); quando definidas, valem no lugar das zonas por plataforma. */
  safe_insets?: Insets | null;
  /** Faixa de título: "brush" (tarja de pincel) ou "bar" (título grande com barra de acento embaixo). */
  banner?: {
    style?: "brush" | "bar"; font?: string; size?: number;
    persist?: boolean; full_width?: boolean; top?: boolean; tilt?: number; shadow_color?: string; shadow_offset?: number; wrap?: number;
  };
  /** Crédito da fonte: texto ("{fonte}" = @ do canal original), fonte, cor e se leva caixa escura. */
  credit?: { format?: string; font?: string; color?: string; box?: boolean };
  /** Pilares de conteúdo: a IA escolhe um por corte (vira a tag da capa e o {pilar} da legenda). */
  pillars?: string[];
}

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Template {
  id: number;
  channel_id: string;
  name: string;
  aspect: Aspect;
  min_duration: number;
  max_duration: number;
  layout: Layout | "auto";
  remove_silence: number;
  hook: "inicio" | "teaser";
  use_items: string; // JSON UseKey[]
  cta_at: string;
  sub_scale: number;
  instructions: string;
  position: number;
  zoom_every: number; // zoom leve a cada N segundos (0 = só nas ênfases)
}

export interface Overrides {
  use?: Partial<Record<UseKey, boolean>>;
  remove_silence?: boolean;
  teaser?: boolean;
  cta_at?: string;
}

export interface AssetRef {
  id: number;
  ext: string;
}

export interface RenderSpec {
  aspect: Aspect;
  removeSilence: boolean;
  teaser: { start: number; end: number } | null;
  banner: {
    style: "brush" | "bar"; font: string; size: number; color: string; text: string; accent: string; tag: string;
    persist: boolean; fullWidth: boolean; top: boolean; tilt: number; shadowColor: string; shadowOffset: number; wrap: number;
  } | null;
  subtitle: {
    font: string; size: number; color: string; highlight: string; maxWords: number;
    outline: number; shadow: number; outlineColor: string; active: "color" | "scale";
  };
  intro: AssetRef | null;
  outro: AssetRef | null;
  cta: { asset: AssetRef; at: string; position: "top" | "center" | "bottom"; scale: number; key: "none" | "green" } | null;
  logo: { asset: AssetRef; position: "top-left" | "top-right" | "bottom-left" | "bottom-right"; opacity: number; scale: number } | null;
  music: { asset: AssetRef; volume: number } | null;
  lowerThird: { name: string; role: string; color: string; textColor: string; duration: number } | null;
  credit: { text: string; font: string; color: string; box: boolean } | null;
  safeZones: SafeZone[];
  safeInsets: Insets | null;
  zoomEvery: number;
}

export const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

export const templateUse = (t: Template | undefined) => new Set(parseJson<UseKey[]>(t?.use_items, ["banner"]));

/** Modelos iniciais de cada canal (o usuário edita/apaga à vontade no dashboard). */
export const DEFAULT_TEMPLATES: Omit<Template, "id" | "channel_id" | "position">[] = [
  {
    name: "Podcast", aspect: "9:16", min_duration: 30, max_duration: 90, layout: "auto", remove_silence: 1, hook: "inicio",
    use_items: JSON.stringify(["banner", "logo", "cta", "lower_third", "outro"]), cta_at: "", sub_scale: 1, zoom_every: 0,
    instructions: "Podcast/entrevista: um tema por corte; o título deve nomear o tema discutido.",
  },
  {
    name: "Debate", aspect: "9:16", min_duration: 30, max_duration: 90, layout: "split_screen", remove_silence: 1, hook: "teaser",
    use_items: JSON.stringify(["banner", "logo", "cta", "lower_third", "outro"]), cta_at: "", sub_scale: 1, zoom_every: 0,
    instructions: "Debate: priorize confrontos diretos, réplicas e tréplicas. O teaser deve ser a fala mais forte do embate.",
  },
  {
    name: "Daily", aspect: "9:16", min_duration: 15, max_duration: 45, layout: "single_speaker", remove_silence: 1, hook: "inicio",
    use_items: JSON.stringify(["banner", "logo", "cta"]), cta_at: "fim", sub_scale: 1.2, zoom_every: 0,
    instructions: "Daily: cortes curtos e diretos, uma ideia só, sem introdução.",
  },
  {
    name: "React", aspect: "9:16", min_duration: 30, max_duration: 90, layout: "screen_share_focus", remove_silence: 0, hook: "inicio",
    use_items: JSON.stringify(["banner", "logo", "credit"]), cta_at: "", sub_scale: 1, zoom_every: 0,
    instructions: "React: o conteúdo comentado é o foco; o corte precisa trazer a reação/comentário, não só o material original.",
  },
];

/** Zonas seguras desejadas: as escolhidas no canal, ou as das plataformas em que ele publica. */
function safeZonesOf(ch: Channel, brand: Brand): SafeZone[] {
  if (brand.safe_zones) return brand.safe_zones;
  const targets = parseJson<string[]>(ch.publish_targets, []);
  return targets.filter((t): t is SafeZone => t === "tiktok" || t === "youtube");
}

/**
 * Junta canal + modelo + sobrescritas do corte. `assets` são os do canal (validação: só entra asset que existe).
 * Sem modelo (cortes antigos): usa o modelo padrão do canal, mas sem cortar silêncios nem teaser — o que já foi
 * aprovado não muda de duração.
 */
export function resolveSpec(ch: Channel, job: Job, clip: Clip, tpl: Template | undefined, assets: Asset[], legacy: boolean): RenderSpec {
  const brand = parseJson<Brand>(ch.brand, {});
  const ov = parseJson<Overrides>(clip.overrides, {});
  const base = templateUse(tpl);
  const use = (k: UseKey) => ov.use?.[k] ?? base.has(k);
  const ref = (id: number | null | undefined): AssetRef | null => {
    const a = id ? assets.find((x) => x.id === id) : undefined;
    return a ? { id: a.id, ext: a.ext } : null;
  };

  const ctaAsset = use("cta") ? ref(brand.cta?.asset) : null;
  const logoAsset = use("logo") ? ref(brand.logo?.asset) : null;
  const musicAsset = use("music") ? ref(brand.music?.asset) : null;
  const teaserOk = clip.teaser_end > clip.teaser_start && clip.teaser_start >= clip.start_s && clip.teaser_end <= clip.end_s;
  const wantTeaser = ov.teaser ?? (!legacy && tpl?.hook === "teaser");

  return {
    aspect: (clip.aspect as Aspect) || tpl?.aspect || "9:16",
    removeSilence: ov.remove_silence ?? (!legacy && !!tpl?.remove_silence),
    teaser: wantTeaser && teaserOk ? { start: clip.teaser_start, end: clip.teaser_end } : null,
    banner: ch.title_banner && use("banner")
      ? {
          style: brand.banner?.style ?? "brush", font: brand.banner?.font || "",
          size: brand.banner?.size || ((brand.banner?.style ?? "brush") === "bar" ? 150 : 108), color: ch.banner_color, text: ch.banner_text_color,
          persist: !!brand.banner?.persist, fullWidth: !!brand.banner?.full_width, top: !!brand.banner?.top,
          tilt: brand.banner?.tilt ?? 2, shadowColor: brand.banner?.shadow_color || "", shadowOffset: brand.banner?.shadow_offset ?? 10,
          wrap: brand.banner?.wrap || 15,
          accent: ch.highlight_color, tag: clip.pillar || "",
        }
      : null,
    subtitle: {
      font: brand.subtitle?.font || "",
      size: Math.round((brand.subtitle?.size || 84) * (tpl?.sub_scale || 1)),
      color: brand.subtitle?.color || "#FFFFFF",
      highlight: ch.highlight_color,
      maxWords: ch.max_words_per_frame,
      outline: brand.subtitle?.outline ?? 6,
      shadow: brand.subtitle?.shadow ?? 3,
      outlineColor: brand.subtitle?.outline_color || "#000000",
      active: brand.subtitle?.active ?? "color",
    },
    intro: use("intro") ? ref(brand.intro) : null,
    outro: use("outro") ? ref(brand.outro) : null,
    cta: ctaAsset
      ? {
          asset: ctaAsset,
          at: ov.cta_at || tpl?.cta_at || brand.cta?.at || "70%",
          position: brand.cta?.position ?? "bottom",
          scale: brand.cta?.scale ?? 0.6,
          key: brand.cta?.key ?? "none",
        }
      : null,
    logo: logoAsset
      ? { asset: logoAsset, position: brand.logo?.position ?? "top-right", opacity: brand.logo?.opacity ?? 0.85, scale: brand.logo?.scale ?? 0.16 }
      : null,
    music: musicAsset ? { asset: musicAsset, volume: brand.music?.volume ?? 0.1 } : null,
    lowerThird:
      use("lower_third") && clip.speaker_name
        ? {
            name: clip.speaker_name,
            role: clip.speaker_role,
            color: brand.lower_third?.color || ch.banner_color,
            textColor: brand.lower_third?.text_color || "#FFFFFF",
            duration: brand.lower_third?.duration ?? 4,
          }
        : null,
    credit: use("credit") && job.video_url
      ? {
          text: (brand.credit?.format || "Fonte: {fonte}").replaceAll("{fonte}", job.uploader || job.title),
          font: brand.credit?.font || "",
          color: brand.credit?.color || "#FFFFFF",
          box: brand.credit?.box ?? true,
        }
      : null,
    safeZones: safeZonesOf(ch, brand),
    safeInsets: brand.safe_insets ?? null,
    zoomEvery: tpl?.zoom_every ?? 0,
  };
}

/**
 * Momento do CTA em segundos dentro do corte: "70%", "12" (segundos), "-5" (5 s antes do fim) ou "fim"
 * (termina junto com o corte).
 */
export function ctaStart(at: string, duration: number, ctaDuration: number): number {
  const s = at.trim().toLowerCase();
  let t: number;
  if (s === "fim" || s === "end") t = duration - ctaDuration - 0.3;
  else if (s.endsWith("%")) t = (duration * parseFloat(s)) / 100;
  else if (s.startsWith("-")) t = duration + parseFloat(s);
  else t = parseFloat(s);
  if (!Number.isFinite(t)) t = duration * 0.7;
  return Math.max(0, Math.min(t, Math.max(0, duration - 1)));
}
