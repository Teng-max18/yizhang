/* 衣账 V1.0 — 纯前端离线账本。所有商品、图片和销售记录存在本机 IndexedDB。 */
'use strict';

const DB_NAME = 'yizhang-private-ledger';
const state = { db: null, products: [], sales: [], tab: 'home', query: '', period: 'month', editingId: null, pendingImage: '' };
const $ = selector => document.querySelector(selector);
const yuan = cents => '¥' + (Number(cents || 0) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyValue = cents => (Number(cents || 0) / 100).toFixed(2);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const uid = () => globalThis.crypto?.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const int = value => Number.parseInt(value, 10);
const asCents = value => Math.round(Number(value) * 100);
let toastTimer;

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('products')) db.createObjectStore('products', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sales')) db.createObjectStore('sales', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('数据库被其他页面占用，请关闭其他标签页后重试'));
  });
}
function getAll(storeName) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function reload() {
  [state.products, state.sales] = await Promise.all([getAll('products'), getAll('sales')]);
  state.products.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  state.sales.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  render();
}
function txWrite(stores, executor) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(stores, 'readwrite');
    let error;
    tx.oncomplete = () => resolve();
    tx.onerror = () => { error ||= tx.error; };
    tx.onabort = () => reject(error || tx.error || new Error('数据库操作未完成'));
    const abort = message => { error = new Error(message); tx.abort(); };
    try { executor(tx, abort); } catch (e) { error = e; tx.abort(); }
  });
}
async function saveProduct(record, editingId) {
  await txWrite(['products'], (tx, abort) => {
    const store = tx.objectStore('products');
    if (!editingId) { store.add({ ...record, stock: record.quantity, createdAt: new Date().toISOString() }); return; }
    store.get(editingId).onsuccess = event => {
      const old = event.target.result;
      if (!old) return abort('商品不存在，请刷新后重试');
      const sold = old.quantity - old.stock;
      if (record.quantity < sold) return abort(`此商品已卖出 ${sold} 件，采购件数不能小于该数量`);
      store.put({ ...old, ...record, stock: record.quantity - sold });
    };
  });
}
async function recordSale(productId, quantity, priceCents, date) {
  await txWrite(['products', 'sales'], (tx, abort) => {
    const products = tx.objectStore('products');
    products.get(productId).onsuccess = event => {
      const p = event.target.result;
      if (!p) return abort('商品不存在');
      if (quantity > p.stock) return abort(`库存不足，目前仅剩 ${p.stock} 件`);
      p.stock -= quantity;
      products.put(p);
      tx.objectStore('sales').add({
        id: uid(), productId, quantity, priceCents, costCents: p.costCents,
        brand: p.brand, sku: p.sku, name: p.name, source: p.source,
        date, createdAt: new Date().toISOString()
      });
    };
  });
}
async function deleteSale(id) {
  await txWrite(['products', 'sales'], (tx, abort) => {
    const sales = tx.objectStore('sales');
    sales.get(id).onsuccess = event => {
      const sale = event.target.result;
      if (!sale) return abort('销售记录不存在');
      const products = tx.objectStore('products');
      products.get(sale.productId).onsuccess = e => {
        const p = e.target.result;
        if (!p) return abort('原商品不存在，无法返还库存');
        p.stock += sale.quantity;
        products.put(p);
        sales.delete(id);
      };
    };
  });
}
async function deleteProduct(id) {
  await txWrite(['products', 'sales'], (tx, abort) => {
    const pStore = tx.objectStore('products');
    pStore.get(id).onsuccess = event => {
      const p = event.target.result;
      if (!p) return abort('商品不存在');
      const salesReq = tx.objectStore('sales').getAll();
      salesReq.onsuccess = () => {
        if (salesReq.result.some(s => s.productId === id)) return abort('此商品有销售记录，请先撤销销售记录');
        pStore.delete(id);
      };
    };
  });
}
function metric(title, value, foot = '', unit = '') {
  return `<div class="metric"><div class="metric-title">${esc(title)}</div><div class="metric-value">${esc(value)}${unit ? `<span class="metric-unit"> ${esc(unit)}</span>` : ''}</div>${foot ? `<div class="metric-foot">${esc(foot)}</div>` : ''}</div>`;
}
function heading(eyebrow, title, description, extra = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1>${description ? `<p>${esc(description)}</p>` : ''}</div>${extra}</div>`;
}
function empty(icon, title, hint, action, label) {
  return `<div class="empty"><div class="empty-icon">${icon}</div><h3>${esc(title)}</h3><p>${esc(hint)}</p>${action ? `<button class="primary-btn" type="button" data-action="${action}">${esc(label)}</button>` : ''}</div>`;
}
function saleRevenue(s) { return s.quantity * s.priceCents; }
function saleCost(s) { return s.quantity * s.costCents; }
function inPeriod(s, period) {
  if (period === 'all') return true;
  if (period === 'today') return s.date === today();
  return s.date?.slice(0, 7) === today().slice(0, 7);
}
function summaries(list) {
  return list.reduce((o, s) => {
    o.revenue += saleRevenue(s); o.cost += saleCost(s); o.profit += saleRevenue(s) - saleCost(s); o.units += s.quantity;
    return o;
  }, { revenue: 0, cost: 0, profit: 0, units: 0 });
}
function periodName(period) { return ({ today: '今日', month: '本月', all: '累计' })[period]; }
function renderHome() {
  const monthSales = state.sales.filter(s => inPeriod(s, 'month'));
  const month = summaries(monthSales);
  const stockQty = state.products.reduce((n, p) => n + p.stock, 0);
  const stockCost = state.products.reduce((n, p) => n + p.stock * p.costCents, 0);
  const total = summaries(state.sales);
  const recent = state.sales.slice(0, 4);
  return heading('OVERVIEW', '经营概览', `${today()} · 每一笔进出，都有迹可循`) + `
    <div class="hero"><div class="hero-top">↗ 本月已实现毛利润</div><div class="hero-value">${yuan(month.profit)}</div>
    <div class="hero-foot">本月售出 ${month.units} 件 · 按实际成交价计算</div><div class="hero-label">累计毛利润 ${yuan(total.profit)}</div></div>
    <div class="metrics">
      ${metric('剩余库存', String(stockQty), `共 ${state.products.length} 条采购记录`, '件')}
      ${metric('库存成本', yuan(stockCost), '未售商品成本')}
      ${metric('本月销售额', yuan(month.revenue), `${monthSales.length} 笔销售记录`)}
      ${metric('本月已售成本', yuan(month.cost), '仅统计本月已卖出商品')}
    </div>
    <div class="actions"><button class="action-btn" data-action="add-product">＋ 录入商品</button><button class="action-btn light" data-action="add-sale">↗ 记录销售</button></div>
    <div class="section-head"><h2>最近销售</h2><button class="pill" data-action="go-sales">查看全部 →</button></div>
    ${recent.length ? `<div class="list">${recent.map(saleCard).join('')}</div>` : empty('◌', '还没有销售记录', '录入商品后，就能记录成交价并自动计算利润。', 'add-product', '添加第一件商品')}
    <div class="section-head"><h2>库存提示</h2><small>实时更新</small></div>
    <div class="card preview-card">
      <div class="preview-stat"><span>在售商品批次</span><strong>${state.products.filter(p => p.stock > 0).length} 条</strong></div>
      <div class="divider"></div>
      <div class="preview-stat"><span>已经售罄的批次</span><strong>${state.products.filter(p => p.stock === 0).length} 条</strong></div>
      <div class="divider"></div><div class="preview-stat"><span>库存总成本</span><strong>${yuan(stockCost)}</strong></div>
    </div>`;
}
function productCard(p) {
  const revenuePer = p.priceCents - p.costCents;
  const detail = [p.category, p.color, p.size].filter(Boolean).map(esc).join(' · ');
  const label = p.name ? `${esc(p.brand)} · ${esc(p.name)}` : esc(p.brand);
  return `<article class="product-card">
    <div class="product-head"><div class="product-image">${p.imageData ? `<img src="${esc(p.imageData)}" alt="商品照片">` : '衣'}</div>
    <div class="sale-main"><div class="product-name">${label}</div><div class="product-sku">货号 ${esc(p.sku)} ${detail ? '· ' + detail : ''}</div>
    <div class="product-meta">来源：${esc(p.source)}${p.supplier ? ' · ' + esc(p.supplier) : ''}<br>采购：${esc(p.purchaseDate)} · 共 ${p.quantity} 件</div></div>
    </div><div class="product-finance"><div><span>当前库存</span><strong>${p.stock} <small>件</small></strong></div><div><span>单件成本</span><strong>${yuan(p.costCents)}</strong></div><div><span>参考毛利</span><strong>${yuan(revenuePer)}</strong></div></div>
    <div class="product-actions"><div><button class="text-btn" type="button" data-action="edit-product" data-id="${esc(p.id)}">编辑</button>
    <button class="text-btn danger" type="button" data-action="delete-product" data-id="${esc(p.id)}">删除</button></div>
    <div class="full-row"><span class="stock-pill ${p.stock === 0 ? 'out' : ''}">${p.stock ? `剩余 ${p.stock}` : '已售罄'}</span><button class="sell-btn" type="button" data-action="sell-product" data-id="${esc(p.id)}" ${p.stock === 0 ? 'disabled' : ''}>记录售出 →</button></div></div>
  </article>`;
}
function matchingProducts() {
  const query = state.query.trim().toLocaleLowerCase();
  return state.products.filter(p => !query || [p.brand, p.sku, p.name, p.source, p.supplier, p.category, p.color, p.size].some(x => String(x || '').toLocaleLowerCase().includes(query)));
}
function renderProductList() {
  const list = $('#productList');
  if (!list) return;
  const products = matchingProducts();
  list.innerHTML = products.length ? `<div class="list products-list">${products.map(productCard).join('')}</div>` : empty('⌕', state.products.length ? '没有找到符合条件的商品' : '商品库还是空的', state.products.length ? '换个品牌、货号或来源试试。' : '记录第一批服饰的成本和来源，系统会自动建立库存。', state.products.length ? '' : 'add-product', '新增商品');
}
function renderProducts() {
  return heading('INVENTORY', '商品与库存', `目前记录了 ${state.products.length} 个采购批次`, `<button class="pill" data-action="add-product">＋ 新增</button>`) + `
    <div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></svg><input id="productSearch" placeholder="搜索品牌、货号、商品来源…" autocomplete="off" value="${esc(state.query)}"></div>
    <div id="productList"></div>`;
}
function saleCard(s) {
  const profit = saleRevenue(s) - saleCost(s);
  return `<article class="card sale-row"><div class="sale-icon">↗</div><div class="sale-main"><strong>${esc(s.brand)} · ${esc(s.sku)}</strong><span>${esc(s.date)} · ${s.quantity} 件 · ${esc(s.source)}</span></div><div class="sale-amount"><strong>${yuan(saleRevenue(s))}</strong><em>毛利 ${yuan(profit)}</em></div><button class="mini-delete" title="撤销此笔销售并返还库存" aria-label="撤销销售" data-action="delete-sale" data-id="${esc(s.id)}">×</button></article>`;
}
function renderSales() {
  const all = summaries(state.sales);
  return heading('SALES JOURNAL', '销售记录', '录入实际成交价，利润自动计算', `<button class="pill" data-action="add-sale">＋ 记一笔</button>`) + `
    <div class="metrics">${metric('累计成交金额', yuan(all.revenue), `累计卖出 ${all.units} 件`)}${metric('累计毛利润', yuan(all.profit), `已售成本 ${yuan(all.cost)}`)}</div>
    <div class="section-head"><h2>交易明细</h2><small>共 ${state.sales.length} 笔</small></div>
    ${state.sales.length ? `<div class="list">${state.sales.map(saleCard).join('')}</div>` : empty('↗', '还没有成交记录', '售出一件衣服后，点击“记录销售”即可扣减库存、记录利润。', 'add-sale', '记录第一笔销售')}`;
}
function renderStats() {
  const filtered = state.sales.filter(s => inPeriod(s, state.period));
  const summary = summaries(filtered);
  const margins = summary.revenue ? (100 * summary.profit / summary.revenue).toFixed(1) + '%' : '—';
  const byBrand = new Map();
  const bySource = new Map();
  filtered.forEach(s => {
    const profit = saleRevenue(s) - saleCost(s);
    byBrand.set(s.brand, (byBrand.get(s.brand) || 0) + profit);
    bySource.set(s.source, (bySource.get(s.source) || 0) + profit);
  });
  const barList = (map, noData) => {
    const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
    if (!entries.length) return `<p class="muted small">${noData}</p>`;
    const max = Math.max(1, ...entries.map(x => Math.abs(x[1])));
    return entries.map(([label, value]) => `<div class="card stat-row"><div class="stat-line"><span>${esc(label)}</span><strong>${yuan(value)}</strong></div><div class="bar-bg"><div class="bar-fill" style="width:${Math.min(100, Math.abs(value) / max * 100).toFixed(1)}%;background:${value < 0 ? '#b65c4c' : '#215e50'}"></div></div></div>`).join('');
  };
  return heading('ANALYTICS', '利润统计', '按实际销售日期归集已实现利润') + `
    <div class="actions" style="margin-bottom:14px">
      ${[['today','今日'],['month','本月'],['all','全部']].map(([v,n]) => `<button class="action-btn ${state.period===v?'':'light'}" data-action="period" data-period="${v}">${n}</button>`).join('')}
    </div>
    <div class="hero"><div class="hero-top">${periodName(state.period)}毛利润</div><div class="hero-value">${yuan(summary.profit)}</div><div class="hero-foot">${summary.units} 件成交 · 毛利率 ${margins}</div></div>
    <div class="metrics">${metric('销售收入', yuan(summary.revenue))}${metric('已售成本', yuan(summary.cost))}</div>
    <div class="section-head"><h2>品牌利润排行</h2><small>按毛利润</small></div>${barList(byBrand, '此时间段暂时没有销售记录。')}
    <div class="section-head"><h2>商品来源利润排行</h2><small>按毛利润</small></div>${barList(bySource, '此时间段暂时没有销售记录。')}
    <p class="muted small" style="margin-top:20px">统计的“成本”仅指已卖出商品的采购成本，库存未售出的投入不计入已实现毛利润。未扣除运费、手续费、税费。</p>`;
}
function render() {
  $('#content').innerHTML = ({home:renderHome,products:renderProducts,sales:renderSales,stats:renderStats})[state.tab]();
  document.querySelectorAll('.tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === state.tab);
    el.setAttribute('aria-current', el.dataset.tab === state.tab ? 'page' : 'false');
  });
  if (state.tab === 'products') renderProductList();
}
function navigate(tab) { state.tab = tab; state.query = ''; render(); window.scrollTo({top:0,behavior:'instant'}); }
function showDialog(id) { const el = document.getElementById(id); if (!el.open) el.showModal(); }
function hideDialog(id) { const el = document.getElementById(id); if (el.open) el.close(); }
function previewImage(data) {
  $('#imagePreview').innerHTML = data ? `<img src="${esc(data)}" alt="商品预览">` : '＋<small>添加商品照片</small>';
}
function openProduct(id) {
  const p = state.products.find(x => x.id === id);
  state.editingId = p?.id || null;
  state.pendingImage = p?.imageData || '';
  $('#productForm').reset();
  const f = $('#productForm').elements;
  $('#productDialogTitle').textContent = p ? '编辑商品' : '新增商品';
  f.namedItem('brand').value = p?.brand || '';
  f.namedItem('sku').value = p?.sku || '';
  f.namedItem('name').value = p?.name || '';
  f.namedItem('category').value = p?.category || '';
  f.namedItem('size').value = p?.size || '';
  f.namedItem('color').value = p?.color || '';
  f.namedItem('source').value = p?.source || '';
  f.namedItem('supplier').value = p?.supplier || '';
  f.namedItem('purchaseDate').value = p?.purchaseDate || today();
  f.namedItem('quantity').value = p?.quantity || '1';
  f.namedItem('cost').value = p ? moneyValue(p.costCents) : '';
  f.namedItem('price').value = p ? moneyValue(p.priceCents) : '';
  $('#productFormNote').textContent = p ? `此批次已售 ${p.quantity - p.stock} 件；修改采购件数不能低于已售件数。` : '相同货号可以分批录入，不同来源或成本分别核算。';
  previewImage(state.pendingImage);
  showDialog('productDialog');
}
function availableProducts() { return state.products.filter(p => p.stock > 0); }
function updateSalePreview() {
  const form = $('#saleForm');
  const p = state.products.find(x => x.id === form.elements.namedItem('productId').value);
  const hint = $('#saleStockHint');
  hint.textContent = p ? `${p.brand} · ${p.sku} · 还剩 ${p.stock} 件 · 成本 ${yuan(p.costCents)}/件` : '请先新增有库存的商品';
  const q = int(form.elements.namedItem('quantity').value);
  const price = asCents(form.elements.namedItem('price').value);
  $('#estimateRevenue').textContent = p && q > 0 && Number.isFinite(price) ? yuan(q * price) : yuan(0);
  $('#estimateProfit').textContent = p && q > 0 && Number.isFinite(price) ? yuan(q * (price - p.costCents)) : yuan(0);
  form.elements.namedItem('quantity').max = p ? String(p.stock) : '1';
}
function openSale(productId = '') {
  $('#saleForm').reset();
  const select = $('#saleProduct');
  const available = availableProducts();
  select.innerHTML = available.length ? available.map(p => `<option value="${esc(p.id)}">${esc(p.brand)} ${esc(p.sku)} · ${esc(p.source)} · 剩余${p.stock}件</option>`).join('') : '<option value="">请先录入商品</option>';
  if (productId && available.some(p => p.id === productId)) select.value = productId;
  const p = state.products.find(x => x.id === select.value);
  $('#saleForm').elements.namedItem('price').value = p ? moneyValue(p.priceCents) : '';
  $('#saleForm').elements.namedItem('quantity').value = 1;
  $('#saleForm').elements.namedItem('saleDate').value = today();
  $('#saleSaveButton').disabled = !available.length;
  updateSalePreview();
  showDialog('saleDialog');
}
function fitImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('请选择图片文件'));
    if (file.size > 25 * 1024 * 1024) return reject(new Error('图片太大，请选择不超过 25MB 的照片'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 720 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', .76));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取所选图片')); };
    img.src = url;
  });
}
function validateCash(value, field) {
  const n = Number(value);
  if (String(value).trim() === '' || !Number.isFinite(n) || n < 0 || n > 99999999) throw new Error(`${field}请输入有效的非负金额`);
  return asCents(n);
}
function validateQuantity(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 999999) throw new Error('数量必须是大于0的整数');
  return n;
}
async function exportFile(name, contents, mime) {
  const file = new File([contents], name, { type: mime });
  try {
    if (navigator.canShare?.({files:[file]})) {
      await navigator.share({ files:[file], title:'衣账数据备份' });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  const blobUrl = URL.createObjectURL(file);
  const a = document.createElement('a'); a.href = blobUrl; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 90000);
  toast('文件已生成，请保存到“文件”App或电脑');
}
function csvRow(values) {
  return values.map(value => {
    let v = String(value ?? '');
    // 防止 Excel 把用户输入当作公式执行。
    if (/^[\s]*[=+@\-]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) v = "'" + v;
    return '"' + v.replace(/"/g, '""') + '"';
  }).join(',') + '\r\n';
}
async function exportBackup() {
  const json = JSON.stringify({ app:'yizhang', version:1, exportedAt:new Date().toISOString(), products:state.products, sales:state.sales });
  await exportFile(`衣账完整备份_${today()}.json`, json, 'application/json');
}
async function exportProductsCsv() {
  const keys = ['品牌','货号','商品名称','分类','颜色','尺码','来源','供应商','采购日期','采购件数','剩余件数','单件成本(元)','参考售价(元)','采购总成本(元)','库存成本(元)'];
  const rows = state.products.map(p => [p.brand,p.sku,p.name,p.category,p.color,p.size,p.source,p.supplier,p.purchaseDate,p.quantity,p.stock,moneyValue(p.costCents),moneyValue(p.priceCents),moneyValue(p.quantity*p.costCents),moneyValue(p.stock*p.costCents)]);
  await exportFile(`衣账商品_${today()}.csv`, '\ufeff' + csvRow(keys) + rows.map(csvRow).join(''), 'text/csv;charset=utf-8');
}
async function exportSalesCsv() {
  const keys = ['销售日期','品牌','货号','名称','来源','卖出件数','单件售价(元)','单件成本(元)','销售收入(元)','已售成本(元)','毛利润(元)'];
  const rows = state.sales.map(s => [s.date,s.brand,s.sku,s.name,s.source,s.quantity,moneyValue(s.priceCents),moneyValue(s.costCents),moneyValue(saleRevenue(s)),moneyValue(saleCost(s)),moneyValue(saleRevenue(s)-saleCost(s))]);
  await exportFile(`衣账销售_${today()}.csv`, '\ufeff' + csvRow(keys) + rows.map(csvRow).join(''), 'text/csv;charset=utf-8');
}
function prepareBackup(backup) {
  if (backup?.app !== 'yizhang' || backup.version !== 1 || !Array.isArray(backup.products) || !Array.isArray(backup.sales)) throw new Error('不是受支持的衣账备份文件');
  if (backup.products.length > 50000 || backup.sales.length > 100000) throw new Error('备份记录过多，无法导入');
  const pids = new Set(), sids = new Set(), soldQty = new Map();
  for (const p of backup.products) {
    if (typeof p?.id !== 'string' || !p.id || pids.has(p.id) || typeof p.brand !== 'string' || typeof p.sku !== 'string' || typeof p.source !== 'string' || !Number.isSafeInteger(p.quantity) || p.quantity < 1 || !Number.isSafeInteger(p.costCents) || p.costCents < 0 || !Number.isSafeInteger(p.priceCents) || p.priceCents < 0) throw new Error('备份中商品数据不完整');
    if (p.imageData && (typeof p.imageData !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/i.test(p.imageData))) throw new Error('备份中的图片格式异常');
    pids.add(p.id);
  }
  for (const s of backup.sales) {
    if (typeof s?.id !== 'string' || !s.id || sids.has(s.id) || !pids.has(s.productId) || !Number.isSafeInteger(s.quantity) || s.quantity < 1 || !Number.isSafeInteger(s.priceCents) || s.priceCents < 0 || !Number.isSafeInteger(s.costCents) || s.costCents < 0 || typeof s.date !== 'string') throw new Error('备份中销售数据不完整');
    sids.add(s.id); soldQty.set(s.productId, (soldQty.get(s.productId) || 0) + s.quantity);
  }
  const products = backup.products.map(p => {
    const remaining = p.quantity - (soldQty.get(p.id) || 0);
    if (remaining < 0) throw new Error('备份库存与销售件数不匹配');
    return {...p, stock:remaining};
  });
  return {products, sales:backup.sales};
}
async function importBackup(file) {
  if (!file) return;
  try {
    if (file.size > 60 * 1024 * 1024) throw new Error('备份文件超过 60MB，请分批整理照片后再试');
    const data = prepareBackup(JSON.parse(await file.text()));
    if (!confirm(`将导入 ${data.products.length} 条商品和 ${data.sales.length} 笔销售记录。\n\n注意：会完全替换当前手机的所有账本数据！\n请确认已备份当前数据。\n\n确定继续吗？`)) return;
    await txWrite(['products','sales'], tx => {
      const products = tx.objectStore('products'); const sales = tx.objectStore('sales');
      products.clear(); sales.clear();
      data.products.forEach(p => products.put(p));
      data.sales.forEach(s => sales.put(s));
    });
    await reload(); hideDialog('settingsDialog'); toast('恢复成功，全部记录已更新');
  } catch (e) { toast('导入失败：' + e.message); }
  finally { $('#importFile').value = ''; }
}
async function handleAction(action, target) {
  const id = target.dataset.id;
  switch (action) {
    case 'add-product': openProduct(); break;
    case 'edit-product': openProduct(id); break;
    case 'add-sale': openSale(); break;
    case 'sell-product': openSale(id); break;
    case 'go-sales': navigate('sales'); break;
    case 'period': state.period = target.dataset.period; render(); break;
    case 'delete-product': {
      const p = state.products.find(x => x.id === id);
      if (p && confirm(`确定删除 ${p.brand} / ${p.sku} 此批次吗？\n此操作不能撤销。`)) { await deleteProduct(id); await reload(); toast('商品已删除'); }
      break;
    }
    case 'delete-sale': {
      const s = state.sales.find(x => x.id === id);
      if (s && confirm(`确定撤销 ${s.brand} / ${s.sku} 的这笔销售吗？\n${s.quantity} 件商品会恢复到库存。`)) { await deleteSale(id); await reload(); toast('销售已撤销，库存已返还'); }
      break;
    }
  }
}
function attachEvents() {
  document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => navigate(button.dataset.tab)));
  $('#settingsButton').addEventListener('click', () => showDialog('settingsDialog'));
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => hideDialog(button.dataset.close)));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));
  $('#content').addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (button && !button.disabled) handleAction(button.dataset.action, button).catch(e => toast('操作失败：' + e.message));
  });
  $('#content').addEventListener('input', event => {
    if (event.target.id === 'productSearch') { state.query = event.target.value; renderProductList(); }
  });
  $('#productImage').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try { state.pendingImage = await fitImage(file); previewImage(state.pendingImage); }
    catch (e) { toast(e.message); }
  });
  $('#productForm').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target; const button = $('#productSaveButton');
    try {
      const f = form.elements;
      const costCents = validateCash(f.namedItem('cost').value, '单件成本');
      const priceRaw = f.namedItem('price').value;
      const priceCents = priceRaw.trim() ? validateCash(priceRaw, '参考售价') : 0;
      const record = {
        id: state.editingId || uid(), imageData:state.pendingImage,
        brand:f.namedItem('brand').value.trim(), sku:f.namedItem('sku').value.trim(), name:f.namedItem('name').value.trim(),
        category:f.namedItem('category').value.trim(), color:f.namedItem('color').value.trim(), size:f.namedItem('size').value.trim(),
        source:f.namedItem('source').value.trim(), supplier:f.namedItem('supplier').value.trim(),
        purchaseDate:f.namedItem('purchaseDate').value, quantity:validateQuantity(f.namedItem('quantity').value), costCents, priceCents
      };
      if (!record.brand || !record.sku || !record.source || !record.purchaseDate) throw new Error('请填写品牌、货号、来源及日期');
      button.disabled = true;
      await saveProduct(record, state.editingId);
      await reload(); hideDialog('productDialog'); toast('商品已保存');
    } catch (e) { toast('保存失败：' + e.message); }
    finally { button.disabled = false; }
  });
  $('#saleProduct').addEventListener('change', () => {
    const p = state.products.find(x => x.id === $('#saleProduct').value);
    $('#saleForm').elements.namedItem('price').value = p ? moneyValue(p.priceCents) : '';
    updateSalePreview();
  });
  $('#saleForm').addEventListener('input', updateSalePreview);
  $('#saleForm').addEventListener('submit', async event => {
    event.preventDefault();
    const f = event.target.elements; const button = $('#saleSaveButton');
    try {
      const qty = validateQuantity(f.namedItem('quantity').value);
      const price = validateCash(f.namedItem('price').value, '实际成交价');
      const productId = f.namedItem('productId').value;
      const saleDate = f.namedItem('saleDate').value;
      if (!productId || !saleDate) throw new Error('请选择商品和销售日期');
      button.disabled = true;
      await recordSale(productId, qty, price, saleDate);
      await reload(); hideDialog('saleDialog'); toast('销售已记录，库存自动扣减');
    } catch (e) { toast('记录失败：' + e.message); }
    finally { button.disabled = false; }
  });
  $('#exportBackup').addEventListener('click', () => exportBackup().catch(e => toast(e.message)));
  $('#importBackup').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', event => importBackup(event.target.files?.[0]));
  $('#exportProductsCsv').addEventListener('click', () => exportProductsCsv().catch(e => toast(e.message)));
  $('#exportSalesCsv').addEventListener('click', () => exportSalesCsv().catch(e => toast(e.message)));
}
async function start() {
  try {
    state.db = await openDb(); attachEvents(); await reload();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js').catch(e => console.warn('离线缓存注册失败:', e));
    }
  } catch (e) {
    $('#content').innerHTML = empty('⚠', '本地存储无法使用', `请用 Safari 打开正式 HTTPS 地址，避免无痕浏览；错误：${e.message}`, '', '');
  }
}
start();
