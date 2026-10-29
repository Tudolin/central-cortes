import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { config } from "../../config.ts";
import type { Channel, Clip } from "../../db.ts";
import { tg } from "../telegram.ts";
import { connect, NeedsHuman, robotScreenUrl, sessionPath } from "./tiktokWeb.ts";

/**
 * Receita "studio" do YouTube: publica pelo YouTube Studio na web com o navegador do robô, como uma pessoa
 * faria pelo site. No Última Rep os envios pela API pararam de ter alcance; os feitos à mão continuam tendo.
 *
 * A sessão é a do canal (data/robot/youtube-<canal>.json, login feito pela tela remota) e o Studio é aberto
 * direto no ID do canal, então uma conta Google com vários canais nunca publica no canal errado.
 * Não contorna verificação: se o Google pedir login ou confirmação, o post falha e o Telegram avisa.
 */

async function needsHumanCheck(page: Page) {
  if (/accounts\.google\.com/.test(page.url())) throw new NeedsHuman("o YouTube Studio está deslogado no navegador do robô");
}

/** Studio usa caixas de texto editáveis (div contenteditable): seleciona tudo e digita por cima. */
async function fill(page: Page, box: Locator, text: string) {
  await box.click({ timeout: 15_000 });
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
}

export async function youtubeStudioUpload(ch: Channel, clip: Clip, file: string, channelId: string) {
  if (!existsSync(sessionPath(ch.id, "youtube"))) {
    void tg.alert(`🤖 Robô do YouTube sem login para "${ch.name}". Entre em Canais → ${ch.name} → YouTube → Robô do YouTube Studio.`);
    throw new Error(`robô YouTube: o canal ${ch.name} ainda não tem login no robô`);
  }
  // O Studio usa o nome do arquivo como título provisório e o guarda nos detalhes do vídeo, como o app do celular.
  const base = clip.title.replace(/[<>\\/:*?"|]/g, "").trim().slice(0, 80) || "corte";
  const named = join(dirname(file), `${base}.mp4`);
  copyFileSync(file, named);

  const browser = await connect();
  const context = await browser.newContext({ storageState: sessionPath(ch.id, "youtube"), viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`https://studio.youtube.com/channel/${channelId}/videos/upload?d=ud`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4000);
    await needsHumanCheck(page);
    if (!page.url().includes(channelId)) throw new Error("a conta logada no robô não tem acesso a este canal");

    // Mesmo truque do TikTok: o arquivo está no mesmo caminho dentro do container do navegador.
    await page.locator('input[type="file"]').first().waitFor({ state: "attached", timeout: 30_000 });
    const cdp = await context.newCDPSession(page);
    const { result } = (await cdp.send("Runtime.evaluate", { expression: `document.querySelector('input[type="file"]')` })) as { result: { objectId?: string } };
    if (!result.objectId) throw new Error("campo de upload não encontrado");
    await cdp.send("DOM.setFileInputFiles", { files: [named], objectId: result.objectId });
    await cdp.detach().catch(() => {});

    // Detalhes: título, descrição e "não é para crianças". Categoria e idioma ficam no padrão do canal.
    const title = page.locator("#title-textarea #textbox").first();
    await title.waitFor({ state: "visible", timeout: 120_000 });
    const tags = (clip.caption.match(/#[^\s#]+/g) ?? []).slice(0, 3);
    let fullTitle = clip.title.replace(/[<>]/g, "").trim().slice(0, 100);
    for (const t of tags) if (fullTitle.length + t.length + 1 <= 100) fullTitle += " " + t;
    await fill(page, title, fullTitle);
    await fill(page, page.locator("#description-textarea #textbox").first(), clip.caption.replace(/[<>]/g, "").slice(0, 4900));
    const typed = (await title.innerText()).trim();
    if (!typed.startsWith(fullTitle.slice(0, 20))) throw new Error("o título não entrou no campo do Studio");
    await page.locator('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]').first().click({ timeout: 15_000 });

    // Detalhes → Elementos → Verificações → Visibilidade.
    for (let i = 0; i < 3; i++) {
      await page.locator("#next-button").first().click({ timeout: 30_000 });
      await page.waitForTimeout(1500);
    }
    await page.locator('tp-yt-paper-radio-button[name="PUBLIC"]').first().click({ timeout: 30_000 });

    // O link do vídeo já aparece nesta etapa.
    const link = await page.locator('a[href*="youtu.be/"], a[href*="youtube.com/shorts/"], a[href*="youtube.com/watch"]').first().getAttribute("href", { timeout: 60_000 });
    const id = link?.match(/(?:youtu\.be\/|shorts\/|v=)([\w-]{11})/)?.[1];
    if (!id) throw new Error("o Studio não mostrou o link do vídeo");

    // Publica só depois que o envio terminar (o processamento continua sozinho no YouTube).
    const progress = page.locator("ytcp-video-upload-progress").first();
    for (let i = 0; i < 300 && /\d+\s?%|Enviando|Uploading/i.test(await progress.innerText().catch(() => "")); i++) await page.waitForTimeout(2000);
    const done = page.locator("#done-button").first();
    for (let i = 0; i < 60 && (await done.getAttribute("aria-disabled")) === "true"; i++) await page.waitForTimeout(2000);
    await done.click({ timeout: 30_000 });
    await page.locator("ytcp-video-share-dialog, ytcp-uploads-still-processing-dialog").first().waitFor({ timeout: 3 * 60_000 });
    await context.storageState({ path: sessionPath(ch.id, "youtube") }).catch(() => {}); // mantém os cookies renovados
    return { status: "OK" as const, external_id: id, url: `https://youtube.com/shorts/${id}`, variant: "studio" };
  } catch (e) {
    const dir = join(config.dataDir, "robot");
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `yt-clip-${clip.id}.png`) }).catch(() => {});
    if (e instanceof NeedsHuman) {
      void tg.alert(
        `🤖 Robô do YouTube parado em "${ch.name}": ${e.message}.\nRefaça o login em Canais → ${ch.name} → Robô do YouTube Studio ` +
          `(a janela aparece na tela remota: ${robotScreenUrl()}). O post será tentado de novo automaticamente.`,
      );
    }
    throw new Error(`robô YouTube: ${(e as Error).message.split("\n")[0].slice(0, 300)}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    rmSync(named, { force: true });
  }
}
