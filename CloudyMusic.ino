/*
  Cloudy Music - Arduino UNO side.
  Hardware: potentiometer (A0), push button (D2 to GND), 16x2 I2C LCD (SDA=A4, SCL=A5).
  Library:  "LiquidCrystal I2C" by Frank de Brabander (Arduino IDE > Library Manager).
  Serial:   9600 baud, one message per line, "KEY|value".

  Arduino -> website:  HELLO|CloudyMusic1   (sent once after reset)
                       BTN|SHORT             (button tapped: play/pause)
                       BTN|LONG              (held >= 800 ms: switch Now Playing / Lyrics)
                       POT|0..100            (knob moved: volume percent)
  Website -> Arduino:  MODE|PLAYER or MODE|LYRICS
                       TITLE|text  ARTIST|text  LYRIC|text  STATUS|text
                       PING|   (keep-alive; if nothing arrives for 8 s the LCD shows "Cloudy offline")
*/
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

const uint8_t LCD_ADDR = 0x27;              // change to 0x3F if the LCD stays blank (run the I2CScanner sketch)
LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);

const uint8_t PIN_BTN = 2;
const uint8_t PIN_POT = A0;
const unsigned long DEBOUNCE_MS = 30;
const unsigned long LONG_PRESS_MS = 800;
const unsigned long SCROLL_MS = 350;
const unsigned long RENDER_MS = 120;
const unsigned long OFFLINE_MS = 8000;
const unsigned long POT_MS = 40;
const uint8_t MAXLEN = 80;

enum Mode { MODE_PLAYER, MODE_LYRICS };
Mode mode = MODE_PLAYER;

char title[MAXLEN + 1], artist[MAXLEN + 1], lyric[MAXLEN + 1], status[33];
bool heard = false;                         // have we received anything from the website yet?
unsigned long lastRx = 0;

char rx[110];
uint8_t rxLen = 0;
bool rxOverflow = false;

char rowText[2][MAXLEN + 1];
char shown[2][17];
uint8_t scrollOff[2] = {0, 0};

/* ---------- helpers ---------- */
void copyClean(char *dst, const char *src, uint8_t maxLen) {
  uint8_t n = 0;
  for (; src[n] && n < maxLen; n++) {
    char c = src[n];
    dst[n] = (c < 32 || c > 126) ? '?' : c;   // the LCD can only show plain ASCII
  }
  dst[n] = 0;
}

void drawRow(uint8_t row, const char *text) {
  if (strcmp(text, rowText[row]) != 0) {      // new text: start scrolling from the beginning
    copyClean(rowText[row], text, MAXLEN);
    scrollOff[row] = 0;
  }
  uint8_t len = strlen(text);
  char out[17];
  for (uint8_t i = 0; i < 16; i++) {
    if (len <= 16) out[i] = (i < len) ? text[i] : ' ';
    else {
      uint8_t k = (scrollOff[row] + i) % (len + 3);   // 3 blank columns between repeats
      out[i] = (k < len) ? text[k] : ' ';
    }
  }
  out[16] = 0;
  if (strcmp(out, shown[row]) != 0) {         // only touch the LCD when something changed
    lcd.setCursor(0, row);
    lcd.print(out);
    strcpy(shown[row], out);
  }
}

void render() {
  if (!heard) { drawRow(0, "Cloudy Music"); drawRow(1, "Open website..."); return; }
  if (millis() - lastRx > OFFLINE_MS) {       // connection lost: never leave an old song on screen
    title[0] = artist[0] = lyric[0] = status[0] = 0;
    drawRow(0, "Cloudy offline"); drawRow(1, "Check website"); return;
  }
  if (mode == MODE_LYRICS) {
    drawRow(0, "Lyrics Mode");
    drawRow(1, lyric[0] ? lyric : "No lyrics yet");
    return;
  }
  if (title[0]) { drawRow(0, title); drawRow(1, artist[0] ? artist : status); }
  else { drawRow(0, "Cloudy Music"); drawRow(1, status[0] ? status : "Nothing playing"); }
}

void advanceScroll() {
  for (uint8_t r = 0; r < 2; r++) {
    uint8_t len = strlen(rowText[r]);
    if (len > 16) scrollOff[r] = (scrollOff[r] + 1) % (len + 3);
  }
}

/* ---------- serial in ---------- */
void handleLine(char *line) {
  char *bar = strchr(line, '|');
  if (!bar) return;
  *bar = 0;
  const char *key = line;
  const char *val = bar + 1;
  lastRx = millis();
  heard = true;
  if (!strcmp(key, "TITLE")) copyClean(title, val, MAXLEN);
  else if (!strcmp(key, "ARTIST")) copyClean(artist, val, MAXLEN);
  else if (!strcmp(key, "LYRIC")) copyClean(lyric, val, MAXLEN);
  else if (!strcmp(key, "STATUS")) copyClean(status, val, 32);
  else if (!strcmp(key, "MODE")) mode = !strcmp(val, "LYRICS") ? MODE_LYRICS : MODE_PLAYER;
  // PING and unknown keys only refresh lastRx
}

void readSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      if (!rxOverflow) { rx[rxLen] = 0; handleLine(rx); }
      rxLen = 0; rxOverflow = false;
    } else if (c != '\r') {
      if (rxLen < sizeof(rx) - 1) rx[rxLen++] = c; else rxOverflow = true;
    }
  }
}

/* ---------- button: debounced, short vs long, no delay() ---------- */
bool btnStable = HIGH, btnLast = HIGH, longSent = false;
unsigned long btnChange = 0, pressStart = 0;

void handleButton() {
  bool r = digitalRead(PIN_BTN);
  unsigned long now = millis();
  if (r != btnLast) { btnLast = r; btnChange = now; }
  if (now - btnChange >= DEBOUNCE_MS && r != btnStable) {
    btnStable = r;
    if (btnStable == LOW) { pressStart = now; longSent = false; }
    else if (!longSent) Serial.println(F("BTN|SHORT"));   // released; a long press already reported itself
  }
  if (btnStable == LOW && !longSent && now - pressStart >= LONG_PRESS_MS) {
    longSent = true;                                        // fires while still held, so release sends nothing
    Serial.println(F("BTN|LONG"));
  }
}

/* ---------- potentiometer: averaged, 0-100, only reports real changes ---------- */
int lastPot = 0;
unsigned long lastPotRead = 0;

int readPercent() {
  long sum = 0;
  for (uint8_t i = 0; i < 8; i++) sum += analogRead(PIN_POT);
  return constrain(map(sum / 8, 0, 1023, 0, 100), 0, 100);
}

void handlePot() {
  if (millis() - lastPotRead < POT_MS) return;
  lastPotRead = millis();
  int p = readPercent();
  if (abs(p - lastPot) >= 2 || ((p == 0 || p == 100) && p != lastPot)) {   // ignore +/-1 jitter
    lastPot = p;
    Serial.print(F("POT|"));
    Serial.println(p);
  }
}

void setup() {
  pinMode(PIN_BTN, INPUT_PULLUP);
  Serial.begin(9600);
  lcd.init();
  lcd.backlight();
  lcd.clear();
  shown[0][0] = shown[1][0] = 0;
  rowText[0][0] = rowText[1][0] = 0;
  lastPot = readPercent();                  // so the volume does not jump until you turn the knob
  render();
  Serial.println(F("HELLO|CloudyMusic1"));
}

void loop() {
  static unsigned long lastScroll = 0, lastRender = 0;
  unsigned long now = millis();
  readSerial();
  handleButton();
  handlePot();
  if (now - lastScroll >= SCROLL_MS) { lastScroll = now; advanceScroll(); }
  if (now - lastRender >= RENDER_MS) { lastRender = now; render(); }
}
