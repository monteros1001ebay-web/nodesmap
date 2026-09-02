(function () {
  const canvas = document.getElementById('mapCanvas');
  const ctx = canvas.getContext('2d');
  const mapWrap = document.getElementById('mapWrap');
  const tooltip = document.getElementById('tooltip');

  // ---- node type legend ----
  const DEFAULT_LEGEND = {
    '█': { name: 'Nodes', color: '#ff5470' },
    '▓': { name: 'Nodes', color: '#4fb3ff' },
    '▒': { name: 'Nodes', color: '#f5c451' },
    '#': { name: 'No node', color: '#9b6bff' }
  };
  let legend = JSON.parse(JSON.stringify(DEFAULT_LEGEND));
  const LEGEND_KEYS = Object.keys(DEFAULT_LEGEND);
  const UNKNOWN_COLOR = '#888888';

  // ---- view state: viewX/viewZ = world coords at screen center, scale = px per block ----
  let view = { x: 0, z: 0, scale: 2 };
  let tileMetadata = [];       // [{ name, wx, wz, size }]
  let tileCache = new Map();   // name -> { img, loaded }
  let nodeMap = new Map();     // "cx,cz" -> type symbol
  let nodesVisible = false;
  let nodesOpacity = 1.0;

  // ---- claims image overlay state ----
  let claimsImg = new Image();
  let claimsLoaded = false;
  let claimsVisible = false;
  let claimsOpacity = 0.7;
  claimsImg.onload = () => { claimsLoaded = true; draw(); };
  claimsImg.src = 'images/claims.png';

  // ---- snitch overlay state ----
  let snitchList = [];         // [{ x, y, z, name, groupName, type, dormantTs, cullTs, createdTs, createdBy }]
  let snitchesVisible = false;
  let snitchesOpacity = 0.8;
  let SQL = null;              // sql.js handle

  let dpr = Math.max(1, window.devicePixelRatio || 1);

  function resizeCanvas() {
    const rect = mapWrap.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    draw();
  }
  window.addEventListener('resize', resizeCanvas);

  function worldToScreen(wx, wz) {
    const cw = canvas.width, ch = canvas.height;
    return {
      x: cw / 2 + (wx - view.x) * view.scale * dpr,
      y: ch / 2 + (wz - view.z) * view.scale * dpr
    };
  }
  function screenToWorld(sx, sy) {
    const cw = canvas.width, ch = canvas.height;
    return {
      x: view.x + (sx * dpr - cw / 2) / (view.scale * dpr),
      z: view.z + (sy * dpr - ch / 2) / (view.scale * dpr)
    };
  }

  function draw() {
    const cw = canvas.width, ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#14161a';
    ctx.fillRect(0, 0, cw, ch);

    if (tileMetadata.length > 0) {
      drawTiles();
    } else {
      drawGrid();
    }
    if (claimsVisible && claimsLoaded) drawClaims();
    if (nodesVisible) drawNodes();
    if (snitchesVisible) drawSnitches();
    drawOrigin();
  }

  function drawGrid() {
    const chunkPx = 16 * view.scale * dpr;
    if (chunkPx > 3) drawGridLines(16, false);
    drawGridLines(512, true);
  }

  function drawGridLines(blockStep, major) {
    const scale = view.scale * dpr;
    const cw = canvas.width, ch = canvas.height;
    ctx.strokeStyle = major ? getCss('--grid-line-major') : getCss('--grid-line');
    ctx.lineWidth = major ? 1.4 : 1;

    const halfWBlocks = (cw / 2) / scale, halfHBlocks = (ch / 2) / scale;
    const startX = Math.floor((view.x - halfWBlocks) / blockStep) * blockStep;
    const endX = Math.ceil(view.x + halfWBlocks);
    const startZ = Math.floor((view.z - halfHBlocks) / blockStep) * blockStep;
    const endZ = Math.ceil(view.z + halfHBlocks);

    for (let wx = startX; wx <= endX; wx += blockStep) {
      const s = worldToScreen(wx, 0);
      ctx.beginPath(); ctx.moveTo(s.x, 0); ctx.lineTo(s.x, ch); ctx.stroke();
    }
    for (let wz = startZ; wz <= endZ; wz += blockStep) {
      const s = worldToScreen(0, wz);
      ctx.beginPath(); ctx.moveTo(0, s.y); ctx.lineTo(cw, s.y); ctx.stroke();
    }
  }

  function getCss(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }

  function colorForType(type) {
    return (legend[type] && legend[type].color) || UNKNOWN_COLOR;
  }

  function drawTiles() {
    const scale = view.scale * dpr;
    const halfWBlocks = (canvas.width / 2) / scale, halfHBlocks = (canvas.height / 2) / scale;
    const buffer = 1024;
    const left = view.x - halfWBlocks - buffer, right = view.x + halfWBlocks + buffer;
    const top = view.z - halfHBlocks - buffer, bottom = view.z + halfHBlocks + buffer;

    ctx.imageSmoothingEnabled = view.scale < 4;

    for (const t of tileMetadata) {
      if (!t.size) continue;
      if (t.wx + t.size < left || t.wx > right || t.wz + t.size < top || t.wz > bottom) continue;

      let cached = tileCache.get(t.name);
      if (!cached) {
        const img = new Image();
        cached = { img, loaded: false };
        tileCache.set(t.name, cached);
        img.onload = () => {
          cached.loaded = true;
          draw();
        };
        img.src = TILES_DIR + encodeURIComponent(t.name);
      }

      if (cached.loaded) {
        const a = worldToScreen(t.wx, t.wz);
        const w = t.size * scale, h = t.size * scale;
        ctx.drawImage(cached.img, a.x, a.y, w, h);
      }
    }
  }

  function drawClaims() {
    const minX = -15360, minZ = -15360;
    const maxX = 15360, maxZ = 15360;
    const a = worldToScreen(minX, minZ);
    const b = worldToScreen(maxX, maxZ);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);

    if (x + w < 0 || y + h < 0 || x > canvas.width || y > canvas.height) return;

    ctx.save();
    ctx.globalAlpha = claimsOpacity;
    ctx.drawImage(claimsImg, x, y, w, h);
    ctx.restore();
  }

  function drawNodes() {
    if (nodeMap.size === 0) return;
    const byType = new Map();
    for (const [key, type] of nodeMap) {
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(key);
    }
    for (const [type, keys] of byType) {
      ctx.fillStyle = colorForType(type);
      ctx.globalAlpha = 0.35 * nodesOpacity;
      for (const key of keys) {
        const [cx, cz] = key.split(',').map(Number);
        const wx0 = cx * 16, wz0 = cz * 16;
        const a = worldToScreen(wx0, wz0);
        const b = worldToScreen(wx0 + 16, wz0 + 16);
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        if (x + w < 0 || y + h < 0 || x > canvas.width || y > canvas.height) continue;
        ctx.fillRect(x, y, w, h);
      }
      ctx.strokeStyle = colorForType(type);
      ctx.globalAlpha = 0.9 * nodesOpacity;
      ctx.lineWidth = 1.5;
      for (const key of keys) {
        const [cx, cz] = key.split(',').map(Number);
        const wx0 = cx * 16, wz0 = cz * 16;
        const a = worldToScreen(wx0, wz0);
        const b = worldToScreen(wx0 + 16, wz0 + 16);
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        if (x + w < 0 || y + h < 0 || x > canvas.width || y > canvas.height) continue;
        ctx.strokeRect(x, y, w, h);
      }
    }
    ctx.globalAlpha = 1;
  }

  function getSnitchCullInfo(s) {
    const rawTs = s.dormantTs || s.cullTs;
    if (!rawTs) {
      return { color: '#6ee7a7', cullText: null };
    }

    let ts = Number(rawTs);
    if (isNaN(ts)) return { color: '#6ee7a7', cullText: null };

    if (ts < 1e11) ts *= 1000;

    const diffMs = ts - Date.now();
    if (diffMs <= 0) {
      return { color: '#ff5470', cullText: 'Culled / Dormant' };
    }

    const totalSecs = Math.floor(diffMs / 1000);
    const days = Math.floor(totalSecs / 86400);
    const hours = Math.floor((totalSecs % 86400) / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);

    let cullText = '';
    if (days > 0) cullText = `${days}d ${hours}h`;
    else if (hours > 0) cullText = `${hours}h ${mins}m`;
    else cullText = `${mins}m`;

    let color = '#6ee7a7'; // Green (not near)
    if (days < 2) {
      color = '#ff5470'; // Red (close)
    } else if (days < 7) {
      color = '#f5c451'; // Yellow (somewhat)
    }

    return { color, cullText };
  }

  function drawSnitches() {
    if (snitchList.length === 0) return;

    ctx.save();
    for (const s of snitchList) {
      // Snitch 10-block radius box spanning [x-10, z-10] to [x+11, z+11]
      const minX = s.x - 10, maxX = s.x + 11;
      const minZ = s.z - 10, maxZ = s.z + 11;

      const a = worldToScreen(minX, minZ);
      const b = worldToScreen(maxX, maxZ);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);

      if (x + w < 0 || y + h < 0 || x > canvas.width || y > canvas.height) continue;

      const cullInfo = getSnitchCullInfo(s);

      // Field box fill
      ctx.fillStyle = cullInfo.color;
      ctx.globalAlpha = 0.15 * snitchesOpacity;
      ctx.fillRect(x, y, w, h);

      // Field box border
      ctx.strokeStyle = cullInfo.color;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.75 * snitchesOpacity;
      ctx.strokeRect(x, y, w, h);
    }
    ctx.restore();
  }

  function drawOrigin() {
    const s = worldToScreen(0, 0);
    ctx.strokeStyle = getCss('--accent-2');
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(s.x - 8, s.y); ctx.lineTo(s.x + 8, s.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s.x, s.y - 8); ctx.lineTo(s.x, s.y + 8); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ---- legend UI ----
  function renderMapLegend() {
    const legendEl = document.getElementById('legend');
    legendEl.innerHTML = '';

    const nodeKeys = LEGEND_KEYS.slice(0, 3);
    const otherKeys = LEGEND_KEYS.slice(3);

    const nodeRow = document.createElement('div');
    nodeRow.className = 'legend-row';
    nodeKeys.forEach(key => {
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = legend[key].color;
      sw.style.opacity = '0.8';
      nodeRow.appendChild(sw);
    });
    nodeRow.appendChild(document.createTextNode(legend[nodeKeys[0]].name));
    legendEl.appendChild(nodeRow);

    otherKeys.forEach(key => {
      const row = document.createElement('div');
      row.className = 'legend-row';
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = legend[key].color;
      sw.style.opacity = '0.8';
      row.appendChild(sw);
      row.appendChild(document.createTextNode(legend[key].name));
      legendEl.appendChild(row);
    });
  }

  function updateLegendVisibility() {
    const legendEl = document.getElementById('legend');
    legendEl.style.display = nodesVisible ? 'flex' : 'none';
  }

  // ---- pan / zoom ----
  let dragging = false, dragStart = null, viewStart = null;
  mapWrap.addEventListener('mousedown', (e) => {
    dragging = true; mapWrap.classList.add('dragging');
    dragStart = { x: e.clientX, y: e.clientY }; viewStart = { x: view.x, z: view.z };
  });
  window.addEventListener('mouseup', () => { dragging = false; mapWrap.classList.remove('dragging'); });
  window.addEventListener('mousemove', (e) => {
    const rect = mapWrap.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (dragging) {
      const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
      view.x = viewStart.x - dx / view.scale;
      view.z = viewStart.z - dy / view.scale;
      draw();
    }
    updateTooltip(mx, my);
  });
  mapWrap.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  mapWrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    view.scale = Math.min(40, Math.max(0.02, view.scale * factor));
    draw();
  }, { passive: false });

  // ---- touch pan / pinch-zoom (mobile) ----
  function touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }
  let touchDragging = false, touchDragStart = null, touchViewStart = null;
  let pinchStartDist = null, pinchStartScale = null;

  mapWrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      touchDragging = true;
      pinchStartDist = null;
      const t = e.touches[0];
      touchDragStart = { x: t.clientX, y: t.clientY };
      touchViewStart = { x: view.x, z: view.z };
    } else if (e.touches.length === 2) {
      touchDragging = false;
      pinchStartDist = touchDist(e.touches);
      pinchStartScale = view.scale;
    }
  }, { passive: true });

  mapWrap.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && touchDragging) {
      e.preventDefault();
      const t = e.touches[0];
      const dx = t.clientX - touchDragStart.x, dy = t.clientY - touchDragStart.y;
      view.x = touchViewStart.x - dx / view.scale;
      view.z = touchViewStart.z - dy / view.scale;
      draw();
    } else if (e.touches.length === 2 && pinchStartDist) {
      e.preventDefault();
      const factor = touchDist(e.touches) / pinchStartDist;
      view.scale = Math.min(40, Math.max(0.02, pinchStartScale * factor));
      draw();
    }
  }, { passive: false });

  mapWrap.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
      touchDragging = false;
      pinchStartDist = null;
    } else if (e.touches.length === 1) {
      touchDragging = true;
      pinchStartDist = null;
      const t = e.touches[0];
      touchDragStart = { x: t.clientX, y: t.clientY };
      touchViewStart = { x: view.x, z: view.z };
    }
  });

  function updateTooltip(mx, my) {
    const w = screenToWorld(mx, my);
    const wx = Math.floor(w.x), wz = Math.floor(w.z);
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);

    let html = `<span class="coord">X: ${wx}  Z: ${wz}</span><br>chunk ${cx}, ${cz}`;

    if (snitchesVisible && snitchList.length > 0) {
      const hovered = snitchList.filter(s =>
        wx >= s.x - 10 && wx <= s.x + 10 && wz >= s.z - 10 && wz <= s.z + 10
      );
      if (hovered.length > 0) {
        for (let i = 0; i < Math.min(3, hovered.length); i++) {
          const s = hovered[i];
          const cullInfo = getSnitchCullInfo(s);
          const displayName = s.name ? s.name : 'Unnamed Snitch';
          const groupName = s.groupName ? s.groupName : 'No Group';

          html += `<div style="border-top:1px solid var(--border);margin-top:6px;padding-top:4px;">`;
          html += `<div style="color:${cullInfo.color};font-weight:bold;font-size:12px;">🔊 ${displayName}</div>`;
          html += `<div style="color:var(--text-dim);font-size:11px;margin-top:2px;">Group: <span style="color:var(--text);">${groupName}</span> | Type: <span style="color:var(--text);">${s.type || 'Snitch'}</span></div>`;
          html += `<div style="color:var(--text-dim);font-size:11px;">Location: <span style="color:var(--accent-2);">X: ${s.x}, Y: ${s.y}, Z: ${s.z}</span></div>`;
          if (cullInfo.cullText) {
            html += `<div style="color:var(--text-dim);font-size:11px;">Cull in: <span style="color:${cullInfo.color};font-weight:bold;">${cullInfo.cullText}</span></div>`;
          }
          html += `</div>`;
        }
      }
    }

    tooltip.style.display = 'block';
    tooltip.style.left = (mx + 14) + 'px';
    tooltip.style.top = (my + 14) + 'px';
    tooltip.innerHTML = html;
  }

  // ---- Xaero tile loading with lazy viewport culling ----
  const XAERO_NAME_RE = /^(-?\d+)_(-?\d+)_x(-?\d+)_z(-?\d+)\.png$/i;
  const TILES_DIR = 'tiles/';

  function setTileStatus(text, ok) {
    if (!ok) console.log('[tiles]', text);
  }

  async function listPngsInDir(dirUrl) {
    const manifestUrl = dirUrl + 'index.json';
    try {
      const res = await fetch(manifestUrl, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const names = Array.isArray(data) ? data : (Array.isArray(data.tiles) ? data.tiles : null);
        if (names) return names;
      }
    } catch (e) { }

    const res = await fetch(dirUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const names = new Set();
    doc.querySelectorAll('a[href]').forEach(a => {
      let href = a.getAttribute('href');
      if (!href) return;
      try { href = decodeURIComponent(href); } catch (e) { }
      href = href.split('/').pop();
      if (/\.png$/i.test(href)) names.add(href);
    });
    return Array.from(names);
  }

  function loadTiles() {
    setTileStatus('Loading tiles\u2026', false);
    listPngsInDir(TILES_DIR).then(names => {
      const parsed = [];
      let unmatched = 0;
      for (const name of names) {
        const m = name.match(XAERO_NAME_RE);
        if (!m) { unmatched++; continue; }
        parsed.push({ name, wx: parseInt(m[3], 10), wz: parseInt(m[4], 10) });
      }
      if (parsed.length === 0) {
        setTileStatus('No matching tile filenames found in ' + TILES_DIR + ' \u2014 showing a plain coordinate grid.', false);
        tileMetadata = [];
        draw();
        return;
      }

      const xs = Array.from(new Set(parsed.map(p => p.wx))).sort((a, b) => a - b);
      const zs = Array.from(new Set(parsed.map(p => p.wz))).sort((a, b) => a - b);
      let size = null;
      for (let i = 1; i < xs.length; i++) { const d = xs[i] - xs[i - 1]; if (d > 0 && (size === null || d < size)) size = d; }
      for (let i = 1; i < zs.length; i++) { const d = zs[i] - zs[i - 1]; if (d > 0 && (size === null || d < size)) size = d; }

      tileMetadata = parsed.map(p => ({ ...p, size: size || 1024 }));
      draw();
    }).catch(err => {
      setTileStatus(`Couldn't load tiles (${err.message}).`, false);
      tileMetadata = [];
      draw();
    });
  }

  // ---- node data helpers ----
  function applyNodesFromObjectArray(arr, replace) {
    if (replace) nodeMap = new Map();
    let added = 0;
    for (const n of arr) {
      if (n == null) continue;
      let cx, cz, type;
      if (Array.isArray(n)) { cx = n[0]; cz = n[1]; type = n[2]; }
      else { cx = n.cx; cz = n.cz; type = n.type; }
      if (typeof cx !== 'number' || typeof cz !== 'number') continue;
      if (type === undefined || type === null) type = '#';
      nodeMap.set(Math.round(cx) + ',' + Math.round(cz), type);
      added++;
    }
    return added;
  }

  function setNodeFileStatus(text, ok) {
    const el = document.getElementById('nodeFileStatus');
    if (el) {
      el.className = ok ? 'ok' : '';
      el.textContent = text;
    }
  }

  function setSnitchFileStatus(text, ok) {
    const el = document.getElementById('snitchFileStatus');
    if (el) {
      el.className = ok ? 'ok' : '';
      el.textContent = text;
    }
  }

  // ---- toggle scraper help info box ----
  const toggleInfoBtn = document.getElementById('toggleInfoBtn');
  const infoBox = document.getElementById('infoBox');
  if (toggleInfoBtn && infoBox) {
    toggleInfoBtn.addEventListener('click', () => {
      infoBox.style.display = (infoBox.style.display === 'block') ? 'none' : 'block';
    });
  }

  // ---- toggle snitch help info box ----
  const toggleSnitchInfoBtn = document.getElementById('toggleSnitchInfoBtn');
  const snitchInfoBox = document.getElementById('snitchInfoBox');
  if (toggleSnitchInfoBtn && snitchInfoBox) {
    toggleSnitchInfoBtn.addEventListener('click', () => {
      snitchInfoBox.style.display = (snitchInfoBox.style.display === 'block') ? 'none' : 'block';
    });
  }

  // ---- manual node file upload handler ----
  document.getElementById('nodeFileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const cfg = JSON.parse(evt.target.result);
        if (cfg.legend) {
          LEGEND_KEYS.forEach(k => {
            if (cfg.legend[k]) {
              if (cfg.legend[k].name) legend[k].name = cfg.legend[k].name;
              if (cfg.legend[k].color) legend[k].color = cfg.legend[k].color;
            }
          });
          renderMapLegend();
        }
        let added = 0;
        if (Array.isArray(cfg.nodes)) {
          added = applyNodesFromObjectArray(cfg.nodes, true);
        } else if (cfg.nodes && typeof cfg.nodes === 'object') {
          nodeMap = new Map();
          for (const key in cfg.nodes) { nodeMap.set(key, cfg.nodes[key]); added++; }
        } else if (Array.isArray(cfg)) {
          added = applyNodesFromObjectArray(cfg, true);
        }
        setNodeFileStatus(`Loaded ${file.name} (${added} chunks).`, true);
        draw();
      } catch (err) {
        setNodeFileStatus(`Error parsing JSON: ${err.message}`, false);
      }
    };
    reader.readAsText(file);
  });

  // ---- manual snitch file upload handler ----
  document.getElementById('snitchFileInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setSnitchFileStatus('Parsing database\u2026', false);

    // JSON fallback support
    if (file.name.endsWith('.json')) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const data = JSON.parse(evt.target.result);
          const arr = Array.isArray(data) ? data : (data.snitches || []);
          snitchList = arr.map(s => ({
            x: Number(s.x), y: Number(s.y || 60), z: Number(s.z),
            name: s.name || '', groupName: s.group_name || s.group || '', type: s.type || 'Snitch',
            dormantTs: s.dormant_ts || s.dormantTs, cullTs: s.cull_ts || s.cullTs
          }));
          setSnitchFileStatus(`Loaded ${file.name} (${snitchList.length} snitches).`, true);
          draw();
        } catch (err) {
          setSnitchFileStatus(`Error parsing JSON: ${err.message}`, false);
        }
      };
      reader.readAsText(file);
      return;
    }

    // SQLite file parsing
    if (!SQL) {
      try {
        if (window.initSqlJs) {
          SQL = await window.initSqlJs({
            locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${f}`
          });
        } else {
          throw new Error('sql.js library not loaded yet');
        }
      } catch (err) {
        setSnitchFileStatus(`SQLite parser unavailable: ${err.message}`, false);
        return;
      }
    }

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const uInt8Array = new Uint8Array(evt.target.result);
        const db = new SQL.Database(uInt8Array);
        const res = db.exec("SELECT * FROM snitches_v2");
        if (!res || res.length === 0) {
          setSnitchFileStatus('No snitch records found in snitches_v2 table.', false);
          snitchList = [];
          draw();
          return;
        }

        const columns = res[0].columns.map(c => c.toLowerCase());
        const values = res[0].values;

        const findCol = (names) => {
          for (const name of names) {
            const idx = columns.indexOf(name.toLowerCase());
            if (idx !== -1) return idx;
          }
          return -1;
        };

        const colX = findCol(['x', '\u0445']); // ASCII 'x' vs Cyrillic 'х'
        const colY = findCol(['y']);
        const colZ = findCol(['z']);
        const colName = findCol(['name']);
        const colGroup = findCol(['group_name', 'group', 'groupname']);
        const colType = findCol(['type']);
        const colCreatedTs = findCol(['created_ts']);
        const colCreatedBy = findCol(['created_by_uuid', 'created_by']);
        const colDormantTs = findCol(['dormant_ts']);
        const colCullTs = findCol(['cull_ts']);

        const parsed = [];
        for (const row of values) {
          const x = colX !== -1 ? Number(row[colX]) : NaN;
          const y = colY !== -1 ? Number(row[colY]) : NaN;
          const z = colZ !== -1 ? Number(row[colZ]) : NaN;
          if (isNaN(x) || isNaN(z)) continue;

          parsed.push({
            x: Math.round(x),
            y: isNaN(y) ? 60 : Math.round(y),
            z: Math.round(z),
            name: colName !== -1 && row[colName] ? String(row[colName]) : '',
            groupName: colGroup !== -1 && row[colGroup] ? String(row[colGroup]) : '',
            type: colType !== -1 && row[colType] ? String(row[colType]) : 'Snitch',
            createdTs: colCreatedTs !== -1 ? row[colCreatedTs] : null,
            createdBy: colCreatedBy !== -1 ? row[colCreatedBy] : null,
            dormantTs: colDormantTs !== -1 ? row[colDormantTs] : null,
            cullTs: colCullTs !== -1 ? row[colCullTs] : null,
          });
        }

        snitchList = parsed;
        setSnitchFileStatus(`Loaded ${file.name} (${snitchList.length} snitches).`, true);
        draw();
      } catch (err) {
        setSnitchFileStatus(`Error reading SQLite DB: ${err.message}`, false);
      }
    };
    reader.readAsArrayBuffer(file);
  });

  // ---- nodes overlay toggle & opacity ----
  document.getElementById('toggleNodes').addEventListener('change', (e) => {
    nodesVisible = e.target.checked;
    updateLegendVisibility();
    draw();
  });
  document.getElementById('nodesOpacity').addEventListener('input', (e) => {
    nodesOpacity = parseFloat(e.target.value);
    document.getElementById('nodesOpacityVal').textContent = Math.round(nodesOpacity * 100) + '%';
    draw();
  });

  // ---- claims overlay toggle & opacity ----
  document.getElementById('toggleClaims').addEventListener('change', (e) => {
    claimsVisible = e.target.checked;
    draw();
  });
  document.getElementById('claimsOpacity').addEventListener('input', (e) => {
    claimsOpacity = parseFloat(e.target.value);
    document.getElementById('claimsOpacityVal').textContent = Math.round(claimsOpacity * 100) + '%';
    draw();
  });

  // ---- snitches overlay toggle & opacity ----
  document.getElementById('toggleSnitches').addEventListener('change', (e) => {
    snitchesVisible = e.target.checked;
    draw();
  });
  document.getElementById('snitchesOpacity').addEventListener('input', (e) => {
    snitchesOpacity = parseFloat(e.target.value);
    document.getElementById('snitchesOpacityVal').textContent = Math.round(snitchesOpacity * 100) + '%';
    draw();
  });

  // ---- jump ----
  document.getElementById('jumpBtn').addEventListener('click', () => {
    const x = parseFloat(document.getElementById('jumpX').value);
    const z = parseFloat(document.getElementById('jumpZ').value);
    if (isNaN(x) || isNaN(z)) return;
    view.x = x; view.z = z; draw();
  });

  // ---- collapsible sidebar (auto-collapsed on mobile) ----
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');
  const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

  function setSidebarOpen(open) {
    sidebar.classList.toggle('collapsed', !open);
    sidebarToggle.innerHTML = open ? '&lsaquo;' : '&rsaquo;';
    sidebarBackdrop.classList.toggle('visible', open && isMobile());
  }

  sidebarToggle.addEventListener('click', () => {
    setSidebarOpen(sidebar.classList.contains('collapsed'));
  });
  sidebarBackdrop.addEventListener('click', () => { setSidebarOpen(false); });
  sidebar.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'width') resizeCanvas();
  });

  setSidebarOpen(!isMobile());

  renderMapLegend();
  updateLegendVisibility();
  resizeCanvas();
  loadTiles();
})();
