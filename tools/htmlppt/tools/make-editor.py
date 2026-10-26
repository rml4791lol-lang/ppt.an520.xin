import re, sys, pathlib
IN = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path('deck.html')
OUT = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else IN.parent / 'editor.html'
src = IN.read_text(encoding='utf-8')
deck_style = re.search(r'<style>([\s\S]*?)</style>', src).group(1)
secs = re.findall(r'<section class="slide"[\s\S]*?</section>', src)

editor_style = r"""
html, body { width:100%; height:auto; overflow:auto; background:#E9EDF3; }
#stage { position:static; width:100%; height:auto; padding:72px 0 60px; }
section.slide { position:relative !important; left:auto !important; top:auto !important;
  margin:0 auto 26px; box-shadow:0 6px 24px rgba(20,40,80,.16); }
#ed-bar { position:fixed; z-index:99999; left:0; right:0; top:0; height:56px; background:#0B2A5B;
  color:#fff; display:flex; align-items:center; gap:14px; padding:0 20px; font:14px/1 -apple-system,"PingFang SC",sans-serif; }
#ed-bar b { font-size:16px; letter-spacing:.5px; }
#ed-bar .sp { flex:1; }
#ed-bar button { font:13px/1 -apple-system,"PingFang SC",sans-serif; color:#fff; background:rgba(255,255,255,.14);
  border:1px solid rgba(255,255,255,.28); border-radius:8px; padding:9px 14px; cursor:pointer; }
#ed-bar button:hover { background:rgba(255,255,255,.24); }
#ed-bar .ok { background:#1E9E63; border-color:#1E9E63; }
#ed-hint { position:fixed; z-index:99999; left:20px; bottom:16px; background:rgba(11,42,91,.92); color:#D8E6F7;
  font:12px/1.7 -apple-system,"PingFang SC",sans-serif; padding:10px 14px; border-radius:10px; max-width:560px; }
[contenteditable="true"] { cursor:text; }
[contenteditable="true"]:hover { outline:1px dashed rgba(30,111,217,.6); }
[contenteditable="true"]:focus { outline:2px solid #2E9BF0; background:rgba(46,155,240,.08); }
.ed-overflow { outline:2px solid #E0483D !important; background:rgba(224,72,61,.08) !important; }
img.ed-img { cursor:pointer; }
img.ed-img:hover { outline:2px solid #2E9BF0; }
.ed-badge { position:absolute; z-index:6; left:8px; top:8px; background:rgba(11,42,91,.82); color:#fff;
  font:600 11px/1 -apple-system,"PingFang SC",sans-serif; padding:5px 8px; border-radius:6px; pointer-events:none; }
#ed-modal { position:fixed; z-index:99999; inset:0; background:rgba(8,20,40,.55); display:none;
  align-items:center; justify-content:center; }
#ed-modal .box { width:540px; background:#fff; border-radius:14px; padding:22px 24px;
  font:14px/1.7 -apple-system,"PingFang SC",sans-serif; color:#22344c; }
#ed-modal h3 { margin:0 0 10px; font-size:17px; color:#14386B; }
#ed-modal .row { margin:10px 0; display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
#ed-modal label { display:flex; gap:8px; align-items:center; cursor:pointer; }
#ed-modal .warn { color:#C2410C; font-size:12px; margin-top:6px; }
#ed-modal .btns { display:flex; gap:10px; justify-content:flex-end; margin-top:18px; }
#ed-modal button { font:13px/1 -apple-system,"PingFang SC",sans-serif; padding:9px 16px; border-radius:8px;
  border:1px solid #D7E2F0; background:#fff; cursor:pointer; }
#ed-modal button.primary { background:#1E6FD9; border-color:#1E6FD9; color:#fff; }
"""

editor_js = r"""
(function(){
  const statusEl = document.getElementById('ed-status');
  const modal = document.getElementById('ed-modal');
  let currentImg = null;
  let changes = 0;
  const changeList = [];   // 用于导出「PPT 补丁」
  function slideNoOf(el){
    const sec = el.closest('section.slide');
    if(!sec) return null;
    return [...document.querySelectorAll('section.slide')].indexOf(sec) + 1;
  }
  function recordChange(obj){
    const i = changeList.findIndex(c => c.slide === obj.slide && c.kind === obj.kind && c.id === obj.id);
    if(i >= 0) changeList.splice(i, 1);
    changeList.push(obj);
    changes = changeList.length;
  }
  const clamp = v => Math.max(0, Math.min(1, v));

  /* ---------- 1. 找叶子文本元素并设为可编辑 ---------- */
  function isLeafText(el){
    if(!el || ['IMG','SVG','TABLE','TR','TD','TH','BR','STYLE','SCRIPT'].includes(el.tagName)) return false;
    if(el.querySelector('img,svg,table,canvas')) return false;
    const t = (el.textContent||'').trim(); if(!t) return false;
    // 只取最内层：后代里没有别的含文字元素
    for(const c of el.children){
      if(c.tagName === 'BR') continue;
      const ct = (c.textContent||'').trim();
      if(ct) return false;
      if(['IMG','SVG'].includes(c.tagName)) return false;
    }
    return true;
  }
  const textEls = [...document.querySelectorAll('section.slide *')].filter(isLeafText);
  const baseline = new Set();   // 原稿自带的溢出（不标红，只统计）
  function scanBaseline(){
    baseline.clear();
    textEls.forEach(el => { const b = boxOf(el); if(overflows(b)) baseline.add(b); });
  }
  textEls.forEach(el => {
    el.setAttribute('contenteditable','true');
    el.setAttribute('spellcheck','false');
    el.dataset.edFont = getComputedStyle(el).fontSize;
    el.addEventListener('focus', () => { el.dataset.edText0 = el.innerText; });
    el.addEventListener('blur', () => {
      if(el.innerText !== el.dataset.edText0){
        const idEl = el.closest('[data-pptx-id]');
        const slideNo = slideNoOf(el);
        if(idEl && slideNo) recordChange({ slide: slideNo, id: Number(idEl.getAttribute('data-pptx-id')),
          kind: 'text', text: el.innerText });
        else changes++;
        const b = boxOf(el);
        baseline.delete(b);      // 编辑过的盒子按"用户新增"处理
        autoFit(b);
      }
      checkAll();
    });
    el.addEventListener('keydown', (e) => {
      if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); el.blur(); }
      if(e.key === 'Escape'){ el.innerText = el.dataset.edText0 || el.innerText; el.blur(); }
    });
  });

  /* ---------- 2. 文本超框检测 + 自动缩字 ---------- */
  function boxOf(el){
    // 优先取带 data-pptx-id 的文本框容器（反向导出产物）
    const idBox = el.closest('[data-pptx-id]');
    if (idBox && idBox !== el) return idBox;
    // 其次找带显式高度的祖先（模板产物：p.abs 自带 height）
    let n = el;
    while (n && n !== document.body) {
      const cs = getComputedStyle(n);
      const styleH = n.getAttribute('style') || '';
      const h = parseFloat(cs.height);
      if (/height\s*:/.test(styleH) && h > 0 && h < 700) return n;
      n = n.parentElement;
    }
    return el;
  }
  function textRect(box){
    const r = document.createRange();
    r.selectNodeContents(box);
    return r.getBoundingClientRect();
  }
  function overflows(box){
    const br = box.getBoundingClientRect();
    const tr = textRect(box);
    if(tr.width === 0 && tr.height === 0) return false;
    // 中英混排时文本行的边界通常比盒子略大，按盒内最大字号给容差，避免误报
    let fs = 16;
    [box, ...box.querySelectorAll('*')].forEach(n => {
      const v = parseFloat(getComputedStyle(n).fontSize);
      if (v && v > fs) fs = v;
    });
    const tolY = Math.max(8, fs * 0.6);
    const tolX = Math.max(6, fs * 0.15);
    return tr.bottom > br.bottom + tolY || tr.top < br.top - tolY || tr.right > br.right + tolX;
  }
  function autoFit(box){
    box.classList.remove('ed-overflow');
    let guard = 0;
    while(guard++ < 40 && overflows(box)){
      let changed = false;
      const nodes = [box, ...box.querySelectorAll('*')].filter(n => (n.textContent||'').trim());
      for(const n of nodes){
        const fs = parseFloat(getComputedStyle(n).fontSize);
        if(!fs || fs <= 8) continue;
        const next = Math.max(8, fs * 0.94);
        n.style.fontSize = next.toFixed(2) + 'px';
        const lh = parseFloat(getComputedStyle(n).lineHeight);
        if(lh) n.style.lineHeight = Math.max(1, Math.round(next * 1.38)) + 'px';
        changed = true;
      }
      if(!changed) break;
    }
    box.classList.toggle('ed-overflow', overflows(box));
  }
  function stats(){ return { texts: textEls.length, over: document.querySelectorAll('.ed-overflow').length }; }

  /* ---------- 3. 图片替换（穿透点击 + 背景图） ---------- */
  let currentBg = null;
  const contentImgs = [...document.querySelectorAll('section.slide img')].filter(im => {
    const r = im.getBoundingClientRect();
    return r.width > 60 && r.height > 60;
  });
  contentImgs.forEach(img => { img.classList.add('ed-img'); img.title = '点击更换图片（默认保持比例）'; });

  function isBgEl(el){
    return el && el.nodeType === 1 && (el.classList.contains('bg-image') ||
      el.getAttribute('data-pptx-role') === 'background-image' ||
      (el.classList.contains('pptx-bg') && getComputedStyle(el).backgroundImage !== 'none'));
  }
  // 按坐标向下穿透：找到最上层的 <img> 或背景图层（即使被遮罩盖住）
  function pickAt(x, y){
    const els = document.elementsFromPoint(x, y);
    for(const el of els){
      if(!el.closest || !el.closest('section.slide')) continue;
      if(el.tagName === 'IMG') return { type:'img', el };
      if(isBgEl(el)) return { type:'bg', el };
    }
    return null;
  }
  document.querySelectorAll('section.slide').forEach(sec => {
    sec.addEventListener('click', (e) => {
      if(e.target.closest('[contenteditable="true"]')) return;   // 点文字优先编辑
      const t = pickAt(e.clientX, e.clientY);
      if(!t) return;
      e.preventDefault(); e.stopPropagation();
      if(t.type === 'img'){ currentImg = t.el; currentBg = null; openModal(); }
      else { currentBg = t.el; currentImg = null; openBgModal(t.el); }
    }, true);
  });
  function ratioInfo(img){
    const r = img.getBoundingClientRect();
    const boxRatio = r.width / Math.max(r.height, 1);
    const natRatio = (img.naturalWidth || 1) / Math.max(img.naturalHeight || 1, 1);
    const diff = Math.abs(boxRatio - natRatio) / Math.max(boxRatio, natRatio);
    return { boxRatio, natRatio, diff };
  }
  function openBgModal(bgEl){
    document.getElementById('ed-m-title').textContent = '更换整页背景图';
    const r = bgEl.getBoundingClientRect();
    const boxRatio = r.width / Math.max(r.height, 1);
    document.getElementById('ed-m-ratio').textContent =
      `背景图层　槽位比例 ${boxRatio.toFixed(2)} : 1　（整页背景图，可整张替换）`;
    document.getElementById('ed-m-file').value = '';
    modal.dataset.mode = 'bg';
    modal.style.display = 'flex';
  }
  function openModal(){
    document.getElementById('ed-m-title').textContent = '更换图片';
    const { boxRatio, natRatio, diff } = ratioInfo(currentImg);
    document.getElementById('ed-m-ratio').textContent =
      `槽位比例 ${boxRatio.toFixed(2)} : 1　原图比例 ${natRatio.toFixed(2)} : 1　` +
      (diff > 0.06 ? `不匹配 ${(diff*100).toFixed(0)}%（建议裁切）` : '基本匹配');
    document.getElementById('ed-m-file').value = '';
    modal.dataset.mode = 'img';
    modal.style.display = 'flex';
  }
  document.getElementById('ed-m-cancel').onclick = () => { modal.style.display = 'none'; };
  document.getElementById('ed-m-ok').onclick = () => {
    const f = document.getElementById('ed-m-file').files[0];
    if(!f){ modal.style.display = 'none'; return; }
    const mode = (document.querySelector('input[name="ed-fit"]:checked') || {}).value || 'cover';
    const rd = new FileReader();
    rd.onload = () => {
      if(modal.dataset.mode === 'bg' && currentBg){
        const map = { cover:'cover', contain:'contain', fill:'100% 100%' };
        currentBg.style.backgroundImage = `url('${rd.result}')`;
        currentBg.style.backgroundSize = map[mode];
        currentBg.style.backgroundPosition = 'center';
        currentBg.style.backgroundRepeat = 'no-repeat';
        recordChange({ slide: slideNoOf(currentBg), kind: 'background', index: 1, dataUrl: rd.result });
        modal.style.display = 'none'; checkAll(); return;
      }
      currentImg.src = rd.result;
      currentImg.removeAttribute('width'); currentImg.removeAttribute('height');
      currentImg.style.objectFit = mode;      // cover 裁切 / contain 完整 / fill 拉伸
      currentImg.dataset.edChanged = '1';
      if(mode === 'fill') currentImg.dataset.edWarn = 'stretch';
      const idEl = currentImg.closest('[data-pptx-id]');
      if(idEl){ recordChange({ slide: slideNoOf(currentImg), id: Number(idEl.getAttribute('data-pptx-id')),
        kind: 'image', dataUrl: rd.result, fit: mode }); }
      else changes++;
      modal.style.display = 'none';
      checkAll();
    };
    rd.readAsDataURL(f);
  };

  /* ---------- 4. 导出 ---------- */
  function exportHtml(){
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('#ed-bar,#ed-hint,#ed-modal,.ed-badge,#ed-style,#ed-script').forEach(n => n.remove());
    clone.querySelectorAll('[contenteditable]').forEach(n => { n.removeAttribute('contenteditable'); n.removeAttribute('spellcheck'); });
    clone.querySelectorAll('.ed-overflow').forEach(n => n.classList.remove('ed-overflow'));
    clone.querySelectorAll('.ed-img').forEach(n => n.classList.remove('ed-img'));
    const html = '<!DOCTYPE html>\n' + clone.outerHTML;
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'deck-edited.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function exportJson(){
    const payload = { generatedAt: new Date().toISOString(), deck: 'deck.html', slides: changeList };
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'changes.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ---------- 5. 状态栏 ---------- */
  let newOver = 0;
  function checkAll(){
    newOver = 0;
    textEls.forEach(el => {
      const b = boxOf(el);
      const bad = overflows(b);
      if(bad && !baseline.has(b)){ b.classList.add('ed-overflow'); newOver++; }
      else if(!bad){ b.classList.remove('ed-overflow'); }
    });
    let badImgs = 0;
    contentImgs.forEach(im => {
      const { diff } = ratioInfo(im);
      const r = im.getBoundingClientRect();
      if(diff > 0.12 && (r.width*r.height)/(1280*720) > 0.02) badImgs++;
    });
    statusEl.textContent =
      `已改 ${changes} 处 · 可编辑文本 ${textEls.length} · 可换图 ${contentImgs.length} · ` +
      `编辑新增超框 ${newOver} · 原稿自带溢出 ${baseline.size} · 需裁切适配图 ${badImgs}`;
  }

  document.getElementById('ed-export').onclick = exportHtml;
  const btnJson = document.getElementById('ed-export-json');
  if(btnJson) btnJson.onclick = exportJson;
  document.getElementById('ed-fitall').onclick = () => { baseline.clear(); textEls.forEach(el => autoFit(boxOf(el))); checkAll(); };
  document.getElementById('ed-reset').onclick = () => { if(confirm('刷新页面恢复初始状态？')) location.reload(); };
  document.querySelectorAll('section.slide').forEach((s, i) => {
    const b = document.createElement('div'); b.className = 'ed-badge'; b.textContent = 'P' + (i + 1);
    s.appendChild(b);
  });
  scanBaseline();
  checkAll();
})();
"""

bar = """
<div id="ed-bar">
  <b>参考稿 18 页 · 可编辑模式</b>
  <span id="ed-status">加载中…</span>
  <span class="sp"></span>
  <button id="ed-fitall">全部自动适配</button>
  <button id="ed-reset">重置</button>
  <button id="ed-export-json">导出 PPT 补丁 JSON</button>
  <button id="ed-export" class="ok">导出 HTML</button>
</div>
<div id="ed-hint">
  点文字直接改（超框自动缩字并标红）· 点图片换图（可穿透遮罩，含整页背景图）· 画布固定 1280×720<br>
  「导出 PPT 补丁 JSON」= 不重排、在原 PPTX 上原地改内容（几何 100% 一致）；「导出 HTML」= 完整可编辑页面。
</div>
<div id="ed-modal">
  <div class="box">
    <h3 id="ed-m-title">更换图片</h3>
    <div id="ed-m-ratio" class="row"></div>
    <div class="row"><input id="ed-m-file" type="file" accept="image/*"></div>
    <div class="row">
      <label><input type="radio" name="ed-fit" value="cover" checked> 裁切铺满（保持比例，推荐）</label>
      <label><input type="radio" name="ed-fit" value="contain"> 完整显示（留白）</label>
      <label><input type="radio" name="ed-fit" value="fill"> 拉伸填满</label>
    </div>
    <div class="warn">「拉伸填满」在比例不匹配时会变形，导出前请确认。</div>
    <div class="btns">
      <button id="ed-m-cancel">取消</button>
      <button id="ed-m-ok" class="primary">替换</button>
    </div>
  </div>
</div>
"""

html = f'''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>可编辑 · 参考稿 18 页</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' fill='%230B2A5B'/></svg>">
<style id="deck-style">{deck_style}</style>
<style id="ed-style">{editor_style}</style>
</head>
<body><div id="stage">
{chr(10).join(secs)}
</div>
{bar}
<script id="ed-script">{editor_js}</script>
</body></html>'''
OUT.write_text(html, encoding='utf-8')
print(f"editor -> {OUT} ({round(len(html)/1024)} KB)")
