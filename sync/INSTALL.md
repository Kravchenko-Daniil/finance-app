# Установка двустороннего sync через cron в WSL

## 1. Убедись что cron работает в WSL

```bash
sudo service cron status
```

Если `cron is not running` — стартуй:

```bash
sudo service cron start
```

Чтобы стартовал автоматом при запуске WSL, добавь в `/etc/wsl.conf`:

```ini
[boot]
command="service cron start"
```

После правки — перезапусти WSL: в PowerShell `wsl --shutdown`.

## 2. Установи crontab-задачу

```bash
crontab -e
```

Добавь строку:

```
*/5 * * * * /mnt/d/proj/my-finans/sync/pull.sh
```

## 3. Проверь что работает

Подожди 5 минут (или запусти руками: `/mnt/d/proj/my-finans/sync/pull.sh`), потом:

```bash
cat /tmp/my-finance-sync.log
```

Должна быть запись с timestamp и (если ничего не менялось) пустые pull/push.

## 4. Auth для git push

Так как `origin` теперь HTTPS GitHub, push требует токен. Варианты:

**A. Использовать `gh auth` credential helper** (если уже залогинен):

```bash
gh auth setup-git
```

**B. Cache credentials** (одноразово вводишь, дальше живёт):

```bash
git config --global credential.helper "cache --timeout=86400000"
```

После первого push введёшь GitHub username + PAT, и помнится.

Для проверки запусти `pull.sh` руками — он попытается push, и если auth не настроен, увидишь ошибку в логе.
