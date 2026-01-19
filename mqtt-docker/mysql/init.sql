CREATE TABLE mesures (
  id INT AUTO_INCREMENT PRIMARY KEY,
  luminosite FLOAT,
  humidite_sol FLOAT,
  rssi INT,
  date_mesure TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
