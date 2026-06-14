import * as vscode from 'vscode';
import { parseFlowchart } from './flowchartParser';
import {
  setDirection, editNodeLabel, addNode, deleteNode,
  addEdge, editEdgeLabel, deleteEdge, changeEdgeStyle, applyToDocument,
  changeNodeShape,
} from './flowchartSerializer';
import { FlowWebToExt } from './types';

export class FlowchartPanel {
  static currentPanel: FlowchartPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _document: vscode.TextDocument;
  private _disposables: vscode.Disposable[] = [];
  private _isOperating = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _applyQueue: Promise<void> = Promise.resolve();

  static createOrShow(extensionUri: vscode.Uri, doc: vscode.TextDocument): void {
    if (FlowchartPanel.currentPanel) {
      FlowchartPanel.currentPanel._panel.reveal(vscode.ViewColumn.Beside);
      FlowchartPanel.currentPanel._document = doc;
      FlowchartPanel.currentPanel._sendUpdate();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'flowchartEditor',
      'フローチャート エディタ',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true,
      }
    );
    FlowchartPanel.currentPanel = new FlowchartPanel(panel, extensionUri, doc);
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
      async (msg: FlowWebToExt) => {
        switch (msg.type) {
          case 'ready':         this._sendUpdate(); break;
          case 'initFlowchart': await this._initFlowchart(); break;
          case 'editNode':      await this._applyOp(c => editNodeLabel(c, msg.nodeId, msg.label)); break;
          case 'addNode':       await this._applyAddNode(); break;
          case 'deleteNode':      await this._applyOp(c => deleteNode(c, msg.nodeId)); break;
          case 'changeNodeShape': await this._applyOp(c => changeNodeShape(c, msg.nodeId, msg.shape)); break;
          case 'addEdge':         await this._applyOp(c => addEdge(c, msg.from, msg.to)); break;
          case 'editEdge':      await this._applyOp(c => editEdgeLabel(c, msg.from, msg.to, msg.idx, msg.label)); break;
          case 'deleteEdge':       await this._applyOp(c => deleteEdge(c, msg.from, msg.to, msg.idx)); break;
          case 'changeEdgeStyle': await this._applyOp(c => changeEdgeStyle(c, msg.from, msg.to, msg.idx, msg.style)); break;
          case 'changeDirection': await this._applyOp(c => setDirection(c, msg.direction)); break;
          case 'undo':          await this._applyRaw(msg.code); break;
          case 'save':          await this._document.save(); this._panel.webview.postMessage({ type: 'saved' }); break;
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
    const text = this._document.getText();
    const isDark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light;
    const data = parseFlowchart(text);
    if (!data) {
      // mermaid ブロック内に flowchart/graph キーワードがあるのに解析できない場合は構文エラー扱い
      const blockMatch = text.match(/```mermaid[ \t]*\n([\s\S]*?)```/);
      const hasFlowchartKeyword = blockMatch && /^(flowchart|graph)\b/im.test(blockMatch[1]);
      if (hasFlowchartKeyword) {
        this._panel.webview.postMessage({
          type: 'parseError',
          message: 'フローチャートの構文エラー: `flowchart TD` / `graph LR` のように方向（TD/LR/BT/RL）を指定してください。',
        });
      } else {
        this._panel.webview.postMessage({ type: 'empty' });
      }
      return;
    }
    const rawCode = this._extractRawCode(text);
    this._panel.webview.postMessage({ type: 'update', rawCode, isDark });
  }

  private _extractRawCode(docText: string): string {
    const blockMatch = docText.match(/```mermaid\s*\n([\s\S]*?)```/);
    if (blockMatch && /^(flowchart|graph)\s+/im.test(blockMatch[1])) {
      return blockMatch[1].trim();
    }
    return docText.trim();
  }

  private async _applyOp(transform: (code: string) => string): Promise<void> {
    const text = this._document.getText();
    const rawCode = this._extractRawCode(text);
    const newRawCode = transform(rawCode);
    if (newRawCode === rawCode) return;
    const newDocText = applyToDocument(text, this._document.fileName, newRawCode);
    await this._writeDoc(newDocText);
  }

  private async _applyAddNode(): Promise<void> {
    const text = this._document.getText();
    const rawCode = this._extractRawCode(text);
    const { code: newRawCode, nodeId } = addNode(rawCode);
    const newDocText = applyToDocument(text, this._document.fileName, newRawCode);
    await this._writeDoc(newDocText);
    this._panel.webview.postMessage({ type: 'startEditNode', nodeId });
  }

  private async _applyRaw(newRawCode: string): Promise<void> {
    const text = this._document.getText();
    const newDocText = applyToDocument(text, this._document.fileName, newRawCode);
    await this._writeDoc(newDocText);
  }

  private _writeDoc(newDocText: string): void {
    this._applyQueue = this._applyQueue
      .then(() => this._doWrite(newDocText))
      .catch(() => { /* keep queue alive */ });
  }

  private async _doWrite(newDocText: string): Promise<void> {
    this._isOperating = true;
    try {
      const docText = this._document.getText();
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

  private async _initFlowchart(): Promise<void> {
    const template =
      '```mermaid\n' +
      'flowchart TD\n' +
      '    A[開始] --> B{条件}\n' +
      '    B -->|はい| C[処理A]\n' +
      '    B -->|いいえ| D[終了]\n' +
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
      vscode.window.showErrorMessage('フローチャートの挿入に失敗しました。');
      return;
    } finally {
      this._isOperating = false;
    }
    this._sendUpdate();
  }

  private _buildHtml(): string {
    const wv = this._panel.webview;
    const nonce = nonce32();
    const uri = (f: string) => wv.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', f));

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src ${wv.cspSource} 'unsafe-inline';">
  <link rel="stylesheet" href="${uri('flowchart.css')}">
</head>
<body>
  <div id="toolbar">
    <button id="btn-add-node">＋ ノード追加</button>
    <button id="btn-undo">↩ 元に戻す</button>
    <button id="btn-fit">⊡ 全体表示</button>
    <span class="toolbar-sep"></span>
    <label class="toolbar-label" for="sel-direction">方向</label>
    <select id="sel-direction">
      <option value="TD">上→下 (TD)</option>
      <option value="LR">左→右 (LR)</option>
      <option value="BT">下→上 (BT)</option>
      <option value="RL">右→左 (RL)</option>
    </select>
    <span id="status-label"></span>
  </div>
  <div id="canvas-wrap">
    <div id="canvas">
      <div id="mermaid-container"></div>
    </div>
    <div id="error-panel"></div>
  </div>
  <div id="empty-overlay">
    <p>フローチャートが見つかりません</p>
    <button id="btn-init-flowchart">＋ フローチャートを挿入</button>
  </div>
  <div id="fc-edit-overlay">
    <input id="fc-edit-input" type="text">
  </div>
  <svg id="drag-edge-svg" xmlns="http://www.w3.org/2000/svg">
    <line id="drag-edge-line"></line>
  </svg>
  <script nonce="${nonce}" src="${uri('mermaid.min.js')}"></script>
  <script nonce="${nonce}" src="${uri('flowchart.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    FlowchartPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}

function nonce32(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
