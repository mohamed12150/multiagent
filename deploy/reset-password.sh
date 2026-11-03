#!/usr/bin/env bash
# تصفير كلمة مرور حساب في Qhub Smart Marketing — يُشغَّل على السيرفر بصلاحية root:
#   bash reset-password.sh <email>
# يولّد كلمة مرور جديدة عشوائية ويطبعها في الطرفية (لمن شغّل الأمر فقط)، ويصفّر عداد القفل.
set -euo pipefail

EMAIL="${1:?Usage: reset-password.sh <email> [new-password]}"
WANTED="${2:-}"
APP=/var/www/vhosts/qub-sa.com/qhub-smart-marketing
set -a; . /etc/qsm/qsm.env; set +a
cd "$APP"

"$APP/.venv/bin/python" - "$EMAIL" "$WANTED" <<'PY'
import secrets
import sys

from sqlalchemy import select

from qsm import db, security
from qsm.models import User

email = sys.argv[1].strip().lower()
wanted = sys.argv[2].strip() if len(sys.argv) > 2 else ""
db.init_db()
if wanted:
    if len(wanted) < 6:
        print("كلمة المرور قصيرة جدًا — 6 أحرف على الأقل")
        raise SystemExit(1)
    new_pw = wanted
else:
    # أحرف وأرقام لا تلتبس عند الكتابة اليدوية (بلا O/0 أو l/1 أو أحرف كبيرة)
    ABC = "abcdefghjkmnpqrstuvwxyz23456789"
    new_pw = "-".join("".join(secrets.choice(ABC) for _ in range(4)) for _ in range(3))
with db.session() as s:
    user = s.scalars(select(User).where(User.email == email)).one_or_none()
    if user is None:
        print(f"لا يوجد حساب بالبريد: {email}")
        print("الحسابات الموجودة:", ", ".join(u.email for u in s.scalars(select(User)).all()) or "لا حسابات بعد")
        raise SystemExit(1)
    user.password_hash = security.hash_password(new_pw)
    user.failed_logins = 0
    user.locked_until = None
    name = user.name or user.username or email

print(f"تم تصفير كلمة مرور: {name} ({email})")
if wanted:
    print("تم تعيين كلمة المرور التي اخترتها — ادخل بها الآن")
else:
    print("كلمة المرور الجديدة (اكتبها بيدك حرفًا حرفًا، كلها أحرف صغيرة):")
    print(new_pw)
print("يُستحسن تغييرها بعد الدخول من: الإعدادات › الحساب")
PY

# ملفات القاعدة يجب أن تبقى ملكًا لمستخدم الخدمة حتى لو شُغّل السكربت بـ root
chown qsm:qsm "$QSM_DATA_DIR"/qsm.db* 2>/dev/null || true
