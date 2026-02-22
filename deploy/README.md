# Déploiement serveur physique (auto-update GitHub)

Ce dossier permet de mettre à jour automatiquement le code depuis GitHub et de rebuild/restart les conteneurs Docker sans action manuelle.

## Principe

- Un script `deploy/autoupdate.sh` vérifie les nouveaux commits sur le dépôt GitHub.
- Si une nouvelle version est trouvée, il fait un `git pull --ff-only`.
- Ensuite, il exécute `docker compose up -d --build --remove-orphans`.
- Un timer `systemd` relance cette vérification à intervalle régulier.

## 1) Préparer le serveur (une fois)

```bash
sudo mkdir -p /opt
cd /opt
sudo git clone <URL_GITHUB_DU_REPO> esp32-iot-plant
cd esp32-iot-plant
sudo cp .env.example .env
```

Configurer ensuite les secrets dans `.env`.

## 2) Préparer les droits

```bash
cd /opt/esp32-iot-plant
sudo chmod +x deploy/autoupdate.sh
sudo usermod -aG docker deploy
```

> Remplace `deploy` par ton utilisateur Linux si besoin.

## 3) Installer le service systemd

1. Édite `deploy/systemd/esp32-iot-autoupdate.service` et adapte :
   - `WorkingDirectory`
   - `ExecStart`
   - `User`
   - `Environment=AUTOUPDATE_BRANCH=...` (ex: `main`)

2. Installer et activer :

```bash
cd /opt/esp32-iot-plant
sudo cp deploy/systemd/esp32-iot-autoupdate.service /etc/systemd/system/
sudo cp deploy/systemd/esp32-iot-autoupdate.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now esp32-iot-autoupdate.timer
```

## 4) Vérifier

```bash
systemctl status esp32-iot-autoupdate.timer
systemctl list-timers | grep esp32-iot-autoupdate
sudo systemctl start esp32-iot-autoupdate.service
journalctl -u esp32-iot-autoupdate.service -n 100 --no-pager
```

## Variables supportées

Dans le service `systemd` :

- `AUTOUPDATE_REMOTE` (défaut: `origin`)
- `AUTOUPDATE_BRANCH` (défaut: branche courante)
- `AUTOUPDATE_COMPOSE_FILE` (défaut: `docker-compose.yml`)
- `AUTOUPDATE_PRUNE_IMAGES` (`1` pour activer `docker image prune -f`)

## Notes importantes

- Le script utilise un lock (`flock`) pour éviter deux runs simultanés.
- Le `git pull` est en `--ff-only` pour éviter les merges automatiques inattendus.
- Fréquence actuelle du timer: toutes les 2 minutes (`OnUnitActiveSec=2min`).
