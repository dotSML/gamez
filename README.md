# Party Suite

Five browser games, one room. Someone creates a session, gets a four-letter
code and a QR, everyone else joins on their own phone, and the host picks a
game. No accounts, no installs, no app store.

Built to be played by two to ten people sitting in the same room, or shouting
at each other over a call.

## The games

| Game | Type | How it works |
| --- | --- | --- |
| **Bomb Word** | Word | A letter lights up and the bomb lands on you. Say a word containing that letter, pass it on. The fuse shortens every pass. Three lives, last one standing wins. |
| **Dead Stop** | Nerve | A target time between 4.00s and 12.00s appears. Tap START, a hidden clock runs, tap STOP. Closest to the target takes the round. Five rounds. |
| **Ink Panic** | Reflex | The word says one colour, the ink is another. Tap the INK. Everyone taps at once. A wrong tap locks you out of the round. Eight rounds. |
| **Bonk Arena** | Physics | 2D brawler. Shove everyone else off a platform that loses tiles as the round runs. Best of three. |
| **Deathmatch** | FPS | Raycast shooter. First person, twin-stick touch controls. 34 damage a hit, three hits to kill, first to 12 kills or the highest score when the clock runs out. |

## Running it

Requires Node 20+ (developed against Node 24). No dependencies to install —
everything is hand-rolled, including the WebSocket implementation.

```sh
node server.mjs
```

It listens on `$PORT`, default `8080`. Health check at `/health`.

Then open the URL, create a session, and share the code. The QR code on the
lobby screen encodes whatever origin the page was loaded from, so load it from
the address your guests will use — not from localhost, or you will hand out a
QR nobody can scan.

## How it is put together

Four files, no build step, no framework.

- **`server.mjs`** — HTTP, the WebSocket upgrade, room state, and every game
  rule. The server is authoritative for all five games: the client sends
  intent, the server decides what happened. A modified client can ask to fire
  but cannot invent a kill, a word, or a point.
- **`app.js`** — the client. Talks WebSocket first and falls back to
  long-polling if the socket will not hold, so a proxy that eats the `Upgrade`
  header degrades instead of breaking. The dot next to the room code shows
  which transport is live: green for socket, amber for polling.
- **`index.html`** + **`styles.css`** — one page, five stages, no router.
- **`qr.js`** — [`qrcode-generator`](https://github.com/kazuhikoarase/qrcode-generator)
  by Kazuhiko Arase, MIT licensed, vendored because a hosted app cannot fetch an
  asset from the network at runtime. To update it:

  ```sh
  npm i qrcode-generator
  cp node_modules/qrcode-generator/dist/qrcode.js ./qr.js
  ```

### Protocol

One socket per player, carrying two kinds of frame:

- `{"t":"state"}` — the full room state. Sent on every change, versioned with a
  monotonic `v`; clients ignore anything older than what they already have.
- `{"t":"bk"}` / `{"t":"fs"}` — high-rate snapshots for the two real-time games
  (Bonk Arena physics, Deathmatch). These are separate from `state` because
  they need 15–20 Hz and the lobby does not.

Client to server: `{"t":"in",...}` for movement and aiming, plain HTTP `POST`s
to `/api/act` for everything else.

### Rooms

In memory only. Restarting the process wipes every live session, and there is
no persistence — this is a party game, not a service. Empty rooms are reaped
on a timer.

## History

Tumblestone was removed. It was an attempt at a match-3 column game and it was
not the game anyone wanted for this suite.
