"""Run from the host terminal. Installs the user's supervised GPU service, not a public tunnel."""
import os
import shutil
import socket
import subprocess
from datetime import datetime
from pathlib import Path


def main():
    gateway = Path(__file__).resolve().parent
    if subprocess.run(['systemctl','--user','show-environment'],capture_output=True).returncode:
        raise SystemExit('请在电脑的系统终端运行此脚本；当前环境不能连接用户服务管理器。')
    # Do not replace/kill a manually launched gateway or interrupt its jobs.
    managed = subprocess.run(['systemctl','--user','is-active','--quiet','binderos-gateway.service']).returncode == 0
    with socket.socket() as probe:
        occupied = probe.connect_ex(('127.0.0.1',8765)) == 0
    if occupied and not managed:
        raise SystemExit('旧的手动计算服务仍在运行。确认没有任务后，在原终端 Ctrl+C，再执行本脚本。不会自动终止旧进程。')
    unit = f'''[Unit]
Description=BinderOS GPU gateway
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory={gateway}
ExecStart=/usr/bin/bash "{gateway}/start-gpu.sh"
Environment=CUDA_VISIBLE_DEVICES=1
Restart=on-failure
RestartSec=10
KillMode=control-group
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
'''
    target = Path.home()/'.config/systemd/user/binderos-gateway.service'
    target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists() and target.read_text()!=unit:
        shutil.copy2(target,target.with_suffix('.service.backup-'+datetime.now().strftime('%Y%m%d%H%M%S')))
    target.write_text(unit)
    subprocess.run(['systemctl','--user','daemon-reload'],check=True)
    subprocess.run(['systemctl','--user','enable','--now','binderos-gateway.service'],check=True)
    print('已启用用户登录时启动、异常退出后重启。关闭终端不会关闭服务。')
    print('查看状态：systemctl --user status binderos-gateway.service')
    print('停止服务：systemctl --user stop binderos-gateway.service')
    print('注意：未启用开机未登录运行，也未配置固定外网通道。')
    if managed:
        print('服务原已运行，本脚本没有重启它。加载代码更新前请确认无任务，再执行 systemctl --user restart binderos-gateway.service。')


if __name__ == '__main__':
    main()
