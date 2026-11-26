#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -e .env ]]; then
  echo "Файл .env уже есть. Для изменения действующих настроек откройте его в редакторе."
  exit 1
fi
umask 077
printf '%s\n' 'Настройка BeChat для bechat.onbequick.ru и lcns.amocrm.ru.'
read -rp 'ID аккаунта amoCRM (число): ' tenant
read -rp 'ID пользователя-учредителя в amoCRM (число): ' founder
read -rp 'ID интеграции (UUID): ' client
read -rsp 'Секретный ключ интеграции: ' client_secret; echo
[[ "$tenant" =~ ^[1-9][0-9]*$ && "$founder" =~ ^[1-9][0-9]*$ ]] || { echo 'Нужны числовые ID из amoCRM.'; exit 1; }
[[ "$client" =~ ^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$ && -n "$client_secret" && "$client_secret" != *"'"* ]] || { echo 'Проверьте ID интеграции и секрет. Для ключа с апострофом заполните .env вручную.'; exit 1; }
key=$(openssl rand -base64 32)
file=$(mktemp .env.setup.XXXXXX)
trap 'rm -f -- "$file"' EXIT
while IFS= read -r line || [[ -n "$line" ]]; do
 case "$line" in
   AMO_TENANT_ID=*) echo "AMO_TENANT_ID=$tenant";;
   BECHAT_FOUNDER_ID=*) echo "BECHAT_FOUNDER_ID=$founder";;
   AMO_CLIENT_ID=*) echo "AMO_CLIENT_ID=$client";;
   AMO_CLIENT_SECRET=*) printf "AMO_CLIENT_SECRET='%s'\n" "$client_secret";;
   BECHAT_ACCOUNT_KEY=*) echo "BECHAT_ACCOUNT_KEY=$key";;
   *) printf '%s\n' "$line";;
 esac
done < .env.example > "$file"
ln "$file" .env || { echo 'Файл .env уже создан в другом процессе.'; exit 1; }
echo 'Настройки записаны в .env. Сохраните защищённую копию этого файла вместе с резервной копией базы.'

