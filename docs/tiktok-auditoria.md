# Auditoria do app no TikTok (publicação direta)

Sem auditoria, o TikTok só aceita publicação direta como **privada** ("Somente eu"). Depois de aprovado, os cortes agendados e o "Publicar agora" saem públicos sem nenhum toque no celular.

O dashboard já segue as [diretrizes de Direct Post](https://developers.tiktok.com/doc/content-sharing-guidelines) que os revisores verificam:

| Exigência do TikTok | Onde está no dashboard |
|---|---|
| Mostrar a conta de destino (nome e avatar), consultada a cada abertura | Estúdio → painel "Publicar no TikTok como …" |
| Bloquear quando a conta não pode postar (`can_post`) e checar a duração máxima | Mensagem vermelha no painel; botões desativados |
| Legenda editável | Campo "Legenda no TikTok" |
| Privacidade escolhida pelo usuário, só entre as opções da conta, **sem padrão** | "Quem pode ver este vídeo" começa em "Selecione…" |
| Comentários / Dueto / Stitch desmarcados por padrão; desativados se a conta não permite | Linha "Permitir:" |
| Divulgação de conteúdo comercial (desligada por padrão), "Sua marca" / "Conteúdo de marca", rótulos e bloqueio de "Somente eu" para conteúdo de marca | Chave "Divulgar conteúdo comercial" |
| Declaração de consentimento com links para as políticas | Texto acima dos botões (muda quando há conteúdo de marca) |
| Prévia do conteúdo | Player 9:16 do corte renderizado |
| Consentimento explícito antes do envio | Envio só acontece depois de clicar em Aprovar / Publicar agora |
| Aviso de processamento e acompanhamento de status | Aviso no painel; o hub consulta o status até o post ficar público e mostra o link |
| Sem marca d'água promocional | A faixa de título é conteúdo editorial do próprio canal, não logo do app |

## Antes de enviar

1. **Páginas públicas obrigatórias.** O hub já serve, sem senha, a página do app, os Termos e a Política de Privacidade (`web/legal/`, rota `/legal/`). Para ficarem públicas na internet, publique pelo Funnel no notebook (uma vez):

   ```bash
   sudo tailscale funnel --bg --set-path /central-cortes http://127.0.0.1:8095/legal
   ```

   Defina o e-mail de contato exibido nas páginas em `~/editor-cortes/.env` (`LEGAL_CONTACT_EMAIL=...`) e rode `docker compose up -d`.

   | Página | URL |
   |---|---|
   | Site do app | `https://debian.hedgehog-parrotfish.ts.net/central-cortes/` |
   | Termos de Uso | `https://debian.hedgehog-parrotfish.ts.net/central-cortes/terms` |
   | Política de Privacidade | `https://debian.hedgehog-parrotfish.ts.net/central-cortes/privacy` |
2. **App de produção.** Em *developers.tiktok.com → seu app → Production*:
   - Products: **Login Kit** (Redirect URI `https://debian.hedgehog-parrotfish.ts.net:10004/oauth/tiktok/callback`) e **Content Posting API** com **Direct Post** ativado.
   - Scopes: `user.info.basic` e `video.publish` (veja "Produtos e escopos para produção").
3. **Gravar o demo no sandbox.** No dashboard (Canais → TikTok: modo) escolha **Publicação direta**, salve e clique em **Reconectar** a conta (o escopo muda para `video.publish`). No sandbox os posts saem privados — é esperado e serve para o vídeo.

## Formulário "Basic information"

| Campo | Valor |
|---|---|
| App icon | `assets/logo-1024.png` |
| App name | `Central de Cortes` |
| Category | Photo & Video (ou Entertainment, se não houver) |
| Description (máx. 120) | `Private tool that turns a creator's own long videos into vertical clips and posts approved ones to their TikTok.` |
| Terms of Service URL | `https://debian.hedgehog-parrotfish.ts.net/central-cortes/terms` |
| Privacy Policy URL | `https://debian.hedgehog-parrotfish.ts.net/central-cortes/privacy` |
| Platforms | **Web** — Web/Desktop URL: `https://debian.hedgehog-parrotfish.ts.net/central-cortes/` |

Domínio verificado por **URL prefix** (`/central-cortes/`): o `*.ts.net` não aceita registro TXT. Os arquivos `tiktok….txt` ficam em `~/editor-cortes/data/verify/` no notebook.

## Produtos e escopos para produção

A revisão exige que **todo** produto e escopo selecionado apareça no vídeo — o que não aparece deve ser removido, senão a análise atrasa. Envie só:

- **Login Kit** — Redirect URI `https://debian.hedgehog-parrotfish.ts.net:10004/oauth/tiktok/callback`
- **Content Posting API** com **Direct Post** ativado
- Scopes: `user.info.basic` e `video.publish` (remova `video.upload`, `user.info.profile` e `video.list`)

## Texto "Explain how each product and scope works" (905/1000)

```text
Central de Cortes is a private web app used only by the owner of the Ideias em Comum channel to publish short clips of the channel's own long videos to the owner's own TikTok account.

Login Kit (user.info.basic): the owner clicks "Connect" in the app, logs in with TikTok and authorizes it. We show the connected account's nickname and avatar on the posting screen so the owner knows where the clip will be posted.

Content Posting API - Direct Post (video.publish): for each clip, the owner previews the video, edits the caption, picks who can view it (no default), chooses Comment/Duet/Stitch (off by default, greyed out if disabled in the account), sets the commercial content disclosure, and agrees to the Music Usage Confirmation. Only after the owner clicks "Publish now" or approves a time is the video uploaded. We poll the post status and show the result. Nothing is posted to any other account.
```

## Vídeo de demonstração (MP4, até 50 MB, ~2–3 min)

**Preparação (antes de gravar)**

1. No sandbox, deixe os mesmos produtos e escopos da lista acima e confira se a conta `ideiasemcomum` está em *Target users*. No cartão TikTok do dashboard, use as chaves **do sandbox**.
2. Dashboard → **Canais** → "TikTok: modo" = **Publicação direta** → *Salvar canal*.
3. Em **Canais → Contas conectadas → TikTok**, clique em **Desconectar** (para mostrar o login do zero no vídeo).
4. Tenha um corte em **Pendente de Aprovação** (processe um vídeo curto se precisar).
5. Navegador em tela cheia, zoom ~110%, abrindo o dashboard por `https://debian.hedgehog-parrotfish.ts.net:10004` — o domínio precisa ser o mesmo do site informado. Gravador: Xbox Game Bar (`Win+Alt+R`) ou OBS; exporte em 1080p.
6. Deixe outra aba aberta no `tiktok.com` logado na conta `ideiasemcomum` (para mostrar o post no final).

**Roteiro (grave sem cortes; narre em inglês ou adicione legendas em inglês)**

| Tempo | Tela | O que mostrar / dizer |
|---|---|---|
| 0:00 | `https://debian.hedgehog-parrotfish.ts.net/central-cortes/` | "This is Central de Cortes, a private tool for the Ideias em Comum channel." Role até os links de Terms e Privacy. |
| 0:15 | Dashboard → **Canais → Contas conectadas** | "First, the owner connects their TikTok account with Login Kit." Clique em **Conectar conta de Ideias em Comum**. |
| 0:25 | Tela de autorização do TikTok | Mostre o app e o escopo pedido; faça login/autorize. Volte ao dashboard: o cartão mostra "conectado: Ideias em Comum". |
| 0:45 | **Pipeline** | "Clips are generated from the channel's own long videos." Mostre o Kanban e clique num corte em *Pendente de Aprovação*. |
| 1:00 | **Estúdio** → painel "Publicar no TikTok como" | Aponte nome e avatar: "user.info.basic shows which account will receive the post." Dê play no corte (prévia). |
| 1:15 | Legenda | Edite a legenda: "The caption is editable." |
| 1:25 | "Quem pode ver este vídeo" | Mostre que começa em *Select* (sem padrão) e abra a lista: "Privacy options come from creator info; there is no default." Escolha **Only me** (no sandbox só sai privado). |
| 1:40 | Permitir Comentários / Dueto / Stitch | "Interactions are off by default; disabled ones are greyed out." Marque Comentários. |
| 1:50 | Divulgar conteúdo comercial | Ligue: mostre o aviso "You need to indicate…". Marque *Your brand* (rótulo Promotional content), depois *Branded content* (Paid partnership) e mostre que **Only me** fica bloqueado. Desligue tudo e escolha a privacidade de novo. |
| 2:15 | Declaração | Aponte o texto "By posting, you agree to TikTok's Music Usage Confirmation" e o link. |
| 2:20 | Botão **Publicar agora** | "The video is uploaded only after the owner explicitly clicks Publish." Clique. Mostre o aviso de processamento. |
| 2:30 | Kanban/Estúdio | Aguarde o card ir para **Publicado** e mostre o status do TikTok: "We poll the publish status and show the result." |
| 2:45 | Aba do `tiktok.com` | Abra o perfil `ideiasemcomum` e mostre o vídeo recém-postado (privado, por ser sandbox). |

Se o arquivo passar de 50 MB, reduza com:

```bash
ffmpeg -i demo.mp4 -vf scale=1280:-2 -c:v libx264 -crf 28 -c:a aac -b:a 96k demo-envio.mp4
```

**Depois de gravar**: volte "TikTok: modo" para **Rascunho** (ou mantenha direto, sabendo que no sandbox tudo sai privado) até a aprovação sair.


## Depois da aprovação

1. Copie **Client key** e **Client secret de produção** para Canais → Contas conectadas → TikTok e salve.
2. Clique em **Reconectar** na conta do canal.
3. Mantenha "TikTok: modo" em **Publicação direta**. A partir daí, cada aprovação pede as opções do TikTok (no Estúdio ou no Telegram) e o post sai sozinho no horário.
