# MQTT-BDD

Ce dossier contient les services d’infrastructure utilisés par le projet : MQTT, bases de données, proxy et monitoring.

## Contenu

- `mosquitto/` : configuration du broker MQTT (`1883`) + WebSocket MQTT (`9001`)
- `postgres/` : script d’initialisation SQL (`init.sql`)
- `grafana/` : configurations Grafana (datasource + dashboards)
- `nginx.conf` : reverse proxy HTTP vers le service web

## Services concernés (docker-compose)

- `mosquitto` → broker MQTT
- `postgres` → base relationnelle (compte utilisateur unique, préférences)
- `influxdb` → base time-series (télémétrie)
- `grafana` → visualisation InfluxDB
- `reverse-proxy` → entrée HTTP sur le port `80`

## Configuration

La configuration est centralisée dans le fichier `.env` à la racine du projet.

Variables principales utilisées par les services de ce dossier :

- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `INFLUX_USER`
- `INFLUX_PASSWORD`
- `INFLUX_ORG`
- `INFLUX_BUCKET`
- `INFLUX_TOKEN`
- `GRAFANA_USER`
- `GRAFANA_PASSWORD`

## Lancer l’infrastructure

Depuis la racine du projet :

```bash
docker compose up -d --build
```

Vérifier l’état :

```bash
docker compose ps
```

Logs utiles :

```bash
docker compose logs -f mosquitto
docker compose logs -f postgres
docker compose logs -f influxdb
docker compose logs -f grafana
docker compose logs -f reverse-proxy
```

## Ports

- MQTT TCP : `1883`
- MQTT WebSocket : `9001`
- InfluxDB : `8086`
- Grafana : `3001`
- Reverse proxy HTTP : `80`

## Notes importantes

- `mosquitto.conf` est actuellement en mode démo (`allow_anonymous true`).
- Le script `postgres/init.sql` n’est exécuté qu’à l’initialisation du volume PostgreSQL.
- Les identifiants Influx/Grafana sont surtout pris en compte lors de la première initialisation des volumes.
