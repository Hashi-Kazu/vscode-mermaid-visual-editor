(function () {
  'use strict';

  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();

  /* ── Constants ── */
  const LABEL_W      = 200;
  const LABEL_W_MIN  = 100;
  const LABEL_W_MAX  = 400;
  const ROW_H        = 36;
  const SECTION_H    = 28;
  const HEADER_H     = 56;
  const BAR_H        = 24;
  const BAR_TOP      = (ROW_H - BAR_H) / 2;
  const DIAMOND_SIZE = BAR_H;
  const MIN_PPD      = 7;
  const MAX_PPD      = 60;
  const DEF_PPD      = 24;
  const HARD_MIN_PPD = 0.5;  // 全期間一望のための絶対下限（可読性の最低限）
  const RESIZE_W     = 8;
  const DRAG_THRESH  = 4;   // px before drag starts
  const PAD_DAYS     = 7;
  const UNDO_LIMIT   = 50;

  /* ビュー全体の拡大縮小（タスクバー範囲のpx/日ズームとは独立）。
     sticky 要素と CSS `zoom` の座標系不整合を避けるため、表示寸法を通常の
     レイアウト座標へ換算する。マウス座標（clientX/Y）も同じ実画面px基準となる。 */
  const VIEW_ZOOM_MIN  = 0.5;
  const VIEW_ZOOM_MAX  = 2;
  const VIEW_ZOOM_STEP = 0.1;
  const DEF_VIEW_ZOOM  = 1;
  /* ビュー既定倍率。パーセント表示100%（viewZoom=1）のとき、実描画をこの倍率で拡大する。
     初期表示を従来比1.2倍にしつつ、UI上は100%として扱うための基準倍率。 */
  const VIEW_SCALE_BASE = 1.2;

  /* ── State ── */
  let ganttData    = null;
  let undoStack    = [];
  let dragState    = null;
  let editingEl    = null;
  let pxPerDay     = DEF_PPD;
  let rangeStart   = null;
  let panState     = null;
  let reorderState = null;
  let rowIndex     = [];
  let autoFitPpd   = true;
  let viewZoom     = DEF_VIEW_ZOOM;
  let labelW       = LABEL_W;
  let labelResizeState = null;
  let deleteTarget = null;  // { si, ti } — ti=-1 means section
  let selected     = null;  // { si, ti } — クリックで確定した選択。ti=-1 はセクション選択
  const collapsedSections = new Set();

  /* ── Date helpers ── */
  const parseDate = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y,m-1,d); };
  const fmtDate   = d => `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;
  const p2        = n => String(n).padStart(2,'0');

  function addDays(dateStr, n) {
    const d = parseDate(dateStr);
    d.setDate(d.getDate() + Math.round(n));
    return fmtDate(d);
  }
  function diffDays(a, b) {
    return Math.round((parseDate(b) - parseDate(a)) / 86400000);
  }

  /* R-G18-03: `excludes` ディレクティブ（weekends / 曜日名 / YYYY-MM-DD）に
     一致する日付かどうかを判定する。表示専用の判定であり、期間計算には使わない。 */
  const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  function isExcludedDate(dateStr) {
    if (!ganttData || !ganttData.excludes || ganttData.excludes.length === 0) return false;
    const day = parseDate(dateStr).getDay();
    return ganttData.excludes.some(tok => {
      const lower = tok.toLowerCase();
      if (lower === 'weekends') return day === 0 || day === 6;
      const wIdx = WEEKDAY_NAMES.indexOf(lower);
      if (wIdx !== -1) return day === wIdx;
      return tok === dateStr;
    });
  }

  /* R-G18-07: 除外日を除いた実働日数（工数）を算出する。表示専用の派生値であり、
     duration/afterId などの既存データ・計算には一切影響しない。純粋関数。 */
  function countWorkingDays(startDate, duration) {
    let workDays = 0;
    for (let i = 0; i < duration; i++) {
      const d = addDays(startDate, i);
      if (!isExcludedDate(d)) workDays++;
    }
    return workDays;
  }

  /* ── Dependency helpers ── */
  function resolveAfterIds() {
    if (!ganttData) return;
    const endById = new Map();
    ganttData.sections.forEach(s => s.tasks.forEach(t => {
      if (t.id) endById.set(t.id, addDays(t.startDate, t.duration || 0));
    }));
    ganttData.sections.forEach(s => s.tasks.forEach(t => {
      if (t.afterId) {
        const end = endById.get(t.afterId);
        if (end) t.startDate = end;
      }
    }));
  }

  function findTaskById(id) {
    for (const sec of ganttData.sections) {
      for (const task of sec.tasks) {
        if (task.id === id) return task;
      }
    }
    return null;
  }

  function generateTaskId() {
    const existing = new Set();
    ganttData.sections.forEach(s => s.tasks.forEach(t => { if (t.id) existing.add(t.id); }));
    let n = 1;
    while (existing.has('t' + n)) n++;
    return 't' + n;
  }

  function hasAnyAfterIds() {
    return ganttData.sections.some(s => s.tasks.some(t => t.afterId));
  }

  /* ── Layout helpers ── */
  function calcRange(data) {
    let min = null, max = null;
    data.sections.forEach(s => s.tasks.forEach(t => {
      const st = parseDate(t.startDate);
      const en = new Date(st); en.setDate(en.getDate() + (t.duration || 0));
      if (!min || st < min) min = new Date(st);
      if (!max || en > max) max = new Date(en);
      if (!max || st > max) max = new Date(st);
    }));
    if (!min) { min = new Date(); max = new Date(); max.setDate(max.getDate() + 30); }
    min.setDate(min.getDate() - PAD_DAYS);
    max.setDate(max.getDate() + PAD_DAYS);
    return { min, max };
  }

  function dateToX(dateStr) {
    return diffDays(fmtDate(rangeStart), dateStr) * displayPpd();
  }

  function viewScale() {
    return viewZoom * VIEW_SCALE_BASE;
  }

  function displaySize(value) {
    return value * viewScale();
  }

  function displayPpd() {
    return displaySize(pxPerDay);
  }

  /* バー内に収まるかどうかの判定用にテキスト幅を計測する。DOM計測(offsetWidth等)は
     layout thrash を招くため、canvas 2d context での測定に統一する。 */
  let measureCanvas = null;
  function measureTextWidth(text, fontPx) {
    if (!measureCanvas) measureCanvas = document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d');
    ctx.font = `${fontPx}px var(--vscode-font-family, sans-serif)`;
    return ctx.measureText(text).width;
  }

  /* バー/ダイヤモンドの右側外側に表示するラベル要素を生成して追加する。
     pointer-events:none とし、既存のドラッグ/パン/編集イベントに影響しない。
     チャート右端(tlW)を超える場合のみ text-overflow:ellipsis でクランプする。 */
  function appendExternalLabel(tlCell, text, left, top, tlW) {
    const label = el('span', 'gantt-ext-label');
    label.textContent = text;
    label.style.left = snapToDpr(left) + 'px';
    label.style.top  = snapToDpr(top) + 'px';
    const fontPx = displaySize(11);
    const textW = measureTextWidth(text, fontPx);
    const remaining = tlW - left;
    if (textW > remaining) {
      label.classList.add('gantt-ext-label-clamped');
      label.style.maxWidth = Math.max(0, remaining) + 'px';
    }
    tlCell.appendChild(label);
    return label;
  }

  /* R-G10-08: 非整数 devicePixelRatio（例: Windows 125%拡大）環境で、
     ラベル列(sticky)とタスクバーのインラインpx座標のスナップ位置が
     一致しないことによる境界のズレを防ぐため、CSS px値を一旦物理pxへ
     変換して丸めてからCSS pxへ戻す。dpr===1（100%拡大）では実質無効。 */
  function snapToDpr(value) {
    const dpr = window.devicePixelRatio || 1;
    return Math.round(value * dpr) / dpr;
  }

  /* 全タスクの全期間がビューに収まる px/日（縮小下限の算出に使用）。
     R-G10-07: ズームアウト下限を、全期間が一望できる倍率まで緩和する。 */
  function fitFloorPpd() {
    if (!ganttData) return MIN_PPD;
    const container = document.getElementById('scroll-container');
    const { min, max } = calcRange(ganttData);
    const totalDays = Math.max(1, diffDays(fmtDate(min), fmtDate(max)));
    // pxPerDay は論理値なので、表示領域を viewScale() で論理座標へ戻して算出する。
    const avail = (container ? container.clientWidth / viewScale() : 0) - labelW;
    if (avail <= 0) return MIN_PPD;
    // 全期間が収まる px/日。MIN_PPD より小さくなる場合のみ下限を緩める。
    return Math.max(HARD_MIN_PPD, Math.min(MIN_PPD, avail / totalDays));
  }

  /* ── Selection helper ── */
  function setSelected(si, ti) {
    // 選択が変化しない場合は再描画しない。ダブルクリックの1回目のクリックで
    // 再描画すると、ラベルDOM要素が入れ替わり2回目のクリックが古い（切り離された）
    // 要素をターゲットにしてしまい、dblclick によるインライン編集が発火しなくなるため。
    if (selected && selected.si === si && selected.ti === ti) return;
    selected = { si, ti };
    render();
  }
  // 選択の妥当性を保つ（行数変化後など）。範囲外なら null に。
  function clampSelection() {
    if (!selected) return;
    const sec = ganttData && ganttData.sections[selected.si];
    if (!sec) { selected = null; return; }
    if (selected.ti >= 0 && selected.ti >= sec.tasks.length) {
      // タスクが消えた場合はセクション選択へ降格
      selected = { si: selected.si, ti: -1 };
    }
  }

  /* ── DOM helper ── */
  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  /* ── Render ── */
  function render() {
    if (!ganttData) return;
    finishEdit(false);
    rowIndex = [];

    const container = document.getElementById('scroll-container');
    const scrollLeft = container.scrollLeft;
    const scrollTop  = container.scrollTop;

    const grid = document.getElementById('gantt-grid');
    grid.innerHTML = '';
    grid.style.setProperty('--label-w', snapToDpr(displaySize(labelW)) + 'px');
    grid.style.setProperty('--header-h', displaySize(HEADER_H) + 'px');
    grid.style.setProperty('--month-h', displaySize(26) + 'px');
    grid.style.setProperty('--day-h', displaySize(30) + 'px');
    grid.style.setProperty('--section-h', displaySize(SECTION_H) + 'px');
    grid.style.setProperty('--row-h', displaySize(ROW_H) + 'px');
    grid.style.setProperty('--bar-h', displaySize(BAR_H) + 'px');
    grid.style.setProperty('--bar-top', displaySize(BAR_TOP) + 'px');
    grid.style.setProperty('--diamond-size', displaySize(DIAMOND_SIZE) + 'px');
    grid.style.setProperty('--resize-w', displaySize(RESIZE_W) + 'px');
    grid.style.setProperty('--label-padding', displaySize(10) + 'px');
    grid.style.setProperty('--font-10', displaySize(10) + 'px');
    grid.style.setProperty('--font-11', displaySize(11) + 'px');
    grid.style.setProperty('--font-12', displaySize(12) + 'px');
    grid.style.setProperty('--font-14', displaySize(14) + 'px');
    grid.style.setProperty('--crit-size', displaySize(18) + 'px');
    grid.style.setProperty('--status-indicator-w', displaySize(10) + 'px');
    grid.style.setProperty('--bar-padding-end', displaySize(8) + 'px');
    grid.style.setProperty('--bar-padding-start', displaySize(16) + 'px');

    const { min, max } = calcRange(ganttData);
    rangeStart = min;
    const totalDays = diffDays(fmtDate(min), fmtDate(max));
    if (autoFitPpd) {
      const avail = container.clientWidth / viewScale() - labelW;
      pxPerDay = Math.max(MIN_PPD, avail > 0 ? Math.min(DEF_PPD, avail / totalDays) : DEF_PPD);
      autoFitPpd = false;
    }
    const tlW = Math.ceil(totalDays * displayPpd());
    grid.style.setProperty('--cell-w', displayPpd() + 'px');

    clampSelection();
    renderHeader(grid, min, max, tlW);
    ganttData.sections.forEach((sec, si) => {
      // 名前付き、または空セクションには行を描画する。
      // 空セクションの行はクリック選択・D&Dドロップ先として機能する。
      if (sec.name || sec.tasks.length === 0) renderSection(grid, sec, si, tlW);
      if (!collapsedSections.has(si)) {
        sec.tasks.forEach((task, ti) => renderTask(grid, task, si, ti, tlW));
      }
    });

    container.scrollLeft = scrollLeft;
    container.scrollTop  = scrollTop;
    renderExcludedBands();
    drawDependencyArrows();
  }

  /* ── Header ── */
  function renderHeader(grid, min, max, tlW) {
    const corner = el('div', 'gantt-cell gantt-label gantt-corner');
    corner.textContent = ganttData.title || 'Gantt';
    corner.title = 'ダブルクリックでタイトルを編集';
    corner.addEventListener('dblclick', () => startTitleEdit(corner));
    const labelResizeHandle = el('div', 'label-resize-handle');
    labelResizeHandle.addEventListener('mousedown', onLabelResizeStart);
    labelResizeHandle.addEventListener('dblclick', e => e.stopPropagation());
    corner.appendChild(labelResizeHandle);
    grid.appendChild(corner);

    const tlHeader = el('div', 'gantt-cell gantt-header-timeline');
    tlHeader.style.width = tlW + 'px';
    const monthRow = el('div', 'month-row');
    const dayRow   = el('div', 'day-row');

    let cur = new Date(min);
    const end = new Date(max);
    let curMonthEl = null, curMonthDays = 0;
    const todayStr = fmtDate(new Date());

    while (cur < end) {
      if (!curMonthEl || cur.getDate() === 1) {
        if (curMonthEl) curMonthEl.style.width = (curMonthDays * displayPpd()) + 'px';
        curMonthEl = el('div', 'month-cell');
        curMonthEl.textContent = `${cur.getFullYear()}/${p2(cur.getMonth()+1)}`;
        monthRow.appendChild(curMonthEl);
        curMonthDays = 0;
      }
      curMonthDays++;
      const dayCell = el('div', 'day-cell');
      dayCell.style.width = displayPpd() + 'px';
      const dom = cur.getDate();
      if (dom === 1 || cur.getDay() === 1) dayCell.textContent = String(dom);
      if (fmtDate(cur) === todayStr) dayCell.classList.add('today');
      if (isExcludedDate(fmtDate(cur))) dayCell.classList.add('excluded');
      dayRow.appendChild(dayCell);
      cur.setDate(cur.getDate() + 1);
    }
    if (curMonthEl) curMonthEl.style.width = (curMonthDays * displayPpd()) + 'px';

    tlHeader.appendChild(monthRow);
    tlHeader.appendChild(dayRow);
    grid.appendChild(tlHeader);
  }

  /* ── Section row ── */
  function renderSection(grid, sec, si, tlW) {
    const labelCell = el('div', 'gantt-cell gantt-label section-label');
    labelCell.style.height = displaySize(SECTION_H) + 'px';
    if (selected && selected.si === si && selected.ti === -1) {
      labelCell.classList.add('row-selected');
    }
    // ラベル余白クリックでセクションを選択（子要素のクリックは各自で処理）
    labelCell.addEventListener('click', e => {
      if (e.target.closest('.reorder-handle') ||
          e.target.closest('.collapse-toggle')) return;
      setSelected(si, -1);
    });

    const rHandle = el('span', 'reorder-handle');
    rHandle.textContent = '⠿';
    rHandle.title = 'ドラッグしてセクションを並び替え';
    rHandle.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      startSectionReorder(e, si);
    });
    labelCell.appendChild(rHandle);

    const collapseBtn = el('span', 'collapse-toggle');
    collapseBtn.textContent = collapsedSections.has(si) ? '▶' : '▼';
    collapseBtn.title = collapsedSections.has(si) ? '展開' : '折りたたみ';
    collapseBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (collapsedSections.has(si)) collapsedSections.delete(si);
      else collapsedSections.add(si);
      render();
    });
    labelCell.appendChild(collapseBtn);

    const nameSpan = el('span', 'section-name');
    if (sec.name) {
      nameSpan.textContent = sec.name;
    } else {
      nameSpan.textContent = '(無名セクション)';
      nameSpan.classList.add('section-name-empty');
    }
    nameSpan.title = 'ダブルクリックで編集';
    nameSpan.addEventListener('dblclick', () => startSectionEdit(si, nameSpan));
    labelCell.appendChild(nameSpan);

    labelCell.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e, si, -1); });
    labelCell.addEventListener('mouseenter', () => { deleteTarget = { si, ti: -1 }; });
    grid.appendChild(labelCell);
    rowIndex.push({ type: 'section', si, ti: -1, el: labelCell });

    const tlCell = el('div', 'gantt-cell section-timeline');
    tlCell.style.width = tlW + 'px';
    tlCell.style.height = displaySize(SECTION_H) + 'px';
    if (selected && selected.si === si && selected.ti === -1) {
      tlCell.classList.add('row-selected');
    }
    tlCell.addEventListener('mousedown', onPanStart);
    tlCell.addEventListener('click', () => setSelected(si, -1));
    tlCell.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e, si, -1); });
    grid.appendChild(tlCell);
  }

  /* ── Task row ── */
  function renderTask(grid, task, si, ti, tlW) {
    const labelCell = el('div', 'gantt-cell gantt-label task-label');
    if (selected && selected.si === si && selected.ti === ti) {
      labelCell.classList.add('row-selected');
    }
    labelCell.addEventListener('click', e => {
      if (e.target.closest('.reorder-handle')) return;
      setSelected(si, ti);
    });

    const rHandle = el('span', 'reorder-handle');
    rHandle.textContent = '⠿';
    rHandle.title = 'ドラッグして並び替え';
    rHandle.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      startReorder(e, si, ti);
    });
    labelCell.appendChild(rHandle);

    const labelText = el('span', 'task-label-text');
    labelText.textContent = task.label;
    labelText.title = task.label;
    labelText.addEventListener('dblclick', e => {
      e.preventDefault();
      e.stopPropagation();
      startLabelInlineEdit(si, ti, labelCell);
    });
    labelCell.appendChild(labelText);

    // R-G18-07: マイルストーンには期間の概念がないため対象外
    if (task.status !== 'milestone') {
      const workDays = countWorkingDays(task.startDate, task.duration);
      const effortSpan = el('span', 'task-effort');
      effortSpan.textContent = '(' + workDays + '日)';
      effortSpan.title = '期間' + task.duration + '日中、除外日を除く実働' + workDays + '日';
      labelCell.appendChild(effortSpan);
    }

    // Crit toggle: shows whether the task is on the critical path
    const critBtn = el('span', 'crit-toggle' + (task.crit ? ' crit-on' : ''));
    critBtn.textContent = '!';
    critBtn.title = task.crit ? 'クリティカル解除' : 'クリティカルに設定';
    critBtn.addEventListener('mousedown', e => e.stopPropagation());
    critBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      toggleCrit(si, ti);
    });
    labelCell.appendChild(critBtn);

    labelCell.addEventListener('mouseenter', () => { deleteTarget = { si, ti }; });
    grid.appendChild(labelCell);
    rowIndex.push({ type: 'task', si, ti, el: labelCell });

    const tlCell = el('div', 'gantt-cell task-timeline');
    tlCell.style.width = tlW + 'px';
    tlCell.dataset.si  = si;
    tlCell.dataset.ti  = ti;
    if (selected && selected.si === si && selected.ti === ti) {
      tlCell.classList.add('row-selected');
    }
    tlCell.addEventListener('click', () => setSelected(si, ti));

    const todayX = dateToX(fmtDate(new Date()));
    if (todayX >= 0 && todayX <= tlW) {
      const marker = el('div', 'today-line');
      marker.style.left = snapToDpr(todayX) + 'px';
      tlCell.appendChild(marker);
    }

    tlCell.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e, si, ti); });
    tlCell.addEventListener('mousedown', onPanStart);
    tlCell.addEventListener('mouseenter', () => { deleteTarget = { si, ti }; });

    if (task.status === 'milestone') {
      const x = Math.round(dateToX(task.startDate));
      const diamond = el('div', 'milestone-diamond');
      diamond.style.left = snapToDpr(x - displaySize(DIAMOND_SIZE) / 2) + 'px';
      diamond.style.top  = snapToDpr(displaySize(BAR_TOP)) + 'px';
      diamond.dataset.si = si;
      diamond.dataset.ti = ti;
      diamond.title = task.label;

      diamond.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragState = {
          type: 'move', si, ti, bar: diamond,
          startX: e.clientX,
          origDate: task.startDate,
          isMilestone: true,
          started: false,
        };
        addDragListeners();
      });
      diamond.addEventListener('dblclick', e => {
        e.preventDefault();
        e.stopPropagation();
        startLabelInlineEdit(si, ti, labelCell);
      });
      diamond.addEventListener('mouseenter', () => { deleteTarget = { si, ti }; });

      tlCell.appendChild(diamond);

      // マイルストーンはダイヤモンド内にテキストを表示するスペースがないため、
      // 常に右側外側にラベルを表示する。
      const diamondRight = x + displaySize(DIAMOND_SIZE) / 2;
      appendExternalLabel(tlCell, task.label, diamondRight + displaySize(4), displaySize(BAR_TOP), tlW);
    } else {
      const x = Math.round(dateToX(task.startDate));
      // バーの自然幅（実期間幅）。ステータスインジケーター(10px)＋左パディング(16px)を
      // 表示できるだけの幅が無い狭いバーではインジケーターを省き、実期間幅で描画して
      // バーが期間範囲からはみ出さないようにする（R-G04-05）。
      const natW = Math.round(task.duration * displayPpd());
      const indicatorMinW = displaySize(16) + displaySize(10);
      const showIndicator = natW >= indicatorMinW;
      // 通常バーは自然幅、狭いバーはクリック/リサイズ可能な絶対下限のみ確保する。
      const w = showIndicator ? natW : Math.max(displaySize(RESIZE_W), natW);
      // Build class list: base status class + optional crit modifier
      let barCls = 'gantt-bar status-' + (task.status || 'default');
      if (task.crit) barCls += ' crit';
      if (!showIndicator) barCls += ' no-indicator';
      const bar = el('div', barCls);
      bar.style.left = snapToDpr(x) + 'px';
      bar.style.width = snapToDpr(w) + 'px';
      bar.style.top   = snapToDpr(displaySize(BAR_TOP)) + 'px';
      bar.dataset.si  = si;
      bar.dataset.ti  = ti;
      bar.title = task.label;

      if (showIndicator) {
        const indicator = el('div', 'status-indicator');
        indicator.title = 'クリックで状態変更';
        indicator.addEventListener('mousedown', e => e.stopPropagation());
        indicator.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          showStatusPicker(si, ti, indicator);
        });
        indicator.addEventListener('dblclick', e => {
          e.preventDefault();
          e.stopPropagation();
        });
        bar.appendChild(indicator);
      }

      const barLabel = el('span', 'bar-label');
      // バー内の実効幅（左右パディングを除く）にタスク名が収まるかを事前計測し、
      // 収まらない場合はバー内は空のままにしてバー右側外側にラベルを表示する。
      // インジケーターを省いた狭いバーは左パディングが縮む（.no-indicator）ため、
      // それに合わせて実効幅を算出する。
      const fontPx = displaySize(11);
      const padStart = showIndicator ? displaySize(16) : displaySize(2);
      const innerW = w - padStart - displaySize(8);
      const textW = measureTextWidth(task.label, fontPx);
      if (textW <= innerW) {
        barLabel.textContent = task.label;
      } else {
        appendExternalLabel(tlCell, task.label, x + w + displaySize(4), displaySize(BAR_TOP), tlW);
      }
      bar.appendChild(barLabel);

      const handle = el('div', 'resize-handle');
      bar.appendChild(handle);

      bar.addEventListener('mousedown',    onMoveStart);
      bar.addEventListener('dblclick',     onBarDblClick);
      bar.addEventListener('mouseenter',   () => { deleteTarget = { si, ti }; });
      handle.addEventListener('mousedown', onResizeStart);

      tlCell.appendChild(bar);
    }

    grid.appendChild(tlCell);
  }

  /* ── Drag / move (with threshold) ── */
  function onMoveStart(e) {
    if (e.target.classList.contains('resize-handle')) return;
    if (e.button !== 0) return;
    e.preventDefault();
    const bar = e.currentTarget;
    const si = +bar.dataset.si, ti = +bar.dataset.ti;
    dragState = {
      type: 'move', si, ti, bar,
      startX: e.clientX,
      origDate: ganttData.sections[si].tasks[ti].startDate,
      isMilestone: false,
      started: false,
    };
    addDragListeners();
  }

  function onResizeStart(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const bar = e.currentTarget.parentElement;
    const si = +bar.dataset.si, ti = +bar.dataset.ti;
    dragState = {
      type: 'resize', si, ti, bar,
      startX: e.clientX,
      origDur: ganttData.sections[si].tasks[ti].duration,
      isMilestone: false,
      started: false,
    };
    addDragListeners();
  }

  function onLabelResizeStart(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    labelResizeState = {
      startX: e.clientX,
      startW: labelW,
    };
    document.body.classList.add('label-resizing');
    document.addEventListener('mousemove', onLabelResizeMove);
    document.addEventListener('mouseup', onLabelResizeEnd);
  }

  function onLabelResizeMove(e) {
    if (!labelResizeState) return;
    const dx = (e.clientX - labelResizeState.startX) / viewScale();
    const nextW = Math.max(LABEL_W_MIN, Math.min(LABEL_W_MAX, Math.round(labelResizeState.startW + dx)));
    if (nextW === labelW) return;
    labelW = nextW;
    autoFitPpd = false;
    render();
  }

  function onLabelResizeEnd() {
    document.removeEventListener('mousemove', onLabelResizeMove);
    document.removeEventListener('mouseup', onLabelResizeEnd);
    document.body.classList.remove('label-resizing');
    labelResizeState = null;
  }

  function addDragListeners() {
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup',   onDragEnd);
  }

  function onDragMove(e) {
    if (!dragState) return;
    const { bar, type, startX, origDate, origDur, isMilestone, si, ti } = dragState;
    const dx = e.clientX - startX;

    if (!dragState.started) {
      if (Math.abs(dx) < DRAG_THRESH) return;
      dragState.started = true;
      pushUndo();
      if (type === 'move') showGhost(ganttData.sections[si].tasks[ti].label);
      else showGhost('リサイズ中');
    }

    // dx と表示上の px/日は、どちらも実画面px基準。
    if (type === 'move') {
      const days = Math.round(dx / (pxPerDay * viewScale()));
      const newDate = addDays(origDate, days);
      const newX = Math.round(dateToX(newDate));
      bar.style.left = snapToDpr(isMilestone ? newX - displaySize(DIAMOND_SIZE) / 2 : newX) + 'px';
      updateGhost(newDate);
    } else {
      const days = Math.round(dx / (pxPerDay * viewScale()));
      const newDur = Math.max(1, origDur + days);
      bar.style.width = snapToDpr(Math.max(displaySize(RESIZE_W + 4), Math.round(newDur * displayPpd()))) + 'px';
      updateGhost(newDur + '日');
    }
  }

  function onDragEnd(e) {
    if (!dragState) return;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup',   onDragEnd);
    removeGhost();

    if (!dragState.started) {
      // 閾値未達 → クリックとして扱い dblclick を妨げない
      dragState = null;
      return;
    }

    const { si, ti, type, startX, origDate, origDur } = dragState;
    const task  = ganttData.sections[si].tasks[ti];
    const dx    = e.clientX - startX;
    const days  = Math.round(dx / (pxPerDay * viewScale()));
    let patch   = {};

    if (type === 'move') {
      if (days === 0) { undoStack.pop(); dragState = null; return; }
      // ドラッグ移動で after <id> 依存を解除 (R-G11-05)
      if (task.afterId) delete task.afterId;
      task.startDate = addDays(origDate, days);
      // 日程を編集したので終了日形式で書き戻す (R-G19)
      if (task.status !== 'milestone') task.useEndDate = true;
      patch = { startDate: task.startDate };
    } else {
      const newDur = Math.max(1, origDur + days);
      if (newDur === origDur) { undoStack.pop(); dragState = null; return; }
      task.duration = newDur;
      // 日程を編集したので終了日形式で書き戻す (R-G19)
      if (task.status !== 'milestone') task.useEndDate = true;
      patch = { duration: task.duration };
    }

    dragState = null;

    // 依存タスクの startDate を再解決し、常に全体 (structuralEdit) を送信。
    // インデックス指定編集は並び替え直後にズレを生むため使わない（拡張側で全文置換）。
    if (hasAnyAfterIds()) resolveAfterIds();
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
  }

  /* ── Ghost label ── */
  function showGhost(text) {
    let g = document.getElementById('drag-ghost');
    if (!g) { g = el('div', 'drag-ghost'); g.id = 'drag-ghost'; document.body.appendChild(g); }
    g.textContent = text;
    document.addEventListener('mousemove', moveGhost);
  }
  function updateGhost(text) {
    const g = document.getElementById('drag-ghost');
    if (g) g.textContent = text;
  }
  function moveGhost(e) {
    const g = document.getElementById('drag-ghost');
    if (g) { g.style.left = (e.clientX + 14) + 'px'; g.style.top = (e.clientY - 10) + 'px'; }
  }
  function removeGhost() {
    const g = document.getElementById('drag-ghost');
    if (g) g.remove();
    document.removeEventListener('mousemove', moveGhost);
  }

  /* ── Inline edit (gantt title in corner cell) ── */
  function startTitleEdit(cornerEl) {
    finishEdit(false);
    const input = el('input', 'section-edit-input');
    input.value = ganttData.title || '';
    input.style.width = '150px';
    cornerEl.textContent = '';
    cornerEl.appendChild(input);
    editingEl = { input, original: ganttData.title || '', type: 'title' };
    input.focus(); input.select();
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); finishEdit(true); }
      if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finishEdit(true));
    document.addEventListener('mousedown', onEditOutsideDown, true);
  }

  /* ── Click-outside handler for inline edit ──
     Registered in capture phase so it fires before any mousedown handler
     that calls e.preventDefault() (which would prevent blur from firing). */
  function onEditOutsideDown(e) {
    if (!editingEl) {
      document.removeEventListener('mousedown', onEditOutsideDown, true);
      return;
    }
    if (e.target === editingEl.input) return;
    finishEdit(true);
  }

  /* ── Bar dblclick → タスク編集GUI（名称・開始日・終了日） ── */
  function onBarDblClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const bar = e.currentTarget;
    showTaskEditPopup(+bar.dataset.si, +bar.dataset.ti, e.clientX, e.clientY);
  }

  function startTaskEdit(si, ti, bar) {
    finishEdit(false);
    const task = ganttData.sections[si].tasks[ti];
    const input = el('input', 'bar-edit-input');
    input.value = task.label;
    bar.appendChild(input);
    editingEl = { input, si, ti, original: task.label, type: 'task' };
    input.focus(); input.select();
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); finishEdit(true); }
      if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finishEdit(true));
    document.addEventListener('mousedown', onEditOutsideDown, true);
  }

  /* ── Inline edit (label cell — milestones & task labels) ── */
  function startLabelInlineEdit(si, ti, labelCell) {
    finishEdit(false);
    const task = ganttData.sections[si].tasks[ti];
    const labelSpan = labelCell.querySelector('.task-label-text');
    if (!labelSpan) return;
    const input = el('input', 'section-edit-input');
    input.value = task.label;
    input.style.width = '140px';
    labelSpan.replaceWith(input);
    editingEl = { input, si, ti, original: task.label, type: 'task' };
    input.focus(); input.select();
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); finishEdit(true); }
      if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finishEdit(true));
    document.addEventListener('mousedown', onEditOutsideDown, true);
  }

  /* ── Inline edit (section name) ── */
  function startSectionEdit(si, nameSpan) {
    finishEdit(false);
    const sec = ganttData.sections[si];
    const input = el('input', 'section-edit-input');
    input.value = sec.name;
    nameSpan.replaceWith(input);
    editingEl = { input, si, original: sec.name, type: 'section' };
    input.focus(); input.select();
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); finishEdit(true); }
      if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finishEdit(true));
    document.addEventListener('mousedown', onEditOutsideDown, true);
  }

  function finishEdit(commit) {
    if (!editingEl) return;
    document.removeEventListener('mousedown', onEditOutsideDown, true);
    const { input, original, type } = editingEl;
    const newVal = type === 'title' ? input.value : input.value.trim();
    const snap = editingEl;
    editingEl = null;
    if (!commit || (type !== 'title' && !newVal) || newVal === original) {
      render();
      document.getElementById('scroll-container').focus({ preventScroll: true });
      return;
    }
    pushUndo();
    if (type === 'task') {
      ganttData.sections[snap.si].tasks[snap.ti].label = newVal;
    } else if (type === 'section') {
      ganttData.sections[snap.si].name = newVal;
    } else if (type === 'title') {
      ganttData.title = newVal;
    }
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
    document.getElementById('scroll-container').focus({ preventScroll: true });
  }

  /* ── Context menu (viewport-aware) ── */
  function showContextMenu(e, si, ti) {
    removeContextMenu();
    deleteTarget = { si, ti };

    const menu = el('div', 'context-menu');
    menu.style.visibility = 'hidden';

    function item(text, fn, disabled) {
      const div = el('div', 'menu-item' + (disabled ? ' menu-item-disabled' : ''));
      div.textContent = text;
      if (!disabled) div.addEventListener('click', () => { removeContextMenu(); fn(); });
      menu.appendChild(div);
    }
    function sep() { menu.appendChild(el('div', 'menu-separator')); }

    if (ti >= 0) {
      // タスクのコンテキストメニュー
      item('＋ タスクを追加', () => addTask(si, ti));
      item('◆ マイルストーンを追加', () => addMilestone(si, ti));
      item('⊕ タスクを複製', () => duplicateTask(si, ti));
      sep();
      item('✎ 日程を編集', () => showDateEditPopup(si, ti, e.clientX, e.clientY));
      sep();
      const isFirst = si === 0 && ti === 0;
      const lastSi  = ganttData.sections.length - 1;
      const isLast  = si === lastSi && ti === ganttData.sections[lastSi].tasks.length - 1;
      item('↑ 上へ移動', () => moveTaskUp(si, ti),   isFirst);
      item('↓ 下へ移動', () => moveTaskDown(si, ti), isLast);
      sep();
      const task = ganttData.sections[si].tasks[ti];
      if (task.afterId) {
        item('⛓ 依存関係を削除', () => removeDependency(si, ti));
      } else {
        item('⛓ 依存関係を設定', () => showDependencyPicker(si, ti, e.clientX, e.clientY));
      }
      sep();
      item('✕ タスクを削除', () => deleteTask(si, ti));
    } else {
      // セクションのコンテキストメニュー
      const lastTi = ganttData.sections[si].tasks.length - 1;
      item('＋ タスクを追加', () => addTask(si, lastTi));
      item('◆ マイルストーンを追加', () => addMilestone(si, lastTi));
      if (ganttData.sections[si].name) {
        sep();
        item('✕ セクションを削除', () => deleteSection(si));
      }
    }

    document.body.appendChild(menu);

    // ビューポート折り返し
    const mW = menu.offsetWidth  || 160;
    const mH = menu.offsetHeight || 120;
    let left = e.clientX;
    let top  = e.clientY;
    if (left + mW > window.innerWidth)  left = e.clientX - mW;
    if (top  + mH > window.innerHeight) top  = e.clientY - mH;
    if (left < 4) left = 4;
    if (top  < 4) top  = 4;
    menu.style.left       = left + 'px';
    menu.style.top        = top  + 'px';
    menu.style.visibility = '';

    setTimeout(() => document.addEventListener('click', removeContextMenu, { once: true }), 0);
  }

  function removeContextMenu() {
    document.querySelectorAll('.context-menu').forEach(m => m.remove());
  }

  /* ── Dependency picker ── */
  function showDependencyPicker(si, ti, cx, cy) {
    removeDependencyPicker();

    const candidates = [];
    ganttData.sections.forEach((sec, sIdx) => {
      sec.tasks.forEach((task, tIdx) => {
        if (sIdx === si && tIdx === ti) return; // exclude self
        candidates.push({ label: task.label, id: task.id, si: sIdx, ti: tIdx });
      });
    });

    if (candidates.length === 0) return;

    const picker = el('div', 'dep-picker');

    const header = el('div', 'dep-picker-header');
    header.textContent = '依存元タスクを選択';
    picker.appendChild(header);

    candidates.forEach(({ label, id, si: srcSi, ti: srcTi }) => {
      const row = el('div', 'menu-item');
      row.textContent = id ? `${label}  [${id}]` : label;
      row.addEventListener('click', e => {
        e.stopPropagation();
        removeDependencyPicker();
        applyDependency(si, ti, srcSi, srcTi);
      });
      picker.appendChild(row);
    });

    picker.style.visibility = 'hidden';
    document.body.appendChild(picker);

    const pW = picker.offsetWidth  || 200;
    const pH = picker.offsetHeight || 200;
    let left = cx, top = cy;
    if (left + pW > window.innerWidth)  left = cx - pW;
    if (top  + pH > window.innerHeight) top  = cy - pH;
    if (left < 4) left = 4;
    if (top  < 4) top  = 4;
    picker.style.left       = left + 'px';
    picker.style.top        = top  + 'px';
    picker.style.visibility = '';

    setTimeout(() => document.addEventListener('click', removeDependencyPicker, { once: true }), 0);
  }

  function removeDependencyPicker() {
    document.querySelectorAll('.dep-picker').forEach(m => m.remove());
  }

  function applyDependency(si, ti, srcSi, srcTi) {
    pushUndo();
    const srcTask = ganttData.sections[srcSi].tasks[srcTi];
    if (!srcTask.id) srcTask.id = generateTaskId();

    const depTask = ganttData.sections[si].tasks[ti];
    depTask.afterId = srcTask.id;
    depTask.startDate = addDays(srcTask.startDate, srcTask.duration || 0);

    resolveAfterIds();
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
  }

  function removeDependency(si, ti) {
    pushUndo();
    delete ganttData.sections[si].tasks[ti].afterId;
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
  }

  /* ── Dependency arrows ── */
  function drawDependencyArrows() {
    const container = document.getElementById('scroll-container');
    const existing = document.getElementById('dep-arrows');
    if (existing) existing.remove();

    if (!ganttData) return;

    // Build id → {si, ti}
    const idToPos = new Map();
    ganttData.sections.forEach((sec, si) => {
      sec.tasks.forEach((task, ti) => {
        if (task.id) idToPos.set(task.id, { si, ti });
      });
    });

    // Collect arrows
    const arrowPairs = [];
    ganttData.sections.forEach((sec, si) => {
      if (collapsedSections.has(si)) return;
      sec.tasks.forEach((task, ti) => {
        if (!task.afterId) return;
        const srcPos = idToPos.get(task.afterId);
        if (!srcPos || collapsedSections.has(srcPos.si)) return;
        arrowPairs.push({ fromSi: srcPos.si, fromTi: srcPos.ti, toSi: si, toTi: ti });
      });
    });

    if (arrowPairs.length === 0) return;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'dep-arrows';
    const grid = document.getElementById('gantt-grid');
    svg.setAttribute('width', grid.scrollWidth);
    svg.setAttribute('height', grid.scrollHeight);
    container.appendChild(svg);

    // Arrowhead marker
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'dep-arrowhead');
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('refX', '7');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');
    const tip = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    tip.setAttribute('points', '0 0, 8 3, 0 6');
    tip.setAttribute('fill', 'var(--vscode-charts-orange, #e8a87c)');
    marker.appendChild(tip);
    defs.appendChild(marker);
    svg.appendChild(defs);

    const cRect = container.getBoundingClientRect();

    function relPos(barEl) {
      const r = barEl.getBoundingClientRect();
      const sl = container.scrollLeft, st = container.scrollTop;
      return {
        right: r.right - cRect.left + sl,
        left:  r.left  - cRect.left + sl,
        midY:  (r.top + r.bottom) / 2 - cRect.top + st,
      };
    }

    arrowPairs.forEach(({ fromSi, fromTi, toSi, toTi }) => {
      const srcEl = document.querySelector(`.gantt-bar[data-si="${fromSi}"][data-ti="${fromTi}"]`) ||
                    document.querySelector(`.milestone-diamond[data-si="${fromSi}"][data-ti="${fromTi}"]`);
      const dstEl = document.querySelector(`.gantt-bar[data-si="${toSi}"][data-ti="${toTi}"]`) ||
                    document.querySelector(`.milestone-diamond[data-si="${toSi}"][data-ti="${toTi}"]`);
      if (!srcEl || !dstEl) return;

      const src = relPos(srcEl);
      const dst = relPos(dstEl);
      const x1 = src.right, y1 = src.midY;
      const x2 = dst.left,  y2 = dst.midY;
      const bend = Math.max(16, Math.abs(x2 - x1) * 0.35);

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
      path.setAttribute('stroke', 'var(--vscode-charts-orange, #e8a87c)');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('fill', 'none');
      path.setAttribute('marker-end', 'url(#dep-arrowhead)');
      svg.appendChild(path);
    });
  }

  /* ── Excluded date bands (weekends / excludes) ──
     R-G18-03: ヘッダーのみに反映されていた除外日グレーアウトを、セクション/タスク行の
     タイムライン領域にも拡張する。行ごとに背景を塗るのではなく、drawDependencyArrows()
     と同様に #scroll-container へ1枚のオーバーレイをかぶせ、render() のたびに再構築する。 */
  function renderExcludedBands() {
    const container = document.getElementById('scroll-container');
    const existing = document.getElementById('excluded-bands');
    if (existing) existing.remove();

    if (!ganttData || !ganttData.excludes || ganttData.excludes.length === 0) return;

    const { min, max } = calcRange(ganttData);

    // 連続する除外日をまとめて区間化する。
    const bands = [];
    let cur = new Date(min);
    let bandStart = null, bandDays = 0;
    while (cur < max) {
      const dateStr = fmtDate(cur);
      if (isExcludedDate(dateStr)) {
        if (bandStart === null) bandStart = dateStr;
        bandDays++;
      } else if (bandStart !== null) {
        bands.push({ start: bandStart, days: bandDays });
        bandStart = null;
        bandDays = 0;
      }
      cur.setDate(cur.getDate() + 1);
    }
    if (bandStart !== null) bands.push({ start: bandStart, days: bandDays });

    if (bands.length === 0) return;

    const grid = document.getElementById('gantt-grid');
    const overlay = el('div', '');
    overlay.id = 'excluded-bands';
    const labelLeft = snapToDpr(displaySize(labelW));
    const top = displaySize(HEADER_H);
    const height = grid.scrollHeight - top;

    bands.forEach(({ start, days }) => {
      const band = el('div', 'excluded-band');
      band.style.left   = (labelLeft + dateToX(start)) + 'px';
      band.style.top    = top + 'px';
      band.style.width  = (days * displayPpd()) + 'px';
      band.style.height = height + 'px';
      overlay.appendChild(band);
    });

    container.appendChild(overlay);
  }

  /* ── Date/duration edit popup ── */
  function onDateEditOutsideDown(e) {
    const popup = document.querySelector('.date-edit-popup');
    if (popup && popup.contains(e.target)) return;
    removeDateEditPopup();
  }

  function removeDateEditPopup() {
    document.removeEventListener('mousedown', onDateEditOutsideDown, true);
    document.querySelectorAll('.date-edit-popup').forEach(p => p.remove());
  }

  function showDateEditPopup(si, ti, cx, cy) {
    finishEdit(false);
    removeDateEditPopup();

    const task = ganttData.sections[si].tasks[ti];
    const isMilestone = task.status === 'milestone';

    const popup = el('div', 'date-edit-popup');

    const header = el('div', 'dep-picker-header');
    header.textContent = '日程を編集';
    popup.appendChild(header);

    // 開始日行
    const startRow = el('div', 'date-edit-row');
    const startLabel = el('label', 'date-edit-label');
    startLabel.textContent = '開始日';
    const startInput = el('input');
    startInput.type = 'date';
    startInput.value = task.startDate;
    startInput.className = 'date-edit-input';
    startRow.appendChild(startLabel);
    startRow.appendChild(startInput);
    popup.appendChild(startRow);

    // 期間行（マイルストーン以外）
    let durInput = null;
    if (!isMilestone) {
      const durRow = el('div', 'date-edit-row');
      const durLabel = el('label', 'date-edit-label');
      durLabel.textContent = '期間（日）';
      durInput = el('input');
      durInput.type = 'number';
      durInput.min = '1';
      durInput.value = String(task.duration);
      durInput.className = 'date-edit-input date-edit-dur';
      durRow.appendChild(durLabel);
      durRow.appendChild(durInput);
      popup.appendChild(durRow);
    }

    // エラー表示
    const errMsg = el('div', 'date-edit-error');
    errMsg.style.display = 'none';
    popup.appendChild(errMsg);

    // ボタン行
    const actions = el('div', 'date-edit-actions');
    const cancelBtn = el('button', 'date-edit-btn date-edit-cancel');
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.type = 'button';
    const applyBtn = el('button', 'date-edit-btn date-edit-apply');
    applyBtn.textContent = '適用';
    applyBtn.type = 'button';
    actions.appendChild(cancelBtn);
    actions.appendChild(applyBtn);
    popup.appendChild(actions);

    popup.style.visibility = 'hidden';
    document.body.appendChild(popup);

    // 位置調整
    const pW = popup.offsetWidth  || 220;
    const pH = popup.offsetHeight || 180;
    let left = cx, top = cy;
    if (left + pW > window.innerWidth)  left = cx - pW;
    if (top  + pH > window.innerHeight) top  = cy - pH;
    if (left < 4) left = 4;
    if (top  < 4) top  = 4;
    popup.style.left       = left + 'px';
    popup.style.top        = top  + 'px';
    popup.style.visibility = '';

    startInput.focus();

    function apply() {
      const newDate = startInput.value;
      if (!newDate || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
        errMsg.textContent = '有効な日付（YYYY-MM-DD）を入力してください';
        errMsg.style.display = 'block';
        return;
      }
      let newDur = isMilestone ? 0 : task.duration;
      if (!isMilestone && durInput) {
        newDur = parseInt(durInput.value, 10);
        if (isNaN(newDur) || newDur < 1) {
          errMsg.textContent = '期間は1日以上で入力してください';
          errMsg.style.display = 'block';
          return;
        }
      }
      removeDateEditPopup();
      pushUndo();

      const t = ganttData.sections[si].tasks[ti];
      t.startDate = newDate;
      t.duration  = newDur;
      if (t.afterId) delete t.afterId; // R-G14-04: 依存関係を解除して絶対日付に変換
      if (!isMilestone) t.useEndDate = true; // 日程を編集したので終了日形式で書き戻す (R-G19)
      vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
      render();
    }

    cancelBtn.addEventListener('click', removeDateEditPopup);
    applyBtn.addEventListener('click', apply);

    [startInput, durInput].filter(Boolean).forEach(inp => {
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); apply(); }
        if (e.key === 'Escape') { e.preventDefault(); removeDateEditPopup(); }
        e.stopPropagation();
      });
    });

    setTimeout(() => document.addEventListener('mousedown', onDateEditOutsideDown, true), 0);
  }

  /* ── Task edit popup (bar dblclick): 名称・開始日・終了日 ──
     R-G15: バーのダブルクリックで名称・開始日・終了日を編集する。
     終了日は内部の duration（日数）へ変換して保持・出力する（duration ベース）。 */
  function showTaskEditPopup(si, ti, cx, cy) {
    finishEdit(false);
    removeDateEditPopup();

    const task = ganttData.sections[si].tasks[ti];

    const popup = el('div', 'date-edit-popup');

    const header = el('div', 'dep-picker-header');
    header.textContent = 'タスクを編集';
    popup.appendChild(header);

    // 名称行
    const nameRow = el('div', 'date-edit-row');
    const nameLabel = el('label', 'date-edit-label');
    nameLabel.textContent = 'タスク名';
    const nameInput = el('input');
    nameInput.type = 'text';
    nameInput.value = task.label;
    nameInput.className = 'date-edit-input';
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);
    popup.appendChild(nameRow);

    // 開始日行
    const startRow = el('div', 'date-edit-row');
    const startLabel = el('label', 'date-edit-label');
    startLabel.textContent = '開始日';
    const startInput = el('input');
    startInput.type = 'date';
    startInput.value = task.startDate;
    startInput.className = 'date-edit-input';
    startRow.appendChild(startLabel);
    startRow.appendChild(startInput);
    popup.appendChild(startRow);

    // 終了日行（マイルストーン以外）。終了日 = 開始日 + duration（包含的に最終日を表示）。
    let endInput = null;
    const isMilestone = task.status === 'milestone';
    if (!isMilestone) {
      const endRow = el('div', 'date-edit-row');
      const endLabel = el('label', 'date-edit-label');
      endLabel.textContent = '終了日';
      endInput = el('input');
      endInput.type = 'date';
      // duration（バー幅日数）は開始日からの差分。終了日入力は最終日（開始 + duration - 1）を表示。
      endInput.value = addDays(task.startDate, Math.max(0, (task.duration || 1) - 1));
      endInput.className = 'date-edit-input';
      endRow.appendChild(endLabel);
      endRow.appendChild(endInput);
      popup.appendChild(endRow);
    }

    const errMsg = el('div', 'date-edit-error');
    errMsg.style.display = 'none';
    popup.appendChild(errMsg);

    const actions = el('div', 'date-edit-actions');
    const cancelBtn = el('button', 'date-edit-btn date-edit-cancel');
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.type = 'button';
    const applyBtn = el('button', 'date-edit-btn date-edit-apply');
    applyBtn.textContent = '適用';
    applyBtn.type = 'button';
    actions.appendChild(cancelBtn);
    actions.appendChild(applyBtn);
    popup.appendChild(actions);

    popup.style.visibility = 'hidden';
    document.body.appendChild(popup);

    const pW = popup.offsetWidth  || 240;
    const pH = popup.offsetHeight || 200;
    let left = cx, top = cy;
    if (left + pW > window.innerWidth)  left = cx - pW;
    if (top  + pH > window.innerHeight) top  = cy - pH;
    if (left < 4) left = 4;
    if (top  < 4) top  = 4;
    popup.style.left       = left + 'px';
    popup.style.top        = top  + 'px';
    popup.style.visibility = '';

    nameInput.focus();
    nameInput.select();

    function apply() {
      const newName = nameInput.value.trim();
      if (!newName) {
        errMsg.textContent = 'タスク名を入力してください';
        errMsg.style.display = 'block';
        return;
      }
      const newStart = startInput.value;
      if (!newStart || !/^\d{4}-\d{2}-\d{2}$/.test(newStart)) {
        errMsg.textContent = '有効な開始日（YYYY-MM-DD）を入力してください';
        errMsg.style.display = 'block';
        return;
      }
      let newDur = isMilestone ? 0 : (task.duration || 1);
      if (!isMilestone && endInput) {
        const newEnd = endInput.value;
        if (!newEnd || !/^\d{4}-\d{2}-\d{2}$/.test(newEnd)) {
          errMsg.textContent = '有効な終了日（YYYY-MM-DD）を入力してください';
          errMsg.style.display = 'block';
          return;
        }
        // 終了日（最終日・包含）→ duration へ変換。最小1日。
        newDur = diffDays(newStart, newEnd) + 1;
        if (newDur < 1) {
          errMsg.textContent = '終了日は開始日以降にしてください';
          errMsg.style.display = 'block';
          return;
        }
      }
      removeDateEditPopup();
      pushUndo();

      const t = ganttData.sections[si].tasks[ti];
      t.label     = newName;
      t.startDate = newStart;
      t.duration  = newDur;
      if (t.afterId) delete t.afterId; // 開始日を直接指定したら依存を解除（R-G11-05 同方針）
      if (!isMilestone) t.useEndDate = true; // 日程を編集したので終了日形式で書き戻す (R-G19)

      if (hasAnyAfterIds()) resolveAfterIds();
      vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
      render();
    }

    cancelBtn.addEventListener('click', removeDateEditPopup);
    applyBtn.addEventListener('click', apply);

    [nameInput, startInput, endInput].filter(Boolean).forEach(inp => {
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); apply(); }
        if (e.key === 'Escape') { e.preventDefault(); removeDateEditPopup(); }
        e.stopPropagation();
      });
    });

    setTimeout(() => document.addEventListener('mousedown', onDateEditOutsideDown, true), 0);
  }

  /* ── Add / Delete ── */
  function addTask(si, afterTi) {
    pushUndo();
    const sec = ganttData.sections[si];
    const prev = (afterTi >= 0 && afterTi < sec.tasks.length) ? sec.tasks[afterTi] : null;
    const startDate = prev ? addDays(prev.startDate, prev.duration || 0) : fmtDate(new Date());
    const newTask = { id: '', label: '新しいタスク', status: '', startDate, duration: 7, useEndDate: true };
    sec.tasks.splice(afterTi + 1, 0, newTask);
    const newTi = afterTi + 1;
    selected = { si, ti: newTi };
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
    const bar = document.querySelector(`.gantt-bar[data-si="${si}"][data-ti="${newTi}"]`);
    if (bar) startTaskEdit(si, newTi, bar);
  }

  function addMilestone(si, afterTi) {
    pushUndo();
    const sec = ganttData.sections[si];
    const prev = (afterTi >= 0 && afterTi < sec.tasks.length) ? sec.tasks[afterTi] : null;
    const startDate = prev ? addDays(prev.startDate, prev.duration || 0) : fmtDate(new Date());
    const newTask = { id: '', label: 'マイルストーン', status: 'milestone', startDate, duration: 0 };
    sec.tasks.splice(afterTi + 1, 0, newTask);
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
    const newTi = afterTi + 1;
    const row = rowIndex.find(r => r.type === 'task' && r.si === si && r.ti === newTi);
    if (row) startLabelInlineEdit(si, newTi, row.el);
  }

  function duplicateTask(si, ti) {
    pushUndo();
    const sec = ganttData.sections[si];
    const orig = sec.tasks[ti];
    const newTask = {
      id: '',
      label: orig.label,
      status: orig.status,
      ...(orig.crit ? { crit: true } : {}),
      startDate: addDays(orig.startDate, orig.duration || 0),
      duration: orig.duration,
      // 複製は日程を新規生成するので、非マイルストーンは終了日形式で書き戻す (R-G19)
      ...(orig.status !== 'milestone' ? { useEndDate: true } : {}),
    };
    sec.tasks.splice(ti + 1, 0, newTask);
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
    const newTi = ti + 1;
    if (orig.status === 'milestone') {
      const row = rowIndex.find(r => r.type === 'task' && r.si === si && r.ti === newTi);
      if (row) startLabelInlineEdit(si, newTi, row.el);
    } else {
      const bar = document.querySelector(`.gantt-bar[data-si="${si}"][data-ti="${newTi}"]`);
      if (bar) startTaskEdit(si, newTi, bar);
    }
  }

  function deleteTask(si, ti) {
    pushUndo();
    ganttData.sections[si].tasks.splice(ti, 1);
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    deleteTarget = null;
    render();
  }

  function deleteSection(si) {
    pushUndo();
    ganttData.sections.splice(si, 1);
    if (ganttData.sections.length === 0) {
      ganttData.sections = [{ name: '', tasks: [] }];
    }
    shiftCollapsedAfterRemove(si);
    if (selected && selected.si === si) selected = null;
    else if (selected && selected.si > si) selected.si--;
    clampSelection();
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    deleteTarget = null;
    render();
  }

  function addSection(name, insertAt) {
    pushUndo();
    const at = (typeof insertAt === 'number')
      ? Math.max(0, Math.min(insertAt, ganttData.sections.length))
      : ganttData.sections.length;
    ganttData.sections.splice(at, 0, { name, tasks: [] });
    // 折りたたみインデックスは挿入位置以降が1つずれるので再構築
    shiftCollapsedAfterInsert(at);
    selected = { si: at, ti: -1 };
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
  }

  // セクション挿入時に collapsedSections のインデックスを補正
  function shiftCollapsedAfterInsert(at) {
    if (collapsedSections.size === 0) return;
    const shifted = new Set();
    collapsedSections.forEach(i => shifted.add(i >= at ? i + 1 : i));
    collapsedSections.clear();
    shifted.forEach(i => collapsedSections.add(i));
  }

  // セクション削除時に collapsedSections のインデックスを補正
  function shiftCollapsedAfterRemove(at) {
    if (collapsedSections.size === 0) return;
    const shifted = new Set();
    collapsedSections.forEach(i => {
      if (i !== at) shifted.add(i > at ? i - 1 : i);
    });
    collapsedSections.clear();
    shifted.forEach(i => collapsedSections.add(i));
  }

  /* ── Task reorder (context menu) ── */
  function moveTaskUp(si, ti) {
    pushUndo();
    if (ti > 0) {
      const tasks = ganttData.sections[si].tasks;
      [tasks[ti-1], tasks[ti]] = [tasks[ti], tasks[ti-1]];
      selected = { si, ti: ti - 1 };
    } else if (si > 0) {
      const task = ganttData.sections[si].tasks.splice(ti, 1)[0];
      ganttData.sections[si-1].tasks.push(task);
      unlinkDependencyOnSectionMove(task);  // 別セクションへ移動(B-8)
      selected = { si: si - 1, ti: ganttData.sections[si-1].tasks.length - 1 };
    }
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
  }

  function moveTaskDown(si, ti) {
    pushUndo();
    const sec = ganttData.sections[si];
    if (ti < sec.tasks.length - 1) {
      [sec.tasks[ti], sec.tasks[ti+1]] = [sec.tasks[ti+1], sec.tasks[ti]];
      selected = { si, ti: ti + 1 };
    } else if (si < ganttData.sections.length - 1) {
      const task = sec.tasks.splice(ti, 1)[0];
      ganttData.sections[si+1].tasks.unshift(task);
      unlinkDependencyOnSectionMove(task);  // 別セクションへ移動(B-8)
      selected = { si: si + 1, ti: 0 };
    }
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
  }

  /* ── Drag-and-drop reorder (tasks) ── */
  function startReorder(e, si, ti) {
    if (e.button !== 0) return;
    reorderState = { type: 'task', si, ti, active: false, startY: e.clientY, target: null };
    document.addEventListener('mousemove', onReorderMove);
    document.addEventListener('mouseup',   onReorderEnd);
  }

  /* ── Drag-and-drop reorder (sections) ── */
  function startSectionReorder(e, si) {
    if (e.button !== 0) return;
    reorderState = { type: 'section', si, active: false, startY: e.clientY, target: null };
    document.addEventListener('mousemove', onReorderMove);
    document.addEventListener('mouseup',   onReorderEnd);
  }

  function onReorderMove(e) {
    if (!reorderState) return;
    if (!reorderState.active && Math.abs(e.clientY - reorderState.startY) > 4) {
      reorderState.active = true;
      const ind = el('div', 'drop-indicator');
      ind.id = 'drop-indicator';
      document.body.appendChild(ind);
    }
    if (!reorderState.active) return;

    const target = reorderState.type === 'section'
      ? findSectionDropTarget(e.clientY, reorderState.si)
      : findDropTarget(e.clientY);
    reorderState.target = target;

    const ind = document.getElementById('drop-indicator');
    if (ind && target) {
      const rect = target.el.getBoundingClientRect();
      ind.style.top = (target.position === 'before' ? rect.top : rect.bottom) - 1 + 'px';
    }
  }

  function onReorderEnd() {
    document.removeEventListener('mousemove', onReorderMove);
    document.removeEventListener('mouseup',   onReorderEnd);
    const ind = document.getElementById('drop-indicator');
    if (ind) ind.remove();

    if (!reorderState || !reorderState.active || !reorderState.target) {
      reorderState = null;
      return;
    }

    const state = reorderState;
    reorderState = null;

    if (state.type === 'section') {
      applySectionReorder(state.si, state.target);
    } else {
      applyTaskReorder(state.si, state.ti, state.target);
    }
  }

  function findDropTarget(clientY) {
    // タスク行に加え、タスク行を表示していないセクション行（空セクション、または
    // 折りたたみセクション）もドロップ先候補に含める。これにより空セクションへ
    // タスクを移動でき(要3)、折りたたみセクションへも入れられる(B-10)。
    const isSectionDrop = r =>
      r.type === 'section' &&
      (ganttData.sections[r.si].tasks.length === 0 || collapsedSections.has(r.si));
    const rows = rowIndex.filter(r => r.type === 'task' || isSectionDrop(r));
    for (const row of rows) {
      const rect = row.el.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        if (row.type === 'section') {
          // セクション行の上端 → そのセクション末尾へ挿入（折りたたみは展開）
          const ti = ganttData.sections[row.si].tasks.length;
          return { si: row.si, ti, position: 'before', el: row.el, sectionDrop: true };
        }
        return { si: row.si, ti: row.ti, position: 'before', el: row.el };
      }
    }
    if (rows.length > 0) {
      const last = rows[rows.length - 1];
      if (last.type === 'section') {
        const ti = ganttData.sections[last.si].tasks.length;
        return { si: last.si, ti, position: 'before', el: last.el, sectionDrop: true };
      }
      return { si: last.si, ti: last.ti, position: 'after', el: last.el };
    }
    return null;
  }

  function findSectionDropTarget(clientY, fromSi) {
    const sections = rowIndex.filter(r => r.type === 'section' && r.si !== fromSi);
    for (const row of sections) {
      const rect = row.el.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return { si: row.si, position: 'before', el: row.el };
      }
    }
    if (sections.length > 0) {
      const last = sections[sections.length - 1];
      return { si: last.si, position: 'after', el: last.el };
    }
    return null;
  }

  function applyTaskReorder(fromSi, fromTi, target) {
    if (fromSi === target.si && fromTi === target.ti && target.position === 'before') {
      render(); return;
    }
    pushUndo();
    const task = ganttData.sections[fromSi].tasks.splice(fromTi, 1)[0];
    let insertTi = target.position === 'after' ? target.ti + 1 : target.ti;
    if (fromSi === target.si && target.ti > fromTi) insertTi--;
    const sec = ganttData.sections[target.si];
    insertTi = Math.max(0, Math.min(insertTi, sec.tasks.length));
    sec.tasks.splice(insertTi, 0, task);
    // 折りたたみセクションへドロップした場合は展開して結果を見せる(B-10)。
    if (target.sectionDrop) collapsedSections.delete(target.si);
    // 別セクションへ移したら依存(after)を解除し、バードラッグ等と整合させる(B-8)。
    if (fromSi !== target.si) unlinkDependencyOnSectionMove(task);
    selected = { si: target.si, ti: insertTi };
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
  }

  // タスクが別セクションへ移動したときの依存(after)整合処理。
  // 自身の afterId は解除し（移動側を絶対日付に固定）、自身に依存している
  // タスクの開始日を再解決して矢印と日付のズレを防ぐ。
  function unlinkDependencyOnSectionMove(task) {
    if (task.afterId) delete task.afterId;
    if (hasAnyAfterIds()) resolveAfterIds();
  }

  function applySectionReorder(fromSi, target) {
    if (!target) { render(); return; }
    let toSi = target.si;
    if (fromSi === toSi) { render(); return; }
    pushUndo();
    const section = ganttData.sections.splice(fromSi, 1)[0];
    let insertSi = target.position === 'after' ? toSi + 1 : toSi;
    if (toSi > fromSi) insertSi--;
    insertSi = Math.max(0, Math.min(insertSi, ganttData.sections.length));
    ganttData.sections.splice(insertSi, 0, section);
    const mapIndex = i => {
      if (i === fromSi) return insertSi;
      if (fromSi < insertSi && i > fromSi && i <= insertSi) return i - 1;
      if (fromSi > insertSi && i >= insertSi && i < fromSi) return i + 1;
      return i;
    };
    const remappedCollapsed = new Set();
    collapsedSections.forEach(i => remappedCollapsed.add(mapIndex(i)));
    collapsedSections.clear();
    remappedCollapsed.forEach(i => collapsedSections.add(i));
    if (selected) selected.si = mapIndex(selected.si);
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
  }

  /* ── Pan ── */
  function onPanStart(e) {
    if (e.button !== 0) return;
    if (e.target.closest('.gantt-bar') ||
        e.target.closest('.milestone-diamond') ||
        e.target.closest('.resize-handle') ||
        e.target.closest('.label-resize-handle')) return;
    e.preventDefault();
    const container = document.getElementById('scroll-container');
    panState = {
      startX: e.clientX, startY: e.clientY,
      scrollLeft: container.scrollLeft, scrollTop: container.scrollTop,
    };
    document.addEventListener('mousemove', onPanMove);
    document.addEventListener('mouseup',   onPanEnd);
  }

  function onPanMove(e) {
    if (!panState) return;
    const container = document.getElementById('scroll-container');
    container.scrollLeft = panState.scrollLeft - (e.clientX - panState.startX);
    container.scrollTop  = panState.scrollTop  - (e.clientY - panState.startY);
  }

  function onPanEnd() {
    document.removeEventListener('mousemove', onPanMove);
    document.removeEventListener('mouseup',   onPanEnd);
    panState = null;
  }

  /* ── Crit toggle ── */
  function toggleCrit(si, ti) {
    pushUndo();
    const task = ganttData.sections[si].tasks[ti];
    if (task.crit) {
      delete task.crit;
    } else {
      task.crit = true;
    }
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
  }

  /* ── Status picker ── */
  function showStatusPicker(si, ti, anchor) {
    removeStatusPicker();
    const picker = el('div', 'status-picker');

    const current = ganttData.sections[si].tasks[ti].status;
    // `crit` is now a separate toggle (see crit-toggle button in the label cell),
    // so the status picker only shows done / active / unset.
    const STATUSES = [
      { value: 'done',   label: '✓  完了 (done)',    cls: 'pick-done'    },
      { value: 'active', label: '▶  進行中 (active)', cls: 'pick-active'  },
      { value: '',       label: '○  未着手',           cls: 'pick-default' },
    ];

    STATUSES.forEach(({ value, label, cls }) => {
      const item = el('div', 'menu-item ' + cls + (value === current ? ' pick-current' : ''));
      item.textContent = (value === current ? '● ' : '  ') + label;
      item.addEventListener('click', e => {
        e.stopPropagation();
        removeStatusPicker();
        applyStatus(si, ti, value);
      });
      picker.appendChild(item);
    });

    picker.style.visibility = 'hidden';
    document.body.appendChild(picker);

    const rect = anchor.getBoundingClientRect();
    let left = rect.left;
    let top  = rect.bottom + 4;
    const pW = picker.offsetWidth  || 160;
    const pH = picker.offsetHeight || 120;
    if (left + pW > window.innerWidth)  left = window.innerWidth  - pW - 4;
    if (top  + pH > window.innerHeight) top  = rect.top - pH - 4;
    if (left < 4) left = 4;
    picker.style.left       = left + 'px';
    picker.style.top        = top  + 'px';
    picker.style.visibility = '';

    setTimeout(() => document.addEventListener('click', removeStatusPicker, { once: true }), 0);
  }

  function removeStatusPicker() {
    document.querySelectorAll('.status-picker').forEach(m => m.remove());
  }

  function applyStatus(si, ti, status) {
    pushUndo();
    ganttData.sections[si].tasks[ti].status = status;
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
  }

  /* ── Undo ── */
  function pushUndo() {
    undoStack.push(JSON.parse(JSON.stringify(ganttData)));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }

  function undo() {
    if (!undoStack.length) return;
    ganttData = undoStack.pop();
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
  }

  /* ── Status bar ── */
  let statusTimer = null;
  function showStatus(text) {
    const lbl = document.getElementById('status-label');
    lbl.textContent = text;
    lbl.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => lbl.classList.remove('show'), 1800);
  }

  /* ── Scroll to today − 3 days ── */
  function scrollToToday() {
    const container = document.getElementById('scroll-container');
    container.scrollLeft = Math.max(0, dateToX(addDays(fmtDate(new Date()), -3)));
    container.scrollTop  = 0;
  }

  /* ── Messages from extension ── */
  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'update') {
      document.getElementById('empty-overlay').classList.remove('visible');
      document.getElementById('scroll-container').style.display = '';
      document.getElementById('btn-add-task').disabled    = false;
      document.getElementById('btn-add-section').disabled = false;
      document.getElementById('btn-undo').disabled         = false;
      document.getElementById('sel-axis-format').disabled = false;
      document.getElementById('chk-exclude-weekends').disabled = false;
      ganttData = msg.gantt;
      document.getElementById('sel-axis-format').value = ganttData.axisFormat || '';
      document.getElementById('chk-exclude-weekends').checked =
        !!(ganttData.excludes && ganttData.excludes.some(tok => tok.trim().toLowerCase() === 'weekends'));
      undoStack = [];
      autoFitPpd = true;
      collapsedSections.clear();
      render();
      scrollToToday();
    } else if (msg.type === 'empty') {
      document.getElementById('scroll-container').style.display = 'none';
      document.getElementById('empty-overlay').classList.add('visible');
      document.getElementById('btn-add-task').disabled    = true;
      document.getElementById('btn-add-section').disabled = true;
      document.getElementById('btn-undo').disabled         = true;
      document.getElementById('sel-axis-format').disabled = true;
      document.getElementById('chk-exclude-weekends').disabled = true;
    } else if (msg.type === 'saved') {
      showStatus('✓ 保存済');
    }
  });

  /* ── Keyboard ── */
  document.addEventListener('keydown', e => {
    if (editingEl) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); vscode.postMessage({ type: 'save' }); return; }
    if (e.key === 'Delete' && deleteTarget) {
      e.preventDefault();
      removeContextMenu();
      const { si, ti } = deleteTarget;
      if (ti >= 0) {
        deleteTask(si, ti);
      } else if (ganttData.sections[si]?.name) {
        deleteSection(si);
      }
    }
  });

  /* ── Wheel zoom (Ctrl+wheel) / scroll (plain wheel) ──
     範囲（px/日）ズーム。カーソル位置の日付を表示座標から算出して維持する。 */
  document.getElementById('scroll-container').addEventListener('wheel', e => {
    if (!e.ctrlKey) return; // plain wheel → browser default scroll
    e.preventDefault();
    const container = e.currentTarget;
    const rect = container.getBoundingClientRect();
    const contentX = e.clientX - rect.left + container.scrollLeft;
    const dayAtCursor = (contentX - displaySize(labelW)) / displayPpd();
    const factor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
    const newPPD = Math.max(fitFloorPpd(), Math.min(MAX_PPD, pxPerDay * factor));
    if (Math.abs(newPPD - pxPerDay) < 0.01) return;
    pxPerDay = newPPD;
    autoFitPpd = false;
    render();
    const newScrollLeft = Math.round((dayAtCursor * newPPD + labelW) * viewScale()) - (e.clientX - rect.left);
    container.scrollLeft = Math.max(0, newScrollLeft);
  }, { passive: false });

  /* ── View zoom (ビュー全体の拡大縮小、範囲ズームとは独立) ── */
  function setViewZoom(next) {
    if (!ganttData) return;
    const clamped = Math.max(VIEW_ZOOM_MIN, Math.min(VIEW_ZOOM_MAX, Math.round(next * 100) / 100));
    if (clamped === viewZoom) return;
    viewZoom = clamped;
    document.getElementById('btn-view-zoom-reset').textContent = Math.round(viewZoom * 100) + '%';
    render();
  }

  document.getElementById('btn-view-zoom-in').addEventListener('click', () => {
    setViewZoom(viewZoom + VIEW_ZOOM_STEP);
  });
  document.getElementById('btn-view-zoom-out').addEventListener('click', () => {
    setViewZoom(viewZoom - VIEW_ZOOM_STEP);
  });
  document.getElementById('btn-view-zoom-reset').addEventListener('click', () => {
    setViewZoom(DEF_VIEW_ZOOM);
  });

  /* ── Toolbar buttons ── */
  document.getElementById('btn-add-task').addEventListener('click', () => {
    if (!ganttData || !ganttData.sections.length) return;
    // 選択中セクションに追加。タスクが選択中ならその直後、なければ末尾。
    // 選択が無ければ従来どおり先頭セクション末尾。
    let si = 0;
    let afterTi = -1;
    if (selected && ganttData.sections[selected.si]) {
      si = selected.si;
      afterTi = selected.ti >= 0 ? selected.ti : ganttData.sections[si].tasks.length - 1;
    } else {
      afterTi = ganttData.sections[si].tasks.length - 1;
    }
    addTask(si, afterTi);
  });

  document.getElementById('btn-add-section').addEventListener('click', () => {
    if (!ganttData) return;
    // 選択中セクションの直後に挿入。選択が無ければ末尾。
    const insertAt = (selected && ganttData.sections[selected.si])
      ? selected.si + 1
      : ganttData.sections.length;
    addSection('新しいセクション', insertAt);
  });

  document.getElementById('btn-undo').addEventListener('click', () => {
    if (!ganttData) return;
    undo();
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    if (!ganttData) return;
    pxPerDay = DEF_PPD;
    autoFitPpd = false;
    render();
    scrollToToday();
  });

  document.getElementById('btn-init-gantt').addEventListener('click', () => {
    vscode.postMessage({ type: 'initGantt' });
  });

  const btnSwitchFlow = document.getElementById('btn-switch-flow');
  if (btnSwitchFlow) {
    btnSwitchFlow.addEventListener('click', () => {
      vscode.postMessage({ type: 'switchType', diagramType: 'flowchart' });
    });
  }

  document.getElementById('sel-axis-format').addEventListener('change', e => {
    if (!ganttData) return;
    const val = e.target.value;
    pushUndo();
    if (val) ganttData.axisFormat = val;
    else delete ganttData.axisFormat;
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
  });

  document.getElementById('chk-exclude-weekends').addEventListener('change', e => {
    if (!ganttData) return;
    pushUndo();
    const set = new Set(ganttData.excludes || []);
    if (e.target.checked) {
      set.add('weekends');
    } else {
      for (const tok of Array.from(set)) {
        if (tok.trim().toLowerCase() === 'weekends') set.delete(tok);
      }
    }
    const next = Array.from(set);
    if (next.length > 0) ganttData.excludes = next;
    else delete ganttData.excludes;
    vscode.postMessage({ type: 'structuralEdit', gantt: ganttData });
    render();
  });

  /* ── Ready ── */
  vscode.postMessage({ type: 'ready' });
})();
