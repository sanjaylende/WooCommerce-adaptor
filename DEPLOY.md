# Deploying

The earlier runbook in this file described a single-store setup run as `ec2-user` (and `deploy/deploy.sh`, `deploy/start.sh` and
the `ec2-user` service unit were removed with it). Use these instead:

| What | Where |
|---|---|
| Architecture, configuration (`.env.example`), WooCommerce specifics | `README.md` and `docs/adapters/woocommerce.md` |
| Local WooCommerce + WordPress test stack | `infra/woocommerce/README.md` |
| Hardened service unit (`/opt/flipick-woocommerce-adapter`) | `deploy/systemd/flipick-woocommerce-adapter.service` |
| nginx in front, Cloudflare-only access, admin and callback allow-lists | `deploy/nginx/` and `docs/security/CLOUDFLARE-SETUP.md` |
| Database TLS, roles, `pg_hba.conf` | `docs/security/DATABASE.md` |
| Backups and the monthly restore test | `scripts/backup/` and `docs/security/OPERATIONS.md` |
| Alerts and monitoring | `docs/security/ALERT-RULES.md` |
| Host protection (file-change monitoring, antivirus, brute-force blocking) | `docs/security/HOST-PROTECTION.md` |
| Reporting a vulnerability | `docs/security/REPORTING.md` and `/.well-known/security.txt` |
