#!/bin/bash
# Bench with ERPNext v15 and this app, for .github/workflows/server-tests.yml.
# MariaDB runs on the runner itself (installed by the workflow), so the site's database
# user created for localhost can connect.
set -eo pipefail
exec > >(tee -a ~/install.log) 2>&1

# Authenticated git for github.com clones (anonymous clones from runners get throttled).
if [ -n "$GITHUB_TOKEN" ]; then
  export GIT_CONFIG_COUNT=2
  export GIT_CONFIG_KEY_0="credential.https://github.com.username"
  export GIT_CONFIG_VALUE_0="x-access-token"
  export GIT_CONFIG_KEY_1="credential.https://github.com.helper"
  export GIT_CONFIG_VALUE_1='!f() { test "$1" = get && echo "password=$GITHUB_TOKEN"; }; f'
fi
export GIT_TERMINAL_PROMPT=0

cd ~
bench init --skip-assets --skip-redis-config-generation --frappe-branch version-15 --python "$(which python)" frappe-bench
cd ~/frappe-bench
sed -i 's/^watch:/# watch:/g; s/^schedule:/# schedule:/g; s/^socketio:/# socketio:/g; s/^redis_socketio:/# redis_socketio:/g' Procfile || true
bench set-config -g redis_cache redis://127.0.0.1:6379
bench set-config -g redis_queue redis://127.0.0.1:6379
bench set-config -g redis_socketio redis://127.0.0.1:6379

bench get-app --skip-assets --branch version-15 payments https://github.com/frappe/payments
bench get-app --skip-assets --branch version-15 erpnext https://github.com/frappe/erpnext
bench get-app --skip-assets warehouse_theatre_3d "${GITHUB_WORKSPACE}"

bench new-site test_site --db-root-password root --admin-password admin
bench --site test_site set-config allow_tests true
bench --site test_site install-app payments
bench --site test_site install-app erpnext
bench --site test_site install-app warehouse_theatre_3d
bench --site test_site list-apps
