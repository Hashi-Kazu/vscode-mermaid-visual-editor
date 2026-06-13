import * as vscode from 'vscode';
import { ExtensionToWebview, WebviewToExtension } from './types';

export class MermaidPanel {
  static currentPanel: MermaidPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _document: vscode.TextDocument;
  private _disposables: vscode.Disposable[] = [];

  static createOrShow(extensionUri: vscode.Uri, doc: vscode.TextDocument): void {
    if (MermaidPanel.currentPanel) {
      MermaidPanel.currentPanel._panel.reveal(vscode.ViewColumn.Beside);
      MermaidPanel.currentPanel._document = doc;
      MermaidPanel.currentPanel._sendRender();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'mermaidPreview',
      'Mermaid プレビュー',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );
    MermaidPanel.currentPanel = new MermaidPanel(panel, extensionUri, doc);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    doc: vscode.TextDocument
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._document = doc;

    this._panel.webview.html = this._getHtml();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (msg: WebviewToExtension) => {
        if (msg.type === 'ready') {
          this._sendRender();
        }
      },
      null,
      this._disposables
    );

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (e.document.uri.toString() !== this._document.uri.toString()) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => this._sendRender(), 500);
      },
      null,
      this._disposables
    );
  }

  private _sendRender(): void {
    const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
      ? 'dark'
      : 'default';
    const msg: ExtensionToWebview = {
      type: 'render',
      code: this._document.getText(),
      theme,
    };
    this._panel.webview.postMessage(msg);
  }

  private _getHtml(): string {
    const webview = this._panel.webview;
    const nonce = getNonce();
    const mermaidUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'mermaid.min.js')
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'preview.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'preview.js')
    );

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src ${webview.cspSource} 'unsafe-inline';">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div id="toolbar">
    <button id="btn-fit" title="フィット表示 (F)">⊡ Fit</button>
    <button id="btn-reset" title="等倍表示">100%</button>
    <button id="btn-export-svg" title="SVGエクスポート">SVG</button>
    <button id="btn-export-png" title="PNGエクスポート">PNG</button>
    <span id="zoom-label"></span>
  </div>
  <div id="canvas">
    <div id="diagram"></div>
  </div>
  <div id="error-panel" style="display:none"></div>
  <script nonce="${nonce}" src="${mermaidUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    MermaidPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach((d) => d.dispose());
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
