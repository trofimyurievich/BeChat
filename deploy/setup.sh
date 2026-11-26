#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
# The working encryption key belongs to the stored messenger and SMS sessions.
source_file=.env.example
if [[ -e .env ]]; then
    if grep -Eq "^AMO_CLIENT_SECRET=.+|^AMO_CLIENT_ID=.+" .env; then
        echo "Интеграция уже заполнена. Откройте .env на сервере для изменения существующего подключения."
        exit 1
    fi
    source_file=.env
fi
exec 9>.env.setup.lock
flock -n 9 || { echo 'Настройка уже открыта в другом окне.'; exit 1; }
if [[ $source_file == .env && ! -f .env ]]; then exit 1; fi
if [[ -f .env ]] && grep -Eq "^AMO_CLIENT_SECRET=.+|^AMO_CLIENT_ID=.+" .env; then exit 1; fi
printf '%s\n' 'Настройка BeChat для bechat.onbequick.ru и lcns.amocrm.ru.'
read -rp 'ID аккаунта amoCRM (число): ' tenant
read -rp 'ID пользователя-учредителя в amoCRM (число): ' founder
read -rp 'ID интеграции (UUID): ' client
read -rsp 'Секретный ключ интеграции: ' client_secret; echo
[[ "$tenant" =~ ^[1-9][0-9]*$ && "$founder" =~ ^[1-9][0-9]*$ ]] || { echo 'Нужны числовые ID из amoCRM.'; exit 1; }
[[ "$client" =~ ^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$ && -n "$client_secret" && "$client_secret" != *"'"* ]] || { echo 'Проверьте ID интеграции и секрет. Для ключа с апострофом заполните .env вручную.'; exit 1; }
file=$(mktemp .env.setup.XXXXXX)
trap 'rm -f -- "$file"' EXIT
while IFS= read -r line || [[ -n "$line" ]]; do
 case "$line" in
   AMO_TENANT_ID=*) echo "AMO_TENANT_ID=$tenant";;
   BECHAT_FOUNDER_ID=*) echo "BECHAT_FOUNDER_ID=$founder";;
   AMO_CLIENT_ID=*) echo "AMO_CLIENT_ID=$client";;
   AMO_CLIENT_SECRET=*) printf "AMO_CLIENT_SECRET='%s'\n" "$client_secret";;
   BECHAT_ACCOUNT_KEY=) printf 'BECHAT_ACCOUNT_KEY=%s\n' "$(openssl rand -base64 32)";;
   *) printf '%s\n' "$line";;
 esac
done < "$source_file" > "$file"
mv -- "$file" .env
echo 'Настройки сохранены. Выполните docker compose up -d --force-recreate app.'
