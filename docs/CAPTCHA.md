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

Quando há uma tela ampliada, uma janela independente acompanha o retângulo dessa tela. Na grade, a janela flutua sobre a região central e pode ser minimizada. Ela não cria backdrop nem prende o foco. A mesma instância do iframe continua aberta ao mudar o layout, sem remontar a partida. Minimizar pausa o jogo; abrir retoma. Os vídeos da chamada não são movidos por este recurso.

Ganhar **ou perder** retira o blur imediatamente. A tela de resultado oferece repetir, liberar e avaliar com cinco estrelas; a nota é opcional. “Liberar telas” também está sempre disponível na barra da janela. A atribuição expira após cinco minutos, inclusive se ficar pausada. Saída, perda de conexão ou erro de carregamento remove a janela e o blur. Ninguém é desconectado pelo CAPTCHA.

O jogador isolado não recebe acesso a câmera, microfone ou captura de tela. A comunicação com a sala verifica origem, janela de origem, identificador da atribuição e nonce. O servidor usa o socket autenticado na sala para autorizar tentativas, avaliações e votos, sem confiar em um nome/peer enviado pelo cliente.

## Votação

Uma votação aberta por sala. O eleitorado é a lista dos presentes no início, incluindo o alvo. Pode exigir um número absoluto ou percentual arredondado para cima. Cada pessoa registra um voto final, sim ou não. Quem entrar depois não aumenta o eleitorado. Saídas não diminuem o total necessário; se o quórum ficar inalcançável, a votação encerra. Saída do alvo cancela. Atingir o total a favor dispara uma única atribuição; alvo ocupado não recebe outra por cima.

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

Teste de sala real: use somente a sala de teste e o token emitido por `ops/dev-test-token.sh`, nomes de teste, áudio/vídeo desabilitados ou uma fonte sintética; encerre suas próprias sessões ao terminar. Os testes locais em Chrome verificam presença real via Socket.IO, API privada, entrega individual, blur seletivo, grade/pin, controles, resultado, nota, repetição, votação, carregamento dos 14 jogos, desconexão e responsividade.
