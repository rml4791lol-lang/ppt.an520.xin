#!/usr/bin/env python3
"""AnPPT 健康监控：服务/API 检查，失败连续 2 次后 SMTP 告警，恢复后通知。"""
import json, smtplib, ssl, subprocess, urllib.error, urllib.request, os, time
from email.mime.text import MIMEText
from email.utils import formataddr

STATE_FILE = '/var/lib/anppt-monitor/state.json'
ENV_FILE = '/opt/anppt-v2/shared/.env'
HEALTH_URL = 'https://ppt.an520.xin/api/health'
ALERT_AFTER = 2  # 连续失败次数达到后告警
ALERT_REPEAT_SEC = 3600  # 持续异常时最多每小时再提醒一次，避免刷邮箱


def read_env(key):
    try:
        with open(ENV_FILE) as f:
            for line in f:
                if line.startswith(key + '='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except OSError:
        return ''
    return ''


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


def checks():
    problems = []
    # 1. systemd：只盯现行站。slideflow-studio 已 disable、Caddy 不再代理 3300，
    # 不列为存活条件（禁区是不杀不代理，不是假装它还在线上）。
    for svc in ['anppt-v2.service', 'caddy.service']:
        r = subprocess.run(['systemctl', 'is-active', svc], capture_output=True, text=True)
        if r.stdout.strip() != 'active':
            problems.append(svc + ' 未运行')
    # 2. API 健康契约：ok + llm/image/editable.configured + 可编辑队列
    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(HEALTH_URL, headers={'User-Agent': 'anppt-monitor'})
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
            d = json.loads(resp.read())
            if not d.get('ok'):
                problems.append('health ok=false')
            if not d.get('llm', {}).get('configured'):
                problems.append('LLM 未配置')
            if not d.get('image', {}).get('configured'):
                problems.append('生图未配置')
            if not d.get('editable', {}).get('configured'):
                problems.append('可编辑导出未配置')
            editable = d.get('editable', {})
            providers = editable.get('providers') or []
            if editable.get('provider') == 'image2ppt' and 'image2ppt' not in providers:
                problems.append('Image2PPT 主通道未配置')
            queue = editable.get('queue') or {}
            if int(queue.get('oldestActiveAgeMs') or 0) > 45 * 60 * 1000:
                problems.append('可编辑导出在途超过 45 分钟')
            if int(queue.get('failedLastHour') or 0) >= 3 and int(queue.get('succeededLastHour') or 0) == 0:
                problems.append('可编辑导出一小时内连续失败且无成功')
            if 'image2ppt' in providers:
                credit_problem = check_image2ppt_credits()
                if credit_problem:
                    problems.append(credit_problem)
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
    return problems


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
    problems = checks()
    fail_count = int(state.get('fail_count', 0) or 0)
    last_alert_at = float(state.get('last_alert_at', 0) or 0)
    now = time.time()
    stamp = time.strftime('%F %T')
    if problems:
        fail_count += 1
        print(stamp, '问题:', problems)
        if fail_count >= ALERT_AFTER:
            due = last_alert_at <= 0 or (now - last_alert_at) >= ALERT_REPEAT_SEC
            if due:
                body = 'AnPPT 监控告警（连续 ' + str(fail_count) + ' 次）：\n\n' + '\n'.join(problems)
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
