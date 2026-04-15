# Report Modifiche: Smart Switching e Limiti Live

## Obiettivo

Il lavoro ha trasformato `cdx` da semplice account switcher basato su snapshot locali a strumento capace di:

- leggere i limiti live degli account direttamente dal runtime di Codex
- mostrare nel picker informazioni utili prima della selezione
- consigliare automaticamente l'account migliore da usare in quel momento
- gestire account deboli, esauriti o non piu validi senza costringere l'utente a controlli manuali

L'intervento principale e stato fatto in [bin/cdx.js](../bin/cdx.js), con copertura di regressione in [tests/regressions.js](../tests/regressions.js).

## Risultato funzionale

Dopo le modifiche, `cdx` offre queste funzionalita:

- `Switch account` mostra per ogni account:
  - email
  - piano
  - stato attivo
  - eventuale raccomandazione
  - limiti live `5h` e `weekly`
  - reset associato a ogni finestra
  - stato di esaurimento immediatamente visibile
  - stato `low credits` quando il backend segnala davvero i credits

- `Smart switch`:
  - e la prima voce del menu
  - seleziona automaticamente l'account migliore disponibile
  - esegue lo switch
  - chiude subito `cdx` dopo l'operazione
  - se l'account migliore e gia quello attivo, chiude comunque senza rientrare nel menu
  - se tutti gli account eleggibili sono esauriti, restituisce errore invece di scegliere male

- Gli account con file auth eliminato vengono rimossi automaticamente dalla configurazione.

- Gli account possono essere:
  - `pinned`
  - esclusi dalla recommendation

## Cosa e stato fatto

### 1. Lettura metadata account piu completa

La lettura dei file auth locali e stata estesa per estrarre:

- email
- piano

Il parsing non si limita ai campi piu ovvi, ma cerca anche dentro i token JWT quando necessario. Questo permette di costruire label piu ricche anche se il fetch live non e disponibile.

### 2. Integrazione live con Codex app-server

Per mostrare i limiti reali al momento dell'apertura del menu, `cdx` ora interroga `codex app-server` invece di basarsi solo sugli snapshot locali.

Il flusso e questo:

1. per ogni account viene creata una `CODEX_HOME` temporanea
2. dentro quella home viene copiato lo snapshot auth dell'account come `auth.json`
3. viene avviato `codex app-server --listen stdio://`
4. `cdx` esegue handshake JSON-RPC con:
   - `initialize`
   - `initialized`
   - `account/read` con `refreshToken: true`
   - `account/rateLimits/read`
5. la risposta viene convertita in uno stato UI compatto con:
   - finestra primaria
   - finestra secondaria
   - reset
   - credits, se disponibili

Questa parte ha richiesto anche:

- risoluzione robusta del launcher Codex su Windows
- gestione degli shim npm
- correzione del protocollo `initialized` senza `params`
- timeout separati per fase
- cleanup sicuro della home temporanea

### 3. Cache breve dei limiti live

Per non rendere il picker lento a ogni apertura, i limiti live vengono memorizzati in cache per un periodo breve.

Caratteristiche:

- cache in memoria
- TTL di 45 secondi
- invalidazione automatica se cambia lo snapshot auth
- concorrenza limitata per non lanciare troppi processi Codex in parallelo

### 4. Miglioramento dell'interfaccia di `Switch account`

Il picker normale e stato reso molto piu informativo.

Ogni account puo mostrare badge come:

- `[PLUS]`
- `[ACTIVE]`
- `[RECOMMENDED]`
- `[PINNED]`
- `[EXCLUDED]`
- `[5H 0%]`
- `[WEEKLY 0%]`
- `[LOW 7 CR]`

I reset sono espliciti per ogni finestra, ad esempio:

```text
5h 74% (reset 18:40) | weekly 91% (reset 2039-09-18 18:40)
```

E stato aggiunto anche un loading iniziale quando i dati live non sono gia in cache.

### 5. Recommendation engine

E stata introdotta una logica di ranking per capire quale account usare senza pensarci.

La recommendation considera:

- account esclusi dalla recommendation
- account pinned
- finestre esaurite
- reset delle finestre esaurite
- margine disponibile sulle finestre attive
- crediti bassi
- crediti a zero

La regola generale e:

- prima vengono gli account davvero usabili subito
- poi quelli con piu margine operativo
- quelli con pochi credits vengono penalizzati
- quelli esauriti non vengono usati per `Smart switch`

### 6. Smart switch

Il vecchio concetto di "switch to recommended" e stato trasformato in `Smart switch`.

Comportamento finale:

- e il primo item del menu
- carica i limiti live
- sceglie il miglior account eleggibile
- se l'account scelto ha pochi credits, avvisa prima dello switch
- se l'account e gia quello attivo, chiude con messaggio informativo
- se lo switch avviene, `cdx` esce subito
- se tutti gli account sono esauriti, mostra errore

### 7. Hard warning su account esauriti

Se un account ha:

- una finestra a `0%`
- oppure credits a `0`

`cdx` lo segnala in modo evidente gia nella lista e, nel picker normale, chiede conferma prima di procedere.

### 8. Gestione dei credits

Il supporto credits e stato implementato con una regola conservativa:

- il badge credits viene mostrato solo se il backend segnala davvero `hasCredits`
- un semplice `balance: 0` senza supporto credits attivo non viene interpretato come esaurimento

Questa correzione e stata importante per evitare falsi `[0 CR]` su account che in realta non usano quel sistema.

### 9. Stato account su disco e auto-riparazione

La gestione di `accounts.json` e stata resa piu robusta.

Ora il progetto:

- normalizza le entry lette dal file
- supporta campi aggiuntivi:
  - `pinned`
  - `excludedFromRecommendation`
- rimuove automaticamente gli account il cui file auth non esiste piu
- riallinea l'account attivo se quello precedente sparisce

Questo riduce la necessita di manutenzione manuale.

## Come e stato implementato

### File principali modificati

- [bin/cdx.js](../bin/cdx.js)
  - logica CLI
  - fetch live dei limiti
  - recommendation
  - smart switch
  - badge UI
  - gestione Windows
  - repair dello stato locale

- [tests/regressions.js](../tests/regressions.js)
  - test di parsing metadata
  - test protocollo app-server
  - test launcher Windows
  - test fallback parziale
  - test recommendation
  - test smart switch
  - test crediti
  - test repair account

### Strutture e logiche introdotte

Le principali aggiunte tecniche sono:

- cache metadata auth
- cache live rate limits
- parser piano + email dagli auth snapshot
- parser credits
- risoluzione binario Codex su Windows
- launcher sicuro per `codex app-server`
- generazione request/notification JSON-RPC
- comparatore di recommendation multi-fattore
- repair automatico di `accounts.json`

## Compatibilita e impatto sui dati

Le modifiche sono retrocompatibili.

`accounts.json` ora puo contenere due flag aggiuntivi:

```json
{
  "name": "work",
  "path": "C:\\path\\to\\work.auth.json",
  "pinned": false,
  "excludedFromRecommendation": false
}
```

Se mancano, vengono interpretati correttamente come `false`.

## Test eseguiti

Verifiche eseguite durante il lavoro:

- `node tests/regressions.js`
- `node .\\bin\\cdx.js`
  - verifica del fallimento corretto in ambiente non TTY

La suite copre in particolare:

- import legacy
- normalizzazione account
- auto-rimozione account mancanti
- parsing email e piano
- formato dei limiti live
- protocollo app-server
- launcher Windows
- fallback quando i limiti falliscono ma l'account viene letto
- pin/exclude
- warning per account esauriti
- low credits
- falso `0 CR` evitato
- recommendation e smart switch
- cache dei limiti live

## Nota finale

La modifica piu importante non e solo estetica: `cdx` adesso prende decisioni basate sullo stato reale dell'account nel momento in cui apri il menu, invece di limitarsi a cambiare file auth.

In pratica, il progetto e passato da:

- "account switcher statico"

a:

- "account switcher con awareness live, ranking e smart routing"
