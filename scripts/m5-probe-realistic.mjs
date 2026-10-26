// M5 排障：用真实量级 payload 探测候选模型能否在 45s 预算内产出合法 JSON 大纲。
// 用法：node --env-file=.env.local scripts/m5-probe-realistic.mjs model1,model2
const base = (process.env.ANPPT_V2_LLM_BASE_URL || 'http://127.0.0.1:6800/v1').replace(/\/+$/, '');
const key = process.env.ANPPT_V2_LLM_API_KEY || '';
if (!key) { console.log('no key'); process.exit(1); }

const TOPIC = `智慧农业——基于 AIoT 的精准种植（职业院校技能大赛参赛项目）
团队介绍：参赛团队由 5 名职业院校学生与 2 名指导老师组成，专业覆盖物联网应用技术、现代农业技术与视觉传达。
项目设计：针对传统种植"凭经验判断、灌溉误差大、病虫害发现滞后"的痛点，设计目标是用低成本 AIoT 体系实现精准感知与自动执行。
工作流程：土壤与气象传感器采集 → 边缘网关汇聚清洗 → 云端作物模型决策 → 水肥一体化设备执行 → 种植效果回流评估。
技能要点：传感器选型与标定、嵌入式采集程序开发、时序数据分析、农艺参数整定、系统联调。
项目成果：已在 3 个试点大棚完成一季种植验证，节水约 30%，病虫害发现提前 5 至 7 天，形成实训工单 12 份。
项目创新：低成本国产传感器组合方案与轻量化作物决策模型，适配职业院校实训场景与中小农户预算。
应用价值：面向中小种植户与农业合作社降低数字化门槛，可复制的"传感+模型+执行"打包方案。
结语展望：让数据成为新农具，让实训对接真生产。`;

const prompt = `你是演示文稿大纲规划器。根据以下素材设计一套 9 页 PPT 大纲，输出纯 JSON（不要 markdown 代码围栏）：{"pages":[{"pageIndex":1,"title":"...","pageType":"cover","summary":"...40字内"}]}。素材：\n${TOPIC}`;

for (const model of process.argv[2].split(',')) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(50_000),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 120);
      try { msg = JSON.parse(text)?.error?.message ?? msg; } catch { /* ignore */ }
      console.log(`FAIL ${model}  HTTP ${res.status}  ${ms}ms  ${msg}`);
      continue;
    }
    let content = '';
    try { content = JSON.parse(text)?.choices?.[0]?.message?.content ?? ''; } catch { /* ignore */ }
    const cleaned = String(content).replace(/^```(?:json)?|```$/gm, '').trim();
    let pages = 0;
    try { pages = JSON.parse(cleaned)?.pages?.length ?? 0; } catch { /* ignore */ }
    console.log(`${pages > 0 ? 'OK  ' : 'BAD '} ${model}  ${ms}ms  content=${String(content).length}chars  pages=${pages}${ms > 45_000 ? '  ⚠ 超 45s 预算' : ''}`);
  } catch (e) {
    console.log(`ERR  ${model}  ${Date.now() - t0}ms  ${e instanceof Error ? e.message : e}`);
  }
}
