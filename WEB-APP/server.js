// ============================================================================
// Main Backend Server
// ----------------------------------------------------------------------------
// Responsabilites:
// - bridge MQTT <-> WebSocket
// - APIs REST auth/profile/settings/history
// - persistence PostgreSQL (compte unique + settings)
// - persistence InfluxDB (telemetrie time-series)
// ============================================================================

// --- Imports -----------------------------------------------------------------
const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
// const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

// --- Environment & Core Config ----------------------------------------------
// Parametres de base (surchargables par variables d'environnement).
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// --- PostgreSQL Pool ---------------------------------------------------------
// PostgreSQL stocke un compte utilisateur unique
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

// --- InfluxDB Client ---------------------------------------------------------
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
let sharedDeviceStates = { led: false, pump: false, fan: false };

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

// --- Auth Helpers -------------------------------------------------------------
// Vérifie le token Bearer JWT envoyé par le client HTTP.
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

function normalizeUsername(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validateUsername(username) {
  return /^[a-zA-Z0-9_.-]{3,32}$/.test(username);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Retourne true si un compte existe deja (mode mono-user).
async function hasExistingUsers() {
  const result = await pgPool.query('SELECT 1 FROM users LIMIT 1');
  return result.rowCount > 0;
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

// --- Startup DB Checks -------------------------------------------------------
// Vérifie les connexions de base au démarrage.
async function initDatabases() {
  try {
    // Test simple PostgreSQL
    const pgClient = await pgPool.connect();
    console.log('[PostgreSQL] Connecté avec succès');
    pgClient.release();
    await ensureRelationalSettingsSchema();
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

// --- Telemetry Persistence ---------------------------------------------------
// Enregistre une mesure dans InfluxDB.
function saveTelemetryToInflux(data) {
  if (!writeApi) return; // InfluxDB non actif
  
  try {
    const ledOn = typeof data.led_on === 'boolean' ? data.led_on : false;
    const fanOn = typeof data.fan_on === 'boolean' ? data.fan_on : false;
    const pumpOn = typeof data.pump_on === 'boolean' ? data.pump_on : false;
    const point = new Point('plant_telemetry')
      .floatField('luminosite', data.luminosite)
      .floatField('humidite_sol', data.humidite_sol)
      .floatField('humidite_air', data.humidite_air || 0)
      .floatField('temperature', data.temperature || 0)
      .floatField('pressure', data.pressure || 0)
      .intField('rssi', data.rssi)
      .intField('water_full', data.water_full ? 1 : 0)
      .intField('led_on', ledOn ? 1 : 0)
      .intField('fan_on', fanOn ? 1 : 0)
      .intField('pump_on', pumpOn ? 1 : 0)
      .timestamp(new Date());

    writeApi.writePoint(point);
  } catch (error) {
    console.error('[InfluxDB] Erreur sauvegarde:', error.message);
  }
}

// --- MQTT Runtime ------------------------------------------------------------
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
    temp: { min: 15, max: 30 }
  },
  indicators: {
    lux: true,
    soil: true,
    air: true,
    temp: true,
    pressure: true
  },
  automations: {
    led: false,
    pump: false,
    fan: false
  },
  automationDurations: {
    led: 1800,
    pump: 20,
    fan: 180
  },
  alerts: {
    rules: {
      lux: { push: true, email: false, startDelaySec: 30, repeatIntervalSec: 300, mailDelayMin: 2, recoveryResetSec: 90 },
      soil: { push: true, email: false, startDelaySec: 30, repeatIntervalSec: 300, mailDelayMin: 2, recoveryResetSec: 90 },
      air: { push: true, email: false, startDelaySec: 30, repeatIntervalSec: 300, mailDelayMin: 2, recoveryResetSec: 90 },
      temp: { push: true, email: false, startDelaySec: 30, repeatIntervalSec: 300, mailDelayMin: 2, recoveryResetSec: 90 },
      rssi: { push: true, email: false, startDelaySec: 30, repeatIntervalSec: 300, mailDelayMin: 2, recoveryResetSec: 90 },
      water: { push: true, email: false, startDelaySec: 30, repeatIntervalSec: 300, mailDelayMin: 2, recoveryResetSec: 90 }
    }
  }
};

let currentSettings = { ...defaultSettings };

// --- Settings Normalization Layer -------------------------------------------
// Fusionne des paramètres entrants avec les valeurs par défaut,
// en conservant des types sûrs (nombres/booleans) pour éviter
// d'écrire des paramètres invalides dans le runtime.
function mergeSettings(defaults, incoming = {}) {
  const merged = { thresholds: {}, indicators: {}, automations: {}, automationDurations: {}, alerts: {} };
  const durationBounds = {
    led: { min: 10, max: 21600 },
    pump: { min: 5, max: 600 },
    fan: { min: 10, max: 3600 }
  };
  const notificationMetrics = ['lux', 'soil', 'air', 'temp', 'rssi', 'water'];

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

  for (const key of Object.keys(defaults.automationDurations)) {
    const val = Number(incoming.automationDurations?.[key]);
    if (!Number.isFinite(val) || val <= 0) {
      merged.automationDurations[key] = defaults.automationDurations[key];
      continue;
    }

    const bounds = durationBounds[key] || { min: 1, max: 86400 };
    merged.automationDurations[key] = Math.min(bounds.max, Math.max(bounds.min, Math.round(val)));
  }

  merged.alerts.rules = {};
  for (const metric of notificationMetrics) {
    const incomingRule = incoming.alerts?.rules?.[metric] || {};
    const legacyAlerts = incoming.alerts || {};
    const defaultRule = defaults.alerts.rules[metric];
    const startDelaySec = Number(incomingRule.startDelaySec);
    const repeatIntervalSec = Number(incomingRule.repeatIntervalSec);
    const mailDelayMin = Number(incomingRule.mailDelayMin);
    const legacyPushMailDeltaSec = Number(incomingRule.pushMailDeltaSec);
    const recoveryResetSec = Number(incomingRule.recoveryResetSec);

    merged.alerts.rules[metric] = {
      push: typeof incomingRule.push === 'boolean' ? incomingRule.push : (typeof legacyAlerts.push === 'boolean' ? legacyAlerts.push : defaultRule.push),
      email: typeof incomingRule.email === 'boolean' ? incomingRule.email : (typeof legacyAlerts.email === 'boolean' ? legacyAlerts.email : defaultRule.email),
      startDelaySec: Number.isFinite(startDelaySec) ? Math.min(3600, Math.max(0, Math.round(startDelaySec))) : defaultRule.startDelaySec,
      repeatIntervalSec: Number.isFinite(repeatIntervalSec) ? Math.min(21600, Math.max(30, Math.round(repeatIntervalSec))) : defaultRule.repeatIntervalSec,
      mailDelayMin: Number.isFinite(mailDelayMin) ? Math.min(1440, Math.max(0, Math.round(mailDelayMin))) : defaultRule.mailDelayMin,
      recoveryResetSec: Number.isFinite(recoveryResetSec) ? Math.min(3600, Math.max(10, Math.round(recoveryResetSec))) : defaultRule.recoveryResetSec
    };

    if (!Number.isFinite(startDelaySec) && Number.isFinite(Number(legacyAlerts.startDelaySec))) {
      merged.alerts.rules[metric].startDelaySec = Math.min(3600, Math.max(0, Math.round(Number(legacyAlerts.startDelaySec))));
    }
    if (!Number.isFinite(repeatIntervalSec) && Number.isFinite(Number(legacyAlerts.repeatIntervalSec))) {
      merged.alerts.rules[metric].repeatIntervalSec = Math.min(21600, Math.max(30, Math.round(Number(legacyAlerts.repeatIntervalSec))));
    }
    if (!Number.isFinite(mailDelayMin) && Number.isFinite(legacyPushMailDeltaSec)) {
      merged.alerts.rules[metric].mailDelayMin = Math.min(1440, Math.max(0, Math.round(legacyPushMailDeltaSec / 60)));
    }
    if (!Number.isFinite(mailDelayMin) && !Number.isFinite(legacyPushMailDeltaSec) && Number.isFinite(Number(legacyAlerts.mailDelayMin))) {
      merged.alerts.rules[metric].mailDelayMin = Math.min(1440, Math.max(0, Math.round(Number(legacyAlerts.mailDelayMin))));
    }
    if (!Number.isFinite(mailDelayMin) && !Number.isFinite(legacyPushMailDeltaSec) && !Number.isFinite(Number(legacyAlerts.mailDelayMin)) && Number.isFinite(Number(legacyAlerts.pushMailDeltaSec))) {
      merged.alerts.rules[metric].mailDelayMin = Math.min(1440, Math.max(0, Math.round(Number(legacyAlerts.pushMailDeltaSec) / 60)));
    }
    if (!Number.isFinite(recoveryResetSec) && Number.isFinite(Number(legacyAlerts.recoveryResetSec))) {
      merged.alerts.rules[metric].recoveryResetSec = Math.min(3600, Math.max(10, Math.round(Number(legacyAlerts.recoveryResetSec))));
    }
  }

  return merged;
}

// --- PostgreSQL Schema & CRUD (settings tables) -----------------------------
async function ensureRelationalSettingsSchema() {
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        is_active BOOLEAN DEFAULT true
      )
    `);

    // Index singleton: impose une seule ligne dans users.
    // Si une ancienne base contient deja plusieurs users, on loggue et on continue.
    try {
      await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_singleton_one_row_idx ON users ((1))');
    } catch (singletonError) {
      console.error('[PostgreSQL] Contrainte mono-user non appliquee (nettoyer les users en doublon):', singletonError.message);
    }

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS settings_thresholds (
        metric VARCHAR(16) PRIMARY KEY,
        min_value DOUBLE PRECISION NOT NULL,
        max_value DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS settings_automations (
        device VARCHAR(16) PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT false,
        duration_sec INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS settings_notifications (
        metric VARCHAR(16) PRIMARY KEY,
        push_enabled BOOLEAN NOT NULL DEFAULT true,
        email_enabled BOOLEAN NOT NULL DEFAULT false,
        start_delay_sec INTEGER NOT NULL,
        repeat_interval_sec INTEGER NOT NULL,
        mail_delay_min INTEGER NOT NULL,
        recovery_reset_sec INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const metric of ['lux', 'soil', 'air', 'temp']) {
      const t = defaultSettings.thresholds[metric];
      await pgPool.query(
        `INSERT INTO settings_thresholds (metric, min_value, max_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (metric) DO NOTHING`,
        [metric, t.min, t.max]
      );
    }

    for (const device of ['led', 'pump', 'fan']) {
      await pgPool.query(
        `INSERT INTO settings_automations (device, enabled, duration_sec)
         VALUES ($1, $2, $3)
         ON CONFLICT (device) DO NOTHING`,
        [device, defaultSettings.automations[device], defaultSettings.automationDurations[device]]
      );
    }

    for (const metric of ['lux', 'soil', 'air', 'temp', 'rssi', 'water']) {
      const r = defaultSettings.alerts.rules[metric];
      await pgPool.query(
        `INSERT INTO settings_notifications (
          metric, push_enabled, email_enabled, start_delay_sec, repeat_interval_sec, mail_delay_min, recovery_reset_sec
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (metric) DO NOTHING`,
        [metric, r.push, r.email, r.startDelaySec, r.repeatIntervalSec, r.mailDelayMin, r.recoveryResetSec]
      );
    }

    console.log('[PostgreSQL] Tables de paramètres relationnels prêtes');
  } catch (error) {
    console.error('[PostgreSQL] Impossible de préparer le schéma de paramètres:', error.message);
  }
}

// Lit les settings effectifs en combinant defaults + base relationnelle.
async function getSettingsForUser(_userId) {
  const [thresholdResult, automationResult, notificationResult] = await Promise.all([
    pgPool.query('SELECT metric, min_value, max_value FROM settings_thresholds'),
    pgPool.query('SELECT device, enabled, duration_sec FROM settings_automations'),
    pgPool.query('SELECT metric, push_enabled, email_enabled, start_delay_sec, repeat_interval_sec, mail_delay_min, recovery_reset_sec FROM settings_notifications')
  ]);

  const incoming = {
    thresholds: {},
    indicators: { ...defaultSettings.indicators },
    automations: {},
    automationDurations: {},
    alerts: { rules: {} }
  };

  for (const metric of ['lux', 'soil', 'air', 'temp']) {
    incoming.thresholds[metric] = { ...defaultSettings.thresholds[metric] };
  }

  for (const device of ['led', 'pump', 'fan']) {
    incoming.automations[device] = defaultSettings.automations[device];
    incoming.automationDurations[device] = defaultSettings.automationDurations[device];
  }

  for (const metric of ['lux', 'soil', 'air', 'temp', 'rssi', 'water']) {
    incoming.alerts.rules[metric] = { ...defaultSettings.alerts.rules[metric] };
  }

  for (const row of thresholdResult.rows) {
    if (!Object.prototype.hasOwnProperty.call(incoming.thresholds, row.metric)) continue;
    incoming.thresholds[row.metric] = {
      min: Number(row.min_value),
      max: Number(row.max_value)
    };
  }

  for (const row of automationResult.rows) {
    if (!Object.prototype.hasOwnProperty.call(incoming.automations, row.device)) continue;
    incoming.automations[row.device] = Boolean(row.enabled);
    incoming.automationDurations[row.device] = Number(row.duration_sec);
  }

  for (const row of notificationResult.rows) {
    if (!Object.prototype.hasOwnProperty.call(incoming.alerts.rules, row.metric)) continue;
    incoming.alerts.rules[row.metric] = {
      push: Boolean(row.push_enabled),
      email: Boolean(row.email_enabled),
      startDelaySec: Number(row.start_delay_sec),
      repeatIntervalSec: Number(row.repeat_interval_sec),
      mailDelayMin: Number(row.mail_delay_min),
      recoveryResetSec: Number(row.recovery_reset_sec)
    };
  }

  // Les cloches du tab Seuils suivent les règles push des métriques communes.
  for (const metric of ['lux', 'soil', 'air', 'temp']) {
    incoming.indicators[metric] = Boolean(incoming.alerts.rules[metric]?.push);
  }

  return mergeSettings(defaultSettings, incoming);
}

// Ecrit les settings normalises dans les tables relationnelles.
async function upsertSettingsForUser(_userId, incomingSettings) {
  const merged = mergeSettings(defaultSettings, incomingSettings || {});

  await pgPool.query('BEGIN');
  try {
    for (const metric of ['lux', 'soil', 'air', 'temp']) {
      await pgPool.query(
        `INSERT INTO settings_thresholds (metric, min_value, max_value, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (metric) DO UPDATE SET
           min_value = EXCLUDED.min_value,
           max_value = EXCLUDED.max_value,
           updated_at = CURRENT_TIMESTAMP`,
        [metric, merged.thresholds[metric].min, merged.thresholds[metric].max]
      );
    }

    for (const device of ['led', 'pump', 'fan']) {
      await pgPool.query(
        `INSERT INTO settings_automations (device, enabled, duration_sec, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (device) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           duration_sec = EXCLUDED.duration_sec,
           updated_at = CURRENT_TIMESTAMP`,
        [device, merged.automations[device], merged.automationDurations[device]]
      );
    }

    for (const metric of ['lux', 'soil', 'air', 'temp', 'rssi', 'water']) {
      const rule = merged.alerts.rules[metric];
      await pgPool.query(
        `INSERT INTO settings_notifications (
          metric, push_enabled, email_enabled, start_delay_sec, repeat_interval_sec, mail_delay_min, recovery_reset_sec, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        ON CONFLICT (metric) DO UPDATE SET
          push_enabled = EXCLUDED.push_enabled,
          email_enabled = EXCLUDED.email_enabled,
          start_delay_sec = EXCLUDED.start_delay_sec,
          repeat_interval_sec = EXCLUDED.repeat_interval_sec,
          mail_delay_min = EXCLUDED.mail_delay_min,
          recovery_reset_sec = EXCLUDED.recovery_reset_sec,
          updated_at = CURRENT_TIMESTAMP`,
        [metric, rule.push, rule.email, rule.startDelaySec, rule.repeatIntervalSec, rule.mailDelayMin, rule.recoveryResetSec]
      );
    }

    await pgPool.query('COMMIT');
    return merged;
  } catch (error) {
    await pgPool.query('ROLLBACK');
    throw error;
  }
}

// --- MQTT Event Handlers -----------------------------------------------------
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

      if (typeof data.led_on === 'boolean') {
        sharedDeviceStates.led = data.led_on;
      }
      if (typeof data.pump_on === 'boolean') {
        sharedDeviceStates.pump = data.pump_on;
      }
      if (typeof data.fan_on === 'boolean') {
        sharedDeviceStates.fan = data.fan_on;
      }

      // Sauvegarde en base
      saveTelemetryToInflux(data);

      // Envoi en temps réel à l'interface web
      io.emit('telemetry', data);
      io.emit('device_state', sharedDeviceStates);
    } catch (error) {
      console.error('[MQTT] Erreur traitement message:', error.message);
    }
  }
});

// --- WebSocket Gateway -------------------------------------------------------
// Canal temps réel navigateur <-> serveur
io.on('connection', (socket) => {
  // Session WebSocket d'un client navigateur : auth, commandes et lifecycle.
  console.log('[WebSocket] Client connecté:', socket.id);
  let authenticatedUser = null;

  // Informe le client si MQTT est connecté
  socket.emit('mqtt_status', { connected: client.connected });
  socket.emit('device_state', sharedDeviceStates);

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

      if (cmd === 'LED_ON') sharedDeviceStates.led = true;
      if (cmd === 'LED_OFF') sharedDeviceStates.led = false;
      if (cmd === 'PUMP_ON') sharedDeviceStates.pump = true;
      if (cmd === 'PUMP_OFF') sharedDeviceStates.pump = false;
      if (cmd === 'FAN_ON') sharedDeviceStates.fan = true;
      if (cmd === 'FAN_OFF') sharedDeviceStates.fan = false;

      io.emit('device_state', sharedDeviceStates);
    } else {
      socket.emit('cmd_ack', { cmd, status: 'error', message: 'MQTT non connecté' });
    }
  });

  socket.on('disconnect', () => {
    // Nettoyage/traçage à la déconnexion d'un client web.
    console.log('[WebSocket] Client déconnecté:', socket.id);
  });
});

// --- HTTP API ----------------------------------------------------------------
// Endpoints REST exposes au front.

app.get('/api/settings', authenticateToken, async (req, res) => {
  // Retourne la configuration active à un utilisateur authentifié.
  try {
    currentSettings = await getSettingsForUser(req.user.id);
    res.json(currentSettings);
  } catch (error) {
    console.error('[SETTINGS] Lecture tables settings_* échouée:', error.message);
    res.status(503).json({ error: 'Base de données indisponible pour charger les paramètres' });
  }
});

app.get('/api/settings/defaults', (req, res) => {
  // Front server-first: expose une copie des valeurs par defaut backend.
  try {
    return res.json(JSON.parse(JSON.stringify(defaultSettings)));
  } catch (error) {
    console.error('[SETTINGS] Erreur export defaults:', error.message);
    return res.status(500).json({ error: 'Impossible de charger les defaults serveur' });
  }
});

app.post('/api/settings', authenticateToken, async (req, res) => {
  // Met à jour les paramètres utilisateur puis les persiste en base.
  try {
    currentSettings = await upsertSettingsForUser(req.user.id, req.body || {});
    io.emit('settings_updated', currentSettings);
    res.json({ message: 'Paramètres mis à jour', settings: currentSettings });
  } catch (error) {
    console.error('[SETTINGS] Écriture tables settings_* échouée:', error.message);
    res.status(503).json({ error: 'Base de données indisponible pour sauvegarder les paramètres' });
  }
});

// Retourne l'historique des mesures
app.get('/api/history', async (req, res) => {
  // Construit et exécute une requête Flux pour renvoyer l'historique
  // des mesures sur les dernières 24h, limité par query param.
  if (!queryApi) {
    return res.json([]);
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
          pump_on: Boolean(o.pump_on)
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

app.get('/api/auth/bootstrap-status', async (req, res) => {
  try {
    const hasUser = await hasExistingUsers();
    res.json({ mode: hasUser ? 'login' : 'bootstrap' });
  } catch (error) {
    console.error('[AUTH] Erreur bootstrap-status:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Creation atomique du compte initial (verrou table users).
app.post('/api/auth/bootstrap-register', async (req, res) => {
  try {
    await pgPool.query('BEGIN');
    await pgPool.query('LOCK TABLE users IN EXCLUSIVE MODE');

    const exists = await hasExistingUsers();
    if (exists) {
      await pgPool.query('ROLLBACK');
      return res.status(403).json({ error: 'Compte initial déjà créé' });
    }

    const username = normalizeUsername(req.body?.username);
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const passwordConfirm = req.body?.passwordConfirm;

    if (!username || !email || !password || !passwordConfirm) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }

    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'Nom utilisateur invalide (3-32, lettres/chiffres/._-)' });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Email invalide' });
    }

    if (password !== passwordConfirm) {
      return res.status(400).json({ error: 'Les mots de passe ne correspondent pas' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const insert = await pgPool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username',
      [username, email, hashedPassword]
    );

    const user = insert.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    await pgPool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    await pgPool.query('COMMIT');

    return res.status(201).json({ token, username: user.username });
  } catch (error) {
    try { await pgPool.query('ROLLBACK'); } catch (_) {}
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Username ou email déjà utilisé' });
    }
    console.error('[AUTH] Erreur bootstrap-register:', error.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

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
    await pgPool.query('BEGIN');
    await pgPool.query('LOCK TABLE users IN EXCLUSIVE MODE');

    const exists = await hasExistingUsers();
    if (exists) {
      await pgPool.query('ROLLBACK');
      return res.status(403).json({ error: 'Inscription publique désactivée après création du premier compte' });
    }

    const username = normalizeUsername(req.body?.username);
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;

    if (!username || !password || !email) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }

    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'Nom utilisateur invalide (3-32, lettres/chiffres/._-)' });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Email invalide' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const result = await pgPool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username',
      [username, email, hashedPassword]
    );

    await pgPool.query('COMMIT');

    res.status(201).json({ message: 'Utilisateur créé', username: result.rows[0].username });
  } catch (error) {
    try { await pgPool.query('ROLLBACK'); } catch (_) {}
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Username ou email déjà utilisé' });
    }
    console.error('[AUTH] Erreur register:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Se déconnecter
app.post('/api/logout', authenticateToken, async (req, res) => {
  // JWT stateless: côté serveur, rien à invalider en base.
  res.json({ message: 'Déconnecté' });
});

app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const userResult = await pgPool.query(
      'SELECT id, username, email, created_at, updated_at, last_login FROM users WHERE id = $1 AND is_active = true',
      [req.user.id]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'Utilisateur introuvable' });
    }

    const settingsTsResult = await pgPool.query(`
      SELECT MAX(updated_at) AS ts FROM (
        SELECT updated_at FROM settings_thresholds
        UNION ALL
        SELECT updated_at FROM settings_automations
        UNION ALL
        SELECT updated_at FROM settings_notifications
      ) s
    `);

    const user = userResult.rows[0];
    res.json({
      username: user.username,
      email: user.email,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      lastLogin: user.last_login,
      settingsUpdatedAt: settingsTsResult.rows[0]?.ts || null
    });
  } catch (error) {
    console.error('[PROFILE] Erreur lecture profil:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.put('/api/profile', authenticateToken, async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const email = normalizeEmail(req.body?.email);
    const currentPassword = req.body?.currentPassword;
    const newPassword = req.body?.newPassword;
    const newPasswordConfirm = req.body?.newPasswordConfirm;

    if (!username || !email || !currentPassword) {
      return res.status(400).json({ error: 'Nom, email et mot de passe actuel requis' });
    }

    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'Nom utilisateur invalide (3-32, lettres/chiffres/._-)' });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Email invalide' });
    }

    if (newPassword || newPasswordConfirm) {
      if (!newPassword || !newPasswordConfirm) {
        return res.status(400).json({ error: 'Nouveau mot de passe incomplet' });
      }
      if (newPassword !== newPasswordConfirm) {
        return res.status(400).json({ error: 'Les nouveaux mots de passe ne correspondent pas' });
      }
    }

    const userResult = await pgPool.query(
      'SELECT id, username, password_hash FROM users WHERE id = $1 AND is_active = true',
      [req.user.id]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'Utilisateur introuvable' });
    }

    const user = userResult.rows[0];
    const validCurrentPassword = await bcrypt.compare(currentPassword, user.password_hash);
    if (!validCurrentPassword) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    }

    const nextPasswordHash = newPassword ? await bcrypt.hash(newPassword, 12) : user.password_hash;

    await pgPool.query(
      'UPDATE users SET username = $1, email = $2, password_hash = $3 WHERE id = $4',
      [username, email, nextPasswordHash, user.id]
    );

    const freshProfile = await pgPool.query(
      'SELECT username, email, created_at, updated_at, last_login FROM users WHERE id = $1',
      [user.id]
    );

    const settingsTsResult = await pgPool.query(`
      SELECT MAX(updated_at) AS ts FROM (
        SELECT updated_at FROM settings_thresholds
        UNION ALL
        SELECT updated_at FROM settings_automations
        UNION ALL
        SELECT updated_at FROM settings_notifications
      ) s
    `);

    const refreshed = freshProfile.rows[0];
    const token = jwt.sign({ id: user.id, username: refreshed.username }, JWT_SECRET, { expiresIn: '7d' });

    return res.json({
      token,
      username: refreshed.username,
      email: refreshed.email,
      createdAt: refreshed.created_at,
      updatedAt: refreshed.updated_at,
      lastLogin: refreshed.last_login,
      settingsUpdatedAt: settingsTsResult.rows[0]?.ts || null
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Username ou email déjà utilisé' });
    }
    console.error('[PROFILE] Erreur update profil:', error.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/profile', authenticateToken, async (req, res) => {
  try {
    const currentPassword = req.body?.currentPassword;
    if (!currentPassword) {
      return res.status(400).json({ error: 'Mot de passe actuel requis' });
    }

    const userResult = await pgPool.query(
      'SELECT id, username, password_hash FROM users WHERE id = $1 AND is_active = true',
      [req.user.id]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: 'Utilisateur introuvable' });
    }

    const user = userResult.rows[0];
    const validCurrentPassword = await bcrypt.compare(currentPassword, user.password_hash);
    if (!validCurrentPassword) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    }

    await pgPool.query('DELETE FROM users WHERE id = $1', [user.id]);
    return res.json({ message: 'Compte supprimé' });
  } catch (error) {
    console.error('[PROFILE] Erreur suppression profil:', error.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/health', (req, res) => {
  // Sonde de santé pour Docker/monitoring (process + dépendances).
  res.json({
    status: 'ok',
    mqtt: client.connected,
    postgres: pgPool.totalCount > 0,
    influxdb: Boolean(queryApi),
    uptime: process.uptime()
  });
});

// --- Process Lifecycle -------------------------------------------------------
// Lancement du serveur
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Rend le service accessible depuis le réseau

async function startServer() {
  // Démarrage ordonné : paramètres -> bases -> écoute HTTP/WebSocket.
  currentSettings = mergeSettings(defaultSettings, {});
  await initDatabases();
  
  server.listen(PORT, HOST, () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🌿 ESP32 Plant Monitor Server');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🌐 Web interface: http://0.0.0.0:${PORT}`);
    console.log(`📊 API History: http://0.0.0.0:${PORT}/api/history`);
    console.log(`📊 API Stats: http://0.0.0.0:${PORT}/api/stats`);
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




