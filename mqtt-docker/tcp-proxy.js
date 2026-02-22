// Petit relais réseau: il reçoit le trafic externe et l'envoie au broker MQTT
const net = require('net');

// Railway donne un port automatiquement (ne pas forcer 1883)
const PROXY_PORT = process.env.PORT || 8080;
const MQTT_HOST = '127.0.0.1';
const MQTT_PORT = 1883;

console.log(`[TCP Proxy] Démarrage sur le port ${PROXY_PORT}`);
console.log(`[TCP Proxy] Redirige vers ${MQTT_HOST}:${MQTT_PORT}`);

// Sécurité: le port public doit être différent du port interne MQTT
if (parseInt(PROXY_PORT) === MQTT_PORT) {
  console.error(`[TCP Proxy] ERREUR: PORT=${PROXY_PORT} ne peut pas être identique au port Mosquitto (${MQTT_PORT})`);
  console.error(`[TCP Proxy] Vérifie les variables d'environnement Railway - PORT ne doit PAS être 1883`);
  process.exit(1);
}

const server = net.createServer((clientSocket) => {
  console.log(`[TCP Proxy] Connexion depuis ${clientSocket.remoteAddress}:${clientSocket.remotePort}`);
  
  const mqttSocket = net.createConnection({
    host: MQTT_HOST,
    port: MQTT_PORT
  }, () => {
    console.log(`[TCP Proxy] Connecté au broker MQTT`);
  });

  clientSocket.pipe(mqttSocket);
  mqttSocket.pipe(clientSocket);

  clientSocket.on('error', (err) => {
    console.error(`[TCP Proxy] Erreur client:`, err.message);
    mqttSocket.destroy();
  });

  mqttSocket.on('error', (err) => {
    console.error(`[TCP Proxy] Erreur MQTT:`, err.message);
    clientSocket.destroy();
  });

  clientSocket.on('close', () => mqttSocket.destroy());
  mqttSocket.on('close', () => clientSocket.destroy());
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`[TCP Proxy] ✓ Écoute sur 0.0.0.0:${PROXY_PORT}`);
});

server.on('error', (err) => {
  console.error(`[TCP Proxy] Erreur:`, err);
  process.exit(1);
});
