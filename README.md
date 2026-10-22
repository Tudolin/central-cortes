# Central de Cortes

Plataforma self-hosted que transforma vídeos longos (podcasts, debates, lives) em cortes verticais 9:16 prontos para TikTok, Shorts e Reels — com curadoria por IA, reframe com rastreio de rosto, legendas estilo Hormozi e um dashboard de aprovação.

```
URL/arquivo ─► yt-dlp ─► ffmpeg+whisper.cpp ─► Claude (curadoria) ─► YuNet+ffmpeg (reframe+legenda) ─► revisão ─► publicado
   Na Fila        │        Transcrevendo          Análise de IA          Renderizando FFmpeg        Pendente      Publicado
```

## Por que essa stack

| Peça | Escolha | Motivo |
|---|---|---|
| Runtime | Node 24 rodando TypeScript direto (sem build) | Um processo só para API, fila e workers; zero etapa de compilação no servidor |
| Banco/fila | `node:sqlite` (embutido no Node) | Sem Redis/Postgres para administrar; fila sobrevive a reinício |
| Transcrição | whisper.cpp | C++ puro, rápido em CPU, timestamps por palavra |
| Curadoria | Claude com *structured outputs* | JSON garantido pelo schema, sem parse frágil |
| Rostos | YuNet (ONNX) via onnxruntime-node | Mesmo modelo do OpenCV, sem Python |
| Render | Uma única passada de ffmpeg | Crop dinâmico + zoom + legenda ASS + loudnorm de uma vez |
| Dashboard | HTML/CSS/JS puro servido pelo próprio app | Nenhum CDN, funciona offline na rede local |

Dependências npm: só `@anthropic-ai/sdk` e `onnxruntime-node`.

### Economia de tokens

- A IA decide **apenas** o que exige julgamento: início/fim, score, gancho, título, layout, zoom e palavras de destaque. Tempos formatados, legenda social, link com timestamp, configs de render e custos são calculados em código — não se paga token de saída por texto repetitivo.
- Transcrição enviada em formato compacto (`SEGUNDO|texto`, uma linha a cada ~12 s). Um debate de 2 h ≈ 41 mil tokens de entrada.
- O system prompt de cada canal é estável e marcado para cache; vídeos seguidos do mesmo canal reaproveitam o prefixo.
- Reprocessar um job que já foi analisado **não** chama a IA de novo (transcrição e análise ficam em cache em disco/banco).
- Custo real (não estimado) é gravado por job a partir do `usage` da API e aparece na aba **Custos**.

Ordem de grandeza por vídeo de 2 h: ~US$ 0,20–0,30 com `claude-opus-5-5` (padrão) ou centavos com `claude-haiku-5-5`. O modelo é configurável por canal.

### Precisão dos cortes

O modelo sugere segundos aproximados; o código faz *snap* para o início/fim de frase mais próximos (pontuação + pausas do whisper), força a duração do canal (30–90 s por padrão) e descarta sobreposições. Assim nenhum corte começa no meio de uma palavra.

### Reframe

A sugestão de layout da IA é cruzada com o que de fato aparece na imagem (rostos amostrados a 3 fps):

- `single_speaker` — recorte 9:16 que segue o rosto, com zona morta (sem "câmera nervosa") e corte seco quando o plano muda.
- `split_screen` — dois falantes empilhados; exige dois rostos estáveis, senão cai para `single_speaker`.
- `screen_share_focus` — falante no topo e a tela inteira abaixo, sobre fundo desfocado.
- `fit` (automático) — sem rosto confiável: vídeo inteiro sobre fundo desfocado.

O layout efetivamente usado aparece no Estúdio e pode ser trocado manualmente.

## Instalação (Debian)

```bash
git clone https://github.com/Tudolin/editor_cortes.git /opt/editor-cortes
```

```bash
sudo bash /opt/editor-cortes/deploy/install-debian.sh
```

O script instala ffmpeg, fonte Montserrat, Node 24, yt-dlp, compila o whisper.cpp (use `CUDA=1` para GPU NVIDIA), baixa o modelo `large-v3-turbo-q5_0`, cria o usuário `cortes` e o serviço systemd. Depois edite `/opt/editor-cortes/.env` (pelo menos `ANTHROPIC_API_KEY` e `DASHBOARD_PASSWORD`) e reinicie:

```bash
sudo systemctl restart editor-cortes
```

Dashboard em `http://SERVIDOR:8080`. Todas as variáveis estão documentadas em [.env.example](.env.example).

## Desenvolvimento local

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run check
```

Requer `ffmpeg`, `yt-dlp` e `whisper-cli` no PATH (ou caminhos no `.env`).

## Usando

1. **Pipeline** — cole uma ou mais URLs (uma por linha) ou caminhos de arquivo no servidor, escolha o canal e clique em *Processar*. O Kanban acompanha cada etapa em tempo real (SSE).
2. **Estúdio** — revise cada corte: player 9:16 do render, player do vídeo original com ajuste fino de início/fim (sliders, ±0,5 s, ou clique numa palavra da transcrição; Shift+clique define o fim), título, layout, zoom, palavras de destaque e legenda social. *Salvar e re-renderizar* coloca o corte de volta na fila de render.
3. **Aprovar e publicar** — marca como `Publicado` e, se o canal tiver webhook, envia um POST com o corte completo no schema do contrato (use n8n/Make/script próprio para subir no TikTok/YouTube/Instagram).
4. **Canais** — cada canal tem nicho, tom, instruções extras, modelo/esforço da IA, limites de duração, cor de destaque, palavras por quadro, template de legenda, webhook e credenciais isoladas (somente escrita; a API nunca devolve os valores).
5. **Custos** — custo e tokens por canal, por vídeo, por corte e por dia.

`GET /api/jobs/:id/result` devolve o resultado de um job no formato `pipeline_metadata` + `cortes` definido no contrato.

### Template de legenda

Placeholders: `{titulo_corte}`, `{url_com_timestamp}`, `{url_video_original}`, `{timestamp_segundos}`. O padrão `{url_video_original}?t={timestamp_segundos}s` é reescrito automaticamente para um link válido (`https://youtu.be/ID?t=135s`) — concatenar `?t=` numa URL `watch?v=` gera um link quebrado.

## Estrutura

```
app/
  main.ts            boot (servidor + workers)
  config.ts          .env, binários, tabela de preços
  db.ts              schema SQLite + canal padrão
  server.ts          API REST, SSE, mídia com Range, Basic Auth
  worker.ts          fila de jobs e de render, recuperação após reinício
  pipeline/
    source.ts        yt-dlp / arquivo local, ffprobe
    transcribe.ts    whisper.cpp → palavras + frases, transcrição compacta
    analyze.ts       Claude, schema de saída, snap de cortes, custo
    faces.ts         YuNet via onnxruntime
    reframe.ts       escolha de layout + filtergraph
    subtitles.ts     legenda ASS estilo Hormozi
    render.ts        ffmpeg final + thumbnail
    caption.ts       legenda social + JSON do contrato
web/                 dashboard
deploy/              instalador Debian + unit systemd
```

O pipeline Python anterior (`main.py`, `src/`) continua no repositório, intocado.
