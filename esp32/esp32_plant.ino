// === Bibliothèques utilisées ===
#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <BH1750.h>
#include <Adafruit_BME280.h>
#include <adafruit_sensor.h>

// ================= RÉGLAGES MQTT =================
const char *MQTT_HOST = "172.16.8.125";
const int MQTT_PORT = 1883;
const char *MQTT_USER = "";
const char *MQTT_PASS = "";
// =================================================

// === Broches ===
#define I2C_SDA 22
#define I2C_SCL 21
#define SOIL_PIN 34
#define WATER_LEVEL_PIN 35
#define LED_PIN 2
#define FAN_PIN 14
#define POMPE_PIN 27

const char *WIFI_SSID = "CFAINSTA_STUDENTS";
const char *WIFI_PASS = "Cf@InSt@-$tUd3nT";

const char *TOPIC_TELEMETRY = "tp/esp32/telemetry";
const char *TOPIC_CMD = "tp/esp32/cmd";

// MQTT
WiFiClient espClient;
PubSubClient mqtt(espClient);

// Capteurs
BH1750 lightMeter;
Adafruit_BME280 bme;

bool bh1750_ok = false;
bool bme280_ok = false;

// États
bool ledOn = false;
bool fanOn = false;
bool pumpOn = false;

unsigned long lastSend = 0;
unsigned long lastRetry = 0;
const int retryInterval = 5000;
const int sendInterval = 5000;

// === Réception commandes ===
void Actions(char *topic, byte *payload, unsigned int length)
{
  String msg = "";
  for (unsigned int i = 0; i < length; i++)
    msg += (char)payload[i];

  if (String(topic) == TOPIC_CMD)
  {
    if (msg == "LED_ON")
    {
      digitalWrite(LED_PIN, LOW);
      ledOn = true;
    }
    else if (msg == "LED_OFF")
    {
      digitalWrite(LED_PIN, HIGH);
      ledOn = false;
    }
    else if (msg == "FAN_ON")
    {
      digitalWrite(FAN_PIN, LOW);
      fanOn = true;
    }
    else if (msg == "FAN_OFF")
    {
      digitalWrite(FAN_PIN, HIGH);
      fanOn = false;
    }
    else if (msg == "PUMP_ON")
    {
      digitalWrite(POMPE_PIN, LOW);
      pumpOn = true;
    }
    else if (msg == "PUMP_OFF")
    {
      digitalWrite(POMPE_PIN, HIGH);
      pumpOn = false;
    }

    Serial.println("Action effectuée : " + msg);
  }
}

// === Connexion MQTT ===
void tryConnectMQTT()
{
  if (!mqtt.connected() && millis() - lastRetry > retryInterval)
  {
    lastRetry = millis();

    Serial.print("[MQTT] Connexion... ");

    String clientId = "ESP32-" + String((uint32_t)ESP.getEfuseMac(), HEX);

    bool connected = false;
    if (strlen(MQTT_USER) > 0)
      connected = mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS);
    else
      connected = mqtt.connect(clientId.c_str());

    if (connected)
    {
      mqtt.subscribe(TOPIC_CMD);
      Serial.println("OK ✓");
    }
    else
    {
      Serial.print("Échec (");
      Serial.print(mqtt.state());
      Serial.println(")");
    }
  }
}
// === SETUP ===
void setup()
{
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n=== ESP32 IoT Plant Monitor ===");

  Wire.begin(I2C_SDA, I2C_SCL);

  pinMode(WATER_LEVEL_PIN, INPUT_PULLUP);

  pinMode(LED_PIN, OUTPUT);
  pinMode(FAN_PIN, OUTPUT);
  pinMode(POMPE_PIN, OUTPUT);

  // FORCER OFF AU DÉMARRAGE
  digitalWrite(LED_PIN, HIGH);
  digitalWrite(FAN_PIN, HIGH);
  digitalWrite(POMPE_PIN, HIGH);

  ledOn = false;
  fanOn = false;
  pumpOn = false;

  // WiFi
  Serial.print("[WiFi] Connexion... ");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED)
  {
    delay(500);
    Serial.print(".");
  }

  Serial.println(" OK");
  Serial.println(WiFi.localIP());

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(Actions);

  // Capteurs
  if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire))
  {
    bh1750_ok = true;
    Serial.println("BH1750 OK");
  }

  if (bme.begin(0x76) || bme.begin(0x77))
  {
    bme280_ok = true;
    Serial.println("BME280 OK");
  }

  Serial.println("Prêt !");
}

// === LOOP ===
void loop()
{
  mqtt.loop();
  tryConnectMQTT();

  unsigned long now = millis();

  if (now - lastSend >= sendInterval)
  {
    lastSend = now;

    int lux = -1;
    if (bh1750_ok)
      lux = (int)lightMeter.readLightLevel();

    int soilRaw = analogRead(SOIL_PIN);
    int soilPercent = map(soilRaw, 4095, 0, 0, 100);

    int temperature = -999;
    int humidity = -1;
    int pressurehPa = 0;

    if (bme280_ok)
    {
      temperature = (int)bme.readTemperature();
      humidity = (int)bme.readHumidity();
      pressurehPa = (int)bme.readPressure() / 100;
    }

    // === Filtrage logiciel appliqué ici ===
    bool waterLevel = !(digitalRead(WATER_LEVEL_PIN)); // true = plein, false = vide

    String payload = "{\"luminosite\":" + String(lux) +
                     ",\"humidite_sol\":" + String(soilPercent) +
                     ",\"temperature\":" + String(temperature) +
                     ",\"humidite_air\":" + String(humidity) +
                     ",\"pressure\":" + String(pressurehPa) +
                     ",\"rssi\":" + String(WiFi.RSSI()) +
                     ",\"water_full\":" + (waterLevel ? "true" : "false") +
                     ",\"led_on\":" + (ledOn ? "true" : "false") +
                     ",\"fan_on\":" + (fanOn ? "true" : "false") +
                     ",\"pump_on\":" + (pumpOn ? "true" : "false") + "}";

    if (mqtt.connected())
      mqtt.publish(TOPIC_TELEMETRY, payload.c_str());

    Serial.println(payload);
  }

  delay(50);
}