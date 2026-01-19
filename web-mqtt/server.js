// ================== IMPORTS ==================
const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mysql = require('mysql2');

// ================== CONFIG ==================
const MQTT_BROKER = 'mqtt://localhost:1883';
const TOPIC_TELEMETRY = 'tp/esp32/telemetry';
const TOPIC_CMD = 'tp/esp32/cmd';

// ================== MYSQL ==================
const db = mysql.createConnection({
  host: 'localhost',
  user: 'esp32',
  password: 'esp32',
  database: 'esp32'
});

db.connect(err => {
  if (err) console.error(err);
  else console.log('[MYSQL] Connecté');
});

// ================== EXPRESS ==================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// 🔽🔽🔽 ICI : HISTORIQUE 🔽🔽🔽
app.get('/api/mesures', (req, res) => {
  db.query(
    'SELECT * FROM mesures ORDER BY date_mesure DESC LIMIT 20',
    (err, results) => {
      if (err) {
        res.status(500).json({ error: err });
      } else {
        res.json(results);
      }
    }
  );
});

// ================== MQTT ==================
const client = mqtt.connect(MQTT_BROKER);

client.on('connect', () => {
  console.log('[MQTT] Connecté');
  client.subscribe(TOPIC_TELEMETRY);
});

client.on('message', (topic, message) => {
  if (topic === TOPIC_TELEMETRY) {
    const data = JSON.parse(message.toString());

    // Envoi temps réel au Web
    io.emit('telemetry', data);

    // Stockage BDD
    db.query(
      'INSERT INTO mesures (luminosite, humidite_sol, rssi) VALUES (?, ?, ?)',
      [data.luminosite, data.humidite_sol, data.rssi]
    );
  }
});

// ================== SOCKET ==================
io.on('connection', (socket) => {
  socket.on('cmd', (cmd) => {
    client.publish(TOPIC_CMD, cmd);
  });
});

// ================== SERVER ==================
server.listen(3000, () => {
  console.log('🌍 Dashboard http://localhost:3000');
});




