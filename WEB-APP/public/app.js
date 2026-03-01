// === Interface web ===
// Ce fichier gère la connexion utilisateur, les données en direct et le graphique.
// Connexion WebSocket et variables globales
const socket = io({ reconnection: true, reconnectionDelay: 1000 });
let chart = null;
let states = { led: false, hum: false, fan: false };
let automationStates = { led: false, hum: false, fan: false };
let token = localStorage.getItem('auth_token');
let currentUsername = localStorage.getItem('username');
let isAuthenticated = false;
let chartData = null;
let latestTelemetry = null;
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
let settingsCache = JSON.parse(JSON.stringify(defaultSettings));
const deviceConfig = {
  led: { btnId: 'led-btn', autoId: 'led-auto', cmd: 'LED' },
  hum: { btnId: 'hum-btn', autoId: 'hum-auto', cmd: 'HUM' },
  fan: { btnId: 'fan-btn', autoId: 'fan-auto', cmd: 'FAN' }
};
const BASE_SCALE = 1000; // Valeur de zoom par défaut au chargement
let maxScale = BASE_SCALE;
const ZOOM_MULTIPLIER = 1.2; // Zoom de 20% à chaque action
const LOGIN_COLLAPSED_CLASS = 'is-collapsed';
let deferredInstallPrompt = null;
let installPromptTriggered = false;

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

// === Fonctions de connexion utilisateur ===
// Affiche/masque le message d'erreur dans le panneau de connexion.
function setLoginError(msg) {
  const el = document.getElementById('login-error');
  if (msg) {
    el.textContent = msg;
    el.style.display = 'block';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

// Active les boutons de contrôle quand l'utilisateur est authentifié.
function enableButtons() {
  console.log('[DEBUG] enableButtons()');
  const ledBtn = document.getElementById('led-btn');
  const humBtn = document.getElementById('hum-btn');
  const fanBtn = document.getElementById('fan-btn');
  const ledAuto = document.getElementById('led-auto');
  const humAuto = document.getElementById('hum-auto');
  const fanAuto = document.getElementById('fan-auto');
  if (ledBtn) ledBtn.classList.remove('disabled');
  if (humBtn) humBtn.classList.remove('disabled');
  if (fanBtn) fanBtn.classList.remove('disabled');
  if (ledAuto) ledAuto.disabled = false;
  if (humAuto) humAuto.disabled = false;
  if (fanAuto) fanAuto.disabled = false;
}

// Désactive les contrôles sensibles quand l'utilisateur est anonyme.
function disableButtons() {
  console.log('[DEBUG] disableButtons()');
  const ledBtn = document.getElementById('led-btn');
  const humBtn = document.getElementById('hum-btn');
  const fanBtn = document.getElementById('fan-btn');
  const ledAuto = document.getElementById('led-auto');
  const humAuto = document.getElementById('hum-auto');
  const fanAuto = document.getElementById('fan-auto');
  if (ledBtn) ledBtn.classList.add('disabled');
  if (humBtn) humBtn.classList.add('disabled');
  if (fanBtn) fanBtn.classList.add('disabled');
  if (ledAuto) ledAuto.disabled = true;
  if (humAuto) humAuto.disabled = true;
  if (fanAuto) fanAuto.disabled = true;
}

// Bascule l'UI en mode "connecté" (chip utilisateur + bouton logout).
function showAuthInfo() {
  const loginInputs = document.querySelector('.login-inputs');
  const authStatus = document.getElementById('auth-status');
  const loginFields = document.getElementById('login-fields');
  const loginToggle = document.getElementById('login-toggle-btn');
  
  if (loginInputs) loginInputs.style.display = 'none';
  if (loginFields) loginFields.classList.add(LOGIN_COLLAPSED_CLASS);
  if (loginToggle) loginToggle.style.display = 'none';
  if (authStatus) {
    authStatus.style.display = 'flex';
    authStatus.innerHTML = `
      <span class="user-chip">👤 ${currentUsername}</span>
      <button class="logout-btn" onclick="logout()">Déconnexion</button>
    `;
  }
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
  
  if (loginInputs) loginInputs.style.display = 'flex';
  if (authStatus) authStatus.style.display = 'none';
  if (loginFields) loginFields.classList.add(LOGIN_COLLAPSED_CLASS);
  if (loginToggle) {
    loginToggle.style.display = 'inline-flex';
    loginToggle.textContent = 'Connexion';
  }
  document.getElementById('login-error').textContent = '';
  
  disableButtons();
}

// Vérifie si l'utilisateur était déjà connecté
if (token) {
  console.log('[DEBUG] Token trouvé:', token.substring(0, 20) + '...');
  isAuthenticated = true;
  showAuthInfo();
  enableButtons();
  loadSettings();
} else {
  console.log('[DEBUG] Pas de token');
  disableButtons();
}

function handleLoginToggle() {
  // Gère le bouton unique "Connexion / Se connecter" selon l'état courant.
  if (isAuthenticated) return;

  const loginFields = document.getElementById('login-fields');
  const loginToggle = document.getElementById('login-toggle-btn');
  const usernameInput = document.getElementById('username');

  if (loginFields && loginFields.classList.contains(LOGIN_COLLAPSED_CLASS)) {
    loginFields.classList.remove(LOGIN_COLLAPSED_CLASS);
    if (loginToggle) loginToggle.textContent = 'Se connecter';
    if (usernameInput) usernameInput.focus();
    return;
  }

  handleLogin();
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

// === Événements temps réel ===
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

// === Mise à jour des capteurs ===
// Met à jour une bulle capteur (valeur + classe visuelle selon seuils).
function update(id, val, min, max) {
  const el = document.getElementById(id);
  const bubble = document.getElementById(id + '-bubble');
  
  if (!el || !bubble) return;
  
  bubble.classList.remove('healthy', 'warning', 'critical');
  if (val >= min && val <= max) bubble.classList.add('healthy');
  else if (Math.abs(val - min) < (max - min) * 0.2 || Math.abs(val - max) < (max - min) * 0.2) bubble.classList.add('warning');
  else bubble.classList.add('critical');
  
  el.textContent = Math.round(val);
}

// Met à jour l'indicateur de niveau d'eau avec un état lisible.
function updateWaterLevel(isFull) {
  const el = document.getElementById('water-level');
  const bubble = document.getElementById('water-bubble');

  if (!el || !bubble) return;

  bubble.classList.remove('healthy', 'warning', 'critical');
  if (isFull === true) {
    el.textContent = 'Plein';
    bubble.classList.add('healthy');
  } else if (isFull === false) {
    el.textContent = 'Vide';
    bubble.classList.add('critical');
  } else {
    el.textContent = '-';
  }
}

// Fusionne des paramètres reçus avec les valeurs locales par défaut
// pour garantir des structures complètes et cohérentes.
function mergeLocalSettings(incoming = {}) {
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

  return merged;
}

// Met à jour l'état visuel d'un bouton d'équipement (ON/OFF manuel).
function setDeviceButtonState(type, isOn) {
  states[type] = Boolean(isOn);
  const button = document.getElementById(deviceConfig[type]?.btnId);
  if (!button) return;
  if (states[type]) button.classList.add('on');
  else button.classList.remove('on');
}

// Met à jour l'état visuel + checkbox d'un mode automatique.
function setAutomationVisualState(type, enabled) {
  automationStates[type] = Boolean(enabled);
  const autoInput = document.getElementById(deviceConfig[type]?.autoId);
  const button = document.getElementById(deviceConfig[type]?.btnId);
  if (autoInput) autoInput.checked = automationStates[type];
  if (button) {
    if (automationStates[type]) button.classList.add('auto-active');
    else button.classList.remove('auto-active');
  }
}

// Envoie la commande MQTT logique pour un équipement ciblé.
function sendDeviceCommand(type, shouldBeOn) {
  const cmd = deviceConfig[type]?.cmd;
  if (!cmd) return;
  socket.emit('cmd', shouldBeOn ? `${cmd}_ON` : `${cmd}_OFF`);
}

// Applique la règle d'automatisation d'un équipement selon télémétrie.
function applyAutomationForDevice(type, telemetry) {
  const thresholds = settingsCache.thresholds;
  let desiredState = null;

  if (type === 'led') {
    const lux = Number(telemetry.luminosite);
    if (!Number.isFinite(lux)) return;
    if (lux <= thresholds.lux.min) desiredState = true;
    else if (lux >= thresholds.lux.max) desiredState = false;
  }

  if (type === 'hum') {
    const soil = Number(telemetry.humidite_sol);
    if (!Number.isFinite(soil)) return;
    if (soil <= thresholds.soil.min) desiredState = true;
    else if (soil >= thresholds.soil.max) desiredState = false;
  }

  if (type === 'fan') {
    const temp = Number(telemetry.temperature);
    if (!Number.isFinite(temp)) return;
    if (temp >= thresholds.temp.max) desiredState = true;
    else if (temp <= thresholds.temp.min) desiredState = false;
  }

  if (desiredState === null || states[type] === desiredState) return;
  setDeviceButtonState(type, desiredState);
  sendDeviceCommand(type, desiredState);
}

// Lance les automations activées pour les 3 équipements pilotables.
function runAutomations(telemetry) {
  if (!isAuthenticated || !telemetry) return;
  if (automationStates.led) applyAutomationForDevice('led', telemetry);
  if (automationStates.hum) applyAutomationForDevice('hum', telemetry);
  if (automationStates.fan) applyAutomationForDevice('fan', telemetry);
}

// Parse un champ numérique de formulaire avec fallback sécurisé.
function parseThresholdInput(elementId, fallbackValue) {
  const parsed = Number(document.getElementById(elementId)?.value);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

// Construit l'objet settings à envoyer au backend depuis le formulaire.
function collectSettingsFromUi() {
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
      },
      rssi: {
        min: parseThresholdInput('rssi-min', settingsCache.thresholds.rssi.min),
        max: parseThresholdInput('rssi-max', settingsCache.thresholds.rssi.max)
      }
    },
    indicators: { ...settingsCache.indicators },
    automations: {
      led: automationStates.led,
      hum: automationStates.hum,
      fan: automationStates.fan
    }
  };
}

// Répercute `settingsCache` vers les champs UI et toggles auto.
function applySettingsToUi() {
  document.getElementById('lux-min').value = settingsCache.thresholds.lux.min;
  document.getElementById('lux-max').value = settingsCache.thresholds.lux.max;
  document.getElementById('soil-min').value = settingsCache.thresholds.soil.min;
  document.getElementById('soil-max').value = settingsCache.thresholds.soil.max;
  document.getElementById('air-min').value = settingsCache.thresholds.air.min;
  document.getElementById('air-max').value = settingsCache.thresholds.air.max;
  document.getElementById('temp-min').value = settingsCache.thresholds.temp.min;
  document.getElementById('temp-max').value = settingsCache.thresholds.temp.max;
  document.getElementById('rssi-min').value = settingsCache.thresholds.rssi.min;
  document.getElementById('rssi-max').value = settingsCache.thresholds.rssi.max;

  setAutomationVisualState('led', settingsCache.automations.led);
  setAutomationVisualState('hum', settingsCache.automations.hum);
  setAutomationVisualState('fan', settingsCache.automations.fan);
}

// Gestion d'un toggle auto : sécurité auth, persist, application immédiate.
async function handleAutomationToggle(type, enabled) {
  if (!isAuthenticated) {
    const autoInput = document.getElementById(deviceConfig[type]?.autoId);
    if (autoInput) autoInput.checked = automationStates[type];
    setLoginError('Veuillez vous connecter pour activer l\'automatisation');
    return;
  }

  setAutomationVisualState(type, enabled);
  settingsCache.automations[type] = automationStates[type];

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
  if (settingsSection) {
    settingsSection.classList.toggle('visible');
    // Recharge les paramètres quand la section devient visible
    if (settingsSection.classList.contains('visible')) {
      loadSettings();
    }
  }
}

socket.on('telemetry', d => {
  // Pipeline front de télémétrie : UI instantanée, historique, sync boutons,
  // puis exécution éventuelle des automatismes.
  if (!d) return;
  latestTelemetry = d;
  const thresholds = settingsCache.thresholds;
  
  // Met à jour les valeurs affichées
  update('lux', d.luminosite || 0, thresholds.lux.min, thresholds.lux.max);
  update('soil', d.humidite_sol || 0, thresholds.soil.min, thresholds.soil.max);
  update('humidity', d.humidite_air || 0, thresholds.air.min, thresholds.air.max);
  update('temp', d.temperature || 0, thresholds.temp.min, thresholds.temp.max);
  update('pressure', d.pressure || 0, 990, 1030);
  update('rssi', d.rssi || -100, thresholds.rssi.min, thresholds.rssi.max);
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
      humidifier_on: d.humidifier_on || false
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
  if (d.humidifier_on !== undefined) {
    setDeviceButtonState('hum', d.humidifier_on);
  }

  runAutomations(d);
});

// === Graphique ===
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
    .then(data => {
      chartData = data;
      renderChart(chartData);
    })
    .catch(err => console.error('Erreur chargement historique:', err));
}

// === Paramètres ===
// Charge les paramètres serveur et les applique au front local.
async function loadSettings() {
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
  try {
    const settings = collectSettingsFromUi();
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

// === Zoom du graphique ===
// On change seulement la hauteur max de l'axe Y pour zoomer simplement.
// Applique la valeur de zoom courante sur l'axe Y.
function applyZoom() {
  if (!chart) return;
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

// Zoom avec la molette de la souris
document.addEventListener('DOMContentLoaded', () => {
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
