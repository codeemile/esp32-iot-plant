// === Bibliothèques utilisées ===
// Elles servent à se connecter au WiFi/MQTT et à lire les capteurs.
#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <BH1750.h>
#include <Adafruit_BME280.h>
#include <adafruit_sensor.h>

// ================= RÉGLAGES MQTT. =================
// Adresse et port du serveur MQTT
const char *MQTT_HOST = "172.16.8.111";
const int MQTT_PORT = 1883;
// Identifiants MQTT (laisser vide si le broker accepte les connexions anonymes)
const char *MQTT_USER = ""; // Vide = pas d'identifiant
const char *MQTT_PASS = "";
// =================================================

// === Branchements des broches ===
#define I2C_SDA 22         // Fil SDA (communication capteurs I2C : luminosité et température/hygrométrie(humidité de l'air)/pression)
#define I2C_SCL 21         // Fil SCL (communication capteurs I2C : luminosité et température/hygrométrie(humidité de l'air)/pression)
#define SOIL_PIN 34        // Lecture humidité du sol
#define WATER_LEVEL_PIN 35 // Détection niveau d'eau (plein/vide)
#define LED_PIN 2          // Commande LED
#define FAN_PIN 14         // Commande ventilateur
#define POMPE_PIN 27       // Commande pompe

const char *WIFI_SSID = "CFAINSTA_STUDENTS";
const char *WIFI_PASS = "Cf@InSt@-$tUd3nT";
// Topics MQTT pour envoyer les mesures et recevoir les commandes
const char *TOPIC_TELEMETRY = "tp/esp32/telemetry";
const char *TOPIC_CMD = "tp/esp32/cmd";

// Initialisation communication MQTT
WiFiClient espClient;
PubSubClient mqtt(espClient);

// Initialisation des capteurs
BH1750 lightMeter;   // Capteur de luminosité en I2C
Adafruit_BME280 bme; // Capteur météo en I2C

// Permet de savoir si les capteurs sont bien détectés
bool bh1750_ok = false;
bool bme280_ok = false;

// État actuel des sorties
bool ledOn = false;
bool fanOn = false;
bool pumpOn = false;

unsigned long lastSend = 0;
unsigned long lastRetry = 0;
const int retryInterval = 5000; // Réessayer la connexion toutes les 5 secondes
const int sendInterval = 5000;  // Envoyer les mesures toutes les 5 secondes

// === Réception des commandes d'action ===
void Actions(char *topic, byte *payload, unsigned int length)
{
  String msg = "";
  for (unsigned int i = 0; i < length; i++)
    msg += (char)payload[i];

  // Pour allumer le relais, il faut que l'état soit LOW (c'est inversé)
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

// === Connexion au serveur MQTT avec tentative automatique. ===
void tryConnectMQTT()
{
  if (!mqtt.connected() && millis() - lastRetry > retryInterval)
  {
    lastRetry = millis();
    Serial.print("[MQTT] Connexion à ");
    Serial.print(MQTT_HOST);
    Serial.print(":");
    Serial.print(MQTT_PORT);
    Serial.print("... ");

    String clientId = "ESP32-" + String((uint32_t)ESP.getEfuseMac(), HEX);

    // Connexion avec identifiants ou sans identifiants
    bool connected = false;
    if (strlen(MQTT_USER) > 0)
    {
      connected = mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS);
    }
    else
    {
      connected = mqtt.connect(clientId.c_str());
    }

    if (connected)
    {
      mqtt.subscribe(TOPIC_CMD);
      Serial.println("OK ✓");
    }
    else
    {
      int code = mqtt.state();
      Serial.print("ÉCHEC (");
      Serial.print(code);
      Serial.print(") ");

      // Messages d'aide en cas d'échec
      switch (code)
      {
      case -4:
        Serial.println("TIMEOUT - Serveur ne répond pas");
        break;
      case -3:
        Serial.println("CONNEXION PERDUE");
        break;
      case -2:
        Serial.println("ÉCHEC RÉSEAU - Vérifier:");
        Serial.println("  1. Le hostname est-il résolvable? (ping)");
        Serial.println("  2. Le port est-il correct?");
        Serial.println("  3. Le port MQTT est-il bien ouvert et accessible?");
        break;
      case -1:
        Serial.println("DÉCONNECTÉ");
        break;
      case 1:
        Serial.println("PROTOCOLE MQTT INVALIDE");
        break;
      case 2:
        Serial.println("CLIENT_ID REJETÉ");
        break;
      case 3:
        Serial.println("SERVEUR INDISPONIBLE");
        break;
      case 4:
        Serial.println("AUTHENTIFICATION ÉCHOUÉE");
        break;
      case 5:
        Serial.println("NON AUTORISÉ");
        break;
      default:
        Serial.println("ERREUR INCONNUE");
      }
    }
  }
}

// === Démarrage de la carte ===
void setup()
{
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n\n=== ESP32 IoT Plant Monitor ===");

  // Initialisation des broches et de la communication I2C
  Wire.begin(I2C_SDA, I2C_SCL);
  pinMode(WATER_LEVEL_PIN, INPUT_PULLUP);
  // OUTPUT = action sur les relais (LED, ventilateur, pompe)
  pinMode(LED_PIN, OUTPUT);
  pinMode(FAN_PIN, OUTPUT);
  pinMode(POMPE_PIN, OUTPUT);

  Serial.print("[WiFi] Connexion à ");
  Serial.print(WIFI_SSID);
  Serial.print("... ");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED)
  {
    delay(500);
    Serial.print(".");
  }
  Serial.println(" OK");
  Serial.print("[WiFi] IP: ");
  Serial.println(WiFi.localIP());

  Serial.print("[MQTT] Configuration: ");
  Serial.print(MQTT_HOST);
  Serial.print(":");
  Serial.println(MQTT_PORT);

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(Actions);
  mqtt.setKeepAlive(60);
  mqtt.setSocketTimeout(15);

  // Démarrage du capteur de luminosité
  if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire))
  {
    bh1750_ok = true;
    Serial.println("BH1750 OK.");
  }
  else
  {
    Serial.println("Erreur : BH1750 introuvable. Vérifie le câblage.");
  }
  // Démarrage du capteur température / humidité / pression
  if (bme.begin(0x76) || bme.begin(0x77))
  {
    bme280_ok = true;
    Serial.println("BME280 OK.");
  }
  else
  {
    Serial.println("Erreur: BME280 introuvable en I2C (0x76/0x77). Vérifie câblage.");
  }

  Serial.println("\nPrêt !");
}

// === Boucle continue ===
void loop()
{
  // 1. Traiter rapidement les commandes reçues
  mqtt.loop();

  // 2. Reconnexion si la liaison est coupée
  tryConnectMQTT();

  // 3. Envoi périodique des capteurs
  unsigned long now = millis();
  if (now - lastSend >= sendInterval)
  {
    lastSend = now;

    // Lire les capteurs avec contrôle d'erreur
    // Lecture de la luminosité en lux (0-65535) - BH1750
    int lux = -1;
    if (bh1750_ok)
    {
      float luxFloat = lightMeter.readLightLevel();
      lux = (int)luxFloat;
    }

    // Lecture de l'humidité du sol (0-4095) et conversion en pourcentage (0-100%)
    int soilRaw = analogRead(SOIL_PIN);
    int soilPercent = map(soilRaw, 4095, 0, 0, 100);

    // Lecture de la température (°C), humidité de l'air (%) et pression (hPa) - BME280
    int temperature = -999;
    int humidity = -1;
    int pressurehPa = 0;
    if (bme280_ok)
    {
      temperature = (int)bme.readTemperature();
      humidity = (int)bme.readHumidity();
      int pressurePa = (int)bme.readPressure();
      pressurehPa = pressurePa / 100;
    }

    // Lecture du niveau d'eau (plein = LOW, vide = HIGH)
    bool waterLevel = (digitalRead(WATER_LEVEL_PIN) == LOW);

    // Envoi des données vers MQTT    
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

    // Envoi du message sur MQTT
    if (mqtt.connected())
      mqtt.publish(TOPIC_TELEMETRY, payload.c_str());
  }

  Serial.println("Données : " + String(payload));

  delay(50); // Petite pause pour garder le système fluide
}