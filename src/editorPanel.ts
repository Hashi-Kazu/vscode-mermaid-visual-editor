import * as vscode from 'vscode';
import { parseGantt } from './ganttParser';
import { ganttToCode, applyToDocument as ganttApply } from './ganttSerializer';
import { parseFlowchart } from './flowchartParser';
import {
  setDirection, editNodeLabel, addNode, deleteNode,
  addEdge, editEdgeLabel, deleteEdge, applyToDocument as flowApply,
} from './flowchartSerializer';
import { GanttData, GanttTask, WebToExt, FlowWebToExt } from './types';

export type DiagramType = 'gantt' | 'flowchart';

function detectType(text: string): DiagramType | null {
  if (/```mermaid\s*\n\s*gantt\b/im.test(text)) return 'gantt';
  if (/```mermaid\s*\n\s*(flowchart|graph)\s+/im.test(text)) return 'flowchart';
  if (/^gantt\b/im.test(text.trim())) return 'gantt';
  if (/^(flowchart|graph)\s+/im.test(text.trim())) return 'flowchart';
  return null;
}

export class EditorPanel {
  static currentPanel: EditorPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _document: vscode.TextDocument;
  private _disposables: vscode.Disposable[] = [];
  private _type: DiagramType | null = null;
  private _isOperating = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _applyQueue: Promise<void> = Promise.resolve();

  // Gantt-specific state
  private _ganttData: GanttData | null = null;

  static createOrShow(
    extensionUri: vscode.Uri,
    doc: vscode.TextDocument,
    preferredType?: DiagramType
  ): void {
    const type = preferredType ?? detectType(doc.getText());

    if (EditorPanel.currentPanel) {
      const ep = EditorPanel.currentPanel;
      ep._document = doc;
      ep._panel.reveal(vscode.ViewColumn.Beside);

      if (type && type !== ep._type) {
        ep._type = type;
        ep._panel.webview.html = ep._buildHtml();
        // 'ready' message will trigger _sendUpdate
      } else {
        if (!ep._type) ep._type = type;
        ep._sendUpdate();
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'mermaidEditor',
      'Mermaid エディタ',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true,
      }
    );

    EditorPanel.currentPanel = new EditorPanel(panel, extensionUri, doc, type);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    doc: vscode.TextDocument,
    type: DiagramType | null
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._document = doc;
    this._type = type;

    this._panel.webview.html = this._buildHtml();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (msg: WebToExt | FlowWebToExt | { type: 'switchType'; diagramType: DiagramType }) => {
        await this._handleMessage(msg as never);
      },
      null,
      this._disposables
    );

    vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (this._isOperating) return;
        if (e.document.uri.toString() !== this._document.uri.toString()) return;
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this._sendUpdate(), 500);
      },
      null,
      this._disposables
    );
  }

  // ── Message routing ──────────────────────────────────────────────────────

  private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
    if (msg.type === 'ready') {
      this._sendUpdate();
      return;
    }
    if (msg.type === 'switchType') {
      const newType = msg.diagramType as DiagramType;
      if (newType !== this._type) {
        this._type = newType;
        this._panel.webview.html = this._buildHtml();
      }
      return;
    }

    if (this._type === 'gantt') {
      await this._handleGantt(msg as unknown as WebToExt);
    } else if (this._type === 'flowchart') {
      await this._handleFlowchart(msg as unknown as FlowWebToExt);
    }
  }

  // ── Gantt handling ───────────────────────────────────────────────────────

  private async _handleGantt(msg: WebToExt): Promise<void> {
    switch (msg.type) {
      case 'initGantt':
        await this._initGantt();
        break;
      case 'editTask':
        await this._editTask(msg.si, msg.ti, msg.patch);
        break;
      case 'addTask':
        await this._addTask(msg.si, msg.afterTi, msg.task);
        break;
      case 'deleteTask':
        await this._deleteTask(msg.si, msg.ti);
        break;
      case 'editSection':
        await this._editSection(msg.si, msg.name);
        break;
      case 'addSection':
        await this._addSection(msg.name);
        break;
      case 'structuralEdit':
        this._ganttData = msg.gantt;
        this._applyGanttData(msg.gantt);
        break;
      case 'save':
        await this._document.save();
        this._panel.webview.postMessage({ type: 'saved' });
        break;
    }
  }

  private _sendGanttUpdate(): void {
    const data = parseGantt(this._document.getText());
    if (!data) {
      this._panel.webview.postMessage({ type: 'empty' });
      return;
    }
    this._ganttData = data;
    this._panel.webview.postMessage({ type: 'update', gantt: data });
  }

  private async _editTask(si: number, ti: number, patch: Partial<GanttTask>): Promise<void> {
    if (!this._ganttData) return;
    const task = this._ganttData.sections[si]?.tasks[ti];
    if (!task) return;
    Object.assign(task, patch);
    await this._applyGanttData(this._ganttData);
  }

  private async _addTask(si: number, afterTi: number, task: GanttTask): Promise<void> {
    if (!this._ganttData) return;
    this._ganttData.sections[si]?.tasks.splice(afterTi + 1, 0, task);
    await this._applyGanttData(this._ganttData);
  }

  private async _deleteTask(si: number, ti: number): Promise<void> {
    if (!this._ganttData) return;
    this._ganttData.sections[si]?.tasks.splice(ti, 1);
    await this._applyGanttData(this._ganttData);
  }

  private async _editSection(si: number, name: string): Promise<void> {
    if (!this._ganttData) return;
    const sec = this._ganttData.sections[si];
    if (!sec) return;
    sec.name = name;
    await this._applyGanttData(this._ganttData);
  }

  private async _addSection(name: string): Promise<void> {
    if (!this._ganttData) return;
    this._ganttData.sections.push({ name, tasks: [] });
    await this._applyGanttData(this._ganttData);
  }

  private _applyGanttData(data: GanttData): void {
    this._applyQueue = this._applyQueue
      .then(() => this._doApplyGanttData(data))
      .catch(() => { /* keep queue alive */ });
  }

  private async _doApplyGanttData(data: GanttData): Promise<void> {
    this._isOperating = true;
    try {
      const newCode = ganttToCode(data);
      const docText = this._document.getText();
      const newDocText = ganttApply(docText, this._document.fileName, newCode);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        this._document.uri,
        new vscode.Range(
          this._document.positionAt(0),
          this._document.positionAt(docText.length)
        ),
        newDocText
      );
      const ok = await vscode.workspace.applyEdit(edit);
      if (ok) {
        await this._document.save();
        this._panel.webview.postMessage({ type: 'saved' });
      }
    } finally {
      this._isOperating = false;
    }
  }

  private async _initGantt(): Promise<void> {
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const start = fmt(today);

    const template =
      '```mermaid\n' +
      'gantt\n' +
      '    title プロジェクトスケジュール\n' +
      '    dateFormat YYYY-MM-DD\n' +
      '\n' +
      '    section フェーズ1\n' +
      `        タスク1 :task1, ${start}, 7d\n` +
      '        タスク2 :task2, after task1, 7d\n' +
      '```';

    await this._insertTemplate(template, 'ガントチャートの挿入に失敗しました。');
  }

  // ── Flowchart handling ───────────────────────────────────────────────────

  private async _handleFlowchart(msg: FlowWebToExt): Promise<void> {
    switch (msg.type) {
      case 'initFlowchart': await this._initFlowchart(); break;
      case 'editNode':   await this._flowOp(c => editNodeLabel(c, msg.nodeId, msg.label)); break;
      case 'addNode':    await this._addFlowNode(); break;
      case 'deleteNode': await this._flowOp(c => deleteNode(c, msg.nodeId)); break;
      case 'addEdge':    await this._flowOp(c => addEdge(c, msg.from, msg.to)); break;
      case 'editEdge':   await this._flowOp(c => editEdgeLabel(c, msg.from, msg.to, msg.idx, msg.label)); break;
      case 'deleteEdge': await this._flowOp(c => deleteEdge(c, msg.from, msg.to, msg.idx)); break;
      case 'setDirection': await this._flowOp(c => setDirection(c, msg.direction)); break;
      case 'undo':       await this._applyFlowRaw(msg.code); break;
      case 'save':
        await this._document.save();
        this._panel.webview.postMessage({ type: 'saved' });
        break;
    }
  }

  private _sendFlowchartUpdate(): void {
    const text = this._document.getText();
    const data = parseFlowchart(text);
    const isDark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light;
    if (!data) {
      this._panel.webview.postMessage({ type: 'empty' });
      return;
    }
    const rawCode = this._extractRawCode(text);
    this._panel.webview.postMessage({ type: 'update', rawCode, isDark });
  }

  private _extractRawCode(docText: string): string {
    const m = docText.match(/```mermaid\s*\n([\s\S]*?)```/);
    if (m && /^(flowchart|graph)\s+/im.test(m[1])) return m[1].trim();
    return docText.trim();
  }

  private async _flowOp(transform: (code: string) => string): Promise<void> {
    const text = this._document.getText();
    const rawCode = this._extractRawCode(text);
    const newRaw = transform(rawCode);
    if (newRaw === rawCode) return;
    const newDoc = flowApply(text, this._document.fileName, newRaw);
    this._enqueueWrite(newDoc);
  }

  private async _addFlowNode(): Promise<void> {
    const text = this._document.getText();
    const rawCode = this._extractRawCode(text);
    const { code: newRaw, nodeId } = addNode(rawCode);
    const newDoc = flowApply(text, this._document.fileName, newRaw);
    this._enqueueWrite(newDoc);
    this._panel.webview.postMessage({ type: 'startEditNode', nodeId });
  }

  private async _applyFlowRaw(newRaw: string): Promise<void> {
    const text = this._document.getText();
    const newDoc = flowApply(text, this._document.fileName, newRaw);
    this._enqueueWrite(newDoc);
  }

  private async _initFlowchart(): Promise<void> {
    const template =
      '```mermaid\n' +
      'flowchart TD\n' +
      '    A[開始] --> B{条件}\n' +
      '    B -->|はい| C[処理A]\n' +
      '    B -->|いいえ| D[終了]\n' +
      '```';

    await this._insertTemplate(template, 'フローチャートの挿入に失敗しました。');
  }

  // ── Shared update dispatcher ─────────────────────────────────────────────

  private _sendUpdate(): void {
    // Auto-detect type from document if not yet set
    if (!this._type) {
      const detected = detectType(this._document.getText());
      if (detected) {
        this._type = detected;
        this._panel.webview.html = this._buildHtml();
        return; // rebuild triggers 'ready' → sendUpdate again
      }
    }

    if (this._type === 'gantt') {
      this._sendGanttUpdate();
    } else if (this._type === 'flowchart') {
      this._sendFlowchartUpdate();
    } else {
      this._panel.webview.postMessage({ type: 'empty' });
    }
  }

  // ── Write helpers ─────────────────────────────────────────────────────────

  private async _insertTemplate(template: string, errMsg: string): Promise<void> {
    const docText = this._document.getText();
    const newText = docText.trim() === '' ? template : docText + '\n\n' + template;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this._document.uri,
      new vscode.Range(
        this._document.positionAt(0),
        this._document.positionAt(docText.length)
      ),
      newText
    );

    this._isOperating = true;
    try {
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        vscode.window.showErrorMessage(errMsg);
        return;
      }
      await this._document.save();
    } catch {
      vscode.window.showErrorMessage(errMsg);
      return;
    } finally {
      this._isOperating = false;
    }
    this._sendUpdate();
  }

  private _enqueueWrite(newDocText: string): void {
    this._applyQueue = this._applyQueue
      .then(() => this._doWrite(newDocText))
      .catch(() => { /* keep queue alive */ });
  }

  private async _doWrite(newDocText: string): Promise<void> {
    this._isOperating = true;
    try {
      const docText = this._document.getText();
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        this._document.uri,
        new vscode.Range(
          this._document.positionAt(0),
          this._document.positionAt(docText.length)
        ),
        newDocText
      );
      const ok = await vscode.workspace.applyEdit(edit);
      if (ok) {
        await this._document.save();
        this._panel.webview.postMessage({ type: 'saved' });
      }
    } finally {
      this._isOperating = false;
    }
    // Flowchart: after write, send updated rawCode so webview re-renders
    if (this._type === 'flowchart') {
      this._sendFlowchartUpdate();
    }
  }

  // ── HTML builders ─────────────────────────────────────────────────────────

  private _buildHtml(): string {
    if (this._type === 'gantt') return this._buildGanttHtml();
    if (this._type === 'flowchart') return this._buildFlowchartHtml();
    return this._buildSelectorHtml();
  }

  private _buildGanttHtml(): string {
    const wv = this._panel.webview;
    const nonce = nonce32();
    const uri = (f: string) => wv.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', f));

    this._panel.title = 'Gantt エディタ';
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src ${wv.cspSource} 'unsafe-inline';">
  <link rel="stylesheet" href="${uri('gantt.css')}">
  <style>
    .mode-badge {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex; align-items: center; gap: 6px;
      margin-left: 8px;
    }
    .mode-badge button {
      font-size: 11px; padding: 2px 8px;
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <button id="btn-add-task">＋ タスク追加</button>
    <button id="btn-add-section">＋ セクション追加</button>
    <button id="btn-undo">↩ 元に戻す</button>
    <button id="btn-reset">⟳ リセット</button>
    <span class="toolbar-sep"></span>
    <label class="toolbar-label" for="sel-axis-format">軸書式</label>
    <select id="sel-axis-format" disabled>
      <option value="">デフォルト</option>
      <option value="%Y/%m">年/月</option>
      <option value="%m/%d">月/日</option>
      <option value="%Y-%m-%d">年-月-日</option>
      <option value="%m-%d">月-日</option>
    </select>
    <span id="status-label"></span>
    <span class="mode-badge">
      <span>Gantt</span>
      <button id="btn-switch-flow" title="フローチャートエディタへ切り替え">↔ フローチャート</button>
    </span>
  </div>
  <div id="scroll-container" tabindex="0">
    <div id="gantt-grid"></div>
  </div>
  <div id="empty-overlay">
    <p>ガントチャートが見つかりません</p>
    <button id="btn-init-gantt">＋ ガントチャートを挿入</button>
  </div>
  <script nonce="${nonce}" src="${uri('gantt.js')}"></script>
</body>
</html>`;
  }

  private _buildFlowchartHtml(): string {
    const wv = this._panel.webview;
    const nonce = nonce32();
    const uri = (f: string) => wv.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', f));

    this._panel.title = 'フローチャート エディタ';
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}' 'unsafe-eval';
             style-src ${wv.cspSource} 'unsafe-inline';
             img-src data: blob:;
             font-src data:;">
  <link rel="stylesheet" href="${uri('flowchart.css')}">
  <style>
    .mode-badge {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex; align-items: center; gap: 6px;
      margin-left: 8px;
    }
    .mode-badge button {
      font-size: 11px; padding: 2px 8px;
    }
  </style>
</head>
<body>
  <div id="toolbar">
    <button id="btn-add-node">＋ ノード追加</button>
    <button id="btn-undo">↩ 元に戻す</button>
    <button id="btn-fit">⊡ 全体表示</button>
    <span class="toolbar-sep"></span>
    <label class="toolbar-label" for="sel-direction">方向</label>
    <select id="sel-direction" disabled>
      <option value="TD">上→下 (TD)</option>
      <option value="LR">左→右 (LR)</option>
      <option value="BT">下→上 (BT)</option>
      <option value="RL">右→左 (RL)</option>
    </select>
    <span id="status-label"></span>
    <span class="mode-badge">
      <span>フローチャート</span>
      <button id="btn-switch-gantt" title="Ganttエディタへ切り替え">↔ Gantt</button>
    </span>
  </div>
  <div id="canvas-wrap">
    <div id="canvas">
      <div id="mermaid-container"></div>
    </div>
  </div>
  <div id="empty-overlay">
    <p>フローチャートが見つかりません</p>
    <button id="btn-init-flowchart">＋ フローチャートを挿入</button>
  </div>
  <div id="error-panel"></div>
  <div id="fc-edit-overlay"><input id="fc-edit-input" type="text"></div>
  <svg id="drag-edge-svg"><line id="drag-edge-line"/></svg>
  <script nonce="${nonce}" src="${uri('mermaid.min.js')}"></script>
  <script nonce="${nonce}" src="${uri('flowchart.js')}"></script>
</body>
</html>`;
  }

  private _buildSelectorHtml(): string {
    const wv = this._panel.webview;
    const nonce = nonce32();

    this._panel.title = 'Mermaid エディタ';
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src ${wv.cspSource} 'unsafe-inline';">
  <style>
    body {
      margin: 0; padding: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      height: 100vh;
      display: flex; align-items: center; justify-content: center;
    }
    .selector { display: flex; flex-direction: column; align-items: center; gap: 16px; }
    .selector p { margin: 0; color: var(--vscode-descriptionForeground); font-size: 13px; }
    .selector-buttons { display: flex; gap: 12px; }
    .selector-buttons button {
      padding: 8px 24px; font-size: 13px; cursor: pointer;
      border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }
    .selector-buttons button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div class="selector">
    <p>編集するダイアグラムの種類を選択してください</p>
    <div class="selector-buttons">
      <button id="btn-gantt">📊 Gantt チャート</button>
      <button id="btn-flowchart">🔀 フローチャート</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('btn-gantt').addEventListener('click', function() {
      vscode.postMessage({ type: 'switchType', diagramType: 'gantt' });
    });
    document.getElementById('btn-flowchart').addEventListener('click', function() {
      vscode.postMessage({ type: 'switchType', diagramType: 'flowchart' });
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    EditorPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}

function nonce32(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
