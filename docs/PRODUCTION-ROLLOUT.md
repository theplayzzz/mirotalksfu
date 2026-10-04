# Produção — o que foi feito em 03/10/2026, como desfazer e como seguir

**Executado em 03/10/2026, 21:14 UTC (18:14 em Brasília), numa única reinicialização.** A produção
(`livestream.grupogrowon.com.br`) passou da imagem `mirotalksfu-prod:screenshare-20261001` (com dois arquivos corrigidos a
quente) para a imagem construída pela CI, `ghcr.io/theplayzzz/mirotalksfu:main` (digest
`sha256:0947a362261fa9e9205327c15e3947d5e79e9760c79dba49059f42255521e669`, commit `455141ee`), **com todos os interruptores
ligados de uma vez**, a pedido do dono ("pode executar tudo agora jogando para produção"), que avisou a galera da queda.

## O que aconteceu

| | |
|---|---|
| Tempo sem a sala | **11,3 s**: o contêiner antigo parou às 21:14:47,4 e o novo ficou saudável às 21:14:58,7. Havia 8 pessoas conectadas; elas voltaram sozinhas em um minuto |
| Contêineres | `mirotalksfu` (imagem nova) e `mirotalk-replay` (o gravador, mesma imagem, núcleo 5, 2 GB), os dois `healthy` |
| Ligado | `HEALTH_METER_ENABLED`, `KEYFRAME_REQUEST_DELAY_MS=1000`, `SELECTIVE_RECEPTION`, `REPLAY_ENABLED`, `REPLAY_UI_ENABLED` (em `/home/debian/.config/mirotalksfu-prod/features.env`) |
| Fica desligado | `SCREEN_CODEC` (continua `vp8`; o medidor antigo só olhava o perfil Constrained Baseline, que o Chrome codifica em software, e por isso mostrava "só software": o H.264 Main/High usa a placa de vídeo, mas gasta ~12 Mbps até com a imagem parada; ver `docs/SCREEN-QUALITY-STRATEGY.md` 3.3) e `ROOM_DELIVERY_WORKERS` (a medição mostrou que não precisa) |
| Máquina | `net.core.rmem_max` = 4 MB, gravado em `/etc/sysctl.d/99-replay.conf` (o gravador pede 8 MB de buffer UDP e o kernel concede o dobro do teto) |
| Caddy | não foi tocado; `reverse_proxy 127.0.0.1:3012` continua servindo `/replay/` sem regra nova |
| Primeiros minutos | ver "Produção, os primeiros minutos" em `docs/MEASUREMENTS.md`: primeiro replay salvo por um amigo (clipe pronto em 0,87 s, MP4 em 90 s), 0 pacotes perdidos no gravador, espectadores com 29-44 fps e perda ≤ 0,3% |

## Segunda subida, 21:54 UTC: o que a galera achou na primeira hora

Na primeira hora o dono reportou duas coisas. **(1)** "quando a gente para de olhar a janela, as transmissões pausam e só
voltam depois de um tempo": era a recepção seletiva pausando de propósito o vídeo de aba escondida; foi tirado (o cliente
nunca pausa, o servidor ignora o pedido de pausa mesmo de uma aba que ainda tenha o JavaScript antigo, só
`SELECTIVE_PAUSE_HIDDEN=true` o aceitaria). **(2)** "o replay fica muito tempo tentando carregar" (e parecia converter
para MP4 sozinho): o player pulava o começo do arquivo (o trecho antes do que foi pedido, até um GOP de ~30 s) e o
navegador tinha que decodificar tudo isso antes da primeira imagem: 7,3 s num PC livre, 34,5 s num PC ocupado. Agora toca
do primeiro quadro (0,8 s e 0,7 s). O MP4 só converte no clique em "Baixar MP4"; o botão agora diz isso e a estimativa
passou de 35 s para os 1,5 s por segundo medidos. Números e método em `docs/MEASUREMENTS.md`.

Subida: imagem `ghcr.io/theplayzzz/mirotalksfu@sha256:2441bb2aa645…` (a `main` no commit `b707d0a9`), por
`./ops/deploy.sh prod main --force`; **queda de 11,4 s** (o contêiner antigo parou às 21:54:36,5 e o novo ficou saudável às
21:54:47,9). Quem estava compartilhando precisou recomeçar a tela e os buffers de replay do momento (até 5 min por tela) foram
descartados, como em qualquer reinício. O desfazer desta subida é o `./ops/rollback.sh prod` (volta ao compose guardado,
`compose.yaml.pre-deploy-20261003T215412Z`, que aponta para a imagem `sha256:0947a362…` da primeira noite).

## Para desfazer a primeira troca — IMPORTANTE: não é o `ops/rollback.sh`

Esta primeira troca mudou o próprio `compose.yaml`. O `ops/rollback.sh prod` volta ao compose de *antes do último deploy*,
que nesta primeira vez já era o compose novo. O caminho de volta ao sistema de 01/10 (contêiner antigo, `config.js`
montado, arquivos corrigidos a quente incluídos) está pronto à parte:

```bash
ssh ovh-mirotalk
cd /home/debian/mirotalksfu
sudo docker compose -p mirotalksfu -f compose.rollback.yaml up -d --force-recreate --remove-orphans
```

- `compose.rollback.yaml` usa a imagem `mirotalksfu-prod:antes-da-troca-20261003` (uma cópia exata do contêiner de 01/10,
  tirada antes da troca com `docker commit --no-pause`, sem congelar a sala). `--remove-orphans` tira o `mirotalk-replay`.
- Conferir que continua válido: `sudo docker compose -p mirotalksfu -f compose.rollback.yaml config --quiet`.
- `compose.yaml.antes-da-troca` é o compose de 01/10 como estava (a imagem dele era `joinfix-20261001`, que nunca subiu: não
  use esse arquivo, use o `compose.rollback.yaml`).
- Desligar só uma coisa não exige voltar: pôr `#` na linha em `features.env` e recriar
  (`cd /home/debian/mirotalksfu && sudo docker compose up -d --force-recreate mirotalksfu`, derruba a sala por ~10 s).
  Para desligar só o replay: `#` em `REPLAY_ENABLED` e `REPLAY_UI_ENABLED`; os clipes salvos continuam no disco até expirar.

## Daqui para a frente

A partir desta troca, `ops/deploy.sh` e `ops/rollback.sh` funcionam como foram desenhados: cada deploy guarda o compose
anterior (`compose.yaml.pre-deploy-<data>`) e `ops/rollback.sh prod` volta a ele.

```bash
cd /home/debian/mirotalksfu
./ops/deploy.sh prod main --check        # só relata: gente conectada? divergência entre o contêiner e o compose? disco?
./ops/deploy.sh prod main                # recusa se houver gente conectada; --force deploya mesmo assim
./ops/deploy.sh prod sha-abc1234         # uma imagem específica da CI
./ops/rollback.sh prod                   # volta ao compose anterior ao último deploy
```

O deploy troca a imagem por digest, espera o `healthy` de todos os contêineres do projeto e, se algo não subir, volta sozinho
ao compose anterior.

## O que olhar nos primeiros dias

- `sudo docker stats --no-stream mirotalksfu mirotalk-replay`: o gravador fica em ~1-10% do núcleo dele e sobe a ~100% **só
  enquanto converte um MP4** (é para isso que o núcleo 5 é dele); o pico de memória medido foi 829 MiB, limite de 2 GiB.
- `sudo docker logs --since 1h mirotalk-replay`: nada de "overflow", perdas, nem reinícios.
- Disco: `du -sh /home/debian/mirotalksfu/data/replays`. O buffer de cada tela estabiliza em ~500-575 MB depois de ~7 minutos
  de tela ligada (≈ 1,2-1,45 MB/s) e some 2 minutos depois que a tela para; clipes ficam 7 dias, cota de 20 GB.
- Os números reais dos espectadores: `python3 ops/health-summary.py /home/debian/mirotalksfu/data/health --hours 12` (o script
  vai por `ssh ovh-mirotalk 'python3 - <dir> --hours 12' < ops/health-summary.py`). Quadros por segundo, congelamentos e
  perdas de quem assiste devem ficar como antes de ligar o replay; é a comparação que o teste de longa duração do dev
  (`docs/MEASUREMENTS.md`) não conseguiu fechar sozinho.
- Quando a galera converter MP4: comparar os congelamentos dos espectadores nos minutos com e sem conversão rodando.
- Aviso do Caddy "aborting with incomplete response" em `/replay/media/.../clip.webm` e `ECONNRESET` no log do SFU: é o player
  de vídeo do navegador cancelando as próprias requisições de trecho. Não é erro.
- Reclamação de "travou" na live: desligar o replay (acima) e me avisar; os testes não mostraram mudança em quadros por
  segundo, congelamentos nem perdas de quem assiste.

## O que mudou para quem usa a sala (já em vigor)

- Quem compartilha a tela **antes de entrar** passa a pedir só o áudio da janela (como já era dentro da sala).
- O áudio da tela fica identificado para o gravador; um codec forçado nas configurações da câmera/tela passa a valer de
  verdade (antes era ignorado por um erro de nome).
- Cada tela mostra um botão de replay (relógio, ao lado do alfinete); a galeria está em `/replay/` (`/replays` redireciona).
  Nada do replay faz som.
- Miniaturas recebem a tela a 15 fps (tiles médios a 30 fps); a tela fixada e as grandes continuam com todos os quadros.
  **Nada é pausado** por janela escondida, aba em segundo plano ou tile fora de vista (era assim na primeira noite e foi tirado).
- O player da galeria toca do primeiro quadro do arquivo (que pode começar até ~30 s antes do que foi pedido) e marca na
  linha do tempo onde o pedido começa; o MP4 só converte quando alguém clica em "Baixar MP4".
