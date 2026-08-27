#!/usr/bin/env node
// 模块 5 实测驱动：注册→解析→大纲→梳理→冻结→选风格/模板→生成→导出，全真实上游。
// 用法：node scripts/m5-run-deck.mjs <label> <stylePackId> <topicKey>
//   label    输出文件标识（deckA / deckB）
//   stylePackId  风格包或真模板 id
//   topicKey     agri（智慧农业）| bearing（轴承检测）
// 结果 JSON 落 output/m5-<label>.json，PPTX 落 output/m5-<label>.pptx。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [, , label = 'deckA', stylePackId = '', topicKey = 'agri'] = process.argv;
const BASE = process.env.BASE_URL || 'http://localhost:3120';
const OUT = path.resolve(process.cwd(), 'output');
mkdirSync(OUT, { recursive: true });

const TOPICS = {
  agri: `智慧农业——基于 AIoT 的精准种植（职业院校技能大赛参赛项目）

团队介绍：参赛团队由 5 名职业院校学生与 2 名指导老师组成，专业覆盖物联网应用技术、现代农业技术与视觉传达。
项目设计：针对传统种植"凭经验判断、灌溉误差大、病虫害发现滞后"的痛点，设计目标是用低成本 AIoT 体系实现精准感知与自动执行。
工作流程：土壤与气象传感器采集 → 边缘网关汇聚清洗 → 云端作物模型决策 → 水肥一体化设备执行 → 种植效果回流评估。
技能要点：传感器选型与标定、嵌入式采集程序开发、时序数据分析、农艺参数整定、系统联调。
项目成果：已在 3 个试点大棚完成一季种植验证，节水约 30%，病虫害发现提前 5 至 7 天，形成实训工单 12 份。
项目创新：低成本国产传感器组合方案与轻量化作物决策模型，适配职业院校实训场景与中小农户预算。
应用价值：面向中小种植户与农业合作社降低数字化门槛，可复制的"传感+模型+执行"打包方案。
结语展望：让数据成为新农具，让实训对接真生产。`,
  bearing: `基于机器视觉的轴承缺陷检测（职业院校技能大赛参赛项目）

团队介绍：团队由 4 名智能制造专业学生与 2 名企业工程师导师组成，覆盖视觉算法、机械工艺与产线集成。
项目设计：针对轴承质检"人工目检漏检率高、效率低"的痛点，设计目标是产线在线机器视觉自动检测。
工作流程：工业相机成像 → 图像预处理 → 缺陷检测模型推理 → 分拣机构联动 → 检测结果追溯归档。
技能要点：光学成像方案设计、缺陷样本标注、检测模型训练与压缩、PLC 联动调试。
项目成果：在某轴承产线完成 3 周试运行，漏检率从 1.8% 降至 0.2%，单件检测节拍 0.6 秒。
项目创新：小样本缺陷增强算法与边缘端轻量化部署，无需改造现有产线。
应用价值：面向中小轴承与精密零件厂商，低成本质检数字化改造方案。
结语展望：让每一条产线都用得起机器视觉。`,
};

const H = { 'x-anppt-action': '1' };
const account = `m5${label}${Date.now().toString(36)}`;
let cookie = '';

async function api(pathname, { method = 'GET', body, form } = {}) {
  const headers = { ...H, cookie };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: payload });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deckState = async (deckId) => (await api(`/api/deck/${deckId}`)).json?.data;
const action = (deckId, body) => api(`/api/deck/${deckId}`, { method: 'POST', body });

// [0] 注册
{
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...H },
    body: JSON.stringify({ account, password: 'password123', confirmPassword: 'password123' }),
  });
  if (res.status !== 201) throw new Error(`注册失败 ${res.status}`);
  cookie = String(res.headers.get('set-cookie') || '').split(';')[0];
  const bal = await api('/api/credits/balance');
  console.log(`[0] 注册 ${account} 余额 ${bal.json?.data?.balance}`);
}

// [1] 解析
let deckId = '';
{
  const form = new FormData();
  form.append('file', new Blob([TOPICS[topicKey]], { type: 'text/plain' }), `${topicKey}.txt`);
  form.append('duration', '10');
  form.append('targetPageCount', '9');
  const { status, json } = await api('/api/deck/parse', { method: 'POST', form });
  if (status !== 201) throw new Error(`parse 失败 ${status} ${JSON.stringify(json)?.slice(0, 200)}`);
  deckId = json.data.deckId;
  console.log(`[1] parse deckId=${deckId}`);
}

// [2] 大纲 → 梳理 → 冻结 → 风格
{
  const r1 = await action(deckId, { action: 'outline' });
  if (r1.status !== 200) throw new Error(`outline 失败 ${r1.status} ${JSON.stringify(r1.json)?.slice(0, 200)}`);
  let s = await deckState(deckId);
  console.log(`[2] outline ${s.slides.length} 页:`);
  for (const sl of s.slides) console.log(`    p${sl.pageIndex} [${sl.role}] ${sl.pageType} | ${sl.title}`);

  const r2 = await action(deckId, { action: 'structure' });
  if (r2.status !== 200) throw new Error(`structure 失败 ${r2.status}`);
  s = await deckState(deckId);
  const notOk = s.slides.filter((x) => x.structureStatus !== 'ok');
  if (notOk.length > 0) throw new Error(`梳理未全 ok: ${notOk.map((x) => x.pageIndex).join(',')}`);

  const r3 = await action(deckId, { action: 'confirm-structure' });
  if (r3.status !== 200) throw new Error(`confirm 失败 ${r3.status}`);

  const r4 = await action(deckId, { action: 'style', stylePackId });
  if (r4.status !== 200) throw new Error(`style 失败 ${r4.status} ${JSON.stringify(r4.json)?.slice(0, 200)}`);
  console.log(`[2] structure ok + locked + style=${stylePackId}`);
}

// [3] 生成
{
  const before = (await api('/api/credits/balance')).json.data.balance;
  const r5 = await action(deckId, { action: 'generate' });
  if (r5.status !== 202) throw new Error(`generate 失败 ${r5.status} ${JSON.stringify(r5.json)?.slice(0, 200)}`);
  console.log(`[3] 生成中…（开始前余额 ${before}）`);

  const deadline = Date.now() + 15 * 60_000;
  let s;
  for (;;) {
    s = await deckState(deckId);
    const pending = s.slides.some((x) => ['queued', 'running'].includes(x.genStatus));
    if (!pending && ['generated', 'partial'].includes(s.deck.status)) break;
    if (Date.now() > deadline) throw new Error(`生成超时，状态 ${s.deck.status}`);
    await sleep(4000);
  }
  const ok = s.slides.filter((x) => x.genStatus === 'succeeded');
  const failedPages = s.slides.filter((x) => x.genStatus === 'failed');
  const after = (await api('/api/credits/balance')).json.data.balance;
  console.log(`[3] 完成：${ok.length} 成功 / ${failedPages.length} 失败；余额 ${before} → ${after}（消耗 ${before - after}）`);
  for (const sl of s.slides) {
    const img = sl.versions?.find((v) => v.imageUrl)?.imageUrl || '';
    console.log(`    p${sl.pageIndex} ${sl.genStatus} ${img}`);
  }

  // [4] 导出
  const r6 = await api(`/api/deck/${deckId}/export-image`, { method: 'POST', body: {} });
  if (r6.status !== 201) throw new Error(`导出失败 ${r6.status} ${JSON.stringify(r6.json)?.slice(0, 160)}`);
  const url = r6.json?.data?.url || '';
  const file = await fetch(`${BASE}${url}`, { headers: { cookie } });
  const buf = Buffer.from(await file.arrayBuffer());
  const pptxPath = path.join(OUT, `m5-${label}.pptx`);
  writeFileSync(pptxPath, buf);
  const slideNames = new Set(buf.toString('latin1').match(/ppt\/slides\/slide\d+\.xml/g) || []);
  console.log(`[4] 导出 pptx ${pptxPath}（内含 ${slideNames.size} 页）`);

  writeFileSync(
    path.join(OUT, `m5-${label}.json`),
    JSON.stringify(
      {
        deckId, account, stylePackId, topicKey,
        credits: { before, after, spent: before - after },
        slides: s.slides.map((sl) => ({
          pageIndex: sl.pageIndex, role: sl.role, pageType: sl.pageType, title: sl.title,
          genStatus: sl.genStatus, imageUrl: sl.versions?.find((v) => v.imageUrl)?.imageUrl || '',
        })),
      },
      null,
      2,
    ),
  );
  console.log(`[done] output/m5-${label}.json`);
}
