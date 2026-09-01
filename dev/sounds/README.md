# sounds

Drop files here and they replace the synthesised placeholders.

| file | plays on |
|---|---|
| `paddle.wav`   | ball hitting a paddle |
| `wall.wav`     | ball hitting a wall, floor, ceiling or goal frame |
| `net.wav`      | ball hitting the net |
| `scored.wav`   | you put it in their goal |
| `conceded.wav` | they put it in yours |

`scored` and `conceded` are the same event in the simulation — the two players
hear different sounds for it, because which one it is depends on who is
listening. A goal plays `scored` on one machine and `conceded` on the other.

Any format the browser can decode works; `.wav` and `.mp3` both do. To use a
different extension, change the filename in the `SOUNDS` map in `index.html`.

Volume follows the impulse of the contact, so record at a consistent level and
let the game scale it. Short samples work best — a paddle hit is over in well
under a tenth of a second, and a sample that outlasts the contact smears once
rallies get fast.

Sound only loads over http(s). Opening `index.html` from disk falls back to the
placeholders, because a page on `file://` cannot fetch its own siblings.
