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
   - Scopes: `user.info.basic`, `video.upload`, `video.publish`.
3. **Gravar o demo no sandbox.** No dashboard (Canais → TikTok: modo) escolha **Publicação direta**, salve e clique em **Reconectar** a conta (o escopo muda para `video.publish`). No sandbox os posts saem privados — é esperado e serve para o vídeo.

## Roteiro do vídeo de demonstração (2–3 min)

Grave a tela do navegador, sem cortes, em inglês ou com legendas em inglês se possível:

1. **Login no TikTok** — Canais → Contas conectadas → TikTok → *Conectar*. Mostre a tela de autorização do TikTok com os escopos e volte ao dashboard já conectado.
2. **Origem do conteúdo** — Pipeline: um vídeo longo do próprio canal sendo processado e os cortes aparecendo em "Pendente de Aprovação".
3. **Tela de publicação** — Estúdio → abra um corte:
   - aponte o nome e o avatar da conta no painel "Publicar no TikTok como …";
   - mostre o player (prévia) e edite a legenda;
   - abra "Quem pode ver este vídeo" mostrando que começa vazio e escolha uma opção;
   - mostre as caixas de Comentários / Dueto / Stitch desmarcadas e marque uma;
   - ligue "Divulgar conteúdo comercial", mostre o aviso e os rótulos ao marcar "Sua marca" e "Conteúdo de marca" (e que "Somente eu" fica bloqueado), depois desligue;
   - destaque a declaração com o link da Music Usage Confirmation.
4. **Consentimento e envio** — clique em **Publicar agora**. Mostre o aviso de processamento.
5. **Resultado** — quando o card for para "Publicado", mostre o link do post e abra o vídeo no TikTok (no sandbox, visível só para você).
6. *(Opcional)* Mostre a aprovação pelo Telegram: Aprovar → escolher visibilidade → interações → "concordo com a Music Usage Confirmation".

## Formulário "Basic information"

| Campo | Valor |
|---|---|
| App icon | `assets/logo-1024.png` |
| App name | `Central de Cortes` |
| Category | Photo & Video (ou Entertainment, se não houver) |
| Description (máx. 120) | `Private tool that turns a creator's own long videos into vertical clips and posts approved ones to their TikTok.` |
| Terms of Service URL | `https://debian.hedgehog-parrotfish.ts.net/central-cortes/terms` |
| Privacy Policy URL | `https://debian.hedgehog-parrotfish.ts.net/central-cortes/privacy` |
| Platforms | **Web** — Website URL: `https://debian.hedgehog-parrotfish.ts.net/central-cortes/` |

## Textos para o formulário de revisão

**Explain how each product and scope works** (cole no campo "App review")

> Central de Cortes is a private web dashboard used only by the owner of the Ideias em Comum channel. Login Kit (user.info.basic): the owner connects their own TikTok account; we show the connected nickname and avatar on the posting screen. Content Posting API (video.publish): for each clip, the owner previews the video, edits the caption, chooses the privacy level (no default), comments/Duet/Stitch (off by default, greyed out when disabled in the account), and the commercial content disclosure, then explicitly agrees to the Music Usage Confirmation and clicks Publish. Only then the video is uploaded to the owner's own account; we poll the publish status and show the result. video.upload sends a clip to the owner's TikTok inbox as a draft when direct posting is turned off. The app never posts to accounts other than the one that authorized it.

**App description**

> Central de Cortes is a private, self-hosted tool used by a single creator to turn their own long-form videos (podcasts and debates published on their YouTube channel) into short vertical clips. The creator reviews each clip in a web dashboard, chooses the TikTok privacy level, interaction settings and commercial content disclosure for that post, and explicitly confirms the upload. Approved clips are then posted to the creator's own TikTok account at the time they selected.

**How will you use the scopes**

> `user.info.basic`: show which TikTok account is connected. `video.upload`: send clips to the creator's inbox as drafts. `video.publish`: post the clips the creator approved, with the privacy and interaction settings they chose for each post, to their own account. The app only ever posts to the account of the user who authorized it.

**Usuários-alvo**: apenas o dono do canal (uma conta). Se o formulário perguntar, deixe claro que não é um serviço aberto a terceiros.

## Depois da aprovação

1. Copie **Client key** e **Client secret de produção** para Canais → Contas conectadas → TikTok e salve.
2. Clique em **Reconectar** na conta do canal.
3. Mantenha "TikTok: modo" em **Publicação direta**. A partir daí, cada aprovação pede as opções do TikTok (no Estúdio ou no Telegram) e o post sai sozinho no horário.
