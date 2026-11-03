#!/usr/bin/env bash
# إعداد سيرفر QHub (Plesk) لتشغيل Qhub Smart Marketing — يُشغَّل على السيرفر بصلاحية root مرة واحدة:
#   sudo bash <app-dir>/deploy/setup-server.sh <domain> [app-dir]
# مثال:
#   sudo bash /var/www/vhosts/qub-sa.com/qhub-smart-marketing/deploy/setup-server.sh mk.qub-sa.com
#
# لا يثبت nginx ولا شهادات — ذلك يُدار من Plesk (انظر plesk-nginx-directives.txt).
# لا يلمس خدمات QHub الأخرى (qhub, qhub-wa-engine, qhub-wa-queue) ولا httpdocs.
set -euo pipefail

DOMAIN="${1:?Usage: setup-server.sh <domain> [app-dir]}"
APP="${2:-/var/www/vhosts/qub-sa.com/qhub-smart-marketing}"
DATA="$(dirname "$APP")/qsm-data"
ENVFILE=/etc/qsm/qsm.env
SVC=qhub-smart-marketing

[ -d "$APP" ] || { echo "خطأ: $APP غير موجود — ارفع الكود أولًا (deploy/upload.sh)"; exit 1; }

echo "== بايثون 3.13+ =="
PY=""
for cand in python3.14 python3.13; do
  command -v "$cand" >/dev/null 2>&1 && { PY=$(command -v "$cand"); break; }
done
if [ -z "$PY" ]; then
  v=$(python3 -c 'import sys; print(sys.version_info[0]*100+sys.version_info[1])' 2>/dev/null || echo 0)
  [ "$v" -ge 313 ] && PY=$(command -v python3)
fi
if [ -z "$PY" ]; then
  echo "خطأ: لا يوجد Python 3.13+ على السيرفر. تثبيته قرار يُعرض على المالك أولًا (قاعدة CLAUDE.md)."
  exit 1
fi
echo "Python: $PY ($("$PY" --version))"

echo "== ffmpeg (اختياري للمعاينات) =="
command -v ffmpeg >/dev/null 2>&1 && echo "موجود" || echo "غير موجود — المنصة تعمل بدونه (بلا معاينة مقاطع)"

echo "== مستخدم الخدمة والمجلدات =="
id -u qsm >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin qsm
mkdir -p "$DATA" /etc/qsm
chown -R qsm:qsm "$APP" "$DATA"

echo "== البيئة الافتراضية =="
sudo -u qsm "$PY" -m venv "$APP/.venv"
sudo -u qsm "$APP/.venv/bin/pip" install -q --upgrade pip
sudo -u qsm "$APP/.venv/bin/pip" install -q -r "$APP/requirements.txt" tzdata

echo "== ملف البيئة (يُنشأ مرة واحدة ولا يُستبدل) =="
if [ ! -f "$ENVFILE" ]; then
  SECRET=$("$APP/.venv/bin/python" -c "import secrets; print(secrets.token_urlsafe(48))")
  MASTER=$("$APP/.venv/bin/python" -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")
  SETUP=$("$APP/.venv/bin/python" -c "import secrets; print(secrets.token_urlsafe(24))")
  cat > "$ENVFILE" <<EOF
QSM_ENV=production
QSM_HOST=127.0.0.1
QSM_PORT=8820
QSM_DATA_DIR=$DATA
QSM_PUBLIC_BASE_URL=https://$DOMAIN
QSM_SECRET_KEY=$SECRET
QSM_MASTER_KEY=$MASTER
QSM_SETUP_TOKEN=$SETUP
EOF
  chmod 600 "$ENVFILE"
  echo ""
  echo ">>> رمز الإعداد الأول (QSM_SETUP_TOKEN) — يُطلب مرة واحدة عند إنشاء حساب المالك:"
  echo ">>>   $SETUP"
  echo ""
fi

echo "== خدمة systemd ($SVC) =="
sed -e "s|__APP_DIR__|$APP|g" -e "s|__DATA_DIR__|$DATA|g" \
    "$APP/deploy/qhub-smart-marketing.service" > "/etc/systemd/system/$SVC.service"
systemctl daemon-reload
systemctl enable --now "$SVC"
sleep 3
systemctl is-active "$SVC" && curl -s -o /dev/null -w "محليًا: HTTP %{http_code}\n" http://127.0.0.1:8820/

echo ""
echo "بقي في Plesk (يدويًا أو بسطرين CLI):"
echo "  1) ساب دومين $DOMAIN بشهادة Let's Encrypt"
echo "  2) لصق توجيهات deploy/plesk-nginx-directives.txt في Additional nginx directives"
echo "ثم افتح https://$DOMAIN وأنشئ حساب المالك برمز الإعداد أعلاه."
