# Rally

A 2D physics paddle game. Hit it over the net, put it in the goal.

**Play:** https://noahtk113.github.io/rally/

One player hosts and shares the four-character room code; the other joins.
Peer-to-peer over WebRTC, with an authoritative server running on the host
machine behind a delayed loopback so both players face the same latency.
Each client predicts locally and reconciles by rewind, so your paddle
responds with no network in the path.

**Controls:** mouse to move, wheel to rotate, hold right-click for fine
rotation, S to level, F to serve, R to reset the score, H for settings and
diagnostics, Esc for the menu.

**Dev build:** https://noahtk113.github.io/rally/dev/
