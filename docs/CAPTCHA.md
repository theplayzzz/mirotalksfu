# CAPTCHA de desenvolvimento

O laboratório foi integrado como experimento da instância de desenvolvimento. O servidor só habilita o recurso com **`APP_ENV=dev` e `CAPTCHA_ENABLED=true`**. Não há vínculo com autenticação, moderação, desconexão, transports ou permissões de mídia. O laboratório local continua separado.

## Acesso e operação

- Painel: `https://mirotalk-dev.40-160-143-32.sslip.io/dev/captcha/`.
- A chave é gerada na primeira inicialização em `/data/captcha/admin-key`, permissão 0600. Alternativamente, configure `CAPTCHA_ADMIN_KEY` com pelo menos 24 caracteres. Não use a senha da sala.
- Para obter a chave pelo canal administrativo existente: `ssh ovh-mirotalk "sudo cat /home/debian/mirotalk-dev/data/captcha/admin-key"`. Não coloque a chave no Git, em URLs ou em mensagens da sala.
- Login cria um token de duas horas, armazenado somente no `sessionStorage` daquela aba. Sair invalida o token. O painel não participa da sala nem conta como voto.
- Selecione a sala para ver seus participantes. “Jogar” envia imediatamente. “Votar” usa a regra configurada. “Sortear participante” escolhe alguém disponível. O jogo pode ser escolhido ou sorteado entre os ativos.
- Automação começa **desligada**. Por sala: ligar/desligar, intervalo, variação, um sorteado ou todos disponíveis, pausa mínima por pessoa. As alterações precisam ser salvas.
- Em “Jogos e resultados”, ajuste a duração (8–40s), intensidade (0,70–1,50) e disponibilidade de cada jogo. Os ajustes entram na próxima tentativa, incluindo uma repetição. Os 14 jogos conservam os controles por mouse e as mecânicas aprovadas no laboratório. Em Estica e dispara, intensidade altera a largura dos telhados; no Spiderman, altera as aberturas.
- “Pausar automação e liberar a sala” desliga o aleatório, encerra votações e libera todos os jogos daquela sala. Não encerra a chamada.

## Dinâmica para os participantes

O cliente identifica vídeos de compartilhamento na montagem da mídia; a classe de blur só afeta esses vídeos. Câmeras, avatares, áudio, barras de controle e chat não são alterados. Novas streams recebem a mesma marcação.

Ao receber o disparo, o participante vê somente o blur e um botão **CAPTCHA do Boiolômetro** no centro de cada stream. O jogo e seus assets não são carregados antes de clicar. Câmeras e avatares não recebem botão. Novas streams herdam o blur e o botão enquanto a verificação está pendente.

O clique abre a janela e inicia a verificação, sem um segundo botão de início. Quando há uma tela ampliada, a janela acompanha aquela tela; na grade, usa a stream escolhida quando houver espaço suficiente ou uma janela central. A mesma instância do iframe continua aberta ao mudar o layout. Minimizar pausa a verificação e mostra novamente os botões nas streams; clicar retoma aquela instância. Ela não cria backdrop nem prende o foco. Os vídeos da chamada não são movidos pelo CAPTCHA. A apresentação ao participante usa linguagem de verificação, sem referências a “resenha”.

Ganhar **ou perder** retira o blur imediatamente. A tela de resultado oferece repetir, liberar e avaliar com cinco estrelas; a nota é opcional. “Encerrar” também está sempre disponível na barra da janela. A atribuição expira após cinco minutos, inclusive se ficar pausada. Saída, perda de conexão ou erro de carregamento remove a janela e o blur. Ninguém é desconectado pelo CAPTCHA.

O jogador isolado não recebe acesso a câmera, microfone ou captura de tela. A comunicação com a sala verifica origem, janela de origem, identificador da atribuição e nonce. O servidor usa o socket autenticado na sala para autorizar tentativas, avaliações e votos, sem confiar em um nome/peer enviado pelo cliente.

## Votação

Uma votação aberta por sala. A pergunta é **“[nome] deve passar pelo Boiolômetro?”**, com respostas Sim e Não. O painel começa em **35%**, ajustável para 30% ou outro valor. O eleitorado é a lista dos presentes no início, incluindo o alvo. O percentual é arredondado para cima: com dez pessoas, 35% exige quatro votos e 30% exige três. Cada pessoa registra um voto final. Quem entrar depois não aumenta o eleitorado. Saídas não diminuem o total necessário; se o quórum ficar inalcançável, a votação encerra. Saída do alvo cancela. Atingir o total a favor envia o blur e o botão; não abre o jogo automaticamente. Alvo ocupado não recebe outra atribuição por cima.

## Registros e médias

`CAPTCHA_DATA_DIR` (padrão `/data/captcha`) fica no volume de dados **do desenvolvimento**. Configurações usam gravação atômica; tentativas, notas e eventos vão para `events.jsonl` com fila de escrita. No reinício, partidas inacabadas ficam interrompidas, sem restaurar blur nos participantes. Uma falha de histórico aparece no painel e não interrompe chamadas.

Por jogo: jogadas iniciadas, pessoas distintas, concluídas, vitórias, derrotas, taxa de vitória, interrompidas, repetições, duração média das concluídas, nota média e total de avaliações. Repetir cria outra tentativa ligada ao mesmo desafio; o resultado de cada uma é preservado. A nota usa **a última nota de cada pessoa por jogo**, identificada pelo hash de sala + `peer_uuid`, de modo que repetir não multiplica avaliações. Identidade é de navegador, não uma conta universal. Resultados de Canvas são reportados pelo cliente; estes números medem o teste entre amigos, não uma competição com proteção antitrapaça.

O registro mostra as últimas 150 tentativas e 100 eventos. A persistência guarda os anteriores. Dados sintéticos dos testes locais usam uma pasta temporária, sem contaminar desenvolvimento.

## Build, testes e implantação

```sh
npm ci --prefix captcha --ignore-scripts
npm run build --prefix captcha
npm test
npm test --prefix captcha
node tests/e2e/captcha.mjs
```

Vite é dependência só de build. O bundle de produção fica em `app/captcha-player` (ignorado pelo Git), com o catálogo gerado em `app/src/captcha-games.json`. CI testa e compila antes de montar a imagem. Docker já copia `app`, incluindo jogador e painel. Os assets com hash usam cache; o painel e suas APIs não.

`ops/compose.dev.yaml` habilita a funcionalidade e monta dados separados. Nenhuma configuração de produção foi alterada. `ops/deploy.sh` recusa implantação com conexões ativas também em desenvolvimento e verifica novamente após baixar a imagem. Não use `--force` para instalar este experimento com participantes conectados.

Para mudanças somente na interface do CAPTCHA, `ops/deploy-captcha-ui.sh sha-<commit>` publica uma lista fixa de arquivos de navegador a partir da imagem construída pela CI, sem recriar o container. Recusa diferenças nos módulos de protocolo do servidor, guarda backups, mantém assets antigos com hash para partidas em andamento, troca HTML/JS/CSS por renomeação atômica e verifica os hashes servidos. Só opera no container de desenvolvimento. Registra a imagem de origem em `frontend-history.log`; a imagem base continua a anterior até uma implantação normal quando a sala estiver vazia. Participantes carregam a interface nova ao atualizar suas próprias páginas.

Teste de sala real: use somente a sala de teste e o token emitido por `ops/dev-test-token.sh`, nomes de teste, áudio/vídeo desabilitados ou uma fonte sintética; encerre suas próprias sessões ao terminar. Os testes locais em Chrome verificam presença real via Socket.IO, API privada, entrega individual, blur seletivo, grade/pin, controles, resultado, nota, repetição, votação, carregamento dos 14 jogos, desconexão e responsividade.

### Verificação da primeira implantação

- Imagem de desenvolvimento: commit `7a17649d`, digest `sha256:7bf75b70d8e330d945c1b820bf3266248ab0603028b1fd835b868c88824c9c30`.
- CI aprovada: https://github.com/theplayzzz/mirotalksfu/actions/runs/41263882773.
- Local: 609 testes do servidor passaram (3 de mediasoup pendentes no Windows), 212 das mecânicas passaram; os dois testes de integração Chrome passaram.
- `tests/e2e/captcha-dev.mjs` passou na instância real com duas sessões próprias na sala `teste`, captura sintética de 640×360 a 15 fps com áudio, recebimento e decodificação contínuos sob o blur, resultado e avaliação persistidos. As sessões foram encerradas e a duração original restaurada. Seu registro aparece com o nome `CAPTCHA-verificacao-jogador`; essa avaliação é uma amostra de verificação, não feedback dos amigos.
- A imagem de produção permaneceu `sha256:acf892f1e9f170b4098b9fd664782c3e1b2f047a736f7dd332db85b6cea10a60`.

### Verificação do fluxo sob demanda e da votação — 01/11/2026

- Interface publicada do commit `707a4cef`, imagem `sha256:16ac6955e22da102957a7e2b6843cb3b6e35154f46760a756567e8d7c3eb0201`, após aprovação da CI: https://github.com/theplayzzz/mirotalksfu/actions/runs/41267344233.
- Publicação estática com backup e hashes conferidos, sem reinício: o container de desenvolvimento conservou o início em `2026-11-01T02:11:20.008575193Z`. Produção permaneceu na mesma imagem da primeira verificação.
- Os 212 testes das mecânicas passaram. A integração Chrome passou incluindo botão antes do carregamento do jogo, início com um clique, streams que entram e saem, ausência de botão sobre câmeras, grade/pin, minimizar/retomar, resultado/nota/repetição, votação, todos os 14 jogadores, erro de asset, desconexão e tela de 390px.
- A regra de votação foi conferida com dez presentes: 30% exige três votos e 35% exige quatro. Aprovação deixa a verificação pendente para o clique do alvo.
- O teste SFU real passou novamente na sala isolada `teste`: duas sessões próprias, stream sintética com áudio, recebimento contínuo sob blur, janela ausente antes do clique, resultado e avaliação persistidos. Não alterou configurações globais, não reiniciou a instância e encerrou apenas suas próprias sessões.
