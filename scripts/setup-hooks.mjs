#!/usr/bin/env node
// npm install / npm ci 时把 core.hooksPath 指向仓库内 .githooks，让新克隆默认启用提交前快集。
// core.hooksPath 是 repo-local 配置、不在版本库里，所以需要这层安装期接线；
// 非 git 环境（打包/无 git）直接跳过，绝不阻塞安装。
import { spawnSync } from 'node:child_process';

const inGit = spawnSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' }).status === 0;
if (!inGit) process.exit(0);

const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
if (result.status === 0) console.log('hooks: core.hooksPath -> .githooks');
process.exit(0);
