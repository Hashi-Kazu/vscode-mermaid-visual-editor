import * as vscode from 'vscode';
import { GanttPanel } from './ganttPanel';

export function activate(context: vscode.ExtensionContext): void {
  const ganttCmd = vscode.commands.registerCommand(
    'mermaid.openGantt',
    (uri?: vscode.Uri) => {
      if (uri) {
        vscode.workspace.openTextDocument(uri).then(doc => {
          GanttPanel.createOrShow(context.extensionUri, doc);
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
        vscode.window.showErrorMessage('Ganttエディタは .mmd または .md ファイルにのみ対応しています。');
        return;
      }
      GanttPanel.createOrShow(context.extensionUri, editor.document);
    }
  );

  context.subscriptions.push(ganttCmd);
}

export function deactivate(): void {}
