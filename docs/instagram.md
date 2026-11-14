# Posts de foto no Instagram

A aba **Instagram** do painel cria, aprova e agenda posts de foto (Feed e Story) de uma conta do Instagram. É o antigo `ig-agent`, agora dentro do hub: mesmo banco, mesmo painel, mesmo bot do Telegram. Não tem relação com os cortes nem com os canais; a conta é uma só para o hub.

```
foto + briefing ─► legenda (DeepSeek) ─► moldura (Templated.io) ─► aprovação ─► agenda ─► Instagram
   Preparando                                                     Para aprovar   Agendado   Publicado
```

## Como usar

**Pelo painel:** aba Instagram → *Novo post* → escolha a foto (JPEG, até 8 MB), o formato e escreva o briefing. O post aparece em *Para aprovar* com a legenda editável; dali você publica na hora, agenda, troca de formato, pede outra legenda à IA ou rejeita.

**Pelo Telegram:** mande a foto ao bot da Central com o briefing na legenda da foto. O bot pergunta o formato e devolve o post pronto com os botões *Publicar agora*, *Agendar*, *Ajustar legenda* e *Rejeitar*. Para agendar, responda com a data: `agora`, `18:30`, `amanhã 9h`, `25/08 18:30`. O comando `/novopost` mostra essas instruções.

O que é decidido num lugar vale no outro: aprovar no painel tira os botões do chat.

Se a publicação falhar, o hub tenta de novo em 5, 20 e 60 minutos e depois avisa no Telegram.

## Configuração

Tudo fica em **Instagram → Configuração**. Só a conta é obrigatória.

| Bloco | Campos | Sem ele |
|---|---|---|
| Conta do Instagram | ID do usuário (IG User ID) e token de longa duração | não publica |
| App da Meta | ID e segredo do app | o token não é renovado sozinho (ele vence em ~60 dias) |
| Legenda por IA | chave do DeepSeek e o texto de marca e voz | o briefing vira a legenda e você edita à mão |
| Moldura | chave do Templated.io e o ID do modelo de Feed e/ou Story | a foto é publicada como está |
| Endereço público | URL pela qual a internet alcança as fotos | a Meta não consegue baixar a imagem |

Com ID e segredo do app salvos, o hub confere o token uma vez por dia e o renova quando faltam 10 dias ou menos.

No modelo do Templated, a foto entra na camada chamada `photo`.

Os mesmos valores podem vir do `.env` do hub, com os nomes que o `ig-agent` usava: `IG_USER_ID`, `IG_ACCESS_TOKEN`, `FB_APP_ID`, `FB_APP_SECRET`, `DEEPSEEK_API_KEY`, `TEMPLATED_API_KEY`, `TEMPLATE_ID_FEED`, `TEMPLATE_ID_STORY`. O que for salvo no painel tem prioridade.

## Endereço público das fotos

O Instagram não recebe upload de imagem: a Meta baixa a foto de uma URL, e o Templated também. Essa URL precisa abrir de fora da sua rede, com https. Um endereço só do Tailscale (`tailscale serve`) não serve.

O hub usa, nesta ordem:

1. o arquivo `data/ig-media-url.txt`, gravado pelo túnel abaixo;
2. o campo *URL pela qual a internet alcança este painel* da configuração;
3. a URL pública do hub.

**Túnel recomendado.** O hub abre uma porta separada (`IG_MEDIA_PORT`, 8096 no `compose.yaml`) que responde só `/public/ig/<nome>.jpg`. O script `deploy/ig-media-tunnel.sh` aponta um quick tunnel do Cloudflare para essa porta e grava o endereço no arquivo. Assim o painel e a API nunca ficam expostos à internet, e o hub acompanha a troca de endereço sem reiniciar.

```bash
sudo sed "s#__APP_DIR__#$HOME/editor-cortes#g; s#__USER__#$USER#" deploy/ig-media-tunnel.service | sudo tee /etc/systemd/system/ig-media-tunnel.service
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ig-media-tunnel
```

Requer o `cloudflared` instalado. As fotos ficam em nomes de 32 caracteres aleatórios e saem do disco 7 dias depois de o post ser publicado ou rejeitado.

## Migrar do ig-agent

1. Atualize o hub para esta versão e suba de novo (`deploy/update-hub.sh`).
2. Copie as credenciais do `ig-agent` para o `.env` do hub (os nomes são os mesmos):

   ```bash
   sudo grep -E '^(IG_USER_ID|IG_ACCESS_TOKEN|FB_APP_ID|FB_APP_SECRET|DEEPSEEK_API_KEY|TEMPLATED_API_KEY|TEMPLATE_ID_FEED|TEMPLATE_ID_STORY)=' /opt/ig-agent/.env >> ~/editor-cortes/.env
   ```

3. Instale o túnel das fotos (seção acima) e reinicie o hub.
4. Na aba Instagram, preencha *Marca e voz* (o prompt do `ig-agent` ainda tinha os campos em branco) e clique em *Conferir token agora*.
5. Faça um post de teste. Funcionando, desligue o serviço antigo:

   ```bash
   sudo systemctl disable --now ig-agent ig-scheduler ig-cloudflared ig-media
   ```

O que muda em relação ao `ig-agent`:

- O bot é o da Central (long polling), não o bot antigo com webhook. Mande as fotos para o bot da Central.
- Cada foto gera um post, no modelo do formato escolhido; não há mais álbum de variações nem o comando `/aviso`, que dependiam de modelos que nunca foram cadastrados.
- Reels por aqui não existe: vídeo é assunto dos cortes.
- Os posts antigos do `queue.db` não são importados.
