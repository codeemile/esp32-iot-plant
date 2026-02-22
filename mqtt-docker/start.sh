#!/bin/sh
# Démarre d'abord le broker MQTT, puis le proxy TCP
set -e

echo "[Start] Démarrage de Mosquitto..."
mosquitto -c /mosquitto/config/mosquitto.conf -d

echo "[Start] Attente démarrage Mosquitto..."
sleep 3

echo "[Start] Démarrage du proxy TCP sur port $PORT..."
exec node /app/tcp-proxy.js
