-- Compte utilisateur unique (mode mono-user)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP,
  is_active BOOLEAN DEFAULT true
);

-- Verrouille la table users en mode mono-compte: 1 ligne maximum.
CREATE UNIQUE INDEX IF NOT EXISTS users_singleton_one_row_idx ON users ((1));

-- Réglages mono-user: seuils par métrique
CREATE TABLE IF NOT EXISTS settings_thresholds (
  metric VARCHAR(16) PRIMARY KEY,
  min_value DOUBLE PRECISION NOT NULL,
  max_value DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Réglages mono-user: automations par équipement
CREATE TABLE IF NOT EXISTS settings_automations (
  device VARCHAR(16) PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  duration_sec INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Réglages mono-user: notifications par métrique
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
);

-- Met automatiquement la date de modification à chaque changement
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Active la mise à jour automatique de la date sur la table users
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Active la mise à jour automatique de la date sur settings_thresholds
CREATE TRIGGER update_settings_thresholds_updated_at BEFORE UPDATE ON settings_thresholds
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Active la mise à jour automatique de la date sur settings_automations
CREATE TRIGGER update_settings_automations_updated_at BEFORE UPDATE ON settings_automations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Active la mise à jour automatique de la date sur settings_notifications
CREATE TRIGGER update_settings_notifications_updated_at BEFORE UPDATE ON settings_notifications
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

