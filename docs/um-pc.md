# Tudo em um PC só

A Central de Cortes roda inteira em uma máquina: painel, banco, agenda, publicação e o processamento pesado (download, transcrição, IA e render) no mesmo processo. É o modo `ROLE=all`, o padrão quando o `.env` não diz outra coisa. Não precisa de Docker, Tailscale, segundo computador nem `WORKER_TOKEN`.

O modo com duas máquinas (hub 24h + worker com GPU, descrito no [README](../README.md#hub--worker-pc-pesado-notebook-24h)) continua igual. A diferença prática:

| | Um PC só (`ROLE=all`) | Hub + worker |
|---|---|---|
| Instalação | um script | Docker no hub + worker no PC |
| Publicação agendada | só com o PC ligado | o hub publica com o PC desligado |
| Acesso de fora de casa | não (só `localhost`, a menos que você exponha) | pelo Tailscale |

Com o PC desligado na hora de um post, nada se perde: ao ligar, o que atrasou até 2 h sai na hora e o resto é remarcado para os próximos horários livres do canal.

## Requisitos

- Windows 10/11 de 64 bits (para Linux, veja [abaixo](#linux)).
- ~10 GB livres para os programas e modelos, mais o espaço dos vídeos (um podcast de 2 h ocupa 1–2 GB enquanto é processado).
- Placa NVIDIA é opcional. Com ela, transcrição e render ficam várias vezes mais rápidos; sem ela tudo funciona pela CPU.
- Uma chave da API da Anthropic (centavos por vídeo) **ou** uma placa de vídeo com 8 GB para a IA local gratuita (Ollama).

## Instalação no Windows

1. Baixe o projeto. Com o [Git](https://git-scm.com/download/win) instalado:

   ```bash
   git clone https://github.com/Tudolin/central-cortes.git
   ```

   Sem Git: no GitHub, **Code → Download ZIP** e extraia.

2. Abra o PowerShell na pasta do projeto e rode:

   ```bash
   powershell -ExecutionPolicy Bypass -File deploy\setup-windows.ps1
   ```

O script pergunta a chave da Anthropic (Enter vazio = IA local com Ollama) e faz o resto:

- instala o Node.js 24 se faltar (pelo `winget` ou, sem ele, pelo instalador oficial) e baixa ffmpeg e yt-dlp para `tools\` quando não estão no PATH;
- baixa o whisper.cpp (versão CUDA se houver placa NVIDIA) para `tools\whisper` e o modelo de transcrição para `models\`;
- cria o `.env` com `ROLE=all`, painel em `http://localhost:8080` atendendo só o próprio PC, e render por NVENC quando há GPU;
- roda o diagnóstico (`npm run doctor`);
- coloca o programa para iniciar escondido junto com o Windows, reiniciando sozinho se cair, e abre o painel no navegador.

Rodar o script de novo é seguro: ele respeita o `.env` existente, não baixa nada duas vezes e reinicia o programa com a configuração atual.

Opções:

| Parâmetro | Efeito |
|---|---|
| `-AnthropicKey sk-ant-...` | passa a chave sem perguntar |
| `-LocalAi` | usa IA local (instala o Ollama e baixa o modelo `qwen3:8b`) |
| `-NoStartup` | só instala e configura; não inicia nem põe na inicialização do Windows |
| `-WhisperModel large-v3-turbo` | outro modelo do whisper.cpp |
| `-Role worker -HubUrl ... -WorkerToken ...` | configura este PC como worker de um hub em outra máquina |

## Dia a dia

- **Painel:** `http://localhost:8080`. No rodapé da barra lateral, o nome do PC aparece como `ocioso` ou `trabalhando`; `worker offline` significa que o programa não está rodando.
- **Log:** `data\worker.log`.
- **Conferir a instalação:** `npm run doctor` mostra o que falta e como resolver.
- **Parar e tirar da inicialização:**

  ```bash
  powershell -ExecutionPolicy Bypass -File deploy\uninstall-worker-startup.ps1
  ```

- **Atualizar:** `git pull` e rode o `setup-windows.ps1` de novo.
- **Backup:** a pasta `data\` (banco `cortes.db`, cortes e logins) e o arquivo `.env`.

Na primeira execução o banco já vem com um canal de exemplo; troque nome, nicho e tom em **Configurações**.

## Publicação

- **YouTube (API):** em **Configurações → Contas conectadas**, use `http://localhost:8080` como URL pública e cadastre `http://localhost:8080/oauth/youtube/callback` como URI de redirecionamento no Google Cloud. O Google aceita `localhost` sem https.
- **TikTok (API):** o TikTok exige uma URL pública com https para o login, o que um PC sozinho não tem. Alternativas: baixar o corte pelo painel e postar pelo celular, ou expor o painel com um túnel https (Tailscale Funnel, Cloudflare Tunnel) e usar essa URL como URL pública.
- **Telegram:** funciona normalmente (o bot só faz conexões de saída).
- **Robô de navegador (TikTok Studio / YouTube Studio):** no modo de duas máquinas ele usa o container `cortes-browser`. Em um PC só, o hub procura um Chrome com depuração remota em `http://127.0.0.1:9222` (`ROBOT_CDP_URL`); dá para abrir um com perfil próprio assim, e os logins dos canais passam a ser feitos nessa janela:

  ```bash
  "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\CentralCortesRobo"
  ```

  Esse arranjo sem Docker não é o caminho testado do projeto; trate como experimental.

## Abrir o painel para outros aparelhos da casa

No `.env`, troque `HOST=127.0.0.1` por `HOST=0.0.0.0`, defina `DASHBOARD_PASSWORD` e libere a porta 8080 no Firewall do Windows. Depois rode o `setup-windows.ps1` de novo para reiniciar.

## Linux

Em Debian/Ubuntu o instalador já sobe tudo em uma máquina, como serviço systemd:

```bash
sudo bash deploy/install-debian.sh
```

Use `sudo CUDA=1 bash deploy/install-debian.sh` com placa NVIDIA e o CUDA toolkit instalados. Depois edite o `.env` (`ANTHROPIC_API_KEY`, `DASHBOARD_PASSWORD`) e rode `sudo systemctl restart editor-cortes`.

## Passar de um PC para hub + worker depois

Copie a pasta `data\` e o `.env` para a máquina que será o hub, suba o hub pelo Docker (`docker compose up -d --build`) com um `WORKER_TOKEN` no `.env` dele, e no PC rode:

```bash
powershell -ExecutionPolicy Bypass -File deploy\setup-windows.ps1 -Role worker -HubUrl http://IP_DO_HUB:8095 -WorkerToken SEGREDO
```

O caminho inverso (juntar tudo em um PC) é o mesmo: traga `data\` do hub para a pasta do projeto no PC, pare o hub e rode o script com `-Role all`.
