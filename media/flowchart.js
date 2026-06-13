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
        break;
      case 'saved':
        showStatus('保存済み');
        break;
      case 'empty':
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

      // Double-click to edit label
      nodeEl.style.cursor = 'pointer';
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

      // Drop target for edge drag
      nodeEl.addEventListener('mouseup', (e) => {
        if (!isDraggingPort) return;
        e.stopPropagation();
        const toNodeId = nodeId;
        if (toNodeId && toNodeId !== dragFromNodeId) {
          pushUndo();
          send({ type: 'addEdge', from: dragFromNodeId, to: toNodeId });
        }
        endPortDrag();
        nodeEl.classList.remove('fc-node-drop-target');
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

      edgeEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showEdgeContextMenu(e, entry);
      });
    });

    // ── Edge labels ──
    const labelEls = svgEl.querySelectorAll('.edgeLabel');
    labelEls.forEach(labelEl => {
      const edgeId = labelEl.id ? labelEl.id.replace(/-label$/, '') : null;
      if (!edgeId) return;
      const edgeInfo = findEdgeByDomId(edgeId);
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

  function findEdgeByDomId(domId) {
    // domId e.g. "L-A-B-0" or "L_A_B_0"
    const edgeEl = container.querySelector(`#${CSS.escape(domId)}`);
    if (!edgeEl) return null;
    const info = getEdgeInfo(edgeEl);
    if (!info) return null;
    const key = `${info.from}::${info.to}`;
    // Find matching entry in edgeRegistry
    return edgeRegistry.find(e => e.from === info.from && e.to === info.to) || null;
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
        startPortDrag(nodeId, e.clientX, e.clientY);
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeContextMenu();
  });

  // ── Pan / Zoom ────────────────────────────────────────────────────────────
  function setTransform() {
    canvas.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
  }

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
    if (e.ctrlKey) {
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
    }
  }, { passive: false });

  // ── Fit view ─────────────────────────────────────────────────────────────
  function fitView() {
    const svgEl = container.querySelector('svg');
    if (!svgEl) return;
    const svgBBox = svgEl.getBBox ? svgEl.getBBox() : null;
    const wrap = canvasWrap.getBoundingClientRect();
    const pad = 32;

    let w, h;
    if (svgBBox && svgBBox.width > 0) {
      w = svgBBox.width + pad * 2;
      h = svgBBox.height + pad * 2;
    } else {
      const svgRect = svgEl.getBoundingClientRect();
      w = svgRect.width + pad * 2;
      h = svgRect.height + pad * 2;
    }

    const newScale = Math.min(
      (wrap.width - pad * 2) / w,
      (wrap.height - pad * 2) / h,
      2
    );
    scale = Math.max(0.1, newScale);
    const scaledW = w * scale;
    const scaledH = h * scale;
    tx = (wrap.width - scaledW) / 2 + pad * scale;
    ty = (wrap.height - scaledH) / 2 + pad * scale;
    setTransform();
  }

  // ── Undo ──────────────────────────────────────────────────────────────────
  function pushUndo() {
    undoStack.push(rawCode);
    if (undoStack.length > 50) undoStack.shift();
  }

  document.addEventListener('keydown', (e) => {
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

  selDirection.addEventListener('change', () => {
    pushUndo();
    send({ type: 'setDirection', direction: selDirection.value });
  });

  document.getElementById('btn-init-flowchart').addEventListener('click', () => {
    send({ type: 'initFlowchart' });
  });

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
