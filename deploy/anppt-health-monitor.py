#!/usr/bin/env python3
"""AnPPT 健康监控：服务/API 检查，失败连续 2 次后 SMTP 告警，恢复后通知。"""
import json, glob, re, smtplib, ssl, subprocess, urllib.error, urllib.request, os, time
from email.mime.text import MIMEText
from email.utils import formataddr

STATE_FILE = '/var/lib/anppt-monitor/state.json'
ENV_FILE = '/opt/anppt-v2/shared/.env'
HEALTH_URL = 'https://ppt.an520.xin/api/health'
ALERT_AFTER = 2  # 连续失败次数达到后告警
ALERT_REPEAT_SEC = 3600  # 持续异常时最多每小时再提醒一次，避免刷邮箱
LOG_ALERT_BYTES = 80 * 1024 * 1024  # 应用侧总量上限 100MiB，80MiB 提前告警
PROBLEM_LOG_DIR = os.environ.get('ANPPT_PROBLEM_LOG_DIR') or '/opt/anppt-v2/shared/data/logs'
UPSTREAM_ERROR_WINDOW_SEC = 30 * 60  # 生图上游错误观察窗口
UPSTREAM_LOG_TAIL_BYTES = 256 * 1024  # 只读问题日志尾部，避免每分钟扫大文件
UPSTREAM_TRANSIENT_ALERT = 5  # 非欠费类上游错误，窗口内达到这个次数才报，避免瞬态误报
# 余额/配额类信号：2026-10-31 事故是 HTTP 400 + `Insufficient balance`（大写 I），
# 只认小写 'insufficient balance' 会漏判，所以统一转小写匹配，message 与 detail 都看。
BALANCE_ERROR_MARKERS = (
    'insufficient balance',
    'insufficient_quota',
    'quota exceeded',
    'insufficient funds',
    'billing',
    '余额不足',
    '余额不够',
    '额度不足',
    '欠费',
)


def read_env(key):
    try:
        with open(ENV_FILE) as f:
            for line in f:
                if line.startswith(key + '='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except OSError:
        return ''
    return ''


def is_balance_error(message, detail):
    """余额/配额类错误：402 保持既有行为，其余按词汇集不分大小写匹配 message 与 detail。

    2026-10-31 事故：灾备站欠费返回 HTTP 400 + `Insufficient balance`，旧判定只认
    `'402' in message` 与小写 `'insufficient balance' in detail`，于是被归成「其他错误」，
    要攒够 5 次、等连续 2 轮才告警。余额类只认充值/摘站，必须立即告警。
    """
    text = (str(message) + '\n' + str(detail)).lower()
    # 402 只看 message（既有口径）：detail 是上游原文，base64/请求 id 里出现 '402' 不算欠费。
    if '402' in str(message):
        return True
    return any(marker in text for marker in BALANCE_ERROR_MARKERS)


def _station_from_payload(payload, depth=0):
    """detail 是结构化 JSON 时取 host（其次 site），带上 model；递归限深，不做猜测。"""
    if depth > 3:
        return ''
    if isinstance(payload, dict):
        station = payload.get('host') or payload.get('site')
        if station:
            model = payload.get('model')
            return str(station) + (' ' + str(model) if model else '')
        for value in payload.values():
            found = _station_from_payload(value, depth + 1)
            if found:
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = _station_from_payload(item, depth + 1)
            if found:
                return found
    return ''


def station_label(record):
    """从 problems 日志点名站点：detail 的 host/site 字段 → host=/site= 文本 → message 括注。

    提不到就返回「未知站点」——告警宁可不点名，也不编造一个站点。2026-10-31 事故的
    告警只写「请检查上游状态」，运维还得逐站试探；点名是这次修复的核心诉求。
    """
    message = str(record.get('message') or '')
    detail = str(record.get('detail') or '')
    for candidate in (detail, message):
        try:
            payload = json.loads(candidate)
        except Exception:
            continue
        if isinstance(payload, str):  # detail 可能被双重编码
            try:
                payload = json.loads(payload)
            except Exception:
                continue
        found = _station_from_payload(payload)
        if found:
            return found
    match = re.search(r'(?:host|site)\s*[=:]\s*["\']?([A-Za-z0-9._:-]+)', detail, re.I)
    if match:
        return match.group(1)
    match = re.search(r'（([^（）]{1,80})）', message)
    if match:
        return match.group(1).strip()
    return '未知站点'


def check_image_upstream_errors():
    """最近窗口内的生图上游错误：(余额类次数, 其他错误次数, 样例消息, 余额类站点)。

    2026-10-26 事故：主站与灾备账户同时欠费，20 次 402，10 页生成失败。
    2026-10-31 事故：灾备站欠费返回 HTTP 400 + `Insufficient balance`，被归成其他错误，
    21:40 已发现 10 次却等到 21:45 才发一封不点名站点的邮件。
    问题日志里 category=image-upstream 是唯一不依赖上游 API 形状的证据面，
    所以用日志而不是余额接口做告警，任何供应商都适用。
    """
    cutoff_ms = int((time.time() - UPSTREAM_ERROR_WINDOW_SEC) * 1000)
    balance_errors = 0
    other_errors = 0
    sample = ''
    stations = set()
    for day_offset in (0, 1):  # 窗口跨零点时也要看昨天
        day = time.strftime('%Y-%m-%d', time.localtime(time.time() - day_offset * 86400))
        for path in glob.glob(os.path.join(PROBLEM_LOG_DIR, 'problems-%s*.jsonl' % day)):
            try:
                size = os.path.getsize(path)
                with open(path, 'rb') as f:
                    if size > UPSTREAM_LOG_TAIL_BYTES:
                        f.seek(size - UPSTREAM_LOG_TAIL_BYTES)
                        f.readline()  # 丢掉被截断的半行
                    for raw in f:
                        try:
                            record = json.loads(raw)
                        except Exception:
                            continue
                        if record.get('category') != 'image-upstream':
                            continue
                        if int(record.get('ts') or 0) < cutoff_ms:
                            continue
                        message = str(record.get('message') or '')
                        detail = str(record.get('detail') or '')
                        if is_balance_error(message, detail):
                            balance_errors += 1
                            stations.add(station_label(record))
                        else:
                            other_errors += 1
                        if not sample:
                            sample = (message or detail)[:80]
            except OSError:
                continue
    return balance_errors, other_errors, sample, sorted(stations)


def check_image2ppt_credits():
    key = read_env('ANPPT_V2_IMAGE2PPT_API_KEY')
    if not key:
        return None
    base = (read_env('ANPPT_V2_IMAGE2PPT_BASE_URL') or 'https://image2ppt.com').rstrip('/')
    try:
        req = urllib.request.Request(
            base + '/api/v1/account',
            headers={'Authorization': 'Bearer ' + key, 'Accept': 'application/json'},
        )
        with urllib.request.urlopen(req, timeout=10, context=ssl.create_default_context()) as resp:
            data = json.loads(resp.read())
        credits = int(data.get('credits') or 0)
        if credits < 20:
            return 'Image2PPT 剩余额度仅 %s，请及时充值' % credits
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            return 'Image2PPT API Key 鉴权失败'
        return 'Image2PPT 额度检查失败: HTTP %s' % error.code
    except Exception as error:
        return 'Image2PPT 额度检查失败: ' + str(error)[:60]
    return None


def check_wps_login():
    cookie = read_env('ANPPT_V2_WPS_AIPPT_COOKIE')
    if not cookie:
        return 'WPS AIPPT Cookie 未配置'
    try:
        req = urllib.request.Request(
            'https://account.wps.cn/api/v3/islogin',
            headers={'Cookie': cookie, 'Accept': 'application/json', 'User-Agent': 'anppt-health-monitor'},
        )
        with urllib.request.urlopen(req, timeout=10, context=ssl.create_default_context()) as resp:
            data = json.loads(resp.read())
        if data.get('result') != 'ok' or data.get('userid') is None:
            return 'WPS AIPPT 登录态已失效，请更新 Cookie'
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            return 'WPS AIPPT 登录态鉴权失败，请更新 Cookie'
        return 'WPS AIPPT 登录态检查失败: HTTP %s' % error.code
    except Exception as error:
        return 'WPS AIPPT 登录态检查失败: ' + str(error)[:60]
    return None


def checks():
    problems = []
    # 1. systemd：只盯现行站。slideflow-studio 已 disable、Caddy 不再代理 3300，
    # 不列为存活条件（禁区是不杀不代理，不是假装它还在线上）。
    for svc in ['anppt-v2.service', 'caddy.service']:
        r = subprocess.run(['systemctl', 'is-active', svc], capture_output=True, text=True)
        if r.stdout.strip() != 'active':
            problems.append(svc + ' 未运行')
    # 2. API 健康契约：ok + llm/image/editable.configured + plugins + 可编辑队列
    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(HEALTH_URL, headers={'User-Agent': 'anppt-monitor'})
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
            d = json.loads(resp.read())
            if not d.get('ok'):
                problems.append('health ok=false')
            if not d.get('release') or d.get('release') == 'unknown':
                problems.append('health release 缺失')
            if not d.get('llm', {}).get('configured'):
                problems.append('LLM 未配置')
            if not d.get('image', {}).get('configured'):
                problems.append('生图未配置')
            if not d.get('editable', {}).get('configured'):
                problems.append('可编辑导出未配置')
            logging = d.get('logging')
            if not isinstance(logging, dict) or not logging.get('ok'):
                problems.append('问题日志落盘不可用')
            elif logging.get('recentFailure') and int(logging.get('writeFailures', 0) or 0) > 0:
                problems.append('问题日志写入失败 ' + str(logging.get('writeFailures')) + ' 次（本次进程）')
            if isinstance(logging, dict) and int(logging.get('totalBytes', 0) or 0) > LOG_ALERT_BYTES:
                problems.append('问题日志体积 ' + str(round(int(logging.get('totalBytes', 0) or 0) / 1024 / 1024, 1)) + 'MiB')
            plugins = d.get('plugins')
            # 回滚到无 plugins 字段的旧版是人工动作，不跟着告警；只有显式 error（当前装配坏了）才报。
            if isinstance(plugins, dict) and plugins.get('error'):
                problems.append('插件运行时装配失败: ' + str(plugins.get('error'))[:80])
            editable = d.get('editable', {})
            providers = editable.get('providers') or []
            if editable.get('provider') == 'image2ppt' and 'image2ppt' not in providers:
                problems.append('Image2PPT 主通道未配置')
            if editable.get('provider') == 'wps' and 'wps' not in providers:
                problems.append('WPS AIPPT 主通道未配置')
            queue = editable.get('queue') or {}
            if int(queue.get('oldestActiveAgeMs') or 0) > 45 * 60 * 1000:
                problems.append('可编辑导出在途超过 45 分钟')
            if int(queue.get('failedLastHour') or 0) >= 3 and int(queue.get('succeededLastHour') or 0) == 0:
                problems.append('可编辑导出一小时内连续失败且无成功')
            if 'image2ppt' in providers:
                credit_problem = check_image2ppt_credits()
                if credit_problem:
                    problems.append(credit_problem)
            if 'wps' in providers:
                wps_problem = check_wps_login()
                if wps_problem:
                    problems.append(wps_problem)
    except Exception as e:
        problems.append('health 请求失败: ' + str(e)[:80])
    # 3. 磁盘
    r = subprocess.run(['df', '-P', '/'], capture_output=True, text=True)
    lines = r.stdout.strip().split('\n')
    pct = int(lines[1].split()[4].rstrip('%'))
    if pct > 90:
        problems.append('磁盘使用 ' + str(pct) + '%')
    # 4. anppt-v2 每日备份新鲜度（26 小时内必须有新备份）
    try:
        bd = '/opt/anppt-v2/backups/daily'
        newest = max(os.path.getmtime(os.path.join(bd, d)) for d in os.listdir(bd))
        if (time.time() - newest) > 26 * 3600:
            problems.append('anppt-v2 备份超过 26 小时未更新')
    except Exception as e:
        problems.append('anppt-v2 备份检查失败: ' + str(e)[:60])
    # 5. 生图上游错误（2026-10-26 402、2026-10-31 400 欠费两次事故的回归闸）：
    #    余额/配额类只认充值或摘站，攒次数没有意义 → 立即告警并点名站点；
    #    真正的上游抖动/非法请求仍攒够次数才报，避免瞬态误报。
    balance_errors, other_errors, sample, balance_stations = check_image_upstream_errors()
    urgent = bool(balance_errors)
    if balance_errors:
        problems.append(
            '生图上游余额不足/配额耗尽最近 %d 分钟出现 %d 次（站点：%s）：用户页面会生成失败，'
            '请给该站充值或临时摘站（402，以及 400/200 错误体里的 Insufficient balance/余额不足 都算此类）'
            % (
                UPSTREAM_ERROR_WINDOW_SEC // 60,
                balance_errors,
                '、'.join(balance_stations) if balance_stations else '未知站点',
            )
        )
    elif other_errors >= UPSTREAM_TRANSIENT_ALERT:
        problems.append(
            '生图上游最近 %d 分钟错误 %d 次（%s），请检查上游状态'
            % (UPSTREAM_ERROR_WINDOW_SEC // 60, other_errors, sample or '无详情')
        )
    return problems, urgent


def send_mail(subject, body):
    host = read_env('SMTP_HOST')
    port = int(read_env('SMTP_PORT') or '465')
    user = read_env('SMTP_USER')
    pwd = read_env('SMTP_PASS')
    to = '366150820@qq.com'
    if not (host and user and pwd):
        print('邮件未发: SMTP 未配齐')
        return False
    msg = MIMEText(body, 'plain', 'utf-8')
    msg['Subject'] = subject
    # QQ 要求 From 等于登录邮箱；中文显示名必须 RFC2047 编码，不能把 SMTP_FROM 原文塞进头。
    msg['From'] = formataddr(('AnPPT 监控', user))
    msg['To'] = to
    try:
        with smtplib.SMTP_SSL(host, port, timeout=15, context=ssl.create_default_context()) as s:
            s.login(user, pwd)
            s.sendmail(user, [to], msg.as_string())
        return True
    except Exception as e:
        print('邮件发送失败:', type(e).__name__, str(e)[:160].replace(pwd, '[redacted]').replace(user, '[user]'))
        return False


def main():
    os.makedirs('/var/lib/anppt-monitor', exist_ok=True)
    state = {}
    try:
        with open(STATE_FILE) as f:
            state = json.load(f)
    except Exception:
        pass
    problems, urgent = checks()
    fail_count = int(state.get('fail_count', 0) or 0)
    last_alert_at = float(state.get('last_alert_at', 0) or 0)
    now = time.time()
    stamp = time.strftime('%F %T')
    if problems:
        fail_count += 1
        print(stamp, '问题:', problems)
        # 余额类不等 ALERT_AFTER（2026-10-31：21:38 首次失败，21:40 已攒够 10 次仍按「连续 2 轮」等）。
        if urgent or fail_count >= ALERT_AFTER:
            due = last_alert_at <= 0 or (now - last_alert_at) >= ALERT_REPEAT_SEC
            if due:
                reason = '余额类立即告警' if urgent else '连续 ' + str(fail_count) + ' 次'
                body = 'AnPPT 监控告警（' + reason + '）：\n\n' + '\n'.join(problems)
                sent = send_mail('[AnPPT] 服务异常告警', body)
                print(stamp, '告警发送:', sent)
                if sent:
                    last_alert_at = now
            else:
                print(stamp, '告警抑制: 距上次不足 %ss' % ALERT_REPEAT_SEC)
    else:
        if fail_count > 0:
            sent = send_mail('[AnPPT] 服务已恢复', 'AnPPT 所有检查已恢复正常。')
            print(stamp, '恢复通知:', sent)
        fail_count = 0
        last_alert_at = 0
        print(stamp, '全部正常')
    state['fail_count'] = fail_count
    state['last_alert_at'] = last_alert_at
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f)


if __name__ == '__main__':
    main()
