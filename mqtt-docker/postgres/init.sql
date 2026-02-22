-- Liste des comptes utilisateurs
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

-- Liste des appareils ESP32 liés aux utilisateurs
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(100) NOT NULL,
  mac_address VARCHAR(17) UNIQUE NOT NULL,
  mqtt_topic VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen TIMESTAMP,
  is_active BOOLEAN DEFAULT true
);

-- Réglages personnels de l'utilisateur (seuils, alertes)
CREATE TABLE IF NOT EXISTS user_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  alert_email BOOLEAN DEFAULT true,
  alert_threshold_soil INTEGER DEFAULT 30,
  alert_threshold_lux_min INTEGER DEFAULT 500,
  alert_threshold_lux_max INTEGER DEFAULT 10000,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index pour accélérer les recherches
CREATE INDEX idx_devices_user_id ON devices(user_id);
CREATE INDEX idx_devices_mac_address ON devices(mac_address);
CREATE INDEX idx_users_email ON users(email);

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

-- Active la mise à jour automatique de la date sur user_preferences
CREATE TRIGGER update_user_preferences_updated_at BEFORE UPDATE ON user_preferences
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

