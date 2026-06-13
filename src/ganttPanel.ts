import * as vscode from 'vscode';
import { parseGantt } from './ganttParser';
import { ganttToCode, applyToDocument } from './ganttSerializer';
import { GanttData, GanttTask, WebToExt } from './types';

export class GanttPanel {
  static currentPanel: GanttPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _document: vscode.TextDocument;
  private _disposables: vscode.Disposable[] = [];
  private _isOperating = false;
  private _currentData: GanttData | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _applyQueue: Promise<void> = Promise.resolve();

  static createOrShow(extensionUri: vscode.Uri, doc: vscode.TextDocument): void {
    if (GanttPanel.currentPanel) {
      GanttPanel.currentPanel._panel.reveal(vscode.ViewColumn.Beside);
      GanttPanel.currentPanel._document = doc;
      GanttPanel.currentPanel._sendUpdate();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'ganttEditor',
      'Gantt エディタ',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true,
      }
    );
    GanttPanel.currentPanel = new GanttPanel(panel, extensionUri, doc);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    doc: vscode.TextDocument
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._document = doc;

    this._panel.webview.html = this._buildHtml();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (msg: WebToExt) => {
        switch (msg.type) {
          case 'ready':
            this._sendUpdate();
            break;
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
            this._currentData = msg.gantt;
            this._applyData(msg.gantt);
            break;
          case 'save':
            await this._document.save();
            this._panel.webview.postMessage({ type: 'saved' });
            break;
        }
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

  private _sendUpdate(): void {
    const data = parseGantt(this._document.getText());
    if (!data) {
      this._panel.webview.postMessage({ type: 'empty' });
      return;
    }
    this._currentData = data;
    this._panel.webview.postMessage({ type: 'update', gantt: data });
  }

  private async _editTask(si: number, ti: number, patch: Partial<GanttTask>): Promise<void> {
    if (!this._currentData) return;
    const task = this._currentData.sections[si]?.tasks[ti];
    if (!task) return;
    Object.assign(task, patch);
    await this._applyData(this._currentData);
  }

  private async _addTask(si: number, afterTi: number, task: GanttTask): Promise<void> {
    if (!this._currentData) return;
    this._currentData.sections[si]?.tasks.splice(afterTi + 1, 0, task);
    await this._applyData(this._currentData);
  }

  private async _deleteTask(si: number, ti: number): Promise<void> {
    if (!this._currentData) return;
    this._currentData.sections[si]?.tasks.splice(ti, 1);
    await this._applyData(this._currentData);
  }

  private async _editSection(si: number, name: string): Promise<void> {
    if (!this._currentData) return;
    const sec = this._currentData.sections[si];
    if (!sec) return;
    sec.name = name;
    await this._applyData(this._currentData);
  }

  private async _addSection(name: string): Promise<void> {
    if (!this._currentData) return;
    this._currentData.sections.push({ name, tasks: [] });
    await this._applyData(this._currentData);
  }

  private _applyData(data: GanttData): void {
    this._applyQueue = this._applyQueue
      .then(() => this._doApplyData(data))
      .catch(() => { /* keep queue alive on error */ });
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

    const docText = this._document.getText();
    const newText = docText.trim() === '' ? template : docText + '\n\n' + template;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this._document.uri,
      new vscode.Range(this._document.positionAt(0), this._document.positionAt(docText.length)),
      newText
    );

    this._isOperating = true;
    try {
      await vscode.workspace.applyEdit(edit);
      await this._document.save();
    } catch {
      vscode.window.showErrorMessage('ガントチャートの挿入に失敗しました。');
      return;
    } finally {
      this._isOperating = false;
    }
    this._sendUpdate();
  }

  private async _doApplyData(data: GanttData): Promise<void> {
    this._isOperating = true;
    try {
      const newCode = ganttToCode(data);
      const docText = this._document.getText();
      const newDocText = applyToDocument(docText, this._document.fileName, newCode);

      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        this._document.positionAt(0),
        this._document.positionAt(docText.length)
      );
      edit.replace(this._document.uri, fullRange, newDocText);
      await vscode.workspace.applyEdit(edit);
      await this._document.save();
      this._panel.webview.postMessage({ type: 'saved' });
    } finally {
      this._isOperating = false;
    }
  }

  private _buildHtml(): string {
    const wv = this._panel.webview;
    const nonce = nonce32();
    const uri = (f: string) =>
      wv.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', f));

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src ${wv.cspSource} 'unsafe-inline';">
  <link rel="stylesheet" href="${uri('gantt.css')}">
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

  dispose(): void {
    GanttPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}

function nonce32(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
