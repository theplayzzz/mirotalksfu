# Subir para a produção — roteiro

**Nada deste roteiro foi executado.** A produção (`livestream.grupogrowon.com.br`) continua exatamente como estava em
01/10: contêiner `mirotalksfu` com a imagem `mirotalksfu-prod:screenshare-20261001` e dois arquivos corrigidos a quente.
Tudo o que está aqui foi validado no dev (`mirotalk-dev`), e cada passo marcado com 🔒 só é feito com o seu "pode subir
para produção" explícito, com a sala vazia e com o rollback pronto.

## Os três portões

1. **Sessão com a galera no dev, com o medidor ligado** (parte do plano: "antes da produção"). O dev tem tudo ligado:
   replay, recepção seletiva, limite de pedidos de quadro completo e o medidor de saúde. Peça para a galera entrar em
   https://mirotalk-dev.40-160-143-32.sslip.io/join/link e jogar uma noite normal; depois eu leio o medidor
   (`ops/health-summary.py`) e comparo.
2. **O seu OK** a cada passo 🔒.
3. **Sala vazia** na hora de trocar a imagem ou reiniciar o contêiner. Conferir:
   `ssh ovh-mirotalk "ss -Htn state established '( dport = :3012 )' | wc -l"` deve dar `0`. O `deploy.sh prod` já se
   recusa a rodar com gente conectada.

## O que muda para quem usa a sala

- Com todos os interruptores desligados (`features.env` só com comentários) a sala se comporta como hoje, com estas
  exceções pequenas que vêm junto com o código novo: quem compartilha a tela **antes de entrar** passa a pedir só o áudio
  da janela (como já é dentro da sala; avise a galera); o áudio da tela fica identificado para o gravador; um codec
  forçado nas configurações da câmera/tela passa a valer de verdade (antes era ignorado por um erro de nome).
- Cada recurso novo liga por uma linha em `features.env` e desliga tirando a linha.

## Passo 0 — a branch `main` (sem efeito na produção)

Depois da sessão com a galera, levar o que está validado para a `main` (a imagem `:main` é a que a produção usa):

```bash
cd mirotalksfu
git checkout main && git merge --no-ff develop -m "Release: replay, recepção seletiva, limite de quadros completos, medidor de saúde"
git push origin main            # a CI constrói ghcr.io/theplayzzz/mirotalksfu:main
```

Isso não troca nada que está rodando: os servidores só puxam imagens por `deploy.sh`.

## Passo 1 🔒 — trocar a imagem, sem ligar nada novo

O que muda: a produção passa a rodar a imagem construída pela CI (a mesma lógica da de hoje, sem os arquivos corrigidos a
quente nem o `config.js` montado), mais o segundo contêiner `mirotalk-replay`, parado em termos de trabalho (nada é enviado
a ele com o replay desligado).

**Antes (não mexe em nada que roda):**

```bash
ssh ovh-mirotalk
cd /home/debian/mirotalksfu
# 1a. uma cópia exata do que roda hoje, arquivos corrigidos a quente incluídos. --pause=false: não congela a sala.
sudo docker commit --pause=false mirotalksfu mirotalksfu-prod:antes-da-troca-20261003
# 1b. o compose que traz de volta exatamente isso (o rollback manual; o do deploy.sh não serve na primeira troca)
cp -a compose.yaml compose.yaml.antes-da-troca
sed 's#^\([[:space:]]*image:[[:space:]]*\).*#\1mirotalksfu-prod:antes-da-troca-20261003#' compose.yaml > compose.rollback.yaml
docker compose -p mirotalksfu -f compose.rollback.yaml config --quiet && echo "rollback compose ok"
# 1c. os arquivos que o compose novo usa (cria features.env vazio, replay.env, pastas; não toca no .env nem em contêiner)
bash /home/debian/mirotalk-dev/ops/setup-prod.sh      # (ou copiar ops/setup-prod.sh do repositório)
```

**A troca:**

```bash
# do PC: o compose novo e o script de deploy
scp ops/compose.prod.yaml ops/deploy.sh ops/rollback.sh ovh-mirotalk:/tmp/
ssh ovh-mirotalk
cp /tmp/compose.prod.yaml /home/debian/mirotalksfu/compose.yaml
mkdir -p /home/debian/mirotalksfu/ops && cp /tmp/deploy.sh /tmp/rollback.sh /home/debian/mirotalksfu/ops/ && chmod +x /home/debian/mirotalksfu/ops/*.sh
cd /home/debian/mirotalksfu
./ops/deploy.sh prod main --check            # só relata: gente conectada? divergência? disco?
./ops/deploy.sh prod main --accept-drift     # a divergência é a conhecida (o contêiner roda screenshare, o compose dizia joinfix)
```

**Conferir** (eu faço): contêiner `healthy`; `curl -s https://livestream.grupogrowon.com.br/config` sem `replay` ligado; entrar
na sala, compartilhar uma tela com áudio e ver o outro lado; a doação do LivePix aparece na entrada; `docker logs --since 5m
mirotalksfu` sem erros novos.

**Se algo estiver errado — rollback em um comando** (volta ao contêiner de hoje, arquivos corrigidos a quente incluídos):

```bash
cd /home/debian/mirotalksfu && docker compose -p mirotalksfu -f compose.rollback.yaml up -d --force-recreate --remove-orphans
```

## Passo 2 🔒 — interruptores, um de cada vez, com o medidor medindo

Editar `/home/debian/.config/mirotalksfu-prod/features.env` (tirar o `#` da linha) e aplicar:

```bash
cd /home/debian/mirotalksfu && docker compose up -d --force-recreate mirotalksfu   # derruba a sala por alguns segundos: sala vazia
```

Nesta ordem, um por noite se quiser medir de verdade:

1. `HEALTH_METER_ENABLED=true` — só mede (quadros, congelamentos, perdas por navegador). Dá o "antes".
2. `KEYFRAME_REQUEST_DELAY_MS=1000` — no máximo um pedido de quadro completo por segundo por remetente.
3. `SELECTIVE_RECEPTION=true` — miniaturas a 15 fps, telas escondidas pausadas. Esperado (medido no dev com 10 espectadores ×
   4 telas): worker de 52,8% para ~32% com uma tela grande e três miniaturas; espectador de 48,9 para 26,4 Mbps.

Comparar o medidor antes e depois de cada um (`python3 ops/health-summary.py /home/debian/mirotalksfu/data/health --hours 12`)
e a CPU do worker (`ops/tools/sample-health.sh`). Para desligar: voltar o `#` e recriar o contêiner.

## Passo 3 🔒 — replay

Antes, **uma mudança na máquina toda (precisa do seu OK separado)**: o gravador pede um buffer de recepção UDP maior do que
o padrão do sistema (208 KB). Sem isso ele funciona (0 pacotes perdidos nos testes), mas uma travada de disco poderia
perder alguns pacotes. A mudança só aumenta o teto que um programa pode pedir; nada passa a usar mais memória sozinho:

```bash
echo 'net.core.rmem_max=4194304' | sudo tee /etc/sysctl.d/99-replay.conf && sudo sysctl --system | grep rmem_max
```

Depois, ligar o replay:

```bash
# em features.env: tirar o # de   REPLAY_ENABLED=true   e   REPLAY_UI_ENABLED=true
cd /home/debian/mirotalksfu && docker compose up -d --force-recreate mirotalksfu      # sala vazia
docker compose ps                                                                      # os dois contêineres healthy
curl -s https://livestream.grupogrowon.com.br/config | python3 -c "import sys,json; print(json.load(sys.stdin)['replay'])"
```

**Conferir com dois amigos (ou comigo + você):** um compartilha a tela com áudio, outro assiste; esperar 1 minuto; o botão
de replay (relógio ao lado do alfinete) deve mostrar "Disponível: últimos 1:0x"; salvar 1 min; abrir "Ver" e a galeria
(`/replay/`); baixar o original e o MP4. O que se espera, medido no dev: clipe pronto em ~1 s; MP4 de 30 s em ~55 s; CPU do
gravador ~13% de um núcleo; disco: ~75 MB por minuto de tela a 10 Mbps (5 min de buffer por tela ≈ 400 MB; a cota é 20 GB,
clipes somem em 7 dias).

**Rollback do replay:** pôr o `#` de volta em `REPLAY_ENABLED` e recriar o `mirotalksfu`; o contêiner `mirotalk-replay`
pode ficar parado (`docker compose stop mirotalk-replay`) e os clipes continuam no disco até expirar.

## O que olhar no primeiro dia

- `docker stats mirotalksfu mirotalk-replay` — o gravador não deve passar de ~20% do núcleo dele; o `mirotalksfu`, como antes.
- `docker logs mirotalk-replay --since 1h` — nada de "overflow" ou perdas.
- Disco: `du -sh /home/debian/mirotalksfu/data/replays`; deve estabilizar depois de ~7 minutos de tela ligada.
- Reclamação de "travou" na live ao ligar o replay: desligar o interruptor (rollback acima) e me avisar; nos testes o replay
  não mudou quadros por segundo, congelamentos nem perdas de quem assiste (`docs/MEASUREMENTS.md`).
