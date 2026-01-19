#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <BH1750.h>

#define I2C_SDA 22
#define I2C_SCL 21
#define SOIL_PIN 34
#define LED_PIN 2
#define FAN_PIN 14
#define HUMIDIFIER_PIN 13

const char* WIFI_SSID = "CFAINSTA_STUDENTS";
const char* WIFI_PASS = "Cf@InSt@-$tUd3nT";

// Configuration des deux serveurs
const char* MQTT_HOST1 = "172.16.8.79";
const char* MQTT_HOST2 = "172.16.8.107";
const int   MQTT_PORT  = 1883;

const char* TOPIC_TELEMETRY = "tp/esp32/telemetry";
const char* TOPIC_CMD       = "tp/esp32/cmd";

WiFiClient espClient1;
WiFiClient espClient2;
PubSubClient mqtt1(espClient1);
PubSubClient mqtt2(espClient2);
BH1750 lightMeter;

unsigned long lastSend = 0;
unsigned long lastRetry1 = 0;
unsigned long lastRetry2 = 0;
const int retryInterval = 5000; // Tente de se reconnecter toutes les 5 secondes si un PC est éteint

void onMessage(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];

  Serial.printf("[MQTT] Message reçu sur %s : %s\n", topic, msg.c_str());

  if (String(topic) == TOPIC_CMD) {
    if (msg == "LED_ON") digitalWrite(LED_PIN, HIGH);
    else if (msg == "LED_OFF") digitalWrite(LED_PIN, LOW);
    else if (msg == "FAN_ON") digitalWrite(FAN_PIN, HIGH);
    else if (msg == "FAN_OFF") digitalWrite(FAN_PIN, LOW);
    else if (msg == "HUM_ON") digitalWrite(HUMIDIFIER_PIN, HIGH);
    else if (msg == "HUM_OFF") digitalWrite(HUMIDIFIER_PIN, LOW);
  }
}

// Tentative de connexion non-bloquante pour le Broker 1
void tryConnectMQTT1() {
  if (!mqtt1.connected() && millis() - lastRetry1 > retryInterval) {
    lastRetry1 = millis();
    Serial.println("[MQTT 1] Tentative de connexion...");
    String clientId = "ESP32-P1-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    if (mqtt1.connect(clientId.c_str())) {
      mqtt1.subscribe(TOPIC_CMD);
      Serial.println("[MQTT 1] Connecté !");
    } else {
      Serial.println("[MQTT 1] Échec (PC éteint ?)");
    }
  }
}

// Tentative de connexion non-bloquante pour le Broker 2
void tryConnectMQTT2() {
  if (!mqtt2.connected() && millis() - lastRetry2 > retryInterval) {
    lastRetry2 = millis();
    Serial.println("[MQTT 2] Tentative de connexion...");
    String clientId = "ESP32-P2-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    if (mqtt2.connect(clientId.c_str())) {
      mqtt2.subscribe(TOPIC_CMD);
      Serial.println("[MQTT 2] Connecté !");
    } else {
      Serial.println("[MQTT 2] Échec (PC éteint ?)");
    }
  }
}

void setup() {
  Serial.begin(115200);
  Wire.begin(I2C_SDA, I2C_SCL);
  pinMode(LED_PIN, OUTPUT);
  pinMode(SOIL_PIN, INPUT);
  pinMode(FAN_PIN, OUTPUT);
  pinMode(HUMIDIFIER_PIN, OUTPUT);

  // Connexion WiFi (Bloquante au démarrage car nécessaire)
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\n[WIFI] Connecté !");

  mqtt1.setServer(MQTT_HOST1, MQTT_PORT);
  mqtt1.setCallback(onMessage);
  
  mqtt2.setServer(MQTT_HOST2, MQTT_PORT);
  mqtt2.setCallback(onMessage);

  lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire);
}

void loop() {
  // Gestion des connexions SANS bloquer le reste du code
  tryConnectMQTT1();
  tryConnectMQTT2();

  mqtt1.loop();
  mqtt2.loop();

  unsigned long now = millis();
  if (now - lastSend >= 2000) {
    lastSend = now;

    float lux = lightMeter.readLightLevel();
    int soilRaw = analogRead(SOIL_PIN);
    float soilPercent = map(soilRaw, 4095, 0, 0, 100); 

    String payload = "{\"luminosite\":" + String(lux) + 
                     ",\"humidite_sol\":" + String(soilPercent) + 
                     ",\"co2\":" + String(random(400, 800)) + 
                     ",\"rssi\":" + String(WiFi.RSSI()) + "}";

    Serial.println("Envoi : " + payload);

    // Publie uniquement si le broker est disponible
    if (mqtt1.connected()) mqtt1.publish(TOPIC_TELEMETRY, payload.c_str());
    if (mqtt2.connected()) mqtt2.publish(TOPIC_TELEMETRY, payload.c_str());
  }
}