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
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 12; // 拡大上限（リセット時に小さな図でも十分大きく表示できるよう引き上げ）
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
    // 再レンダリングで SVG が差し替わると編集オーバーレイの位置が陳腐化するため、
    // 進行中の編集（外部からのドキュメント変更時など）は破棄する。
    cancelEdit();
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

    // 再レンダリングで古いノード要素が消えても、body に追加したポート div は
    // 残り続けて画面に取り残される。各セットアップ時に確実に掃除する。
    cancelHidePorts();
    hideAllPorts();

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
        cancelHidePorts();
        if (!isDraggingPort) showPorts(nodeId);
      });
      nodeEl.addEventListener('mouseleave', () => {
        nodeEl.classList.remove('fc-node-hover');
        // ポートはノードの上に重なるため、カーソルがポートへ移動すると
        // ノードの mouseleave が発火する。即時に隠すとポートを掴めないため、
        // 遅延して隠し、ノード／ポートへ再進入した場合はキャンセルする。
        if (!isDraggingPort) scheduleHidePorts(nodeId);
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

      // エッジ線のダブルクリックでもラベル編集を起動する。
      // ラベルの無いエッジは .edgeLabel が潰れて掴めないため、こちらが確実な導線になる。
      edgeEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startEdgeLabelEdit(entry);
      });

      edgeEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showEdgeContextMenu(e, entry);
      });

      // 当たり判定を広げる: エッジ線に沿った透明な太いパスを重ね、
      // 細い実線(2px)の上だけでなく周辺の帯でも選択・編集できるようにする。
      const d = edgeEl.getAttribute('d');
      if (d && edgeEl.parentNode) {
        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hit.setAttribute('d', d);
        hit.setAttribute('fill', 'none');
        hit.setAttribute('stroke', 'transparent');
        hit.setAttribute('stroke-width', '14');
        hit.setAttribute('stroke-linecap', 'round');
        hit.classList.add('fc-edge-hit');
        hit.style.cursor = 'pointer';
        hit.style.pointerEvents = 'stroke';
        edgeEl.parentNode.insertBefore(hit, edgeEl.nextSibling);
        hit.addEventListener('click', (e) => { e.stopPropagation(); selectEdge(entry); });
        hit.addEventListener('dblclick', (e) => { e.stopPropagation(); startEdgeLabelEdit(entry); });
        hit.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showEdgeContextMenu(e, entry);
        });
        entry.hitEl = hit;
      }
    });

    // ── Edge labels ──
    // Mermaid 11 のラベル構造:
    //   <g class="edgeLabel"><g class="label" data-id="L_{from}_{to}_{n}">…<span class="edgeLabel">
    // 内側の <span> にも class="edgeLabel" が付くため '.edgeLabel' で集めると要素数が
    // 2倍になり DOM 順インデックスでは対応が崩れる（別エッジのラベルを編集する不具合の原因）。
    // そこで data-id（エッジID）から from/to/連番を解いて確実に対応付ける。
    const labelOuters = Array.from(svgEl.querySelectorAll('g.edgeLabel'));
    labelOuters.forEach(outer => {
      const lg = outer.querySelector('[data-id]');
      const did = lg ? (lg.getAttribute('data-id') || '') : '';
      const m = did.match(/L[-_](.+?)[-_](.+?)[-_](\d+)$/);
      if (!m) return;
      const from = m[1], to = m[2], lidx = parseInt(m[3], 10);
      const entry =
        edgeRegistry.find(e => e.from === from && e.to === to && e.idx === lidx) ||
        edgeRegistry.find(e => e.from === from && e.to === to && !e.labelEl);
      if (!entry) return;
      entry.labelEl = outer;

      outer.style.cursor = 'pointer';
      outer.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startEdgeLabelEdit(entry);
      });
      outer.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showEdgeContextMenu(e, entry);
      });
    });
  }

  function getNodeId(el) {
    // Try data-id attribute first (Mermaid 10+)
    const dataId = el.getAttribute('data-id');
    if (dataId) return dataId;
    // Fallback: parse from id like "flowchart-NodeId-N" or "fc-render-1-flowchart-NodeId-N"
    const id = el.id || '';
    const m = id.match(/(?:^|-)flowchart-(.+?)-\d+$/);
    if (m) return m[1];
    return null;
  }

  function getEdgeInfo(el) {
    // Mermaid 11 は edgePath の LS-/LE- クラスを実ノードIDではなく
    // 固定値 "a1"/"b1" で出力するため、from/to の特定には使えない。
    // 一方で path の id は `[prefix-]L_{from}_{to}_{counter}` 形式で
    // 実ノードIDを保持しているため、id から from/to を解決する。
    const id = el.id || '';
    const mId = id.match(/L[-_](.+?)[-_](.+?)[-_]\d+$/);
    if (mId) return { from: mId[1], to: mId[2] };

    // Fallback: 旧バージョンの CSS クラス LS-{from} LE-{to}
    // （"a1"/"b1" は Mermaid 11 のダミー値なので除外する）
    let from = null, to = null;
    el.classList.forEach(cls => {
      if (cls.startsWith('LS-')) from = cls.slice(3);
      if (cls.startsWith('LE-')) to = cls.slice(3);
    });
    if (from && to && !(from === 'a1' && to === 'b1')) return { from, to };
    return null;
  }

  function getLabelText(labelEl) {
    const span = labelEl.querySelector('span, foreignObject span, .edgeLabel span');
    return span ? span.textContent.trim() : '';
  }

  // ── Ports ─────────────────────────────────────────────────────────────────
  const portElements = new Map(); // nodeId -> [portEl, ...]
  let portHideTimer = null;

  function scheduleHidePorts(nodeId) {
    clearTimeout(portHideTimer);
    portHideTimer = setTimeout(() => {
      if (!isDraggingPort) hidePorts(nodeId);
    }, 150);
  }

  function cancelHidePorts() {
    clearTimeout(portHideTimer);
    portHideTimer = null;
  }

  function showPorts(nodeId) {
    const info = nodeRegistry.get(nodeId);
    if (!info) return;
    const nodeEl = info.el;
    const bbox = nodeEl.getBoundingClientRect();

    hidePorts(nodeId);
    const ports = [];
    // 図形の各辺の中点をそのままポート中心に使う
    // （CSS の translate(-50%,-50%) でドットが中心に揃う）
    const cx = bbox.left + bbox.width / 2;
    const cy = bbox.top + bbox.height / 2;
    const positions = [
      { x: cx,          y: bbox.top,    label: 'top' },
      { x: cx,          y: bbox.bottom, label: 'bottom' },
      { x: bbox.left,   y: cy,          label: 'left' },
      { x: bbox.right,  y: cy,          label: 'right' },
    ];

    positions.forEach(pos => {
      const port = document.createElement('div');
      port.className = 'fc-port visible';
      port.style.left = pos.x + 'px';
      port.style.top  = pos.y + 'px';
      port.style.position = 'fixed';
      document.body.appendChild(port);
      ports.push(port);

      // ポートにカーソルが乗っている間はノードの mouseleave による
      // 自動非表示をキャンセルし、確実に掴めるようにする
      port.addEventListener('mouseenter', cancelHidePorts);
      port.addEventListener('mouseleave', () => scheduleHidePorts(nodeId));

      port.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cancelHidePorts();
        // pos はポート（＝図形端点）の中心座標
        startPortDrag(nodeId, pos.x, pos.y);
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

  function startEdgeLabelEdit(edgeInfo) {
    const labelEl = edgeInfo.labelEl;
    const currentLabel = labelEl ? getLabelText(labelEl) : '';

    // ラベル位置を基準にするが、ラベルが無い／潰れている場合は
    // エッジ線の中央を基準にしてエディタが画面外へ出ないようにする。
    let box = labelEl ? labelEl.getBoundingClientRect() : null;
    if (!box || box.width < 4 || box.height < 4) {
      const pb = edgeInfo.el.getBoundingClientRect();
      box = {
        left: pb.left + pb.width / 2 - 8,
        top:  pb.top  + pb.height / 2 - 8,
        width: 16,
        height: 16,
      };
    }

    editState = { kind: 'edge', edgeInfo };
    showEditInput(box, currentLabel);
  }

  function showEditInput(bbox, value) {
    // ズーム倍率に合わせて入力欄の文字サイズを少しだけ拡大する。
    // 固定だと拡大表示中に小さく見えるが、倍率比例だと大きすぎるため
    // 平方根で緩やかに増やし、上限を抑える。
    const fontSize = Math.max(14, Math.min(14 * Math.sqrt(scale), 26));
    const w = Math.max(bbox.width + fontSize, fontSize * 5);
    editInput.value = value;
    editInput.style.fontSize = fontSize + 'px';
    editInput.style.width = w + 'px';
    // bbox 中心へ配置（CSS の translate(-50%,-50%) で中央寄せ）
    editOverlay.style.left = (bbox.left + bbox.width / 2) + 'px';
    editOverlay.style.top  = (bbox.top + bbox.height / 2) + 'px';
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

  // 編集中なら確定する。パン・ズーム・別所クリックなどで
  // 入力欄と図形の表示位置がずれるのを防ぐため、それらの操作の直前に呼ぶ。
  function commitEditIfActive() {
    if (editState) commitEdit();
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

    addItem('✎ ラベルを編集', () => startEdgeLabelEdit(edgeInfo));

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
    if (!e.target.closest('g.node, .edgePath, .flowchart-link, .fc-edge-hit, .edgeLabel')) {
      clearSelection();
    }
  });

  // ダブルクリックで空白部分にノードを追加する
  canvasWrap.addEventListener('dblclick', (e) => {
    if (e.target.closest('g.node, .edgePath, .flowchart-link, .fc-edge-hit, .edgeLabel, .fc-menu, .fc-port, #fc-edit-overlay')) return;
    if (!rawCode) return;
    e.preventDefault();

    const rect = canvasWrap.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left - tx) / scale);
    const y = Math.round((e.clientY - rect.top  - ty) / scale);

    pushUndo();
    send({ type: 'addNode', x, y });
  });

  canvasWrap.addEventListener('mousedown', (e) => {
    // 入力欄外のどこかをクリックしたら編集を確定する
    // （パン用の preventDefault が blur を抑止するため明示的に確定が必要）
    if (!e.target.closest('#fc-edit-overlay')) commitEditIfActive();
    if (e.button !== 0) return;
    const target = e.target;
    // Only pan on background (not on nodes or edges)
    if (target.closest('g.node, .edgePath, .flowchart-link, .fc-edge-hit, .edgeLabel, .fc-menu, .fc-port, #fc-edit-overlay')) return;
    isPanning = true;
    panStartX = e.clientX; panStartY = e.clientY;
    panStartTx = tx; panStartTy = ty;
    canvasWrap.style.cursor = 'grabbing';
    // ポートは固定座標で body に配置されるため、パン中は取り残されないよう消す
    cancelHidePorts();
    hideAllPorts();
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
    // ズームすると入力欄の表示位置がずれるため、編集中なら確定する
    commitEditIfActive();
    // ズームするとポートの固定座標がノードからずれるため消す
    cancelHidePorts();
    hideAllPorts();
    const rect = canvasWrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
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
    // リセット（拡大率・位置の変更）で入力欄がずれるため、編集中なら確定する
    commitEditIfActive();

    const svgEl = container.querySelector('svg');
    if (!svgEl) return;

    const wrap = canvasWrap.getBoundingClientRect();
    if (wrap.width <= 0 || wrap.height <= 0) return; // panel not yet laid out

    // viewBox の寸法に依存せず、実際に描画された SVG の画面上ジオメトリから
    // 「変換前の実寸」と「キャンバスローカル座標での位置」を逆算する。
    // これにより全ノード・全エッジ（ラベル含む）を正確に中央へ収められる。
    const r = svgEl.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;

    const realW = r.width  / scale; // 現在の scale を打ち消した実寸
    const realH = r.height / scale;
    // SVG 左上のキャンバスローカル座標（#canvas の transform を逆算）
    const svgLeftLocal = (r.left - (wrap.left + tx)) / scale;
    const svgTopLocal  = (r.top  - (wrap.top  + ty)) / scale;

    const margin = 12; // ビュー端の余白（片側）。小さくして拡大率を上げる

    // 全ノード・エッジが収まる範囲で可能な限り拡大する（最大拡大）
    const fitScale = Math.min(
      (wrap.width  - margin * 2) / realW,
      (wrap.height - margin * 2) / realH
    );
    const newScale = Math.max(MIN_SCALE, Math.min(fitScale, MAX_SCALE));

    // SVG 本体の中心をビュー中央へ合わせてセンタリングする
    tx = wrap.width  / 2 - newScale * (svgLeftLocal + realW / 2);
    ty = wrap.height / 2 - newScale * (svgTopLocal  + realH / 2);
    scale = newScale;
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
    // else: give up — user can click リセット
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

  // エクスポート用に、編集UI由来の要素・装飾を取り除いた SVG 文字列を返す
  function serializeCleanSvg(svgEl) {
    const clone = svgEl.cloneNode(true);
    // 当たり判定用の透明パスを除去
    clone.querySelectorAll('.fc-edge-hit').forEach(el => el.remove());
    // 選択・ホバーなどの一時的な装飾クラスを除去
    clone.querySelectorAll('.fc-selected, .fc-node-hover, .fc-node-drop-target')
      .forEach(el => el.classList.remove('fc-selected', 'fc-node-hover', 'fc-node-drop-target'));
    // インラインで付与した cursor / pointer-events を除去
    clone.querySelectorAll('[style]').forEach(el => {
      el.style.removeProperty('cursor');
      el.style.removeProperty('pointer-events');
    });
    return new XMLSerializer().serializeToString(clone);
  }

  function exportAs(format) {
    const svgEl = container.querySelector('svg');
    if (!svgEl) return;

    const svgStr = serializeCleanSvg(svgEl);

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
