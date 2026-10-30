// Finds the I2C address of your LCD. Upload, open Serial Monitor (9600 baud), read the address.
#include <Wire.h>
void setup() {
  Serial.begin(9600);
  Wire.begin();
  delay(500);
  bool found = false;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { Serial.print("Found device at 0x"); Serial.println(a, HEX); found = true; }
  }
  if (!found) Serial.println("Nothing found. Check SDA/SCL wiring and power.");
}
void loop() {}
