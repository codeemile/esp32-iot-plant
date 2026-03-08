// ============================================================================
// Front UI Layer (DOM only)
// ----------------------------------------------------------------------------
// Ce fichier ne fait que de la manipulation visuelle:
// - affichage/masquage de blocs
// - classes CSS d'etat
// - synchronisation champs <-> etat local
// Aucune logique reseau/API metier ne vit ici.
// ============================================================================

// --- Auth Panel UI -----------------------------------------------------------
// Affiche ou masque un message d'erreur dans le panneau d'authentification.
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

// Bascule les champs du login panel selon le mode courant (bootstrap/login).
function updateAuthModeUi() {
  const loginToggle = document.getElementById('login-toggle-btn');
  const emailInput = document.getElementById('email');
  const confirmInput = document.getElementById('password-confirm');
  const hint = document.getElementById('auth-mode-hint');

  const isBootstrap = authMode === 'bootstrap';

  if (loginToggle) {
    loginToggle.textContent = isBootstrap ? 'Creation de compte' : 'Connexion';
  }
  if (emailInput) {
    emailInput.style.display = isBootstrap ? 'block' : 'none';
    emailInput.required = isBootstrap;
  }
  if (confirmInput) {
    confirmInput.style.display = isBootstrap ? 'block' : 'none';
    confirmInput.required = isBootstrap;
  }
  if (hint) {
    hint.textContent = isBootstrap
      ? 'Premiere initialisation: creez votre compte.'
      : 'Connectez-vous avec votre compte existant.';
  }
}

// Active les controles sensibles (boutons + toggles auto) une fois authentifie.
function enableButtons() {
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

// Desactive les controles sensibles pour un utilisateur non authentifie.
function disableButtons() {
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

// Rend l'etat "connecte": chip utilisateur + bouton deconnexion.
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
      <button type="button" class="user-chip" onclick="toggleProfileSection()" title="Ouvrir le profil">👤 ${currentUsername}</button>
      <button class="logout-btn" onclick="logout()">Deconnexion</button>
    `;
  }
}

// --- Profile UI --------------------------------------------------------------
// Message de retour dans le panneau profil (success/error).
function setProfileMessage(msg, isError = false) {
  const el = document.getElementById('profile-message');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = isError ? '#ef4444' : '#94a3b8';
}

// Formate les timestamps ISO pour l'affichage utilisateur.
function formatTimestamp(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('fr-FR');
}

// --- Sensor Bubbles UI -------------------------------------------------------
// Met a jour une bulle capteur (valeur + couleur de severite).
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

// Met a jour l'indicateur de niveau d'eau (plein/vide/inconnu).
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

// --- Device Buttons UI -------------------------------------------------------
// Repercute l'etat on/off d'un equipement sur son bouton circulaire.
function setDeviceButtonState(type, isOn) {
  states[type] = Boolean(isOn);
  const button = document.getElementById(deviceConfig[type]?.btnId);
  if (!button) return;
  if (states[type]) button.classList.add('on');
  else button.classList.remove('on');
}

// Synchronise le rendu du mode auto (checkbox + badge visuel bouton).
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

// --- Settings Form UI --------------------------------------------------------
// Ecrit une valeur dans un input si l'element existe dans le DOM.
function setInputValueIfExists(elementId, value) {
  const element = document.getElementById(elementId);
  if (!element) return;
  element.value = value;
}

// Repercute tout settingsCache dans les champs, toggles et boutons d'alertes.
function applySettingsToUi() {
  if (!ensureSettingsReady()) return;
  setInputValueIfExists('lux-min', settingsCache.thresholds.lux.min);
  setInputValueIfExists('lux-max', settingsCache.thresholds.lux.max);
  setInputValueIfExists('soil-min', settingsCache.thresholds.soil.min);
  setInputValueIfExists('soil-max', settingsCache.thresholds.soil.max);
  setInputValueIfExists('air-min', settingsCache.thresholds.air.min);
  setInputValueIfExists('air-max', settingsCache.thresholds.air.max);
  setInputValueIfExists('temp-min', settingsCache.thresholds.temp.min);
  setInputValueIfExists('temp-max', settingsCache.thresholds.temp.max);
  setInputValueIfExists('led-duration', sanitizeDuration('led', settingsCache.automationDurations.led));
  setInputValueIfExists('hum-duration', sanitizeDuration('hum', settingsCache.automationDurations.hum));
  setInputValueIfExists('fan-duration', sanitizeDuration('fan', settingsCache.automationDurations.fan));

  for (const metric of NOTIFICATION_METRICS) {
    const rule = settingsCache.alerts?.rules?.[metric] || NOTIFICATION_RULE_DEFAULTS;
    setInputValueIfExists(`notif-start-${metric}`, rule.startDelaySec);
    setInputValueIfExists(`notif-repeat-${metric}`, rule.repeatIntervalSec);
    setInputValueIfExists(`notif-delta-${metric}`, rule.mailDelayMin);
    setInputValueIfExists(`notif-reset-${metric}`, rule.recoveryResetSec);
    updateNotificationRuleButtons(metric);
  }

  setAutomationVisualState('led', settingsCache.automations.led);
  setAutomationVisualState('hum', settingsCache.automations.hum);
  setAutomationVisualState('fan', settingsCache.automations.fan);
  updateThresholdAlertButton('lux');
  updateThresholdAlertButton('soil');
  updateThresholdAlertButton('air');
  updateThresholdAlertButton('temp');
}
