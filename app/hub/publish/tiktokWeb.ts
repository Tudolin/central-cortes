import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { config } from "../../config.ts";
import type { Channel, Clip } from "../../db.ts";
import { settings } from "../settings.ts";
import { tg } from "../telegram.ts";

/**
 * Modo "Navegador": publica pelo TikTok Studio na web, controlando o Chromium do container cortes-browser
 * (mesma rede do hub, CDP em 127.0.0.1:9222).
 *
 * Cada canal tem a própria sessão do TikTok: o login é feito numa janela isolada do robô e os cookies
 * ficam salvos em data/robot/tiktok-<canal>.json. Cada post abre uma janela isolada com essa sessão,
 * então dois canais nunca se misturam no mesmo navegador.
 *
 * Não contorna detecção de robô: se o TikTok pedir login ou verificação, o post falha, o hub tenta de novo
 * mais tarde e o Telegram avisa para resolver na tela remota.
 */
const CDP = process.env.ROBOT_CDP_URL || "http://127.0.0.1:9222";
const UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload?from=webapp";

/** Tela remota do robô: mesmo host do painel, porta 10005 (Tailscale Serve). */
export const robotScreenUrl = () => process.env.ROBOT_SCREEN_URL || settings.publicUrl.replace(/:\d+$/, "") + ":10005";

class NeedsHuman extends Error {}

const robotDir = () => {
  const dir = join(config.dataDir, "robot");
  mkdirSync(dir, { recursive: true });
  return dir;
};
const sessionPath = (channelId: string) => join(robotDir(), `tiktok-${channelId}.json`);
const connect = () =>
  chromium.connectOverCDP(CDP, { timeout: 20_000 }).catch(() => {
    throw new Error("navegador do robô fora do ar (container cortes-browser)");
  });

/** Logins em andamento: janela isolada aberta na tela remota esperando o usuário entrar na conta. */
const pendingLogins = new Map<string, { browser: Browser; context: BrowserContext; page: Page; at: number }>();

export function robotStatus(channelId: string) {
  const p = sessionPath(channelId);
  return {
    saved: existsSync(p) ? statSync(p).mtime.toISOString() : null,
    pending: pendingLogins.has(channelId),
  };
}

/** Abre na tela remota uma janela isolada na página de login do TikTok, só para este canal. */
export async function robotLoginStart(channelId: string) {
  await robotLoginCancel(channelId);
  const browser = await connect();
  const context = await browser.newContext({
    viewport: null,
    ...(existsSync(sessionPath(channelId)) ? { storageState: sessionPath(channelId) } : {}),
  });
  const page = await context.newPage();
  await page.goto("https://www.tiktok.com/login", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.bringToFront().catch(() => {});
  pendingLogins.set(channelId, { browser, context, page, at: Date.now() });
}

/** Confere que a janela está logada (o Studio abre sem pedir login) e guarda a sessão do canal. */
export async function robotLoginFinish(channelId: string) {
  const p = pendingLogins.get(channelId);
  if (!p) throw new Error("Nenhum login em andamento: clique em \"Entrar no TikTok pelo robô\" primeiro");
  await p.page.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await p.page.waitForTimeout(3000);
  if (/\/login/.test(p.page.url())) throw new Error("Ainda não está logado: termine o login na tela remota e clique de novo");
  await p.context.storageState({ path: sessionPath(channelId) });
  await robotLoginCancel(channelId);
}

export async function robotLoginCancel(channelId: string) {
  const p = pendingLogins.get(channelId);
  pendingLogins.delete(channelId);
  if (!p) return;
  await p.context.close().catch(() => {});
  await p.browser.close().catch(() => {});
}

/** Usa a conta já logada na janela principal do robô (como era antes das sessões por canal). */
export async function robotAdoptMain(channelId: string) {
  const browser = await connect();
  try {
    const main = browser.contexts()[0];
    if (!main) throw new Error("janela principal do robô não encontrada");
    const page = await main.newPage();
    try {
      await page.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(3000);
      if (/\/login/.test(page.url())) throw new Error("a janela principal do robô não está logada no TikTok");
    } finally {
      await page.close().catch(() => {});
    }
    await main.storageState({ path: sessionPath(channelId) });
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- YouTube para downloads ----------
// O YouTube às vezes bloqueia downloads da conexão de casa ("confirme que você não é um robô").
// Com uma conta do Google logada na janela principal do robô, o hub exporta os cookies do YouTube
// em formato Netscape e o worker passa para o yt-dlp. A conta só é usada para ler vídeos públicos.

const YT_AUTH = ["LOGIN_INFO", "SAPISID", "__Secure-3PSID", "SID"];

/** cookies.txt enviado pelo painel (exportado de um navegador comum): tem prioridade sobre o robô. */
const uploadedCookiesPath = () => join(robotDir(), "youtube-cookies.txt");
const hasYoutubeAuth = (txt: string) =>
  txt.split(/\r?\n/).some((l) => {
    const f = l.split("\t");
    return f.length >= 7 && /youtube\.com$/.test(f[0].replace(/^#HttpOnly_/, "")) && YT_AUTH.includes(f[5]);
  });

export function saveYoutubeCookies(txt: string) {
  if (!/^# (Netscape )?HTTP Cookie File/m.test(txt) && !txt.includes("\t")) throw new Error("Arquivo não está no formato cookies.txt (Netscape)");
  if (!hasYoutubeAuth(txt)) throw new Error("O arquivo não tem a sessão do YouTube: exporte estando logado em youtube.com");
  writeFileSync(uploadedCookiesPath(), txt);
}
export const removeYoutubeCookies = () => rmSync(uploadedCookiesPath(), { force: true });
export const youtubeCookiesSource = () => (existsSync(uploadedCookiesPath()) ? statSync(uploadedCookiesPath()).mtime.toISOString() : null);

/** Cookies do YouTube (Netscape): o arquivo enviado pelo painel ou, sem ele, a janela principal do robô. */
export async function youtubeCookies(): Promise<string | null> {
  if (existsSync(uploadedCookiesPath())) return readFileSync(uploadedCookiesPath(), "utf8");
  const browser = await connect();
  try {
    const main = browser.contexts()[0];
    if (!main) return null;
    const cookies = await main.cookies(["https://www.youtube.com", "https://youtube.com", "https://accounts.google.com", "https://www.google.com"]);
    if (!cookies.some((c) => YT_AUTH.includes(c.name) && /youtube\.com$/.test(c.domain))) return null;
    const lines = cookies.map((c) => [
      c.domain, c.domain.startsWith(".") ? "TRUE" : "FALSE", c.path, c.secure ? "TRUE" : "FALSE",
      c.expires > 0 ? Math.floor(c.expires) : 0, c.name, c.value,
    ].join("\t"));
    return ["# Netscape HTTP Cookie File", ...lines, ""].join("\n");
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Abre o login do Google/YouTube na janela principal do robô (o usuário entra pela tela remota). */
export async function youtubeLoginOpen() {
  const browser = await connect();
  try {
    const main = browser.contexts()[0];
    if (!main) throw new Error("janela principal do robô não encontrada");
    const page = await main.newPage();
    await page.goto("https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
  } finally {
    await browser.close().catch(() => {}); // só desconecta: a aba fica aberta para o login
  }
}

export interface TikTokItem {
  item_id: string;
  desc: string;
  create_time: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
}

/**
 * Lê as publicações da conta do canal no TikTok Studio (aba Publicações) com a sessão do robô.
 * Não clica em nada: abre a lista e guarda o JSON que a própria página busca (item_list),
 * rolando para carregar mais páginas (50 por página).
 */
export async function tiktokStudioItems(channelId: string, maxPages = 6): Promise<TikTokItem[]> {
  if (!existsSync(sessionPath(channelId))) throw new Error("canal sem login no robô do TikTok");
  const browser = await connect();
  const context = await browser.newContext({ storageState: sessionPath(channelId), viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const items = new Map<string, TikTokItem>();
  let hasMore = true, pages = 0;
  page.on("response", async (r) => {
    if (!r.url().includes("/creator/manage/item_list/")) return;
    try {
      const j = (await r.json()) as { has_more?: boolean; item_list?: Record<string, string>[] };
      pages++;
      hasMore = !!j.has_more;
      for (const it of j.item_list ?? []) {
        items.set(it.item_id, {
          item_id: it.item_id, desc: it.desc ?? "", create_time: +it.create_time,
          views: +it.play_count || 0, likes: +it.like_count || 0, comments: +it.comment_count || 0,
          shares: +it.share_count || 0, saves: +it.favorite_count || 0,
        });
      }
    } catch {}
  });
  try {
    await page.goto("https://www.tiktok.com/tiktokstudio/content", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(6000);
    await needsHumanCheck(page);
    for (let i = 0; i < maxPages && hasMore; i++) {
      const before = pages;
      await page.mouse.move(640, 600);
      await page.mouse.wheel(0, 6000);
      await page.waitForTimeout(3000);
      if (pages === before) break;
    }
    if (!pages) throw new Error("o TikTok Studio não carregou a lista de publicações");
    await context.storageState({ path: sessionPath(channelId) }).catch(() => {});
    return [...items.values()];
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export function robotLogout(channelId: string) {
  rmSync(sessionPath(channelId), { force: true });
}

async function needsHumanCheck(page: Page) {
  if (/\/login/.test(page.url())) throw new NeedsHuman("o TikTok está deslogado no navegador do robô");
  const captcha = page.locator('[id*="captcha"], [class*="captcha"], iframe[src*="captcha"]');
  if (await captcha.first().isVisible().catch(() => false)) throw new NeedsHuman("o TikTok pediu uma verificação (captcha)");
}

/**
 * Fecha avisos de primeiro uso que cobrem o formulário (contas novas mostram vários, em PT ou EN).
 * O convite de "verificações automáticas de conteúdo" é fechado em Cancelar: o robô não muda configuração da conta.
 */
async function dismissTips(page: Page) {
  for (let round = 0; round < 4; round++) {
    let hit = false;
    const checks = page.getByText(/automatic content checks|verifica\S* autom\S* de conte/i).first();
    if (await checks.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: /^(Cancel|Cancelar)$/ }).last().click({ timeout: 3000 }).catch(() => {});
      hit = true;
    }
    for (const name of [/^Entendi$/, /^Got it$/, /^OK$/, /^Agora não$/, /^Not now$/]) {
      const b = page.getByRole("button", { name }).first();
      if (await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 3000 }).catch(() => {});
        hit = true;
      }
    }
    if (!hit) return;
    await page.waitForTimeout(600);
  }
}

/** Clica mesmo que um aviso apareça por cima no meio do caminho: fecha os avisos e tenta de novo. */
async function clickThrough(page: Page, target: Locator, what: string) {
  for (let i = 0; i < 4; i++) {
    await dismissTips(page);
    try {
      await target.click({ timeout: 8000 });
      return;
    } catch {
      await page.waitForTimeout(1000);
    }
  }
  throw new Error(`não consegui clicar em ${what} (algum aviso do TikTok ficou na frente; veja data/robot/)`);
}

export async function tiktokWebUpload(ch: Channel, clip: Clip, file: string, opts: { dryRun?: boolean } = {}) {
  // Sem sessão do canal não publica: evita postar na conta de outro canal que estiver aberta no robô.
  if (!existsSync(sessionPath(ch.id))) {
    void tg.alert(`🤖 Robô do TikTok sem login para "${ch.name}". Entre em Canais → ${ch.name} → TikTok → Robô do TikTok.`);
    throw new Error(`robô TikTok: o canal ${ch.name} ainda não tem login no robô`);
  }
  const browser = await connect();
  const context = await browser.newContext({ storageState: sessionPath(ch.id), viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
    await needsHumanCheck(page);

    // O arquivo existe no mesmo caminho dentro do container do navegador (volume compartilhado):
    // aponta o input direto para ele via CDP, sem transferir bytes (o Playwright limita a 50 MB por CDP).
    await page.locator('input[type="file"]').first().waitFor({ state: "attached", timeout: 30_000 });
    const cdp = await context.newCDPSession(page);
    const { result } = (await cdp.send("Runtime.evaluate", { expression: `document.querySelector('input[type="file"]')` })) as { result: { objectId?: string } };
    if (!result.objectId) throw new Error("campo de upload não encontrado");
    await cdp.send("DOM.setFileInputFiles", { files: [file], objectId: result.objectId });
    await cdp.detach().catch(() => {});

    // A legenda vem preenchida com o nome do arquivo: substitui pela legenda do corte.
    const editor = page.locator('.public-DraftEditor-content[contenteditable="true"]').first();
    await editor.waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForTimeout(1500); // os avisos de primeiro uso surgem logo depois do upload começar
    await clickThrough(page, editor, "a legenda");
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await page.keyboard.insertText(clip.caption.slice(0, 4000));
    await page.keyboard.press("Escape"); // fecha sugestão de hashtag/menção, se abrir
    await dismissTips(page);
    // Nunca publica com a legenda errada (ex.: o nome do arquivo que o Studio coloca sozinho).
    const typed = (await editor.innerText()).replace(/\s+/g, " ");
    const expected = clip.caption.slice(0, 40).replace(/\s+/g, " ").trim();
    if (!typed.includes(expected.slice(0, 25))) throw new Error("a legenda não entrou no campo do TikTok");

    // Espera o upload terminar ("Enviado") antes de publicar.
    await page
      .locator('[data-e2e="upload_status_container"] .info-progress.success, [data-e2e="upload_status_container"]:has-text("Enviado"), [data-e2e="upload_status_container"]:has-text("Uploaded")')
      .first()
      .waitFor({ timeout: 10 * 60_000 });
    await needsHumanCheck(page);

    // Visibilidade pública explícita (o padrão já é "Todos", mas não depende disso).
    const visibility = page.locator('[data-e2e="video_visibility_container"]');
    if (await visibility.isVisible().catch(() => false)) {
      if (!/\b(Everyone|Todos)\b/.test(await visibility.innerText())) {
        await clickThrough(page, visibility.locator("button").first(), "a visibilidade");
        await page.getByRole("option", { name: /^(Everyone|Todos)$/ }).first().click({ timeout: 10_000 });
      }
    }

    const post = page.locator('[data-e2e="post_video_button"]');
    await post.waitFor({ state: "visible", timeout: 60_000 });
    if (opts.dryRun) {
      // Teste: tudo pronto para publicar; descarta em vez de postar.
      const caption = await editor.innerText();
      await clickThrough(page, page.locator('[data-e2e="discard_post_button"]'), "Descartar");
      await page.getByRole("button", { name: /^(Descartar|Discard)$/ }).last().click({ timeout: 10_000 });
      return { status: "OK" as const, external_id: "dry-run", url: "", caption };
    }
    for (let i = 0; i < 60 && ((await post.isDisabled()) || (await post.getAttribute("aria-disabled")) === "true"); i++) {
      await page.waitForTimeout(2000);
    }
    await clickThrough(page, post, "Publicar");

    // Às vezes o TikTok confirma antes ("Publicar agora" enquanto a verificação de conteúdo roda).
    const confirm = page.getByRole("button", { name: /^(Publicar agora|Post now)$/ }).first();
    if (await confirm.isVisible({ timeout: 5000 }).catch(() => false)) await confirm.click();

    // Sucesso: o Studio sai do upload (vai para a lista de publicações) ou mostra o aviso de publicado.
    await Promise.race([
      page.waitForURL((u) => !u.pathname.includes("/upload"), { timeout: 3 * 60_000 }),
      page.getByText(/(foi publicado|sendo publicado|Your video (has been|is being) (posted|uploaded)|Vídeo publicado)/i).first().waitFor({ timeout: 3 * 60_000 }),
    ]);
    await needsHumanCheck(page);
    await context.storageState({ path: sessionPath(ch.id) }).catch(() => {}); // mantém os cookies renovados
    return { status: "OK" as const, external_id: `web:${Date.now()}`, url: "" };
  } catch (e) {
    // Print da tela para entender a falha (data/robot/clip-ID.png).
    const dir = join(config.dataDir, "robot");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `clip-${clip.id}.png`) }).catch(() => {});
    if (e instanceof NeedsHuman) {
      void tg.alert(
        `🤖 Robô do TikTok parado em "${ch.name}": ${e.message}.\nRefaça o login em Canais → ${ch.name} → Robô do TikTok ` +
          `(a janela aparece na tela remota: ${robotScreenUrl()}). O post será tentado de novo automaticamente.`,
      );
    }
    throw new Error(`robô TikTok: ${(e as Error).message.split("\n")[0].slice(0, 300)}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {}); // em conexão CDP, só desconecta; o Chromium continua aberto
  }
}
