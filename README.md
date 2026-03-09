# 🌱 ESP32 IoT Plant Monitor

Système complet de surveillance et contrôle de plante connectée avec ESP32, MQTT, PostgreSQL, InfluxDB et interface web temps réel.

## Fonctionnalités

### Capteurs et Actuateurs
- **Luminosité** : Capteur BH1750 (0-65535 lux)
- **Humidité du sol** : Capteur capacitif (0-100%)
- **Signal WiFi** : RSSI en temps réel
- **Contrôles** : LED, Pompe d'arrosage, Ventilateur

### Interface Web
- Dashboard responsive (mobile/desktop)
- Visualisation en cercles colorés
- Graphiques historiques interactifs
- Indicateur de connexion et d'authentification JWT
- Panneau Parametres pour ajuster les seuils capteurs
- Grafana pour dashboards avancés (source InfluxDB préconfigurée)

### Backend
- MQTT broker (Mosquitto)
- PostgreSQL pour gestion d'un compte utilisateur unique
- InfluxDB pour données time-series
- API REST + WebSocket temps réel (authentification JWT 7 jours)
- Profil utilisateur sécurisé (édition/suppression avec mot de passe actuel)
- Paramètres persistés en PostgreSQL (tables relationnelles)

## Architecture

```
esp32-iot-plant/
├── esp32/                  # Code Arduino pour ESP32
│   └── esp32_plant.ino
├── MQTT-BDD/               # Configuration MQTT / bases
│   ├── mosquitto/
│   │   └── mosquitto.conf
│   └── postgres/
│       └── init.sql
└── WEB-APP/                # Application web Node.js
  ├── package.json
  ├── server.js           # API REST + WebSocket + MQTT bridge
  └── public/
    ├── index.html      # Structure HTML (sans styles inline)
    ├── style.css       # Styles globaux et panneau Parametres
    ├── front.js        # Manipulation visuelle (DOM/UI)
    └── script.js       # Logique API/WebSocket et metier
```

## Installation

### Prérequis
- Docker + Docker Compose
- Arduino IDE (pour ESP32)
- Capteurs : BH1750, capteur d'humidité du sol

### 1. Configuration de l'environnement

Le projet utilise **un seul fichier de configuration** : `.env` à la racine.

Copier le fichier d'exemple :

```bash
cp .env.example .env
```

Variables à renseigner dans `.env` :

```env
# PostgreSQL
POSTGRES_DB=iot_plant
POSTGRES_USER=iot_user
POSTGRES_PASSWORD=<mot-de-passe-fort>

# InfluxDB
INFLUX_USER=admin
INFLUX_PASSWORD=<mot-de-passe-fort>
INFLUX_ORG=iot_org
INFLUX_BUCKET=plant_data
INFLUX_TOKEN=<token-fort>
INFLUX_URL=http://influxdb:8086

# Grafana
GRAFANA_USER=admin
GRAFANA_PASSWORD=<mot-de-passe-fort>

# Sécurité API web
JWT_SECRET=<secret-long-et-aleatoire>
```

> Important : les identifiants d'initialisation InfluxDB/Grafana/PostgreSQL sont appliqués à la création initiale des volumes. Si les volumes existent déjà, changer `.env` ne remplace pas toujours automatiquement les comptes déjà créés.

### Déploiement serveur physique

Le projet peut etre deploye via Docker Compose sur un serveur Linux (systemd, cron ou CI/CD selon votre infra).

### 2. Lancer la stack Docker (recommandé)

Depuis la racine du projet :

```bash
docker compose up -d --build
```

Services démarrés :
- Web app : `http://localhost:3000`
- Grafana : `http://localhost:3001`
- InfluxDB : `http://localhost:8086`
- MQTT : `localhost:1883`

### 2.1 Configuration et usage par service

#### Web app (`web`)
- URL : `http://localhost:3000`
- Rôle : API REST, WebSocket, bridge MQTT, auth JWT.
- Variables utilisées : `POSTGRES_*`, `INFLUX_*`, `JWT_SECRET`.
- Santé : `GET /health`

#### PostgreSQL (`postgres-db`)
- Role : compte utilisateur unique + preferences + etats devices.
- Variables utilisées : `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`.
- Accès SQL (backdoor) :

```bash
docker compose exec postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

- Reinitialiser le compte unique en SQL (hash bcrypt via `pgcrypto`) :

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DELETE FROM users;
INSERT INTO users (username, email, password_hash)
VALUES ('admin', 'admin@mail.local', crypt('MonMotDePasseFort', gen_salt('bf', 10)));
```

#### InfluxDB (`influxdb`)
- URL : `http://localhost:8086`
- Rôle : stockage time-series télémétrie.
- Variables utilisées : `INFLUX_USER`, `INFLUX_PASSWORD`, `INFLUX_ORG`, `INFLUX_BUCKET`, `INFLUX_TOKEN`.
- Vérification rapide :

```bash
docker compose exec influxdb influx ping
```

#### Grafana (`grafana`)
- URL : `http://localhost:3001`
- Login admin : `GRAFANA_USER` / `GRAFANA_PASSWORD`.
- Datasource Influx provisionnée automatiquement (`InfluxDB-Plant`) via `MQTT-BDD/grafana/datasources`.

#### Mosquitto (`mqtt-broker`)
- Ports : `1883` (MQTT TCP), `9001` (WebSocket).
- Configuration : `MQTT-BDD/mosquitto/mosquitto.conf`.
- Mode actuel : `allow_anonymous true` (démo/dev).

#### Nginx reverse proxy (`reverse-proxy`)
- URL : `http://localhost:80`
- Configuration : `MQTT-BDD/nginx.conf`.
- Rôle : point d'entrée HTTP vers le service web.

### 2.2 Commandes utiles de gestion

```bash
# État des services
docker compose ps

# Logs d'un service
docker compose logs -f web
docker compose logs -f postgres

# Redémarrer un service
docker compose restart web

# Recharger après changement du .env (sans supprimer les volumes)
docker compose up -d --build

# Réinitialisation complète ( supprime les données)
docker compose down -v && docker compose up -d --build
```

### 3. (Optionnel) Lancer seulement le serveur web en local

Ce mode est utile pour du debug Node.js, pas pour un démarrage standard de la stack.

```bash
cd WEB-APP
npm install
npm start
```

### 4. Configuration ESP32

#### Installation des bibliothèques Arduino
- WiFi
- PubSubClient
- Wire
- BH1750
- Adafruit_BME280
- adafruit_sensor

#### Câblage
```
ESP32          BH1750
GPIO 22   -->  SDA
GPIO 21   -->  SCL
3.3V      -->  VCC
GND       -->  GND

ESP32          Capteur Sol
GPIO 34   -->  AOUT
3.3V      -->  VCC
GND       -->  GND

ESP32          BME280
GPIO 22   -->  SDA
GPIO 21   -->  SCL
3.3V      -->  VCC
GND       -->  GND

ESP32          Capteur de niveau d'eau
GPIO 35   -->  IN
GND       -->  OUT

ESP32          Actionneurs
GPIO 2    -->  LED
GPIO 14   -->  Ventilateur
GPIO 13   -->  Pompe
```

#### Configuration du code
Modifier dans [esp32/esp32_plant.ino](esp32/esp32_plant.ino) :

```cpp
// Broker MQTT
const char* MQTT_HOST = "<hote-mqtt>";
const int   MQTT_PORT = 1883;

// WiFi
const char* WIFI_SSID = "VotreSSID";
const char* WIFI_PASS = "VotreMotDePasse";
```

#### Upload du code
1. Sélectionner la carte : **ESP32 Dev Module**
2. Sélectionner le port COM
3. Téléverser

## Utilisation

### Interface Web
Accéder à : **http://localhost:3000**

- Cercles de capteurs en temps réel (couleurs selon seuils)
- Boutons LED / Arrosage / Ventilation (auth requise)
- Graphique : dernières 100 mesures (luminosité, humidité, température, pression)
- Panneau Parametres : seuils min/max éditables (auth requise)

### API REST

- Historique InfluxDB : `GET /api/history?limit=100`
- Statistiques 24h : `GET /api/stats`
- Paramètres capteurs : `GET/POST /api/settings` (JWT obligatoire)
- Defaults paramètres : `GET /api/settings/defaults`
- Profil utilisateur : `GET/PUT/DELETE /api/profile` (JWT obligatoire)
- Auth bootstrap : `GET /api/auth/bootstrap-status`, `POST /api/auth/bootstrap-register`
- Auth session : `POST /api/login`, `POST /api/logout`
- Santé serveur : `GET /health`

### Grafana
- URL : `http://localhost:3001`
- Identifiants : `GRAFANA_USER` / `GRAFANA_PASSWORD` (voir `.env`)
- Datasource : `InfluxDB-Plant` (provisionnée automatiquement)
- Créer un dashboard et utiliser Flux sur le bucket `plant_data`

## Seuils et Alertes

Seuils par défaut (éditables dans le panneau Parametres ou via `/api/settings`):

| Capteur | Optimal | Alerte |
|---------|---------|--------|
| Luminosité | 500-10000 lux | < 500 ou > 10000 |
| Humidité sol | 30-70% | < 30% |
| Température | 15-30 °C | < 15 ou > 30 |
| Pression | 990-1030 hPa | < 990 ou > 1030 |
| WiFi | > -70 dB | < -80 dB |

## Développement

### Structure des bases de données

#### PostgreSQL (Compte utilisateur unique)
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### InfluxDB (Données time-series)
```
Measurement: plant_telemetry
Fields: luminosite, humidite_sol, humidite_air, temperature, pressure, rssi, water_full, led_on, fan_on, pump_on
Timestamp: automatique
```

## Topics MQTT

| Topic | Direction | Format |
|-------|-----------|--------|
| `tp/esp32/telemetry` | ESP32 → Server | JSON |
| `tp/esp32/cmd` | Server → ESP32 | String |

### Exemple télémétrie
```json
{
  "luminosite": 1234.5,
  "humidite_sol": 45.2,
  "humidite_air": 55.1,
  "temperature": 23.4,
  "pressure": 1012.3,
  "water_full": true,
  "rssi": -65
}
```

### Commandes disponibles
- `LED_ON` / `LED_OFF`
- `FAN_ON` / `FAN_OFF`
- `PUMP_ON` / `PUMP_OFF`

## Dépannage

### ESP32 ne se connecte pas au WiFi
- Vérifier SSID et mot de passe
- Vérifier la portée WiFi
- Vérifier le moniteur série (115200 baud)

### Pas de connexion MQTT
- Vérifier que le broker est démarré : `docker compose ps`
- Vérifier l'adresse IP : `docker inspect mqtt-broker | grep IPAddress`
- Tester avec mosquitto_pub/sub

### Interface web ne reçoit pas de données
- Vérifier les logs : `docker compose logs -f web`
- Vérifier la console du navigateur (F12)
- Tester l'API : `curl http://localhost:3000/health`

### Bases de données ne fonctionnent pas
- Vérifier les credentials dans [.env](.env)
- Tester la connexion PostgreSQL / InfluxDB avec les outils clients
- InfluxDB UI : http://localhost:8086

## Sécurité

### Production
- JWT signé avec `JWT_SECRET` robuste
- Variables d'environnement pour credentials
- Healthchecks pour MQTT / PostgreSQL / InfluxDB
- Activer l'authentification MQTT (mosquitto.conf)
- Utiliser HTTPS et certificats valides
- Firewall pour les ports exposés

## Optimisations

### Backend
- PostgreSQL pour compte utilisateur unique
- InfluxDB pour stockage time-series optimisé
- Pas de cache mémoire (tout en base)
- Gestion d'erreurs robuste
- Logs structurés
- Arrêt propre avec flush InfluxDB (SIGTERM)

### Frontend
- Responsive design
- Reconnexion WebSocket automatique
- Indicateur de connexion
- Auth JWT (7 jours), panneau Parametres, graphiques Chart.js
- Accessibilité (ARIA, clavier)

## Auteurs
- Emile
- Enzo
- Julien