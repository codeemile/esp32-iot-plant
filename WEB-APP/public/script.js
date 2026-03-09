// ============================================================================
// Front Logic Layer
// ----------------------------------------------------------------------------
// Ce fichier contient la logique metier front:
// - auth (bootstrap/login/logout)
// - orchestration API et WebSocket
// - gestion settings/automations/notifications
// - rendu et interactions du graphique
// Les manipulations purement visuelles vivent dans front.js.
// ============================================================================

// --- Core Runtime State ------------------------------------------------------
// Socket principal avec reconnexion auto; autoConnect false pour attendre init.
const socket = io({ reconnection: true, reconnectionDelay: 1000, autoConnect: false });
const RSSI_FIXED_RANGE = { min: -90, max: -30 };
const RSSI_ALERT_THRESHOLD = -85;
const NOTIFICATION_METRICS = ['lux', 'soil', 'air', 'temp', 'rssi', 'water'];
const LINKED_THRESHOLD_METRICS = ['lux', 'soil', 'air', 'temp'];
const NOTIFICATION_RULE_DEFAULTS = {
  push: true,
  email: false,
  startDelaySec: 30,
  repeatIntervalSec: 300,
  mailDelayMin: 2,
  recoveryResetSec: 90
};
let chart = null;
let states = { led: false, pump: false, fan: false };
let automationStates = { led: false, pump: false, fan: false };
let token = localStorage.getItem('auth_token');
let currentUsername = localStorage.getItem('username');
let isAuthenticated = false;
let authMode = 'login';
let chartData = null;
let latestTelemetry = null;
let defaultSettings = null;
let settingsCache = null;
const automationTimerState = {
  led: { timeoutId: null, activeUntil: 0, lastTriggerAt: 0 },
  pump: { timeoutId: null, activeUntil: 0, lastTriggerAt: 0 },
  fan: { timeoutId: null, activeUntil: 0, lastTriggerAt: 0 }
};
const deviceConfig = {
  led: { btnId: 'led-btn', autoId: 'led-auto', cmd: 'LED' },
  pump: { btnId: 'pump-btn', autoId: 'pump-auto', cmd: 'PUMP' },
  fan: { btnId: 'fan-btn', autoId: 'fan-auto', cmd: 'FAN' }
};
const BASE_SCALE = 1000; // Valeur de zoom par défaut au chargement
let maxScale = BASE_SCALE;
const ZOOM_MULTIPLIER = 1.2; // Zoom de 20% à chaque action
const LOGIN_COLLAPSED_CLASS = 'is-collapsed';
let deferredInstallPrompt = null;
let installPromptTriggered = false;
let swRegistrationRef = null;
let pushPermissionAsked = false;
const alertRuntimeState = new Map();

// --- Generic Helpers ---------------------------------------------------------
// Clone profond JSON pour isoler defaults/settings mutables.
function cloneSettings(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureSettingsReady() {
  return Boolean(defaultSettings && settingsCache);
}

// Charge la source de verite des defaults depuis le backend.
async function loadServerSettingsDefaults() {
  const response = await fetch('/api/settings/defaults');
  if (!response.ok) {
    throw new Error('Impossible de charger les parametres par defaut serveur');
  }

  const payload = await response.json();
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload defaults invalide');
  }

  defaultSettings = cloneSettings(payload);
  settingsCache = cloneSettings(payload);
}

const ALERT_POLICY_BOUNDS = {
  startDelaySec: { min: 0, max: 3600 },
  repeatIntervalSec: { min: 30, max: 21600 },
  mailDelayMin: { min: 0, max: 1440 },
  recoveryResetSec: { min: 10, max: 3600 }
};

// --- PWA & Browser Capabilities ---------------------------------------------
// Attache des interactions utilisateur natives (clic/touche)
// pour déclencher l'installation PWA au bon moment navigateur.
function attachNativeInstallPrompt() {
  const triggerPrompt = async () => {
    if (!deferredInstallPrompt || installPromptTriggered) return;
    installPromptTriggered = true;

    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;

    try {
      promptEvent.prompt();
      await promptEvent.userChoice;
    } catch (_) {
      // Sur certains navigateurs, cette fenêtre peut être annulée
    }
  };

  window.addEventListener('pointerdown', triggerPrompt, { once: true, capture: true });
  window.addEventListener('keydown', triggerPrompt, { once: true, capture: true });
}

// Demande l'autorisation navigateur pour les notifications push locales.
async function ensurePushPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  if (pushPermissionAsked) return false;

  pushPermissionAsked = true;
  try {
    const permission = await Notification.requestPermission();
    return permission === 'granted';
  } catch (_) {
    return false;
  }
}

// --- Alert Engine (Push/Email policy runtime) -------------------------------
function getTelemetryPushAlerts(data) {
  if (!ensureSettingsReady()) return [];
  const alerts = [];
  const thresholds = settingsCache.thresholds;
  const rules = settingsCache.alerts?.rules || {};

  const lux = Number(data.luminosite);
  if (rules.lux?.push || rules.lux?.email) {
    if (Number.isFinite(lux) && lux < thresholds.lux.min) {
      alerts.push({ key: 'lux', title: 'Alerte luminosite basse', body: `Luminosite: ${Math.round(lux)} lux (min ${thresholds.lux.min})` });
    } else if (Number.isFinite(lux) && lux > thresholds.lux.max) {
      alerts.push({ key: 'lux', title: 'Alerte luminosite haute', body: `Luminosite: ${Math.round(lux)} lux (max ${thresholds.lux.max})` });
    }
  }

  const soil = Number(data.humidite_sol);
  if ((rules.soil?.push || rules.soil?.email) && Number.isFinite(soil) && soil < thresholds.soil.min) {
    alerts.push({ key: 'soil', title: 'Alerte humidite sol', body: `Humidite sol: ${Math.round(soil)}% (min ${thresholds.soil.min}%)` });
  }

  const air = Number(data.humidite_air);
  if (rules.air?.push || rules.air?.email) {
    if (Number.isFinite(air) && air < thresholds.air.min) {
      alerts.push({ key: 'air', title: 'Alerte humidite air basse', body: `Humidite air: ${Math.round(air)}% (min ${thresholds.air.min}%)` });
    } else if (Number.isFinite(air) && air > thresholds.air.max) {
      alerts.push({ key: 'air', title: 'Alerte humidite air haute', body: `Humidite air: ${Math.round(air)}% (max ${thresholds.air.max}%)` });
    }
  }

  const temp = Number(data.temperature);
  if (rules.temp?.push || rules.temp?.email) {
    if (Number.isFinite(temp) && temp < thresholds.temp.min) {
      alerts.push({ key: 'temp', title: 'Alerte temperature basse', body: `Temperature: ${Math.round(temp)} C (min ${thresholds.temp.min} C)` });
    } else if (Number.isFinite(temp) && temp > thresholds.temp.max) {
      alerts.push({ key: 'temp', title: 'Alerte temperature haute', body: `Temperature: ${Math.round(temp)} C (max ${thresholds.temp.max} C)` });
    }
  }

  const rssi = Number(data.rssi);
  if ((rules.rssi?.push || rules.rssi?.email) && Number.isFinite(rssi) && rssi <= RSSI_ALERT_THRESHOLD) {
    alerts.push({ key: 'rssi', title: 'Alerte signal WiFi', body: `Signal faible: ${Math.round(rssi)} dB (seuil ${RSSI_ALERT_THRESHOLD} dB)` });
  }

  if ((rules.water?.push || rules.water?.email) && data.water_full === false) {
    alerts.push({ key: 'water', title: 'Alerte reservoir', body: 'Reservoir d eau vide - verifier le niveau.' });
  }

  return alerts;
}

async function pushNotify(title, body, tag) {
  const permissionOk = await ensurePushPermission();
  if (!permissionOk) return;

  const options = {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag,
    renotify: true,
    data: { url: '/' }
  };

  try {
    if (swRegistrationRef) {
      await swRegistrationRef.showNotification(title, options);
      return;
    }
  } catch (_) {
    // Fallback ci-dessous
  }

  try {
    new Notification(title, options);
  } catch (_) {
    // navigateur non compatible, on ignore silencieusement
  }
}

function maybeSendPushAlerts(data) {
  if (!ensureSettingsReady()) return;
  const hasEnabledChannel = NOTIFICATION_METRICS.some((metric) => {
    const rule = settingsCache.alerts?.rules?.[metric];
    return Boolean(rule?.push || rule?.email);
  });
  if (!hasEnabledChannel) return;

  const now = Date.now();
  const alerts = getTelemetryPushAlerts(data);
  const activeKeys = new Set(alerts.map((alertItem) => alertItem.key));

  for (const [key, state] of alertRuntimeState.entries()) {
    const rule = settingsCache.alerts?.rules?.[key] || NOTIFICATION_RULE_DEFAULTS;
    const recoveryResetMs = sanitizeAlertSeconds(
      rule.recoveryResetSec,
      NOTIFICATION_RULE_DEFAULTS.recoveryResetSec,
      ALERT_POLICY_BOUNDS.recoveryResetSec.min,
      ALERT_POLICY_BOUNDS.recoveryResetSec.max
    ) * 1000;

    if (activeKeys.has(key)) {
      state.recoveredAt = 0;
      continue;
    }

    if (!state.recoveredAt) {
      state.recoveredAt = now;
      continue;
    }

    if (now - state.recoveredAt >= recoveryResetMs) {
      alertRuntimeState.delete(key);
    }
  }

  for (const alertItem of alerts) {
    const rule = settingsCache.alerts?.rules?.[alertItem.key] || NOTIFICATION_RULE_DEFAULTS;
    const startDelayMs = sanitizeAlertSeconds(
      rule.startDelaySec,
      NOTIFICATION_RULE_DEFAULTS.startDelaySec,
      ALERT_POLICY_BOUNDS.startDelaySec.min,
      ALERT_POLICY_BOUNDS.startDelaySec.max
    ) * 1000;
    const repeatIntervalMs = sanitizeAlertSeconds(
      rule.repeatIntervalSec,
      NOTIFICATION_RULE_DEFAULTS.repeatIntervalSec,
      ALERT_POLICY_BOUNDS.repeatIntervalSec.min,
      ALERT_POLICY_BOUNDS.repeatIntervalSec.max
    ) * 1000;
    const mailDelayMs = sanitizeAlertSeconds(
      rule.mailDelayMin,
      NOTIFICATION_RULE_DEFAULTS.mailDelayMin,
      ALERT_POLICY_BOUNDS.mailDelayMin.min,
      ALERT_POLICY_BOUNDS.mailDelayMin.max
    ) * 60 * 1000;

    const state = alertRuntimeState.get(alertItem.key) || {
      firstDetectedAt: now,
      lastPushAt: 0,
      lastEmailAt: 0,
      recoveredAt: 0
    };

    if (!alertRuntimeState.has(alertItem.key)) {
      alertRuntimeState.set(alertItem.key, state);
    }

    if (!state.firstDetectedAt) {
      state.firstDetectedAt = now;
    }

    const problemDurationMs = now - state.firstDetectedAt;
    if (problemDurationMs < startDelayMs) continue;

    const canSendPush = rule.push && (state.lastPushAt === 0 || (now - state.lastPushAt) >= repeatIntervalMs);
    if (canSendPush) {
      state.lastPushAt = now;
      pushNotify(alertItem.title, alertItem.body, alertItem.key);
    }

    const canSendEmail = rule.email && (state.lastEmailAt === 0 || (now - state.lastEmailAt) >= repeatIntervalMs);
    if (canSendEmail) {
      if ((now - state.firstDetectedAt) >= mailDelayMs) {
        state.lastEmailAt = now;
        // Backend email currently en standby: garde la logique de timing pour activation future.
      }
    }
  }
}

function sanitizeAlertSeconds(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

// Construit l'objet rules en lisant les inputs de l'onglet Notifications.
function getAlertSettingsFromUi() {
  if (!ensureSettingsReady()) return { rules: {} };
  const rules = {};

  for (const metric of NOTIFICATION_METRICS) {
    const current = settingsCache.alerts?.rules?.[metric] || NOTIFICATION_RULE_DEFAULTS;
    rules[metric] = {
      push: Boolean(document.getElementById(`notif-push-${metric}`)?.classList.contains('active')),
      email: Boolean(document.getElementById(`notif-mail-${metric}`)?.classList.contains('active')),
      startDelaySec: sanitizeAlertSeconds(
        document.getElementById(`notif-start-${metric}`)?.value,
        current.startDelaySec,
        ALERT_POLICY_BOUNDS.startDelaySec.min,
        ALERT_POLICY_BOUNDS.startDelaySec.max
      ),
      repeatIntervalSec: sanitizeAlertSeconds(
        document.getElementById(`notif-repeat-${metric}`)?.value,
        current.repeatIntervalSec,
        ALERT_POLICY_BOUNDS.repeatIntervalSec.min,
        ALERT_POLICY_BOUNDS.repeatIntervalSec.max
      ),
      mailDelayMin: sanitizeAlertSeconds(
        document.getElementById(`notif-delta-${metric}`)?.value,
        current.mailDelayMin,
        ALERT_POLICY_BOUNDS.mailDelayMin.min,
        ALERT_POLICY_BOUNDS.mailDelayMin.max
      ),
      recoveryResetSec: sanitizeAlertSeconds(
        document.getElementById(`notif-reset-${metric}`)?.value,
        current.recoveryResetSec,
        ALERT_POLICY_BOUNDS.recoveryResetSec.min,
        ALERT_POLICY_BOUNDS.recoveryResetSec.max
      )
    };
  }

  return { rules };
}

// --- Auth & Profile Flows ----------------------------------------------------

async function detectAuthMode() {
  try {
    const res = await fetch('/api/auth/bootstrap-status');
    if (!res.ok) {
      authMode = 'login';
      updateAuthModeUi();
      return;
    }

    const payload = await res.json();
    authMode = payload?.mode === 'bootstrap' ? 'bootstrap' : 'login';
    updateAuthModeUi();
  } catch (_) {
    authMode = 'login';
    updateAuthModeUi();
  }
}

// Charge et affiche les infos profil (compte + timestamps).
async function loadProfile() {
  if (!token) return;
  try {
    const res = await fetch('/api/profile', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const payload = await res.json();
    if (!res.ok) {
      setProfileMessage(payload.error || 'Erreur de chargement du profil', true);
      return;
    }

    document.getElementById('profile-username').value = payload.username || '';
    document.getElementById('profile-email').value = payload.email || '';
    document.getElementById('profile-created-at').textContent = formatTimestamp(payload.createdAt);
    document.getElementById('profile-updated-at').textContent = formatTimestamp(payload.updatedAt);
    document.getElementById('profile-last-login').textContent = formatTimestamp(payload.lastLogin);
    document.getElementById('profile-settings-updated-at').textContent = formatTimestamp(payload.settingsUpdatedAt);
    setProfileMessage('');
  } catch (_) {
    setProfileMessage('Erreur réseau', true);
  }
}

// Sauvegarde profil (username/email/password) avec verification currentPassword.
async function saveProfile() {
  if (!isAuthenticated || !token) return;

  const username = document.getElementById('profile-username')?.value.trim() || '';
  const email = document.getElementById('profile-email')?.value.trim() || '';
  const currentPassword = document.getElementById('profile-current-password')?.value || '';
  const newPassword = document.getElementById('profile-new-password')?.value || '';
  const newPasswordConfirm = document.getElementById('profile-new-password-confirm')?.value || '';

  if (!username || !email || !currentPassword) {
    setProfileMessage('Nom, email et mot de passe actuel sont requis', true);
    return;
  }

  try {
    const res = await fetch('/api/profile', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ username, email, currentPassword, newPassword, newPasswordConfirm })
    });

    const payload = await res.json();
    if (!res.ok) {
      setProfileMessage(payload.error || 'Erreur de mise à jour du profil', true);
      return;
    }

    if (payload.token) {
      token = payload.token;
      localStorage.setItem('auth_token', token);
      socket.emit('auth', token);
    }
    if (payload.username) {
      currentUsername = payload.username;
      localStorage.setItem('username', currentUsername);
      showAuthInfo();
    }

    document.getElementById('profile-current-password').value = '';
    document.getElementById('profile-new-password').value = '';
    document.getElementById('profile-new-password-confirm').value = '';
    setProfileMessage('Profil mis à jour avec succès');
    await loadProfile();
  } catch (_) {
    setProfileMessage('Erreur réseau', true);
  }
}

// Suppression irreversible du compte, protegee par mot de passe actuel.
async function deleteAccount() {
  if (!isAuthenticated || !token) return;

  const currentPassword = document.getElementById('profile-current-password')?.value || '';
  if (!currentPassword) {
    setProfileMessage('Mot de passe actuel requis pour supprimer le compte', true);
    return;
  }

  const confirmed = window.confirm('Supprimer définitivement ce compte ? Cette action est irreversible.');
  if (!confirmed) return;

  try {
    const res = await fetch('/api/profile', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ currentPassword })
    });

    const payload = await res.json();
    if (!res.ok) {
      setProfileMessage(payload.error || 'Erreur suppression compte', true);
      return;
    }

    setProfileMessage('Compte supprimé. Déconnexion...');
    logout();
    detectAuthMode();
  } catch (_) {
    setProfileMessage('Erreur réseau', true);
  }
}

// Ouvre/ferme le panneau profil et ferme le panneau settings si besoin.
function toggleProfileSection() {
  if (!isAuthenticated) return;
  const profileSection = document.getElementById('profile-section');
  const settingsSection = document.getElementById('settings-section');
  if (!profileSection) return;

  const willOpen = !profileSection.classList.contains('visible');
  profileSection.classList.toggle('visible', willOpen);

  if (settingsSection && willOpen) {
    settingsSection.classList.remove('visible');
  }

  if (willOpen) {
    loadProfile();
  }

  syncOverlayPanelsState();
}

function syncOverlayPanelsState() {
  const profileSection = document.getElementById('profile-section');
  const settingsSection = document.getElementById('settings-section');
  const overlayOpen = Boolean(
    profileSection?.classList.contains('visible') || settingsSection?.classList.contains('visible')
  );
  document.body.classList.toggle('panel-overlay-open', overlayOpen);
}

function closeOverlayPanel(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.classList.remove('visible');
  syncOverlayPanelsState();
}

// Termine la session locale (token + UI) et remet l'état invité.
function logout() {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('username');
  token = null;
  currentUsername = null;
  isAuthenticated = false;
  
  const loginInputs = document.querySelector('.login-inputs');
  const authStatus = document.getElementById('auth-status');
  const loginFields = document.getElementById('login-fields');
  const loginToggle = document.getElementById('login-toggle-btn');
  const profileSection = document.getElementById('profile-section');
  
  if (loginInputs) loginInputs.style.display = 'flex';
  if (authStatus) authStatus.style.display = 'none';
  if (loginFields) loginFields.classList.add(LOGIN_COLLAPSED_CLASS);
  if (loginToggle) {
    loginToggle.style.display = 'inline-flex';
    loginToggle.textContent = authMode === 'bootstrap' ? 'Création de compte' : 'Connexion';
  }
  document.getElementById('login-error').textContent = '';
  if (profileSection) profileSection.classList.remove('visible');
  const settingsSection = document.getElementById('settings-section');
  if (settingsSection) settingsSection.classList.remove('visible');
  syncOverlayPanelsState();
  detectAuthMode();
  
  disableButtons();
}

// Sequence de bootstrap front:
// 1) charger defaults serveur
// 2) connecter socket
// 3) restaurer session JWT locale si presente
async function initApp() {
  disableButtons();

  try {
    await loadServerSettingsDefaults();
    applySettingsToUi();
  } catch (error) {
    console.error('[SETTINGS] Init defaults serveur échouée:', error.message);
    setLoginError('Impossible de charger la configuration serveur');
    return;
  }

  socket.connect();
  detectAuthMode();

  if (token) {
    console.log('[DEBUG] Token trouvé:', token.substring(0, 20) + '...');
    isAuthenticated = true;
    showAuthInfo();
    enableButtons();
    loadSettings();
  } else {
    console.log('[DEBUG] Pas de token');
  }
}

initApp();

function handleLoginToggle() {
  // Gère le bouton unique "Connexion / Se connecter" selon l'état courant.
  if (isAuthenticated) return;

  const loginFields = document.getElementById('login-fields');
  const loginToggle = document.getElementById('login-toggle-btn');
  const usernameInput = document.getElementById('username');

  if (loginFields && loginFields.classList.contains(LOGIN_COLLAPSED_CLASS)) {
    loginFields.classList.remove(LOGIN_COLLAPSED_CLASS);
    if (loginToggle) {
      loginToggle.textContent = authMode === 'bootstrap' ? 'Création de compte' : 'Se connecter';
    }
    updateAuthModeUi();
    if (usernameInput) usernameInput.focus();
    return;
  }

  if (authMode === 'bootstrap') {
    handleBootstrapRegister();
    return;
  }

  handleLogin();
}

// Creation du compte initial (mode bootstrap, one-shot).
async function handleBootstrapRegister() {
  const username = document.getElementById('username').value.trim();
  const email = document.getElementById('email')?.value.trim() || '';
  const password = document.getElementById('password').value;
  const passwordConfirm = document.getElementById('password-confirm')?.value || '';

  if (!username || !email || !password || !passwordConfirm) {
    setLoginError('Veuillez remplir tous les champs');
    return;
  }

  try {
    const res = await fetch('/api/auth/bootstrap-register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password, passwordConfirm })
    });

    const payload = await res.json();
    if (!res.ok) {
      setLoginError(payload.error || 'Erreur de création du compte');
      await detectAuthMode();
      return;
    }

    token = payload.token;
    currentUsername = payload.username;
    localStorage.setItem('auth_token', token);
    localStorage.setItem('username', currentUsername);

    document.getElementById('username').value = '';
    if (document.getElementById('email')) document.getElementById('email').value = '';
    document.getElementById('password').value = '';
    if (document.getElementById('password-confirm')) document.getElementById('password-confirm').value = '';
    setLoginError('');

    socket.emit('auth', token);
    isAuthenticated = true;
    authMode = 'login';
    updateAuthModeUi();
    showAuthInfo();
    enableButtons();
  } catch (_) {
    setLoginError('Erreur réseau');
  }
}

async function handleLogin() {
  // Envoie la demande de login à l'API et stocke le JWT en localStorage.
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  if (!username || !password) {
    setLoginError('Veuillez remplir tous les champs');
    return;
  }

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (res.ok) {
      const data = await res.json();
      token = data.token;
      currentUsername = data.username;
      localStorage.setItem('auth_token', token);
      localStorage.setItem('username', currentUsername);
      
      document.getElementById('username').value = '';
      document.getElementById('password').value = '';
      setLoginError('');
      
      socket.emit('auth', token);
      isAuthenticated = true;
      showAuthInfo();
      enableButtons();
    } else {
      const error = await res.json();
      setLoginError(error.error || 'Erreur de connexion');
    }
  } catch (err) {
    setLoginError('Erreur réseau');
  }
}

// --- Real-time Socket Event Handlers ----------------------------------------
socket.on('connect', () => {
  // Ré-authentifie automatiquement le socket après reconnexion réseau.
  console.log('[WebSocket] Connecté');
  if (token) {
    socket.emit('auth', token);
  }
});

socket.on('mqtt_status', (data) => {
  // Met à jour l'indicateur visuel ON/OFF du broker MQTT.
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  if (data.connected) {
    statusEl.classList.add('connected');
    statusEl.textContent = 'MQTT ON';
  } else {
    statusEl.classList.remove('connected');
    statusEl.textContent = 'MQTT OFF';
  }
});

socket.on('auth_success', (data) => {
  // Applique les privilèges UI quand le backend valide le token.
  enableButtons();
  isAuthenticated = true;
  console.log('Authentifié:', data.username);
  loadSettings();
});

socket.on('auth_error', (data) => {
  // Révoque les actions sensibles si l'auth socket échoue.
  disableButtons();
  isAuthenticated = false;
  console.error('Erreur auth:', data.message);
});

socket.on('disconnect', () => {
  // Réinitialise le badge de statut quand la socket se coupe.
  const statusEl = document.getElementById('status');
  if (statusEl) {
    statusEl.classList.remove('connected');
    statusEl.textContent = 'MQTT OFF';
  }
});

socket.on('device_state', (state) => {
  if (!state) return;
  if (typeof state.led === 'boolean') {
    setDeviceButtonState('led', state.led);
  }
  if (typeof state.pump === 'boolean') {
    setDeviceButtonState('pump', state.pump);
  }
  if (typeof state.fan === 'boolean') {
    setDeviceButtonState('fan', state.fan);
  }
});

socket.on('settings_updated', (incomingSettings) => {
  if (!defaultSettings) return;
  settingsCache = mergeLocalSettings(incomingSettings);
  applySettingsToUi();
  runAutomations(latestTelemetry);
});

// --- Settings Merge / Normalization -----------------------------------------
// Fusionne des paramètres reçus avec les valeurs locales par défaut
// pour garantir des structures complètes et cohérentes.
function mergeLocalSettings(incoming = {}) {
  if (!defaultSettings) return incoming;
  const merged = JSON.parse(JSON.stringify(defaultSettings));
  const incomingThresholds = incoming.thresholds || {};
  for (const key of Object.keys(merged.thresholds)) {
    const threshold = incomingThresholds[key] || {};
    const minCandidate = Number(threshold.min);
    const maxCandidate = Number(threshold.max);
    if (Number.isFinite(minCandidate)) merged.thresholds[key].min = minCandidate;
    if (Number.isFinite(maxCandidate)) merged.thresholds[key].max = maxCandidate;
  }

  const incomingIndicators = incoming.indicators || {};
  for (const key of Object.keys(merged.indicators)) {
    if (typeof incomingIndicators[key] === 'boolean') merged.indicators[key] = incomingIndicators[key];
  }

  const incomingAutomations = incoming.automations || {};
  for (const key of Object.keys(merged.automations)) {
    if (typeof incomingAutomations[key] === 'boolean') merged.automations[key] = incomingAutomations[key];
  }

  const incomingDurations = incoming.automationDurations || {};
  for (const key of Object.keys(merged.automationDurations)) {
    const durationCandidate = Number(incomingDurations[key]);
    if (Number.isFinite(durationCandidate) && durationCandidate > 0) {
      merged.automationDurations[key] = sanitizeDuration(key, durationCandidate);
    }
  }

  const incomingAlerts = incoming.alerts || {};
  const incomingRules = incomingAlerts.rules || {};
  const legacyAlerts = incoming.alerts || {};
  merged.alerts.rules = {};

  for (const metric of NOTIFICATION_METRICS) {
    const baseRule = defaultSettings.alerts.rules[metric] || NOTIFICATION_RULE_DEFAULTS;
    const incomingRule = incomingRules[metric] || {};
    merged.alerts.rules[metric] = {
      push: typeof incomingRule.push === 'boolean' ? incomingRule.push : baseRule.push,
      email: typeof incomingRule.email === 'boolean' ? incomingRule.email : baseRule.email,
      startDelaySec: sanitizeAlertSeconds(
        incomingRule.startDelaySec,
        baseRule.startDelaySec,
        ALERT_POLICY_BOUNDS.startDelaySec.min,
        ALERT_POLICY_BOUNDS.startDelaySec.max
      ),
      repeatIntervalSec: sanitizeAlertSeconds(
        incomingRule.repeatIntervalSec,
        baseRule.repeatIntervalSec,
        ALERT_POLICY_BOUNDS.repeatIntervalSec.min,
        ALERT_POLICY_BOUNDS.repeatIntervalSec.max
      ),
      mailDelayMin: sanitizeAlertSeconds(
        incomingRule.mailDelayMin,
        baseRule.mailDelayMin,
        ALERT_POLICY_BOUNDS.mailDelayMin.min,
        ALERT_POLICY_BOUNDS.mailDelayMin.max
      ),
      recoveryResetSec: sanitizeAlertSeconds(
        incomingRule.recoveryResetSec,
        baseRule.recoveryResetSec,
        ALERT_POLICY_BOUNDS.recoveryResetSec.min,
        ALERT_POLICY_BOUNDS.recoveryResetSec.max
      )
    };

    if (
      LINKED_THRESHOLD_METRICS.includes(metric) &&
      typeof incomingRule.push !== 'boolean' &&
      typeof incomingIndicators[metric] === 'boolean'
    ) {
      merged.alerts.rules[metric].push = incomingIndicators[metric];
    }

    if (
      !Number.isFinite(Number(incomingRule.mailDelayMin)) &&
      Number.isFinite(Number(incomingRule.pushMailDeltaSec))
    ) {
      merged.alerts.rules[metric].mailDelayMin = sanitizeAlertSeconds(
        Math.round(Number(incomingRule.pushMailDeltaSec) / 60),
        baseRule.mailDelayMin,
        ALERT_POLICY_BOUNDS.mailDelayMin.min,
        ALERT_POLICY_BOUNDS.mailDelayMin.max
      );
    }

    if (
      !Number.isFinite(Number(incomingRule.mailDelayMin)) &&
      !Number.isFinite(Number(incomingRule.pushMailDeltaSec)) &&
      Number.isFinite(Number(legacyAlerts.mailDelayMin))
    ) {
      merged.alerts.rules[metric].mailDelayMin = sanitizeAlertSeconds(
        Number(legacyAlerts.mailDelayMin),
        baseRule.mailDelayMin,
        ALERT_POLICY_BOUNDS.mailDelayMin.min,
        ALERT_POLICY_BOUNDS.mailDelayMin.max
      );
    }

    if (
      !Number.isFinite(Number(incomingRule.mailDelayMin)) &&
      !Number.isFinite(Number(incomingRule.pushMailDeltaSec)) &&
      !Number.isFinite(Number(legacyAlerts.mailDelayMin)) &&
      Number.isFinite(Number(legacyAlerts.pushMailDeltaSec))
    ) {
      merged.alerts.rules[metric].mailDelayMin = sanitizeAlertSeconds(
        Math.round(Number(legacyAlerts.pushMailDeltaSec) / 60),
        baseRule.mailDelayMin,
        ALERT_POLICY_BOUNDS.mailDelayMin.min,
        ALERT_POLICY_BOUNDS.mailDelayMin.max
      );
    }
  }

  // Source of truth: keep threshold bells synced with notification push rules.
  for (const metric of LINKED_THRESHOLD_METRICS) {
    if (Object.prototype.hasOwnProperty.call(merged.indicators, metric)) {
      merged.indicators[metric] = Boolean(merged.alerts.rules?.[metric]?.push);
    }
  }

  return merged;
}

// --- Settings UI Interaction -------------------------------------------------
function setActiveSettingsTab(tabName) {
  const tabs = ['thresholds', 'automations', 'notifications'];
  for (const tab of tabs) {
    const tabBtn = document.getElementById(`tab-btn-${tab}`);
    const panel = document.getElementById(`settings-panel-${tab}`);
    const isActive = tab === tabName;

    if (tabBtn) {
      tabBtn.classList.toggle('active', isActive);
      tabBtn.setAttribute('aria-selected', String(isActive));
    }

    if (panel) {
      panel.classList.toggle('active', isActive);
      panel.hidden = !isActive;
    }
  }
}

function updateThresholdAlertButton(sensorKey) {
  const bellButton = document.getElementById(`alert-bell-${sensorKey}`);
  if (!bellButton) return;

  const pushEnabled = Boolean(settingsCache.alerts?.rules?.[sensorKey]?.push);
  bellButton.classList.toggle('active', pushEnabled);
  bellButton.setAttribute('aria-pressed', String(pushEnabled));
}

function updateNotificationRuleButtons(metric) {
  const pushButton = document.getElementById(`notif-push-${metric}`);
  const mailButton = document.getElementById(`notif-mail-${metric}`);
  const rule = settingsCache.alerts?.rules?.[metric] || NOTIFICATION_RULE_DEFAULTS;

  if (pushButton) {
    pushButton.classList.toggle('active', Boolean(rule.push));
    pushButton.setAttribute('aria-pressed', String(Boolean(rule.push)));
  }

  if (mailButton) {
    mailButton.classList.toggle('active', Boolean(rule.email));
    mailButton.setAttribute('aria-pressed', String(Boolean(rule.email)));
  }
}

function toggleNotificationRuleChannel(metric, channel) {
  if (!ensureSettingsReady()) return;
  if (!NOTIFICATION_METRICS.includes(metric)) return;
  if (!['push', 'email'].includes(channel)) return;
  if (!isAuthenticated) {
    setLoginError('Veuillez vous connecter pour modifier les alertes');
    return;
  }

  const rule = settingsCache.alerts?.rules?.[metric];
  if (!rule) return;

  rule[channel] = !Boolean(rule[channel]);

  if (channel === 'push' && Object.prototype.hasOwnProperty.call(settingsCache.indicators, metric)) {
    settingsCache.indicators[metric] = rule.push;
    updateThresholdAlertButton(metric);
  }

  updateNotificationRuleButtons(metric);
}

function toggleThresholdAlertChannel(sensorKey, channel) {
  if (!ensureSettingsReady()) return;
  if (channel !== 'push') return;
  if (!isAuthenticated) {
    setLoginError('Veuillez vous connecter pour modifier les alertes');
    return;
  }

  const current = Boolean(settingsCache.indicators?.[sensorKey]);
  const next = !current;
  settingsCache.indicators[sensorKey] = next;
  if (settingsCache.alerts?.rules?.[sensorKey]) {
    settingsCache.alerts.rules[sensorKey].push = next;
    updateNotificationRuleButtons(sensorKey);
  }
  updateThresholdAlertButton(sensorKey);
}

function getDurationBounds(type) {
  if (type === 'pump') return { min: 5, max: 600 };
  if (type === 'fan') return { min: 10, max: 3600 };
  return { min: 10, max: 21600 };
}

function sanitizeDuration(type, seconds) {
  const { min, max } = getDurationBounds(type);
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed)) {
    const fallback = defaultSettings?.automationDurations?.[type];
    return Number.isFinite(Number(fallback)) ? Number(fallback) : min;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

// --- Automation Runtime ------------------------------------------------------
function getAutomationDurationMs(type) {
  const seconds = sanitizeDuration(type, settingsCache.automationDurations[type]);
  return seconds * 1000;
}

function clearAutomationTimer(type) {
  const timer = automationTimerState[type];
  if (!timer) return;
  if (timer.timeoutId) {
    clearTimeout(timer.timeoutId);
    timer.timeoutId = null;
  }
  timer.activeUntil = 0;
}

function startTimedAutomation(type) {
  const timer = automationTimerState[type];
  if (!timer) return;

  const now = Date.now();
  if (timer.activeUntil > now) return;

  const durationMs = getAutomationDurationMs(type);
  const cooldownMs = Math.max(15000, Math.floor(durationMs * 0.5));
  if (now - timer.lastTriggerAt < cooldownMs) return;

  timer.lastTriggerAt = now;
  timer.activeUntil = now + durationMs;

  setDeviceButtonState(type, true);
  sendDeviceCommand(type, true);

  if (timer.timeoutId) clearTimeout(timer.timeoutId);
  timer.timeoutId = setTimeout(() => {
    timer.timeoutId = null;
    timer.activeUntil = 0;

    if (!automationStates[type]) return;
    setDeviceButtonState(type, false);
    sendDeviceCommand(type, false);
    runAutomations(latestTelemetry);
  }, durationMs);
}

// Envoie la commande MQTT logique pour un équipement ciblé.
function sendDeviceCommand(type, shouldBeOn) {
  const cmd = deviceConfig[type]?.cmd;
  if (!cmd) return;
  socket.emit('cmd', shouldBeOn ? `${cmd}_ON` : `${cmd}_OFF`);
}

// Applique la règle d'automatisation d'un équipement selon télémétrie.
function applyAutomationForDevice(type, telemetry) {
  if (!ensureSettingsReady()) return;
  const thresholds = settingsCache.thresholds;
  let desiredState = null;

  if (type === 'led') {
    const lux = Number(telemetry.luminosite);
    if (!Number.isFinite(lux)) return;
    if (lux <= thresholds.lux.min) desiredState = true;
    else if (lux >= thresholds.lux.max) desiredState = false;
  }

  if (type === 'pump') {
    const soil = Number(telemetry.humidite_sol);
    if (!Number.isFinite(soil)) return;
    if (soil <= thresholds.soil.min) desiredState = true;
    else if (soil >= thresholds.soil.max) desiredState = false;
  }

  if (type === 'fan') {
    const temp = Number(telemetry.temperature);
    const airHumidity = Number(telemetry.humidite_air);
    if (!Number.isFinite(temp) && !Number.isFinite(airHumidity)) return;

    const tempHigh = Number.isFinite(temp) && temp >= thresholds.temp.max;
    const airHigh = Number.isFinite(airHumidity) && airHumidity >= thresholds.air.max;
    const tempLow = Number.isFinite(temp) && temp <= thresholds.temp.min;
    const airLow = Number.isFinite(airHumidity) && airHumidity <= thresholds.air.max;

    if (tempHigh || airHigh) desiredState = true;
    else if (tempLow && airLow) desiredState = false;
  }

  if (desiredState === null) return;

  const timer = automationTimerState[type];
  const timerIsRunning = Boolean(timer?.activeUntil && timer.activeUntil > Date.now());

  if (desiredState) {
    startTimedAutomation(type);
    return;
  }

  if (!timerIsRunning && states[type]) {
    setDeviceButtonState(type, false);
    sendDeviceCommand(type, false);
  }
}

// Lance les automations activées pour les 3 équipements pilotables.
function runAutomations(telemetry) {
  if (!isAuthenticated || !telemetry) return;
  if (automationStates.led) applyAutomationForDevice('led', telemetry);
  if (automationStates.pump) applyAutomationForDevice('pump', telemetry);
  if (automationStates.fan) applyAutomationForDevice('fan', telemetry);
}

// Parse un champ numérique de formulaire avec fallback sécurisé.
function parseThresholdInput(elementId, fallbackValue) {
  const parsed = Number(document.getElementById(elementId)?.value);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

// Construit l'objet settings à envoyer au backend depuis le formulaire.
function collectSettingsFromUi() {
  if (!ensureSettingsReady()) return null;
  return {
    thresholds: {
      lux: {
        min: parseThresholdInput('lux-min', settingsCache.thresholds.lux.min),
        max: parseThresholdInput('lux-max', settingsCache.thresholds.lux.max)
      },
      soil: {
        min: parseThresholdInput('soil-min', settingsCache.thresholds.soil.min),
        max: parseThresholdInput('soil-max', settingsCache.thresholds.soil.max)
      },
      air: {
        min: parseThresholdInput('air-min', settingsCache.thresholds.air.min),
        max: parseThresholdInput('air-max', settingsCache.thresholds.air.max)
      },
      temp: {
        min: parseThresholdInput('temp-min', settingsCache.thresholds.temp.min),
        max: parseThresholdInput('temp-max', settingsCache.thresholds.temp.max)
      }
    },
    indicators: {
      lux: Boolean(settingsCache.indicators.lux),
      soil: Boolean(settingsCache.indicators.soil),
      air: Boolean(settingsCache.indicators.air),
      temp: Boolean(settingsCache.indicators.temp),
      pressure: settingsCache.indicators.pressure
    },
    automations: {
      led: automationStates.led,
      pump: automationStates.pump,
      fan: automationStates.fan
    },
    automationDurations: {
      led: sanitizeDuration('led', parseThresholdInput('led-duration', settingsCache.automationDurations.led)),
      pump: sanitizeDuration('pump', parseThresholdInput('pump-duration', settingsCache.automationDurations.pump)),
      fan: sanitizeDuration('fan', parseThresholdInput('fan-duration', settingsCache.automationDurations.fan))
    },
    alerts: {
      ...getAlertSettingsFromUi()
    }
  };
}

// Gestion d'un toggle auto : sécurité auth, persist, application immédiate.
async function handleAutomationToggle(type, enabled) {
  if (!ensureSettingsReady()) return;
  if (!isAuthenticated) {
    const autoInput = document.getElementById(deviceConfig[type]?.autoId);
    if (autoInput) autoInput.checked = automationStates[type];
    setLoginError('Veuillez vous connecter pour activer l\'automatisation');
    return;
  }

  setAutomationVisualState(type, enabled);
  settingsCache.automations[type] = automationStates[type];

  if (!enabled) {
    clearAutomationTimer(type);
  }

  if (enabled && latestTelemetry) {
    applyAutomationForDevice(type, latestTelemetry);
  }

  await saveSettings(false);
}

// Contrôle manuel d'un équipement (hors mode auto).
function toggle(type, cmd) {
  if (!isAuthenticated) {
    setLoginError('');
    return;
  }
  if (automationStates[type]) {
    alert('Désactivez le mode Auto avant de contrôler manuellement cet équipement.');
    return;
  }
  const nextState = !states[type];
  setDeviceButtonState(type, nextState);
  socket.emit('cmd', nextState ? cmd + '_ON' : cmd + '_OFF');
}

// Ouvre/ferme la section paramètres, avec chargement à l'ouverture.
function toggleSettingsSection() {
  if (!isAuthenticated) {
    alert('Veuillez vous connecter pour accéder aux paramètres');
    return;
  }
  const settingsSection = document.getElementById('settings-section');
  const profileSection = document.getElementById('profile-section');
  if (settingsSection) {
    settingsSection.classList.toggle('visible');
    if (profileSection && settingsSection.classList.contains('visible')) {
      profileSection.classList.remove('visible');
    }
    // Recharge les paramètres quand la section devient visible
    if (settingsSection.classList.contains('visible')) {
      setActiveSettingsTab('thresholds');
      loadSettings();
    }

    syncOverlayPanelsState();
  }
}

// Flux principal de telemetrie: rendu live + historique + automations + alertes.
socket.on('telemetry', d => {
  // Pipeline front de télémétrie : UI instantanée, historique, sync boutons,
  // puis exécution éventuelle des automatismes.
  if (!d) return;
  if (!ensureSettingsReady()) return;
  latestTelemetry = d;
  const thresholds = settingsCache.thresholds;
  const pumpOn = d.pump_on;
  
  // Met à jour les valeurs affichées
  update('lux', d.luminosite || 0, thresholds.lux.min, thresholds.lux.max);
  update('soil', d.humidite_sol || 0, thresholds.soil.min, thresholds.soil.max);
  update('humidity', d.humidite_air || 0, thresholds.air.min, thresholds.air.max);
  update('temp', d.temperature || 0, thresholds.temp.min, thresholds.temp.max);
  update('pressure', d.pressure || 0, 990, 1030);
  update('rssi', d.rssi || -100, RSSI_FIXED_RANGE.min, RSSI_FIXED_RANGE.max);
  updateWaterLevel(typeof d.water_full === 'boolean' ? d.water_full : null);
  
  // Ajoute le nouveau point au graphique
  if (chartData) {
    chartData.push({
      timestamp: new Date().toISOString(),
      luminosite: d.luminosite || 0,
      humidite_sol: d.humidite_sol || 0,
      humidite_air: d.humidite_air || 0,
      temperature: d.temperature || 0,
      pressure: d.pressure || 0,
      rssi: d.rssi || 0,
      water_full: d.water_full || false,
      led_on: d.led_on || false,
      fan_on: d.fan_on || false,
      pump_on: pumpOn || false
    });
    
    if (chartData.length > 100) chartData.shift();
    renderChart(chartData);
  }
  
  // Synchronise l'état des boutons avec l'état réel des équipements
  if (d.led_on !== undefined) {
    setDeviceButtonState('led', d.led_on);
  }
  if (d.fan_on !== undefined) {
    setDeviceButtonState('fan', d.fan_on);
  }
  if (pumpOn !== undefined) {
    setDeviceButtonState('pump', pumpOn);
  }

  runAutomations(d);
  maybeSendPushAlerts(d);
});

// --- Charting ----------------------------------------------------------------
// Rend ou met à jour le graphique Chart.js à partir des points historiques.
function renderChart(data) {
  if (!data || data.length === 0) return;
  
  const ctx = document.getElementById('chart');
  if (!ctx) return;
  
  const ctxData = ctx.getContext('2d');
  const labels = data.map(d => new Date(d.timestamp).toLocaleTimeString());
  
  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = data.map(d => d.luminosite);
    chart.data.datasets[1].data = data.map(d => d.humidite_sol);
    chart.data.datasets[2].data = data.map(d => d.humidite_air || 0);
    chart.data.datasets[3].data = data.map(d => d.temperature || 0);
    chart.data.datasets[4].data = data.map(d => d.pressure || 0);
    chart.update('none');
    return;
  }
  
  chart = new Chart(ctxData, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Luminosité (lux)',
          data: data.map(d => d.luminosite),
          borderColor: '#fbbf24',
          backgroundColor: 'rgba(251,191,36,0.05)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.4,
          fill: true,
          yAxisID: 'y'
        },
        {
          label: 'Humidité sol (%)',
          data: data.map(d => d.humidite_sol),
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.05)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.4,
          fill: true,
          yAxisID: 'y'
        },
        {
          label: 'Humidité air (%)',
          data: data.map(d => d.humidite_air || 0),
          borderColor: '#06b6d4',
          backgroundColor: 'rgba(6,182,212,0.05)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.4,
          fill: true,
          yAxisID: 'y'
        },
        {
          label: 'Température (°C)',
          data: data.map(d => d.temperature || 0),
          borderColor: '#f97316',
          backgroundColor: 'rgba(249,115,22,0.05)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.4,
          fill: true,
          yAxisID: 'y'
        },
        {
          label: 'Pression (hPa)',
          data: data.map(d => d.pressure || 0),
          borderColor: '#8b5cf6',
          backgroundColor: 'rgba(139,92,246,0.05)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.4,
          fill: true,
          yAxisID: 'y'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { left: 0, right: 0 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { color: '#94a3b8', usePointStyle: true, padding: 10 }
        }
      },
      scales: {
        y: {
          type: 'linear',
          position: 'right',
          min: 0,
          max: maxScale,
          ticks: { color: '#94a3b8', font: { weight: 'bold' } },
          grid: { color: 'rgba(148,163,184,0.1)' }
        },
        x: {
          ticks: { color: '#94a3b8', maxRotation: 45, minRotation: 0 },
          grid: { color: 'rgba(255,255,255,0.05)' }
        }
      }
    }
  });
}

// Charge les 100 derniers points depuis l'API et initialise le graphique.
function loadChart() {
  maxScale = BASE_SCALE; // Remet le zoom par défaut
  fetch('/api/history?limit=100')
    .then(r => r.json())
    .then(payload => {
      const data = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
      chartData = data;
      renderChart(chartData);
    })
    .catch(err => console.error('Erreur chargement historique:', err));
}

// --- Settings API Sync -------------------------------------------------------
// Charge les paramètres serveur et les applique au front local.
async function loadSettings() {
  if (!defaultSettings) {
    await loadServerSettingsDefaults();
  }

  try {
    const response = await fetch('/api/settings', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (response.ok) {
      const data = await response.json();
      settingsCache = mergeLocalSettings(data);
      applySettingsToUi();
      runAutomations(latestTelemetry);
    } else {
      console.error('Erreur chargement paramètres');
    }
  } catch (err) {
    console.error('Erreur:', err);
  }
}

// Sauvegarde les paramètres vers l'API avec messages utilisateur.
async function saveSettings(showAlert = true) {
  if (!ensureSettingsReady()) {
    if (showAlert) alert('Configuration non chargee depuis le serveur');
    return;
  }

  try {
    const settings = collectSettingsFromUi();
    if (!settings) return;
    settingsCache = mergeLocalSettings(settings);

    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(settingsCache)
    });

    if (response.ok) {
      const payload = await response.json();
      settingsCache = mergeLocalSettings(payload.settings || settingsCache);
      applySettingsToUi();
      runAutomations(latestTelemetry);
      if (showAlert) {
        alert('✅ Paramètres sauvegardés avec succès!');
      }
    } else {
      let errorMessage = 'Erreur lors de la sauvegarde';
      try {
        const errorPayload = await response.json();
        if (errorPayload?.error) errorMessage = errorPayload.error;
      } catch (_) {
        // garde le message d'erreur standard
      }
      if (showAlert) {
        alert(`❌ ${errorMessage}`);
      }
    }
  } catch (err) {
    console.error('Erreur:', err);
    if (showAlert) {
      alert('❌ Erreur serveur');
    }
  }
}

// --- Chart Zoom & Resizable Layout ------------------------------------------
// On change seulement la hauteur max de l'axe Y pour zoomer simplement.
// Applique la valeur de zoom courante sur l'axe Y.
function applyZoom() {
  if (!chart) return;
  if (maxScale < 1) maxScale = 1;
  chart.options.scales.y.min = 0;
  chart.options.scales.y.max = Math.round(maxScale);
  chart.update('none');
}

// Zoom avant (réduction max axe Y).
function zoomIn() {
  maxScale /= ZOOM_MULTIPLIER; 
  applyZoom();
}

// Zoom arrière (augmentation max axe Y, avec borne haute).
function zoomOut() {
  maxScale *= ZOOM_MULTIPLIER;
  if (maxScale > 100000) maxScale = 100000; // Évite un zoom trop grand
  applyZoom();
}

function initLayoutResizer() {
  const main = document.querySelector('main');
  const interfaceStack = document.getElementById('interface-stack');
  const interfaceSection = document.getElementById('interface-section');
  const resizer = document.getElementById('layout-resizer');
  if (!main || !interfaceStack || !interfaceSection || !resizer) return;

  const desktopQuery = window.matchMedia('(min-width: 821px)');
  const MIN_PANEL_PX = 0;
  const DEFAULT_INTERFACE_RATIO = 0.45;
  let dragging = false;

  const getInterfaceMaxBasis = () => {
    const mainRect = main.getBoundingClientRect();
    const fullMainMax = mainRect.height - resizer.offsetHeight;
    const bubblesLevelMax = Math.ceil(interfaceSection.getBoundingClientRect().height);
    return Math.max(MIN_PANEL_PX, Math.min(fullMainMax, bubblesLevelMax));
  };

  const applyFromClientY = (clientY) => {
    const rect = main.getBoundingClientRect();
    const maxBasis = getInterfaceMaxBasis();
    const desired = Math.round(clientY - rect.top);
    const basis = Math.max(MIN_PANEL_PX, Math.min(maxBasis, desired));
    interfaceStack.style.flexBasis = `${basis}px`;
    if (chart) chart.resize();
  };

  const syncForViewport = () => {
    if (!desktopQuery.matches) {
      interfaceStack.style.flexBasis = 'auto';
      return;
    }

    const rect = main.getBoundingClientRect();
    const maxBasis = getInterfaceMaxBasis();
    const currentBasis = parseFloat(interfaceStack.style.flexBasis);
    const fallbackBasis = Math.round(rect.height * DEFAULT_INTERFACE_RATIO);
    const basisSource = Number.isFinite(currentBasis) ? currentBasis : fallbackBasis;
    const clamped = Math.max(MIN_PANEL_PX, Math.min(maxBasis, basisSource));
    interfaceStack.style.flexBasis = `${Math.round(clamped)}px`;
    if (chart) chart.resize();
  };

  resizer.addEventListener('pointerdown', (event) => {
    if (!desktopQuery.matches) return;
    dragging = true;
    document.body.classList.add('layout-resizing');
    resizer.setPointerCapture(event.pointerId);
    applyFromClientY(event.clientY);
  });

  window.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    applyFromClientY(event.clientY);
  });

  window.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('layout-resizing');
  });

  window.addEventListener('resize', syncForViewport);
  syncForViewport();
}

// --- DOM Lifecycle Hooks -----------------------------------------------------
// Zoom avec la molette de la souris
document.addEventListener('DOMContentLoaded', () => {
  initLayoutResizer();

  // Active le zoom molette uniquement sur la zone graphique.
  const chartWrapper = document.getElementById('chart-wrapper');
  if (chartWrapper) {
    chartWrapper.addEventListener('wheel', (e) => {
      if (!chart) return;
      
      e.preventDefault();
      
      // Roulette vers le haut = zoom avant, vers le bas = zoom arrière
      if (e.deltaY < 0) {
        zoomIn();
      } else {
        zoomOut();
      }
    }, { passive: false });
  }
});

// Charge l'historique au démarrage
loadChart();

window.addEventListener('beforeinstallprompt', (event) => {
  // Intercepte le prompt PWA natif pour déclenchement contrôlé.
  event.preventDefault();
  deferredInstallPrompt = event;
  installPromptTriggered = false;
  attachNativeInstallPrompt();
});

window.addEventListener('appinstalled', () => {
  // Nettoie l'état local une fois l'installation PWA effectuée.
  deferredInstallPrompt = null;
  installPromptTriggered = true;
});

if ('serviceWorker' in navigator) {
  // Gestion de cycle service worker : registration, update et refresh auto.
  let hasRefreshedForSw = false;

  // Force l'activation immédiate d'un worker en attente.
  const activateUpdate = (registration) => {
    if (registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hasRefreshedForSw) return;
    hasRefreshedForSw = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then((registration) => {
        swRegistrationRef = registration;
        activateUpdate(registration);

        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed') {
              activateUpdate(registration);
            }
          });
        });

        setInterval(() => {
          registration.update().catch(() => {});
        }, 5 * 60 * 1000);
      })
      .catch((err) => {
        console.error('Service worker non enregistré:', err);
      });
  });
}

// Declenche la demande de permission push sur premiere interaction utilisateur.
window.addEventListener('pointerdown', () => {
  const hasEnabledPushRule = NOTIFICATION_METRICS.some((metric) => Boolean(settingsCache.alerts?.rules?.[metric]?.push));
  if (!hasEnabledPushRule) return;
  ensurePushPermission();
}, { once: true, capture: true });

window.addEventListener('keydown', () => {
  const hasEnabledPushRule = NOTIFICATION_METRICS.some((metric) => Boolean(settingsCache.alerts?.rules?.[metric]?.push));
  if (!hasEnabledPushRule) return;
  ensurePushPermission();
}, { once: true, capture: true });
