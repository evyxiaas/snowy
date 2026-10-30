# Cloudy Music

A pastel-blue Now Playing + Lyrics dashboard for **YouTube Music in Microsoft Edge**, with an **Arduino UNO** (potentiometer, button, 16x2 I2C LCD). YouTube Music keeps playing the audio. Cloudy only watches the page and presses its buttons.

## How it works

```
YouTube Music tab -> ytm-content.js -> background.js -> cloudy-content.js -> app.js (website)
                                                                             |  Web Serial, 9600 baud
 app.js commands travel the other way (and report success/failure)          Arduino + LCD
```

- **Track info:** read from the player bar (title, artist, album, artwork). **Position, duration, play state, volume** come from the page's `<video>` element, so the progress bar is real. If duration is unknown, the bar is disabled.
- **Updates:** a MutationObserver on the player bar plus video events (play, pause, seek) react instantly; a 1-second check keeps position fresh (every 3 s while paused).
- **Commands:** play/pause, next, previous click the real buttons; seek sets the video position; volume sets the video's volume. Each command waits to see if it actually worked and reports the real result. If not, Cloudy shows "Playback command failed".
- **Security:** the extension only accepts messages from `https://music.youtube.com` and `http://localhost:8765` / `127.0.0.1:8765`, only knows 5 fixed commands, and validates values. The page only accepts messages from its own window and origin. No cookies, tokens, or accounts are touched; nothing leaves your computer except YouTube's own album-art images.
- **Permissions:** no extension API permissions at all, just host access to those three addresses (needed to read YouTube Music and talk to Cloudy).

### Lyrics (what is and isn't possible)

1. If you open the **Lyrics tab** in YouTube Music's side panel, the extension tries to read that text (plain, **never timestamped**). Unverified selectors, so it may not work.
2. You can **paste lyrics** per song in Lyrics Mode. They are saved in your browser (localStorage) under that song.
3. **Synced highlighting only happens if your pasted text has real timestamps** like `[01:23.45] line`. Plain text is shown without highlighting, and Cloudy says so. Lyrics are cleared when the song changes.

### Arduino behaviour

- **Short press:** play/pause. **Hold 0.8 s+:** switch Now Playing / Lyrics Mode (the release does nothing extra).
- **Knob = YouTube Music volume (0-100%).** Nothing changes until you turn it. It sets the player's volume directly, so YouTube Music's own volume slider may not move, and YouTube Music may reset the level on a new song (turn the knob again). Check it works on your PC (step 14).
- **LCD:** Now Playing: title / artist. Lyrics Mode: "Lyrics Mode" / current synced line, or "Lyrics on screen" / "No lyrics yet". Text over 16 characters scrolls. The LCD shows plain ASCII only, so accents are simplified and other alphabets (Japanese, etc.) become `?`. If Cloudy goes quiet for 8 s, the LCD shows "Cloudy offline" instead of an old song.

### Serial protocol (9600 baud, one `KEY|value` per line, `\n` ends it)

| Direction | Message |
|---|---|
| Arduino -> site | `HELLO|CloudyMusic1`, `BTN|SHORT`, `BTN|LONG`, `POT|0..100` |
| Site -> Arduino | `MODE|PLAYER` / `MODE|LYRICS`, `TITLE|..`, `ARTIST|..`, `LYRIC|..`, `STATUS|..`, `PING|` |

Text is ASCII, max 80 characters, with `|` and control characters removed. The site sends lines 40 ms apart so the UNO's small buffer never overflows.

## Wiring

| Part | Pin | Goes to |
|---|---|---|
| Potentiometer | left outer | 5V |
| | right outer | GND |
| | middle | A0 |
| Push button | leg 1 | D2 |
| | leg 2 (opposite side) | GND |
| I2C LCD | VCC | 5V |
| | GND | GND |
| | SDA | A4 |
| | SCL | A5 |

No resistor needed for the button (the sketch uses the internal pull-up). If the button seems always pressed, use the two legs on opposite sides of the button.

## Install guide (Windows + Edge)

1. **Extract:** right-click `CloudyMusic.zip` > *Extract All* > *Extract*. Keep the folder somewhere permanent (e.g. Documents), because Edge loads the extension from it.
2. **Python:** install from python.org if you don't have it (tick **Add python.exe to PATH**). Test: open Command Prompt, type `python --version`.
3. **Start the website:** open the `CloudyMusic` folder and double-click `start-snowy.bat`. A black window appears: leave it open. (Manual way: in the folder's address bar type `cmd`, press Enter, run `python -m http.server 8765 --bind 127.0.0.1`.)
4. **Open Cloudy:** in Edge go to `http://localhost:8765`. You'll see the sky page with "Looking for the extension…" then "Extension disconnected" (until step 7).
5. **Extensions page:** in a new tab go to `edge://extensions`.
6. **Developer mode:** switch **Developer mode** on (left menu or bottom-left).
7. **Load the extension:** click **Load unpacked**, pick the **`edge-extension`** folder (the one containing `manifest.json`), *Select Folder*. "Cloudy Music Bridge" appears. Reload the Cloudy tab (F5): the status becomes "Waiting for YouTube Music".
8. **Play music:** open `https://music.youtube.com` in another tab, **reload it once (F5) after installing**, and play a song.
9. **Arduino IDE:** install from arduino.cc. *Tools > Manage Libraries*, search **LiquidCrystal I2C**, install the one by **Frank de Brabander**.
10. **Upload:** plug in the UNO, open `arduino/CloudyMusic/CloudyMusic.ino`, choose *Tools > Board > Arduino UNO* and the right *Port*, click Upload (->). The LCD should show "Cloudy Music / Open website...". **Close the Arduino Serial Monitor** afterwards (only one program can use the port).
11. **Connect in Cloudy:** click the **cloud icon** (top left), then **Connect Arduino**, choose the "Arduino Uno (COMx)" entry, *Connect*. The Arduino restarts for ~2 s, then the LCD shows your song.
12. **Test the controls:**
    - Play/Next/Previous on the website change YouTube Music.
    - Tap the button: play/pause. Hold it: the website flips to Lyrics Mode and back.
    - Turn the knob: "Volume N%" under the buttons changes and the sound follows.
13. **Check track detection:** skip songs in YouTube Music directly. Title, artist, artwork, and progress should follow within about a second. Drag the progress bar: YouTube Music jumps there.
14. **Check commands honestly:** if something does nothing, open *Connection details* at the bottom of Cloudy; it shows the last error.
15. **Lyrics:** click **Lyrics Mode**. Either open YouTube Music's *Lyrics* tab, or press **Paste lyrics**. For highlighting, paste LRC-style lines (`[00:12.50] First line`). Check the LCD shows "Lyrics Mode".

## Troubleshooting

| Problem | Who's responsible / what to do |
|---|---|
| "Nothing playing yet" | Extension or YouTube Music tab. Reload the YouTube Music tab (F5) after installing; make sure a song is playing; check `edge://extensions` shows the extension enabled with no errors. |
| Extension does not connect | You must use exactly `http://localhost:8765` (or `127.0.0.1:8765`), not a file or another port. Reload the Cloudy tab after (re)loading the extension. |
| Can't read the current track | `ytm-content.js` selectors. On the YouTube Music tab press F12 > Console and look for errors; YouTube may have renamed `.title` / `.byline` in the player bar. |
| Title changes, artwork doesn't | Artwork selector or blocked image. Cloudy shows the cloud placeholder when the image fails. |
| Buttons do nothing | Read the error in *Connection details*. "No YouTube Music tab" = open one. "Not responding" = reload it. If clicks are ignored, click once in the YouTube Music tab (browsers block play until you've interacted with it). |
| Progress bar is inaccurate | It follows the page's video clock. During ads or when the tab is heavily throttled it can lag a second or two. |
| Lyrics unavailable / don't sync | Expected: YouTube Music doesn't expose timed lyrics. Paste timestamped (LRC) lyrics to get highlighting. |
| Edge can't access serial | Use Edge on the localhost address; close the Arduino Serial Monitor/IDE uploads; unplug and re-plug. |
| UNO not in the port list | Bad/charge-only USB cable, missing driver (clones need CH340), or another program has the port. |
| LCD blank squares/nothing | Turn the small blue contrast screw on the back of the LCD; check VCC/GND/SDA/SCL. |
| Wrong I2C address | Upload `arduino/I2CScanner`, read the address in Serial Monitor, set `LCD_ADDR` in `CloudyMusic.ino` (often 0x3F). |
| Knob erratic | Check the three wires (outer = 5V and GND, middle = A0). The sketch already averages and ignores +/-1 steps. |
| Button fires many times | Wire it D2 to GND on opposite legs. The sketch debounces at 30 ms. |
| Arduino disconnects | Cable or power glitch. Cloudy reports "Arduino unplugged"; click Connect Arduino again. |

## Known limitations

- Only one YouTube Music tab should be open.
- Controls depend on YouTube Music's page structure and can break when it changes.
- Volume control sets the player's volume, not YouTube Music's own slider.
- Lyrics from the YouTube Music tab are plain text and best-effort.
