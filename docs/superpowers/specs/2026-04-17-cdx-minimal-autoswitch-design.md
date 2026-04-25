# CDX Minimal Autoswitch Redesign

Date: 2026-04-17

## Goal

Rendere `cdx` un wrapper quasi trasparente di `codex` con un'unica automazione core:

- rilevare `usage_limit_exceeded` in modo affidabile
- chiudere la sessione corrente
- eseguire smart switch account
- riaprire la **stessa** chat con `resume <sessionId>`
- verificare che il `sessionId` riaperto sia identico

Se anche una sola certezza manca, `cdx` deve fermarsi con errore invece di tentare fallback fragili.

## Non-Goals

Questa versione **non** prova a essere "magica".

Fuori scope:

- restore del prompt
- autosubmit del prompt
- parsing del prompt visibile
- highlight dei prompt
- badge/footer/logo/banner decorativi
- fallback `fork`
- riapertura di chat "simili" o "più probabili"

## User Contract

Per l'utente il comportamento desiderato è:

- `cdx ...` resta il comando principale
- nelle sessioni interattive, `cdx` si comporta quasi come `codex`
- quando arriva exhaustion reale, anche durante una generazione in corso:
  - `cdx` interrompe la sessione
  - cambia account
  - riapre la **stessa** chat
- se non riesce a provare che la chat riaperta è la stessa, mostra errore e si ferma

## Success Criteria

Un autoswitch è considerato riuscito **solo** se:

1. l'exhaustion è confermata da segnale strutturato
2. `sessionId` e `sessionFilePath` della sessione corrente sono noti con certezza
3. lo switch account riesce
4. `resume <sessionId>` riesce
5. la sessione riaperta conferma lo **stesso** `sessionId`

Qualsiasi altra condizione è un errore.

## Architectural Rules

### 1. Transparent PTY Transport

Il path critico input/output deve essere quasi trasparente:

- input inoltrato a Codex
- output inoltrato a terminale
- nessuna decisione critica basata su `Enter`
- nessuna decisione critica basata sull'output renderizzato

### 2. Session Identity Is Canonical

La sessione corrente è definita solo da:

- `sessionId`
- `sessionFilePath`

Se uno dei due manca o è ambiguo, `cdx` non deve tentare autoswitch.

### 3. Observer Owns Exhaustion

L'unica fonte di verità per exhaustion è il session log strutturato.

Trigger ammessi:

- `latestError.code === "usage_limit_exceeded"`
- oppure equivalente strutturato nel `jsonl`

Il parsing del testo TUI non deve essere usato come trigger core.

### 4. Resume Must Be Verified

Dopo lo switch:

- `cdx` esegue `resume <sessionId>`
- verifica che la sessione riaperta esponga lo stesso `sessionId`
- senza conferma esplicita: errore

## Runtime Model

Il runtime viene ridotto a quattro lane:

### Input lane

- pass-through quasi totale
- nessuna semantica di submit

### Output lane

- pass-through quasi totale
- nessuna logica di stato

### Session observer

Responsabilità:

- leggere session state dal `jsonl`
- mantenere sincronizzati `sessionId`, `sessionFilePath`, exhaustion

### Switch orchestrator

Responsabilità:

- bloccare il runtime quando exhaustion è confermata
- chiudere la PTY corrente
- eseguire smart switch
- fare `resume <sessionId>`
- verificare identità della sessione riaperta

## Session Discovery Rules

### New session

Per una sessione nuova, il file scoperto dopo il launch appartiene interamente alla sessione corrente.

Conseguenza:

- il tail iniziale va preservato
- non va buttato via il primo `user_message`

### Resumed/preexisting session

Per sessioni già esistenti:

- baseline a EOF
- gli eventi storici vanno ignorati

Conseguenza:

- nessun errore vecchio deve riattivare lo switch

## Failure Policy

`cdx` deve fallire esplicitamente se:

- exhaustion non è strutturalmente confermata
- `sessionId` non è noto
- `sessionFilePath` non è noto
- switch account fallisce
- `resume <sessionId>` fallisce
- la sessione riaperta non conferma lo stesso `sessionId`

Nessun fallback:

- niente `fork`
- niente chat "best effort"
- niente reopen di una sessione solo "compatibile"

## Simplification Policy

Per questa fase, se una feature non è necessaria a garantire correttezza, va disattivata.

Ordine di priorità:

1. stessa chat
2. switch al momento giusto
3. compatibilità con le shortcut native di Codex
4. trasparenza del wrapper
5. qualsiasi comodità extra

## Test Plan

I test minimi richiesti sono:

- non autoswitcha senza identità certa della sessione
- autoswitcha su exhaustion strutturata anche senza nuovo `Enter`
- non usa parsing TUI come trigger core
- dopo lo switch usa solo `resume <sessionId>`
- errore se la sessione riaperta non coincide con lo stesso `sessionId`
- nessun fallback `fork`
- nessun restore/autosubmit del prompt richiesto per il successo
- `cdx` non rompe `Esc`, `Ctrl+C`, history, approval UI
- i comandi non interattivi restano trasparenti

## Migration Plan

### Phase 1

Spegnere tutto il non essenziale dal path interattivo:

- highlight
- badge/footer
- banner extra
- prompt restore
- autosubmit

### Phase 2

Rendere `sessionId` + `sessionFilePath` l'unica identità canonica della sessione.

### Phase 3

Spostare il trigger di autoswitch esclusivamente sull'observer strutturato.

### Phase 4

Rendere obbligatoria la verifica del `sessionId` dopo `resume`.

## Acceptance

Questa redesign è accettata quando:

- `cdx` non apre più chat sbagliate
- lo switch parte anche se il limite viene raggiunto durante una generazione
- in caso di incertezza il wrapper mostra errore invece di fare guess
- il path interattivo è abbastanza semplice da non rompere più le shortcut native di Codex
