import * as vscode from 'vscode';
import { EditorPanel } from './editorPanel';

export function activate(context: vscode.ExtensionContext): void {
  const openEditor = (uri: vscode.Uri | undefined, type: 'gantt' | 'flowchart') => {
    if (uri) {
      vscode.workspace.openTextDocument(uri).then(doc => {
        EditorPanel.createOrShow(context.extensionUri, doc, type);
      });
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('まず .mmd または .md ファイルを開いてください。');
      return;
    }
    const lang = editor.document.languageId;
    if (lang !== 'mermaid' && lang !== 'markdown') {
      vscode.window.showErrorMessage('エディタは .mmd または .md ファイルにのみ対応しています。');
      return;
    }
    EditorPanel.createOrShow(context.extensionUri, editor.document, type);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('mermaid.openGantt', (uri?: vscode.Uri) =>
      openEditor(uri, 'gantt')
    ),
    vscode.commands.registerCommand('mermaid.openFlowchart', (uri?: vscode.Uri) =>
      openEditor(uri, 'flowchart')
    )
  );
}

export function deactivate(): void {}
