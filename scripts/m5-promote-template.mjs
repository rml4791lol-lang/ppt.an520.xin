// M5：把 deckA 实测产出的 9 页图下载为真模板素材。
// 用法：node scripts/m5-promote-template.mjs output/m5-deckA.json
// 输出：public/assets/style-packs/wvcsc-aiot-skeleton/NN-<pageType>.<ext>，并打印注册用映射。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:3120';
const DIR = 'wvcsc-aiot-skeleton';
const outDir = path.resolve(process.cwd(), 'public', 'assets', 'style-packs', DIR);
mkdirSync(outDir, { recursive: true });

const resultPath = process.argv[2] || 'output/m5-deckA.json';
const result = JSON.parse(readFileSync(resultPath, 'utf8'));
const { account, slides } = result;
console.log(`deck=${result.deckId} account=${account} slides=${slides.length}`);

// 重新登录拿 cookie（runner 的 cookie 没落盘）
const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-anppt-action': '1' },
  body: JSON.stringify({ account, password: 'password123' }),
});
if (!login.ok) throw new Error(`登录失败 ${login.status}`);
const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];

const mapping = [];
for (const sl of slides) {
  if (sl.genStatus !== 'succeeded' || !sl.imageUrl) {
    console.log(`  skip p${sl.pageIndex} ${sl.genStatus}`);
    continue;
  }
  const res = await fetch(`${BASE}${sl.imageUrl}`, { headers: { cookie } });
  if (!res.ok) throw new Error(`p${sl.pageIndex} 下载失败 ${res.status}`);
  const ext = (sl.imageUrl.match(/\.(png|webp|jpe?g)$/i)?.[1] || 'png').toLowerCase();
  const name = `${String(sl.pageIndex).padStart(2, '0')}-${sl.pageType}.${ext}`;
  writeFileSync(path.join(outDir, name), Buffer.from(await res.arrayBuffer()));
  mapping.push({ pageIndex: sl.pageIndex, pageType: sl.pageType, role: sl.role, file: `/assets/style-packs/${DIR}/${name}` });
  console.log(`  ✓ p${sl.pageIndex} [${sl.pageType}] → ${name}`);
}
console.log('\n注册映射（templatePages 用）:');
console.log(JSON.stringify(mapping, null, 2));
