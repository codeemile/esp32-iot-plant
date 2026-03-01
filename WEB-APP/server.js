// === Serveur principal ===
// Ce serveur relie l'ESP32, l'interface web et les bases de données.
const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs').promises;
// const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

// Paramètres de base (peuvent être changés via les variables d'environnement)
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const SETTINGS_FILE = process.env.SETTINGS_FILE || './settings.json';

// PostgreSQL stocke les utilisateurs
// Si DATABASE_URL existe on l'utilise, sinon on lit les champs séparés
const pgPool = new Pool(
  process.env.DATABASE_URL ? 
  {
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    ssl: { rejectUnauthorized: false }
  }
  : 
  {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: process.env.POSTGRES_PORT || 5432,
    database: process.env.POSTGRES_DATABASE || 'iot_plant',
    user: process.env.POSTGRES_USER || 'iot_user',
    password: process.env.POSTGRES_PASSWORD || 'iot_password',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  }
);

// Évite l'arrêt du serveur si une connexion DB tombe
pgPool.on('error', (err, client) => {
  console.error('[PostgreSQL] Erreur inattendue:', err.message);
  // Le pool recrée les connexions automatiquement
});

// InfluxDB stocke les mesures capteurs (optionnel)
const influxURL = process.env.INFLUX_URL || 'http://localhost:8086';
const influxToken = process.env.INFLUX_TOKEN || 'mytoken123456';
const influxOrg = process.env.INFLUX_ORG || 'iot_org';
const influxBucket = process.env.INFLUX_BUCKET || 'plant_data';

let writeApi = null;
let queryApi = null;

// Vérifie que l'adresse InfluxDB est correcte avant initialisation
try {
  new URL(influxURL);
  const influxDB = new InfluxDB({ url: influxURL, token: influxToken });
  writeApi = influxDB.getWriteApi(influxOrg, influxBucket, 'ms');
  queryApi = influxDB.getQueryApi(influxOrg);
  console.log('[InfluxDB] Client initialisé');
} catch (error) {
  console.log('[InfluxDB] Désactivé - URL invalide ou pas configuré:', error.message);
}

const TOPIC_TELEMETRY = 'tp/esp32/telemetry';
const TOPIC_CMD = 'tp/esp32/cmd';
let lastTelemetrySent = 0;
const MIN_SEND_INTERVAL = 2000; // Envoi limité à un message toutes les 2 secondes

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static('public'));
app.use(express.json());

// Vérifie le token de connexion envoyé par le navigateur
function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Pas de token' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

// L'historique n'est pas gardé en mémoire, il est lu depuis InfluxDB

// Bloc email prêt mais désactivé
/*
const emailConfig = {
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
};

let transporter = null;
if (emailConfig.auth.user && emailConfig.auth.pass) {
  transporter = nodemailer.createTransport(emailConfig);
}

// Envoi d'alerte par email
async function sendAlertEmail(subject, message) {
  if (!transporter) {
    console.log('[EMAIL] Non configuré - alerte ignorée');
    return;
  }

  const mailOptions = {
    from: emailConfig.auth.user,
    to: process.env.EMAIL_TO || emailConfig.auth.user,
    subject: subject,
    text: message
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('[EMAIL] Alerte envoyée:', info.messageId);
  } catch (error) {
    console.error('[EMAIL] Erreur:', error.message);
  }
}
*/

// Vérifie les connexions aux bases au démarrage
async function initDatabases() {
  try {
    // Test simple PostgreSQL
    const pgClient = await pgPool.connect();
    console.log('[PostgreSQL] Connecté avec succès');
    pgClient.release();
  } catch (error) {
    console.error('[PostgreSQL] Erreur de connexion:', error.message);
    console.log('[PostgreSQL] Le serveur continue sans PostgreSQL');
  }

  // Test simple InfluxDB
  if (writeApi) {
    console.log('[InfluxDB] Connecté avec succès');
  } else {
    console.log('[InfluxDB] Non disponible');
  }
}

// Enregistre une mesure dans InfluxDB
function saveTelemetryToInflux(data) {
  if (!writeApi) return; // InfluxDB non actif
  
  try {
    const point = new Point('plant_telemetry')
      .floatField('luminosite', data.luminosite)
      .floatField('humidite_sol', data.humidite_sol)
      .floatField('humidite_air', data.humidite_air || 0)
      .floatField('temperature', data.temperature || 0)
      .floatField('pressure', data.pressure || 0)
      .intField('rssi', data.rssi)
      .intField('water_full', data.water_full ? 1 : 0)
      .timestamp(new Date());

    writeApi.writePoint(point);
  } catch (error) {
    console.error('[InfluxDB] Erreur sauvegarde:', error.message);
  }
}

// Connexion MQTT (messages ESP32)
const client = mqtt.connect(MQTT_BROKER, {
  reconnectPeriod: 5000,
  connectTimeout: 30000
});

const defaultSettings = {
  thresholds: {
    lux: { min: 500, max: 10000 },
    soil: { min: 30, max: 70 },
    air: { min: 30, max: 70 },
    temp: { min: 15, max: 30 },
    rssi: { min: -70, max: -50 }
  },
  indicators: {
    lux: true,
    soil: true,
    temp: true,
    pressure: true,
    rssi: true
  },
  automations: {
    led: false,
    hum: false,
    fan: false
  }
};

let currentSettings = { ...defaultSettings };

// Fusionne des paramètres entrants avec les valeurs par défaut,
// en conservant des types sûrs (nombres/booleans) pour éviter
// d'écrire des paramètres invalides dans le runtime.
function mergeSettings(defaults, incoming = {}) {
  const merged = { thresholds: {}, indicators: {}, automations: {} };

  for (const key of Object.keys(defaults.thresholds)) {
    const candidate = incoming.thresholds?.[key] || {};
    const minCandidate = Number(candidate.min);
    const maxCandidate = Number(candidate.max);
    const min = Number.isFinite(minCandidate) ? minCandidate : defaults.thresholds[key].min;
    const max = Number.isFinite(maxCandidate) ? maxCandidate : defaults.thresholds[key].max;
    merged.thresholds[key] = { min, max };
  }

  for (const key of Object.keys(defaults.indicators)) {
    const val = incoming.indicators?.[key];
    merged.indicators[key] = typeof val === 'boolean' ? val : defaults.indicators[key];
  }

  for (const key of Object.keys(defaults.automations)) {
    const val = incoming.automations?.[key];
    merged.automations[key] = typeof val === 'boolean' ? val : defaults.automations[key];
  }

  return merged;
}

// Charge les paramètres depuis le fichier JSON local.
// Si le fichier est absent/corrompu, on retombe sur la config par défaut.
async function loadSettingsFromFile() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    currentSettings = mergeSettings(defaultSettings, parsed);
    console.log('[SETTINGS] Paramètres chargés depuis le fichier');
  } catch (error) {
    currentSettings = { ...defaultSettings };
    console.log('[SETTINGS] Fichier absent ou invalide, utilisation des valeurs par défaut');
  }
}

// Sauvegarde la configuration courante sur disque pour persistance
// entre deux redémarrages du serveur.
async function saveSettingsToFile() {
  try {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(currentSettings, null, 2), 'utf8');
    console.log('[SETTINGS] Paramètres sauvegardés');
  } catch (error) {
    console.error('[SETTINGS] Erreur sauvegarde:', error.message);
  }
}

client.on('connect', () => {
  // Bloc de gestion de connexion MQTT : statut global + abonnement topic.
  console.log('[MQTT] Connecté au broker');
  io.emit('mqtt_status', { connected: true });
  client.subscribe(TOPIC_TELEMETRY, (err) => {
    if (err) {
      console.error('[MQTT] Erreur subscription:', err);
    } else {
      console.log('[MQTT] Abonné à:', TOPIC_TELEMETRY);
    }
  });
});

client.on('error', (error) => {
  // Bloc de gestion des erreurs MQTT : journalisation + statut client UI.
  console.error('[MQTT] Erreur:', error.message);
  io.emit('mqtt_status', { connected: false });
});

client.on('close', () => {
  // Bloc de gestion de fermeture MQTT : bascule l'état de connexion côté UI.
  console.log('[MQTT] Déconnecté du broker');
  io.emit('mqtt_status', { connected: false });
});

client.on('message', async (topic, message) => {
  // Bloc principal de traitement télémétrie MQTT : parse, normalisation,
  // throttling, persistance InfluxDB et diffusion temps réel via WebSocket.
  if (topic === TOPIC_TELEMETRY) {
    try {
      const data = JSON.parse(message.toString());
      
      // Limite d'envoi pour éviter de saturer les clients
      const now = Date.now();
      if (now - lastTelemetrySent < MIN_SEND_INTERVAL) {
        console.log('[MQTT] Throttled - attente avant envoi');
        return;
      }
      lastTelemetrySent = now;

      console.log('[MQTT] Données reçues:', data);

      // Ajoute l'heure de réception
      data.timestamp = new Date().toISOString();
      
      // Arrondit les valeurs pour l'affichage
      data.luminosite = Math.round(data.luminosite);
      data.humidite_sol = Math.round(data.humidite_sol);
      data.humidite_air = Math.round(data.humidite_air || 0);
      data.temperature = Math.round(data.temperature);
      data.pressure = Math.round(data.pressure);
      data.rssi = Math.round(data.rssi);

      // Sauvegarde en base
      saveTelemetryToInflux(data);

      // Envoi en temps réel à l'interface web
      io.emit('telemetry', data);
    } catch (error) {
      console.error('[MQTT] Erreur traitement message:', error.message);
    }
  }
});

// Canal temps réel navigateur <-> serveur
io.on('connection', (socket) => {
  // Session WebSocket d'un client navigateur : auth, commandes et lifecycle.
  console.log('[WebSocket] Client connecté:', socket.id);
  let authenticatedUser = null;

  // Informe le client si MQTT est connecté
  socket.emit('mqtt_status', { connected: client.connected });

  // Connexion sécurisée du client web
  socket.on('auth', async (token) => {
    // Authentifie la session socket avec le JWT fourni par le front.
    try {
      // Vérifie le token
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Vérifie que l'utilisateur existe encore et qu'il est actif
      const result = await pgPool.query(
        'SELECT id, username FROM users WHERE id = $1 AND is_active = true',
        [decoded.id]
      );
      
      if (result.rows.length > 0) {
        authenticatedUser = result.rows[0];
        socket.emit('auth_success', { username: authenticatedUser.username });
        console.log('[WebSocket] Authentifié:', authenticatedUser.username);
      } else {
        socket.emit('auth_error', { message: 'Utilisateur non trouvé ou inactif' });
      }
    } catch (error) {
      console.error('[WebSocket] Erreur auth:', error.message);
      socket.emit('auth_error', { message: 'Erreur serveur' });
    }
  });

  socket.on('cmd', (cmd) => {
    // Reçoit une commande utilisateur et la republie sur MQTT si autorisé.
    // Refuse les commandes si l'utilisateur n'est pas connecté
    if (!authenticatedUser) {
      socket.emit('cmd_ack', { cmd, status: 'error', message: 'Non authentifié' });
      return;
    }

    console.log('[CMD] Commande de', authenticatedUser.username + ':', cmd);
    if (client.connected) {
      client.publish(TOPIC_CMD, cmd);
      socket.emit('cmd_ack', { cmd, status: 'sent' });
    } else {
      socket.emit('cmd_ack', { cmd, status: 'error', message: 'MQTT non connecté' });
    }
  });

  socket.on('disconnect', () => {
    // Nettoyage/traçage à la déconnexion d'un client web.
    console.log('[WebSocket] Client déconnecté:', socket.id);
  });
});

// API HTTP

app.get('/api/settings', authenticateToken, (req, res) => {
  // Retourne la configuration active à un utilisateur authentifié.
  res.json(currentSettings);
});

app.post('/api/settings', authenticateToken, async (req, res) => {
  // Met à jour les paramètres depuis l'UI puis les persiste sur disque.
  currentSettings = mergeSettings(defaultSettings, req.body || {});
  await saveSettingsToFile();
  res.json({ message: 'Paramètres mis à jour', settings: currentSettings });
});

// Retourne l'historique des mesures
app.get('/api/history', async (req, res) => {
  // Construit et exécute une requête Flux pour renvoyer l'historique
  // des mesures sur les dernières 24h, limité par query param.
  if (!queryApi) {
    return res.json({ message: 'InfluxDB désactivé', data: [] });
  }

  try {
    const limit = parseInt(req.query.limit) || 100;
    const query = `
      from(bucket: "${influxBucket}")
        |> range(start: -24h)
        |> filter(fn: (r) => r._measurement == "plant_telemetry")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: true)
        |> limit(n: ${limit})
    `;

    const data = [];
    await queryApi.queryRows(query, {
      next(row, tableMeta) {
        const o = tableMeta.toObject(row);
        data.push({
          timestamp: o._time,
          luminosite: o.luminosite || 0,
          humidite_sol: o.humidite_sol || 0,
          humidite_air: o.humidite_air || 0,
          temperature: o.temperature || 0,
          pressure: o.pressure || 0,
          rssi: o.rssi || 0,
          led_on: o.led_on || false,
          fan_on: o.fan_on || false,
          humidifier_on: o.humidifier_on || false
        });
      },
      error(error) {
        console.error('[InfluxDB] Erreur query:', error);
        res.status(500).json({ error: 'Erreur récupération données' });
      },
      complete() {
        // Inverse l'ordre pour l'affichage du graphique
        res.json(data.reverse());
      }
    });
  } catch (error) {
    console.error('[API] Erreur historique:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Retourne les moyennes sur 24h
app.get('/api/stats', async (req, res) => {
  // Agrège des moyennes 24h par champ afin d'alimenter les stats globales.
  if (!queryApi) {
    return res.json({ message: 'InfluxDB désactivé', stats: {} });
  }

  try {
    const query = `
      from(bucket: "${influxBucket}")
        |> range(start: -24h)
        |> filter(fn: (r) => r._measurement == "plant_telemetry")
        |> group(columns: ["_field"])
        |> mean()
    `;

    const stats = {};
    await queryApi.queryRows(query, {
      next(row, tableMeta) {
        const o = tableMeta.toObject(row);
        stats[o._field] = o._value;
      },
      error(error) {
        console.error('[InfluxDB] Erreur stats:', error);
        res.status(500).json({ error: 'Erreur récupération stats' });
      },
      complete() {
        res.json({
          avg_lux: stats.luminosite || 0,
          avg_humidity_soil: stats.humidite_sol || 0,
          avg_humidity_air: stats.humidite_air || 0,
          avg_temperature: stats.temperature || 0,
          avg_pressure: stats.pressure || 0,
          avg_rssi: stats.rssi || 0
        });
      }
    });
  } catch (error) {
    console.error('[API] Erreur stats:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// API de connexion utilisateur

// Se connecter
app.post('/api/login', async (req, res) => {
  // Vérifie les identifiants utilisateur et émet un JWT signé (7 jours).
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username et password requis' });
    }

    const result = await pgPool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1 AND is_active = true',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    // Crée un token valable 7 jours
    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Mémorise la dernière connexion
    await pgPool.query(
      'UPDATE users SET last_login = NOW() WHERE id = $1',
      [user.id]
    );

    res.json({ token, username: user.username });
  } catch (error) {
    console.error('[AUTH] Erreur login:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Créer un compte (bloqué en production)
app.post('/api/register', async (req, res) => {
  // Crée un compte public uniquement hors production (mode dev).
  // En production, la création de compte public est désactivée
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Inscription désactivée en production' });
  }

  try {
    const { username, password, email } = req.body;

    if (!username || !password || !email) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit avoir au moins 6 caractères' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pgPool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username',
      [username, email, hashedPassword]
    );

    res.status(201).json({ message: 'Utilisateur créé', username: result.rows[0].username });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Username ou email déjà utilisé' });
    }
    console.error('[AUTH] Erreur register:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Se déconnecter
app.post('/api/logout', authenticateToken, async (req, res) => {
  // Invalide une session stockée en base (si table sessions utilisée).
  try {
    const token = req.headers['authorization'].split(' ')[1];
    await pgPool.query('DELETE FROM sessions WHERE token = $1', [token]);
    res.json({ message: 'Déconnecté' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Liste des utilisateurs
app.get('/api/users', async (req, res) => {
  // Liste les utilisateurs pour affichage/diagnostic côté front.
  try {
    const result = await pgPool.query('SELECT id, username, email, created_at, is_active FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('[API] Erreur users:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============= API ADMIN (protégée par token secret) =============

// Vérifie le token administrateur
function requireAdminToken(req, res, next) {
  // Middleware d'administration : contrôle strict du header x-admin-token.
  const adminToken = req.headers['x-admin-token'];
  const expectedToken = process.env.ADMIN_SECRET_TOKEN;

  if (!expectedToken) {
    return res.status(500).json({ error: 'Token admin non configuré sur le serveur' });
  }

  if (!adminToken || adminToken !== expectedToken) {
    return res.status(403).json({ error: 'Accès refusé - Token admin invalide' });
  }

  next();
}

// Admin : voir tous les utilisateurs
app.get('/api/admin/users', requireAdminToken, async (req, res) => {
  // Endpoint admin pour consulter tous les utilisateurs avec métadonnées.
  try {
    const result = await pgPool.query('SELECT id, username, email, created_at, last_login, is_active FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('[ADMIN] Erreur liste users:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Admin : créer un utilisateur
app.post('/api/admin/users', requireAdminToken, async (req, res) => {
  // Endpoint admin pour créer un utilisateur (hash bcrypt côté serveur).
  try {
    const { username, password, email } = req.body;

    if (!username || !password || !email) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit avoir au moins 6 caractères' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pgPool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, email, hashedPassword]
    );

    res.status(201).json({ message: 'Utilisateur créé', user: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Username ou email déjà utilisé' });
    }
    console.error('[ADMIN] Erreur création user:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Admin : supprimer un utilisateur
app.delete('/api/admin/users/:id', requireAdminToken, async (req, res) => {
  // Endpoint admin pour supprimer un utilisateur via son identifiant.
  try {
    const { id } = req.params;
    const result = await pgPool.query('DELETE FROM users WHERE id = $1 RETURNING username', [id]);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    res.json({ message: 'Utilisateur supprimé', username: result.rows[0].username });
  } catch (error) {
    console.error('[ADMIN] Erreur suppression user:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============= FIN API ADMIN =============

// Suppression utilisateur (bloquée en production)
app.delete('/api/users/:id', async (req, res) => {
  // Suppression "standard" désactivée en production pour sécurité.
  // En production, la suppression directe est désactivée
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Suppression désactivée en production' });
  }

  try {
    const { id } = req.params;
    await pgPool.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ message: 'Utilisateur supprimé' });
  } catch (error) {
    console.error('[API] Erreur suppression user:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/health', (req, res) => {
  // Sonde de santé pour Docker/monitoring (process + dépendances).
  res.json({
    status: 'ok',
    mqtt: client.connected,
    postgres: pgPool.totalCount > 0,
    influxdb: true,
    uptime: process.uptime()
  });
});

// Lancement du serveur
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Rend le service accessible depuis le réseau

async function startServer() {
  // Démarrage ordonné : paramètres -> bases -> écoute HTTP/WebSocket.
  await loadSettingsFromFile();
  await initDatabases();
  
  server.listen(PORT, HOST, () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🌿 ESP32 Plant Monitor Server');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🌐 Web interface: http://0.0.0.0:${PORT}`);
    console.log(`📊 API History: http://0.0.0.0:${PORT}/api/history`);
    console.log(`📊 API Stats: http://0.0.0.0:${PORT}/api/stats`);
    console.log(`👥 API Users: http://0.0.0.0:${PORT}/api/users`);
    console.log(`💚 Health: http://0.0.0.0:${PORT}/health`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  });
}

// Arrêt propre du serveur
process.on('SIGTERM', async () => {
  // Arrêt propre : flush InfluxDB, fermeture pool PG/MQTT/HTTP.
  console.log('[SERVER] Arrêt en cours...');
  
  // Vide le buffer InfluxDB avant arrêt
  try {
    await writeApi.close();
    console.log('[InfluxDB] Données flushées');
  } catch (e) {
    console.error('[InfluxDB] Erreur flush:', e);
  }
  
  // Ferme PostgreSQL
  await pgPool.end();
  
  // Ferme MQTT
  if (client) client.end();
  
  server.close(() => {
    console.log('[SERVER] Arrêté proprement');
    process.exit(0);
  });
});

startServer().catch(error => {
  console.error('[SERVER] Erreur fatale:', error);
  process.exit(1);
});




