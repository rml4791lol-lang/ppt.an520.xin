#!/usr/bin/env python3
"""#48 监控分类 fixture（python3 直跑、零网络、零第三方依赖）。

直接 import deploy/anppt-health-monitor.py 验证真实分类逻辑（只读，不修改它）：
- is_balance_error：Insufficient balance / 余额不足 / HTTP 402 → 余额类；HTTP 400 + 别的文案 → 通用类。
- station_label：从 problems 日志 detail 提取站点 host（结构化 JSON → host=/site= 文本 → message 括注）。
- check_image_upstream_errors：固定样本落盘后的余额/通用计数与站点去重。
- checks()：余额类告警文案点名站点、urgent=True 跳过连续 2 次节流；通用类不误报余额。

2026-10-31 事故：灾备站欠费返回 HTTP 400 + `Insufficient balance`，旧分类大小写敏感且只看
detail，被判成「其他错误」，要攒 5 次、等连续 2 轮才告警；400 还被生成链映射成「内容太长」。
ops 改完 deploy/anppt-health-monitor.py 后本文件必须保持绿；脚本若再重构，按报错同步本
fixture —— 不要反过来改生产脚本来迁就测试。
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from types import SimpleNamespace

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MONITOR_PATH = os.path.join(REPO, 'deploy', 'anppt-health-monitor.py')

passed = 0
failed = 0
failures = []


def check(name, condition, detail=''):
    global passed, failed
    if condition:
        passed += 1
        print('  ✓ ' + name)
    else:
        failed += 1
        failures.append(name + (('：' + detail) if detail else ''))
        print('  ✗ ' + name + (('：' + detail) if detail else ''))


def load_monitor():
    spec = importlib.util.spec_from_file_location('anppt_health_monitor_fixture', MONITOR_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def station_detail(host, model, upstream, status=400, balance=True):
    """core 当前落盘形状：detail 是 JSON 字符串，含 site/host/model/status/balance/upstream。"""
    return json.dumps({
        'site': 'backup',
        'host': host,
        'model': model,
        'status': status,
        'balance': balance,
        'upstream': json.dumps({'error': {'message': upstream}}, ensure_ascii=False),
    }, ensure_ascii=False)


def problem_record(message, detail, category='image-upstream'):
    return {
        'ts': int(time.time() * 1000),
        'category': category,
        'level': 'error',
        'message': message,
        'detail': detail,
    }


def write_log(log_dir, records):
    day = time.strftime('%Y-%m-%d', time.localtime())
    path = os.path.join(log_dir, 'problems-%s.jsonl' % day)
    with open(path, 'w', encoding='utf-8') as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + '\n')
    return path


def fake_subprocess_run(command, **kwargs):
    if command and command[0] == 'systemctl':
        return SimpleNamespace(stdout='active\n', stderr='', returncode=0)
    if command and command[0] == 'df':
        return SimpleNamespace(
            stdout='Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 100 900 12% /\n',
            stderr='',
            returncode=0,
        )
    return SimpleNamespace(stdout='', stderr='', returncode=0)


def fake_urlopen(*args, **kwargs):
    raise urllib.error.URLError('fixture: 零网络')


def run_checks_with_logs(monitor, records):
    """把 PROBLEM_LOG_DIR 指向固定样本，并掐断 checks() 的网络/子进程，只断言告警文案。"""
    saved_urlopen = urllib.request.urlopen
    saved_run = subprocess.run
    original_dir = monitor.PROBLEM_LOG_DIR
    with tempfile.TemporaryDirectory() as log_dir:
        monitor.PROBLEM_LOG_DIR = log_dir
        write_log(log_dir, records)
        urllib.request.urlopen = fake_urlopen
        subprocess.run = fake_subprocess_run
        try:
            return monitor.checks()
        finally:
            urllib.request.urlopen = saved_urlopen
            subprocess.run = saved_run
            monitor.PROBLEM_LOG_DIR = original_dir


def main():
    print('== #48 监控分类 fixture（零网络） ==')
    monitor = load_monitor()

    print('\n[1] is_balance_error 分类')
    for name, message, detail, expected in [
        ('HTTP 400 + Insufficient balance（大写，2026-10-31 事故）', '生图上游 HTTP 400',
         '{"error":{"message":"Insufficient balance"}}', True),
        ('HTTP 400 + 余额不足（中文）', '生图上游 HTTP 400',
         '{"error":{"message":"余额不足"}}', True),
        # 「upstream 402」按 message 里的上游状态码判定；detail 原文里的 '402' 故意不算余额类
        # （上游 body/请求 id 可能含 402），与 ops 在 is_balance_error 里的取舍保持一致。
        ('HTTP 402（旧口径，仍必须命中）', '生图上游 HTTP 402',
         '{"error":{"message":"payment required"}}', True),
        ('HTTP 400 + INSUFFICIENT_QUOTA', '生图上游 HTTP 400',
         '{"error":{"message":"INSUFFICIENT_QUOTA"}}', True),
        ('HTTP 400 + prompt too long → 通用类', '生图上游 HTTP 400',
         '{"error":{"message":"prompt too long"}}', False),
        ('HTTP 500 + upstream timeout → 通用类', '生图上游 HTTP 500',
         '{"error":{"message":"upstream timeout"}}', False),
    ]:
        actual = monitor.is_balance_error(message, detail)
        check(name, actual is expected, '实际 %s' % actual)

    print('\n[2] station_label 站点提取')
    for name, record, expected in [
        ('detail JSON 的 host + model', {
            'message': '生图上游 HTTP 400',
            'detail': station_detail('api.lk888.ai', 'tt-image-2.5', 'Insufficient balance'),
        }, 'api.lk888.ai tt-image-2.5'),
        ('detail 文本 host=', {
            'message': '生图上游 HTTP 400',
            'detail': 'host=api.text.example status=400',
        }, 'api.text.example'),
        ('message 中文括注', {
            'message': '生图上游 HTTP 402（backup tt-image）',
            'detail': 'not-json',
        }, 'backup tt-image'),
        ('提不到站点 → 未知站点（不编造）', {
            'message': '生图上游 HTTP 500',
            'detail': '',
        }, '未知站点'),
    ]:
        actual = monitor.station_label(record)
        check(name, actual == expected, '实际 %r' % actual)

    print('\n[3] check_image_upstream_errors 固定样本统计')
    original_dir = monitor.PROBLEM_LOG_DIR
    with tempfile.TemporaryDirectory() as log_dir:
        monitor.PROBLEM_LOG_DIR = log_dir
        try:
            write_log(log_dir, [
                problem_record('生图上游 HTTP 400',
                               station_detail('api.lk888.ai', 'tt-image-2.5', 'Insufficient balance')),
                problem_record('生图上游 HTTP 400',
                               station_detail('api.thin.example', 'model-thin', '余额不足')),
                problem_record('生图上游 HTTP 402',
                               station_detail('api.primary.example', 'model-main', 'payment required',
                                              status=402)),
                problem_record('生图上游 HTTP 400',
                               station_detail('api.good.example', 'model-good', 'invalid image size',
                                              balance=False)),
                problem_record('生图上游 HTTP 400', '{"error":{"message":"Insufficient balance"}}',
                               category='other-category'),
            ])
            balance, other, _sample, stations = monitor.check_image_upstream_errors()
        finally:
            monitor.PROBLEM_LOG_DIR = original_dir
    check('3 条余额类 / 1 条通用类（category 不符的记录被忽略）',
          (balance, other) == (3, 1), '实际 %s / %s' % (balance, other))
    check('余额类站点去重排序且带 host',
          stations == ['api.lk888.ai tt-image-2.5', 'api.primary.example model-main',
                       'api.thin.example model-thin'],
          '实际 %s' % (stations,))

    print('\n[4] checks() 告警文案')
    problems, urgent = run_checks_with_logs(monitor, [
        problem_record('生图上游 HTTP 400',
                       station_detail('api.lk888.ai', 'tt-image-2.5', 'Insufficient balance')),
        problem_record('生图上游 HTTP 400',
                       station_detail('api.thin.example', 'model-thin', '余额不足')),
        problem_record('生图上游 HTTP 402',
                       station_detail('api.primary.example', 'model-main', 'payment required',
                                      status=402)),
        problem_record('生图上游 HTTP 400',
                       station_detail('api.good.example', 'model-good', 'invalid image size',
                                      balance=False)),
    ])
    alert_lines = [line for line in problems if '余额' in line and '站点' in line]
    alert = alert_lines[0] if alert_lines else ''
    check('余额类 urgent=True（跳过连续 2 次节流立即告警）', urgent is True, '实际 %s' % urgent)
    check('告警文案点名全部余额类站点 host',
          all(host in alert for host in ('api.lk888.ai', 'api.thin.example', 'api.primary.example')),
          '实际 %s' % (alert or problems))
    check('告警文案写明充值/摘站动作，且不再只说「请检查上游状态」',
          ('充值' in alert or '摘站' in alert) and '请检查上游状态' not in alert,
          '实际 %s' % (alert or '(无)'))

    generic_problems, generic_urgent = run_checks_with_logs(monitor, [
        problem_record('生图上游 HTTP 400',
                       station_detail('api.good.example', 'model-good', 'prompt too long',
                                      balance=False)),
    ])
    check('真实 400（通用类）不触发余额告警、urgent=False',
          generic_urgent is False and all('余额' not in line for line in generic_problems),
          '实际 urgent=%s %s' % (generic_urgent, generic_problems))
    check('通用类仅 1 次（低于阈值 5）不报上游抖动',
          all('生图上游最近' not in line for line in generic_problems),
          '实际 %s' % (generic_problems,))

    print('\n结果：%d 通过 / %d 失败' % (passed, failed))
    if failed:
        print('失败项：\n - ' + '\n - '.join(failures))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
