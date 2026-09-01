# sounds

Drop files here and they replace the synthesised placeholders.

| file | plays on |
|---|---|
| `paddle.wav` | ball hitting a paddle |
| `wall.wav`   | ball hitting a wall, floor, ceiling or goal frame |
| `net.wav`    | ball hitting the net |
| `goal.wav`   | a goal scored |

Any format the browser can decode works — `.wav` and `.mp3` both do. To use a
different extension, change the filename in the `SOUNDS` map in `index.html`.

Volume follows the impulse of the contact, so record at a consistent level and
let the game scale it. Short samples work best; a paddle hit is over in well
under a tenth of a second.

Sound only loads over http(s). Opening `index.html` from disk falls back to the
placeholders, because a page on `file://` cannot fetch its own siblings.
