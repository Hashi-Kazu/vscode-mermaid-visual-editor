/* flowchart.js — Webview script for Flowchart Editor (SVG overlay approach) */
/* global mermaid */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // ── State ────────────────────────────────────────────────────────────────
  let rawCode = '';
  let isDark = false;
  let undoStack = [];
  let isOperating = false;
  let isFirstRender = true;
  let selectedNodeId = null;
  let selectedEdge = null; // { el, from, to, idx }

  // Pan/zoom state
  let tx = 0, ty = 0, scale = 1;
  let isPanning = false;
  let panStartX = 0, panStartY = 0, panStartTx = 0, panStartTy = 0;

  // Port drag state
  let isDraggingPort = false;
  let dragFromNodeId = '';
  let dragStartX = 0, dragStartY = 0;

  // Per-render node/edge registries (reset on each render)
  let nodeRegistry = new Map(); // nodeId -> { el, bbox } (svg-relative coords)
  let edgeRegistry = [];        // [{ el, from, to, idx, labelEl }]
  let edgeCounts = new Map();   // 'from::to' -> count so far

  // ── DOM ──────────────────────────────────────────────────────────────────
  const canvasWrap   = document.getElementById('canvas-wrap');
  const canvas       = document.getElementById('canvas');
  const container    = document.getElementById('mermaid-container');
  const emptyOverlay = document.getElementById('empty-overlay');
  const errorPanel   = document.getElementById('error-panel');
  const btnAddNode   = document.getElementById('btn-add-node');
  const btnUndo      = document.getElementById('btn-undo');
  const btnFit       = document.getElementById('btn-fit');
  const btnExport    = document.getElementById('btn-export');
  const selDirection = document.getElementById('sel-direction');
  const statusLabel  = document.getElementById('status-label');
  const editOverlay  = document.getElementById('fc-edit-overlay');
  const editInput    = document.getElementById('fc-edit-input');
  const dragEdgeSvg  = document.getElementById('drag-edge-svg');
  const dragEdgeLine = document.getElementById('drag-edge-line');

  // ── Mermaid init ─────────────────────────────────────────────────────────
  mermaid.initialize({
    startOnLoad: false,
    suppressErrorRendering: true,
    flowchart: { curve: 'basis', useMaxWidth: false },
  });

  // ── VS Code message handler ───────────────────────────────────────────────
  window.addEventListener('message', async (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'update':
        rawCode = msg.rawCode;
        isDark = msg.isDark;
        hideEmpty();
        await renderDiagram();
        syncDirectionDropdown();
        setControlsEnabled(true);
        if (isFirstRender) {
          isFirstRender = false;
          scheduleFirstFit(0);
        }
        break;
      case 'saved':
        showStatus('保存済み');
        break;
      case 'parseError':
        hideEmpty();
        container.innerHTML = '';
        showError(msg.message);
        setControlsEnabled(false);
        break;
      case 'empty':
        hideError();
        showEmpty();
        setControlsEnabled(false);
        break;
      case 'startEditNode':
        // After addNode, extension tells us which nodeId to start editing
        // We need to wait for the re-render triggered by 'update' first.
        // Store it and pick up in next render.
        pendingEditNodeId = msg.nodeId;
        break;
    }
  });

  let pendingEditNodeId = null;

  // ── Render ───────────────────────────────────────────────────────────────
  let renderId = 0;
  async function renderDiagram() {
    clearSelection();
    if (!rawCode) return;

    mermaid.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: isDark ? 'dark' : 'default',
      flowchart: { curve: 'basis', useMaxWidth: false },
    });

    const myId = ++renderId;
    const diagramId = 'fc-render-' + myId;
    hideError();

    let svgText;
    try {
      const result = await mermaid.render(diagramId, rawCode);
      svgText = result.svg;
    } catch (err) {
      showError(err.message || String(err));
      return;
    }
    if (myId !== renderId) return; // stale render

    container.innerHTML = svgText;

    const svgEl = container.querySelector('svg');
    if (svgEl) {
      svgEl.removeAttribute('width');
      svgEl.removeAttribute('height');
      svgEl.style.overflow = 'visible';
    }

    setupOverlays();

    if (pendingEditNodeId) {
      const nid = pendingEditNodeId;
      pendingEditNodeId = null;
      setTimeout(() => startNodeLabelEdit(nid), 50);
    }
  }

  // ── SVG Overlay setup ─────────────────────────────────────────────────────
  function setupOverlays() {
    nodeRegistry = new Map();
    edgeRegistry = [];
    edgeCounts = new Map();

    const svgEl = container.querySelector('svg');
    if (!svgEl) return;

    // ── Nodes ──
    const nodeEls = svgEl.querySelectorAll('g.node');
    nodeEls.forEach(nodeEl => {
      const nodeId = getNodeId(nodeEl);
      if (!nodeId) return;

      nodeRegistry.set(nodeId, { el: nodeEl });

      // Click to select, double-click to edit
      nodeEl.style.cursor = 'pointer';
      nodeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        selectNode(nodeId);
      });
      nodeEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startNodeLabelEdit(nodeId);
      });

      // Hover: show ports
      nodeEl.addEventListener('mouseenter', () => {
        nodeEl.classList.add('fc-node-hover');
        if (!isDraggingPort) showPorts(nodeId);
      });
      nodeEl.addEventListener('mouseleave', () => {
        nodeEl.classList.remove('fc-node-hover');
        if (!isDraggingPort) hidePorts(nodeId);
      });

      // Right-click context menu
      nodeEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showNodeContextMenu(e, nodeId);
      });

      nodeEl.addEventListener('dragover', (e) => e.preventDefault());
    });

    // ── Edges ──
    const edgeEls = svgEl.querySelectorAll('.edgePath, path.flowchart-link');
    edgeEls.forEach(edgeEl => {
      const info = getEdgeInfo(edgeEl);
      if (!info) return;
      const key = `${info.from}::${info.to}`;
      const idx = edgeCounts.get(key) ?? 0;
      edgeCounts.set(key, idx + 1);
      const entry = { el: edgeEl, from: info.from, to: info.to, idx, labelEl: null };
      edgeRegistry.push(entry);

      edgeEl.style.cursor = 'pointer';
      edgeEl.setAttribute('stroke-width', edgeEl.getAttribute('stroke-width') || '2');
      edgeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        selectEdge(entry);
      });

      edgeEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showEdgeContextMenu(e, entry);
      });
    });

    // ── Edge labels ──
    // Mermaid の edgeLabel id は バージョンによって "L-A-B-0-label" / "L_A_B_0" など
    // 書式が不安定なため id に依存せず、edgePath と edgeLabel の DOM 順序（index）が
    // 対応することを利用して from/to を解決する。
    const labelEls = Array.from(svgEl.querySelectorAll('.edgeLabel'));
    // LS-* クラスを持つ edgePath だけを対象にする（補助パスを除外）
    const labeledPaths = edgeRegistry.map(e => e.el).filter(el =>
      Array.from(el.classList).some(c => c.startsWith('LS-'))
    );

    labelEls.forEach((labelEl, idx) => {
      // DOM 順序で対応する edgeRegistry エントリを引く
      const edgeInfo = edgeRegistry[idx] ?? null;
      if (!edgeInfo) return;
      edgeInfo.labelEl = labelEl;

      labelEl.style.cursor = 'pointer';
      labelEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const currentLabel = getLabelText(labelEl);
        startEdgeLabelEdit(labelEl, currentLabel, edgeInfo);
      });
      labelEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showEdgeContextMenu(e, edgeInfo);
      });
    });
  }

  function getNodeId(el) {
    // Try data-id attribute first (Mermaid 10+)
    const dataId = el.getAttribute('data-id');
    if (dataId) return dataId;
    // Fallback: parse from id="flowchart-NodeId-N"
    const id = el.id || '';
    const m = id.match(/^flowchart-(.+)-\d+$/);
    if (m) return m[1];
    return null;
  }

  function getEdgeInfo(el) {
    // Try CSS classes: LS-{from} LE-{to}
    let from = null, to = null;
    el.classList.forEach(cls => {
      if (cls.startsWith('LS-')) from = cls.slice(3);
      if (cls.startsWith('LE-')) to = cls.slice(3);
    });
    if (from && to) return { from, to };

    // Fallback: parse element id (L-from-to-idx or L_from_to_idx)
    const id = el.id || '';
    const mHyphen = id.match(/^L[-_](.+?)[-_](.+?)[-_]\d+$/);
    if (mHyphen) return { from: mHyphen[1], to: mHyphen[2] };
    return null;
  }

  function findEdgeByFromTo(from, to) {
    return edgeRegistry.find(e => e.from === from && e.to === to) || null;
  }

  function getLabelText(labelEl) {
    const span = labelEl.querySelector('span, foreignObject span, .edgeLabel span');
    return span ? span.textContent.trim() : '';
  }

  // ── Ports ─────────────────────────────────────────────────────────────────
  const portElements = new Map(); // nodeId -> [portEl, ...]

  function showPorts(nodeId) {
    const info = nodeRegistry.get(nodeId);
    if (!info) return;
    const nodeEl = info.el;
    const bbox = nodeEl.getBoundingClientRect();

    hidePorts(nodeId);
    const ports = [];
    const positions = [
      { x: bbox.left + bbox.width / 2, y: bbox.top - 2,               label: 'top' },
      { x: bbox.left + bbox.width / 2, y: bbox.bottom - 8,            label: 'bottom' },
      { x: bbox.left - 2,              y: bbox.top + bbox.height / 2,  label: 'left' },
      { x: bbox.right - 8,             y: bbox.top + bbox.height / 2,  label: 'right' },
    ];

    positions.forEach(pos => {
      const port = document.createElement('div');
      port.className = 'fc-port visible';
      port.style.left = pos.x + 'px';
      port.style.top  = pos.y + 'px';
      port.style.position = 'fixed';
      document.body.appendChild(port);
      ports.push(port);

      port.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // ポート div は 10×10px なので中心から線を引く
        startPortDrag(nodeId, pos.x + 5, pos.y + 5);
      });
    });
    portElements.set(nodeId, ports);
  }

  function hidePorts(nodeId) {
    const ports = portElements.get(nodeId);
    if (ports) ports.forEach(p => p.remove());
    portElements.delete(nodeId);
  }

  function hideAllPorts() {
    portElements.forEach((ports) => ports.forEach(p => p.remove()));
    portElements.clear();
  }

  // ── Port drag ─────────────────────────────────────────────────────────────
  function startPortDrag(fromNodeId, clientX, clientY) {
    isDraggingPort = true;
    dragFromNodeId = fromNodeId;
    dragStartX = clientX;
    dragStartY = clientY;
    dragEdgeSvg.classList.add('active');
    updateDragLine(clientX, clientY);
    hideAllPorts();
  }

  function updateDragLine(toX, toY) {
    dragEdgeLine.setAttribute('x1', dragStartX);
    dragEdgeLine.setAttribute('y1', dragStartY);
    dragEdgeLine.setAttribute('x2', toX);
    dragEdgeLine.setAttribute('y2', toY);
  }

  function endPortDrag() {
    isDraggingPort = false;
    dragFromNodeId = '';
    dragEdgeSvg.classList.remove('active');
  }

  document.addEventListener('mousemove', (e) => {
    if (!isDraggingPort) return;
    updateDragLine(e.clientX, e.clientY);

    // Highlight node under cursor
    const svgEl = container.querySelector('svg');
    if (!svgEl) return;
    svgEl.querySelectorAll('.fc-node-drop-target').forEach(el => el.classList.remove('fc-node-drop-target'));
    const nodeEls = svgEl.querySelectorAll('g.node');
    nodeEls.forEach(nodeEl => {
      const r = nodeEl.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        const nid = getNodeId(nodeEl);
        if (nid && nid !== dragFromNodeId) nodeEl.classList.add('fc-node-drop-target');
      }
    });
  });

  document.addEventListener('mouseup', (e) => {
    if (!isDraggingPort) return;
    // SVG の g.node は mouseup のバブリングが不安定なため、
    // nodeRegistry の bounding rect とマウス座標で衝突判定してエッジを追加する
    for (const [nodeId, info] of nodeRegistry) {
      if (nodeId === dragFromNodeId) continue;
      const r = info.el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        pushUndo();
        send({ type: 'addEdge', from: dragFromNodeId, to: nodeId });
        break;
      }
    }
    endPortDrag();
    const svgEl = container.querySelector('svg');
    if (svgEl) svgEl.querySelectorAll('.fc-node-drop-target').forEach(el => el.classList.remove('fc-node-drop-target'));
  });

  // ── Inline label edit (nodes) ─────────────────────────────────────────────
  let editState = null;

  function startNodeLabelEdit(nodeId) {
    const info = nodeRegistry.get(nodeId);
    if (!info) return;
    const bbox = info.el.getBoundingClientRect();

    const currentLabel = getCurrentNodeLabel(info.el);
    editState = { kind: 'node', nodeId };
    showEditInput(bbox, currentLabel);
  }

  function getCurrentNodeLabel(nodeEl) {
    const span = nodeEl.querySelector('foreignObject span, .label span, .nodeLabel');
    if (span) return span.textContent.trim();
    const text = nodeEl.querySelector('text');
    if (text) return text.textContent.trim();
    return '';
  }

  function startEdgeLabelEdit(labelEl, currentLabel, edgeInfo) {
    const bbox = labelEl.getBoundingClientRect();
    editState = { kind: 'edge', edgeInfo };
    showEditInput(bbox, currentLabel);
  }

  function showEditInput(bbox, value) {
    const w = Math.max(bbox.width + 20, 100);
    editInput.value = value;
    editInput.style.width = w + 'px';
    editOverlay.style.left = (bbox.left + bbox.width / 2 - w / 2) + 'px';
    editOverlay.style.top  = (bbox.top + bbox.height / 2 - 16) + 'px';
    editOverlay.classList.add('visible');
    editInput.focus();
    editInput.select();
  }

  function commitEdit() {
    const value = editInput.value.trim();
    if (!editState) return;
    if (value === '') { cancelEdit(); return; }

    if (editState.kind === 'node') {
      pushUndo();
      send({ type: 'editNode', nodeId: editState.nodeId, label: value });
    } else if (editState.kind === 'edge') {
      const { from, to, idx } = editState.edgeInfo;
      pushUndo();
      send({ type: 'editEdge', from, to, idx, label: value });
    }
    cancelEdit();
  }

  function cancelEdit() {
    editOverlay.classList.remove('visible');
    editInput.value = '';
    editState = null;
  }

  editInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commitEdit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  });
  editInput.addEventListener('blur', () => {
    if (editState) commitEdit();
  });

  // ── Context menus ─────────────────────────────────────────────────────────
  function showNodeContextMenu(e, nodeId) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'fc-menu';

    const addItem = (text, action) => {
      const item = document.createElement('div');
      item.className = 'fc-menu-item';
      item.textContent = text;
      item.addEventListener('mousedown', (ev) => { ev.preventDefault(); action(); closeContextMenu(); });
      menu.appendChild(item);
    };

    addItem('✎ ラベルを編集', () => startNodeLabelEdit(nodeId));

    // 形状変更サブメニュー
    const shapeItem = document.createElement('div');
    shapeItem.className = 'fc-menu-item fc-menu-submenu';
    shapeItem.textContent = '⬡ 形状を変更';
    const shapeArrow = document.createElement('span');
    shapeArrow.className = 'fc-menu-arrow';
    shapeArrow.textContent = '▶';
    shapeItem.appendChild(shapeArrow);

    const shapes = [
      { shape: 'rect',    label: '矩形  [ ]' },
      { shape: 'round',   label: '角丸矩形  ( )' },
      { shape: 'diamond', label: '菱形  { }' },
      { shape: 'stadium', label: 'スタジアム  ([ ])' },
      { shape: 'circle',  label: '円  (( ))' },
    ];
    const subMenu = document.createElement('div');
    subMenu.className = 'fc-menu fc-submenu';
    shapes.forEach(({ shape, label }) => {
      const subItem = document.createElement('div');
      subItem.className = 'fc-menu-item';
      subItem.textContent = label;
      subItem.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        pushUndo();
        send({ type: 'changeNodeShape', nodeId, shape });
        closeContextMenu();
      });
      subMenu.appendChild(subItem);
    });
    shapeItem.appendChild(subMenu);
    menu.appendChild(shapeItem);

    const sep = document.createElement('div'); sep.className = 'fc-menu-sep'; menu.appendChild(sep);
    addItem('✕ ノードを削除', () => { pushUndo(); send({ type: 'deleteNode', nodeId }); });

    placeMenu(menu, e.clientX, e.clientY);
  }

  function showEdgeContextMenu(e, edgeInfo) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'fc-menu';

    const addItem = (text, action) => {
      const item = document.createElement('div');
      item.className = 'fc-menu-item';
      item.textContent = text;
      item.addEventListener('mousedown', (ev) => { ev.preventDefault(); action(); closeContextMenu(); });
      menu.appendChild(item);
    };

    addItem('✎ ラベルを編集', () => {
      const labelEl = edgeInfo.labelEl;
      const currentLabel = labelEl ? getLabelText(labelEl) : '';
      const refEl = labelEl || edgeInfo.el;
      const bbox = refEl.getBoundingClientRect();
      editState = { kind: 'edge', edgeInfo };
      showEditInput(bbox, currentLabel);
    });

    // スタイル変更サブメニュー
    const styleItem = document.createElement('div');
    styleItem.className = 'fc-menu-item fc-menu-submenu';
    styleItem.textContent = '↔ スタイルを変更';
    const styleArrow = document.createElement('span');
    styleArrow.className = 'fc-menu-arrow';
    styleArrow.textContent = '▶';
    styleItem.appendChild(styleArrow);

    const edgeStyles = [
      { style: 'solid-arrow',    label: '実線矢印  (-->)' },
      { style: 'dotted-arrow',   label: '点線矢印  (-.->' },
      { style: 'thick-arrow',    label: '太線矢印  (==>' },
      { style: 'solid-no-arrow', label: '矢印なし実線  (---)' },
      { style: 'dotted-no-arrow', label: '矢印なし点線  (-.-)'  },
    ];
    const styleSubMenu = document.createElement('div');
    styleSubMenu.className = 'fc-menu fc-submenu';
    edgeStyles.forEach(({ style, label }) => {
      const subItem = document.createElement('div');
      subItem.className = 'fc-menu-item';
      subItem.textContent = label;
      subItem.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        pushUndo();
        send({ type: 'changeEdgeStyle', from: edgeInfo.from, to: edgeInfo.to, idx: edgeInfo.idx, style });
        closeContextMenu();
      });
      styleSubMenu.appendChild(subItem);
    });
    styleItem.appendChild(styleSubMenu);
    menu.appendChild(styleItem);

    const sep = document.createElement('div'); sep.className = 'fc-menu-sep'; menu.appendChild(sep);
    addItem('✕ エッジを削除', () => {
      pushUndo();
      send({ type: 'deleteEdge', from: edgeInfo.from, to: edgeInfo.to, idx: edgeInfo.idx });
    });

    placeMenu(menu, e.clientX, e.clientY);
  }

  let currentMenu = null;
  function placeMenu(menu, x, y) {
    document.body.appendChild(menu);
    currentMenu = menu;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = (x + w > vw ? vw - w - 4 : x) + 'px';
    menu.style.top  = (y + h > vh ? vh - h - 4 : y) + 'px';
  }

  function closeContextMenu() {
    if (currentMenu) { currentMenu.remove(); currentMenu = null; }
  }

  document.addEventListener('mousedown', (e) => {
    if (currentMenu && !currentMenu.contains(e.target)) closeContextMenu();
  });

  // ── Pan / Zoom ────────────────────────────────────────────────────────────
  function setTransform() {
    canvas.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
  }

  canvasWrap.addEventListener('click', (e) => {
    if (!e.target.closest('g.node, .edgePath, .edgeLabel')) {
      clearSelection();
    }
  });

  // ダブルクリックで空白部分にノードを追加する
  canvasWrap.addEventListener('dblclick', (e) => {
    if (e.target.closest('g.node, .edgePath, .edgeLabel, .fc-menu, .fc-port, #fc-edit-overlay')) return;
    if (!rawCode) return;
    e.preventDefault();

    const rect = canvasWrap.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left - tx) / scale);
    const y = Math.round((e.clientY - rect.top  - ty) / scale);

    pushUndo();
    send({ type: 'addNode', x, y });
  });

  canvasWrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const target = e.target;
    // Only pan on background (not on nodes or edges)
    if (target.closest('g.node, .edgePath, .edgeLabel, .fc-menu, .fc-port, #fc-edit-overlay')) return;
    isPanning = true;
    panStartX = e.clientX; panStartY = e.clientY;
    panStartTx = tx; panStartTy = ty;
    canvasWrap.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    tx = panStartTx + (e.clientX - panStartX);
    ty = panStartTy + (e.clientY - panStartY);
    setTransform();
  });

  document.addEventListener('mouseup', () => {
    if (isPanning) { isPanning = false; canvasWrap.style.cursor = ''; }
  });

  canvasWrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvasWrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.max(0.1, Math.min(4, scale * factor));
    tx = mx - (mx - tx) * (newScale / scale);
    ty = my - (my - ty) * (newScale / scale);
    scale = newScale;
    setTransform();
  }, { passive: false });

  // ── Selection ─────────────────────────────────────────────────────────────
  function selectNode(nodeId) {
    clearSelection();
    selectedNodeId = nodeId;
    const entry = nodeRegistry.get(nodeId);
    if (entry) entry.el.classList.add('fc-selected');
  }

  function selectEdge(edgeEntry) {
    clearSelection();
    selectedEdge = edgeEntry;
    edgeEntry.el.classList.add('fc-selected');
  }

  function clearSelection() {
    if (selectedNodeId) {
      const entry = nodeRegistry.get(selectedNodeId);
      if (entry) entry.el.classList.remove('fc-selected');
      selectedNodeId = null;
    }
    if (selectedEdge) {
      selectedEdge.el.classList.remove('fc-selected');
      selectedEdge = null;
    }
  }

  // ── Fit view ─────────────────────────────────────────────────────────────
  function fitView() {
    const svgEl = container.querySelector('svg');
    if (!svgEl) return;

    const wrap = canvasWrap.getBoundingClientRect();
    if (wrap.width <= 0 || wrap.height <= 0) return; // panel not yet laid out

    // Use viewBox dimensions as the SVG's natural rendered size
    // (when no explicit width/height, viewBox width/height = CSS pixels in browser)
    let svgW = 0, svgH = 0;
    const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
    if (vb && vb.width > 0) {
      svgW = vb.width;
      svgH = vb.height;
    } else {
      const bb = svgEl.getBBox ? svgEl.getBBox() : null;
      if (bb && bb.width > 0) { svgW = bb.width; svgH = bb.height; }
    }
    if (svgW <= 0 || svgH <= 0) return;

    const containerPad = 48; // 24px each side from #mermaid-container
    const canvasW = svgW + containerPad;
    const canvasH = svgH + containerPad;
    const margin = 32;

    const newScale = Math.min(
      (wrap.width  - margin) / canvasW,
      (wrap.height - margin) / canvasH,
      2
    );
    scale = Math.max(0.1, newScale);
    tx = (wrap.width  - canvasW * scale) / 2;
    ty = (wrap.height - canvasH * scale) / 2;
    setTransform();
  }

  // Retry helper for first-render auto-fit: panel layout may not be ready at t=0
  function scheduleFirstFit(tries) {
    const wrap = canvasWrap.getBoundingClientRect();
    if (wrap.width > 0 && wrap.height > 0) {
      fitView();
    } else if (tries < 6) {
      setTimeout(() => scheduleFirstFit(tries + 1), 150);
    }
    // else: give up — user can click 全体表示
  }

  // ── Undo ──────────────────────────────────────────────────────────────────
  function pushUndo() {
    undoStack.push(rawCode);
    if (undoStack.length > 50) undoStack.shift();
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeContextMenu();
      cancelEdit();
      clearSelection();
      return;
    }
    if (editOverlay.classList.contains('visible')) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (undoStack.length > 0) {
        const prev = undoStack.pop();
        rawCode = prev;
        send({ type: 'undo', code: prev });
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      send({ type: 'save' });
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedNodeId) {
        e.preventDefault();
        pushUndo();
        const nid = selectedNodeId;
        clearSelection();
        send({ type: 'deleteNode', nodeId: nid });
      } else if (selectedEdge) {
        e.preventDefault();
        pushUndo();
        const { from, to, idx } = selectedEdge;
        clearSelection();
        send({ type: 'deleteEdge', from, to, idx });
      }
    }
  });

  // ── Toolbar ───────────────────────────────────────────────────────────────
  btnAddNode.addEventListener('click', () => {
    pushUndo();
    send({ type: 'addNode' });
  });

  btnUndo.addEventListener('click', () => {
    if (undoStack.length > 0) {
      const prev = undoStack.pop();
      rawCode = prev;
      send({ type: 'undo', code: prev });
    }
  });

  btnFit.addEventListener('click', fitView);

  btnExport.addEventListener('click', (e) => {
    e.stopPropagation();
    showExportMenu(e);
  });

  function showExportMenu(e) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'fc-menu';

    const addItem = (text, action) => {
      const item = document.createElement('div');
      item.className = 'fc-menu-item';
      item.textContent = text;
      item.addEventListener('mousedown', (ev) => { ev.preventDefault(); action(); closeContextMenu(); });
      menu.appendChild(item);
    };

    addItem('SVGとして保存', () => exportAs('svg'));
    addItem('PNGとして保存', () => exportAs('png'));

    const rect = e.currentTarget.getBoundingClientRect();
    placeMenu(menu, rect.left, rect.bottom + 4);
  }

  function exportAs(format) {
    const svgEl = container.querySelector('svg');
    if (!svgEl) return;

    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svgEl);

    if (format === 'svg') {
      send({ type: 'export', format: 'svg', data: svgStr });
      return;
    }

    // PNG: render SVG into a canvas via a data URI image
    const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
    const w = (vb && vb.width > 0) ? vb.width  : (svgEl.getBoundingClientRect().width  || 800);
    const h = (vb && vb.height > 0) ? vb.height : (svgEl.getBoundingClientRect().height || 600);

    const svgBase64 = btoa(unescape(encodeURIComponent(svgStr)));
    const dataUrl = 'data:image/svg+xml;base64,' + svgBase64;

    const img = new Image();
    img.onload = () => {
      const px = 2; // 2x resolution for crisp output
      const cvs = document.createElement('canvas');
      cvs.width  = w * px;
      cvs.height = h * px;
      const ctx = cvs.getContext('2d');
      ctx.scale(px, px);
      ctx.fillStyle = isDark ? '#1e1e1e' : '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const pngBase64 = cvs.toDataURL('image/png').split(',')[1];
      send({ type: 'export', format: 'png', data: pngBase64 });
    };
    img.onerror = () => showStatus('PNGエクスポートに失敗しました');
    img.src = dataUrl;
  }

  selDirection.addEventListener('change', () => {
    pushUndo();
    send({ type: 'changeDirection', direction: selDirection.value });
  });

  document.getElementById('btn-init-flowchart').addEventListener('click', () => {
    send({ type: 'initFlowchart' });
  });

  const btnSwitchGantt = document.getElementById('btn-switch-gantt');
  if (btnSwitchGantt) {
    btnSwitchGantt.addEventListener('click', () => {
      send({ type: 'switchType', diagramType: 'gantt' });
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function send(msg) {
    vscode.postMessage(msg);
  }

  function syncDirectionDropdown() {
    const m = rawCode.match(/^(flowchart|graph)\s+(TD|LR|BT|RL|TB)/im);
    if (m) {
      const dir = m[2].toUpperCase() === 'TB' ? 'TD' : m[2].toUpperCase();
      selDirection.value = dir;
    }
  }

  function setControlsEnabled(enabled) {
    btnAddNode.disabled   = !enabled;
    btnUndo.disabled      = !enabled;
    btnFit.disabled       = !enabled;
    btnExport.disabled    = !enabled;
    selDirection.disabled = !enabled;
  }

  function showEmpty() {
    emptyOverlay.classList.add('visible');
    container.innerHTML = '';
  }

  function hideEmpty() {
    emptyOverlay.classList.remove('visible');
  }

  function showError(msg) {
    errorPanel.textContent = 'パースエラー: ' + msg;
    errorPanel.classList.add('visible');
  }

  function hideError() {
    errorPanel.classList.remove('visible');
  }

  let statusTimer;
  function showStatus(text) {
    statusLabel.textContent = text;
    statusLabel.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => statusLabel.classList.remove('show'), 2000);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  setControlsEnabled(false);
  send({ type: 'ready' });
})();
