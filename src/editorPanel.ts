import * as vscode from 'vscode';
import * as path from 'path';
import { parseGantt } from './ganttParser';
import { ganttToCode, applyToDocument as ganttApply } from './ganttSerializer';
import { parseFlowchart } from './flowchartParser';
import { detectConflict, normalizeText } from './conflictDetection';
import {
  setDirection, editNodeLabel, addNode, deleteNode,
  addEdge, editEdgeLabel, deleteEdge, changeEdgeStyle, changeNodeShape,
  applyToDocument as flowApply,
} from './flowchartSerializer';
import { GanttData, GanttTask, WebToExt, FlowWebToExt } from './types';
import { exportDefaultPath, exportEncoding } from './svgExport';
import { backupTimestamp, backupFileName } from './backupNaming';

export type DiagramType = 'gantt' | 'flowchart';

function detectType(text: string): DiagramType | null {
  if (/```mermaid\s*\n\s*gantt\b/im.test(text)) return 'gantt';
  if (/```mermaid\s*\n\s*(flowchart|graph)\s+/im.test(text)) return 'flowchart';
  if (/^gantt\b/im.test(text.trim())) return 'gantt';
  if (/^(flowchart|graph)\s+/im.test(text.trim())) return 'flowchart';
  return null;
}

function isSupportedDocument(doc: vscode.TextDocument): boolean {
  return (doc.languageId === 'markdown' || doc.languageId === 'mermaid')
    && detectType(doc.getText()) !== null;
}

export class EditorPanel {
  static currentPanel: EditorPanel | undefined;
  private static _pendingViewerFocusRestore = false;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _document: vscode.TextDocument;
  private _disposables: vscode.Disposable[] = [];
  private _type: DiagramType | null = null;
  private _isOperating = false;
  private _isSwitchPending = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _applyQueue: Promise<void> = Promise.resolve();
  private _documentOperationQueue: Promise<void> = Promise.resolve();
  private _switchQueue: Promise<void> = Promise.resolve();
  private _switchRequestId = 0;
  private _documentGeneration = 0;
  private _documentChangeDisposable: vscode.Disposable | undefined;
  private _wasActive = false;
  private _restoreFocusAfterNextUpdate = false;

  // The exact document text (newline-normalized) the current displayed/cached
  // state was last derived from. Used as the optimistic-concurrency "base":
  // before a full-document overwrite we verify the live/disk content still
  // equals this, so a concurrent external edit (shared drive / Git pull) is
  // detected instead of being silently clobbered. null until the first sync.
  private _baseText: string | null = null;

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
      ep._panel.reveal(vscode.ViewColumn.Beside);
      ep._requestDocumentSwitch(doc, type);
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

  static takePendingViewerFocusRestore(): boolean {
    const shouldRestore = EditorPanel._pendingViewerFocusRestore;
    EditorPanel._pendingViewerFocusRestore = false;
    return shouldRestore;
  }

  static discardPendingViewerFocusRestore(): void {
    EditorPanel._pendingViewerFocusRestore = false;
  }

  static followActiveDocument(doc: vscode.TextDocument, restoreFocus = false): boolean {
    if (!EditorPanel.currentPanel || !isSupportedDocument(doc)) return false;
    const ep = EditorPanel.currentPanel;
    if (!ep._isSwitchPending && ep._document.uri.toString() === doc.uri.toString()) return false;
    ep._requestDocumentSwitch(doc, detectType(doc.getText()), restoreFocus);
    return true;
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
    this._wasActive = this._panel.active;

    this._panel.webview.html = this._buildHtml();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.onDidChangeViewState((event) => {
      const wasActive = this._wasActive;
      this._wasActive = event.webviewPanel.active;
      if (wasActive && !event.webviewPanel.active) {
        EditorPanel._pendingViewerFocusRestore = true;
      }
    }, null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (msg: WebToExt | FlowWebToExt | { type: 'switchType'; diagramType: DiagramType }) => {
        await this._handleMessage(msg as never);
      },
      null,
      this._disposables
    );

    this._bindDocumentListener();
  }

  private _bindDocumentListener(): void {
    this._documentChangeDisposable?.dispose();
    const documentUri = this._document.uri.toString();
    const generation = this._documentGeneration;
    this._documentChangeDisposable = vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (this._isOperating) return;
        if (e.document.uri.toString() !== documentUri) return;
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
          if (generation !== this._documentGeneration) return;
          if (this._document.uri.toString() !== documentUri) return;
          this._sendUpdate();
        }, 500);
      }
    );
  }

  private _requestDocumentSwitch(
    doc: vscode.TextDocument,
    type: DiagramType | null,
    restoreFocusAfterUpdate = false
  ): void {
    const requestId = ++this._switchRequestId;
    this._isSwitchPending = true;
    this._restoreFocusAfterNextUpdate = false;
    this._switchQueue = this._switchQueue
      .then(async () => {
        await this._applyQueue;
        await this._documentOperationQueue;
        if (requestId !== this._switchRequestId) return;

        clearTimeout(this._debounceTimer);
        this._debounceTimer = undefined;
        this._documentGeneration++;
        this._document = doc;
        this._type = type;
        // Both old-document queues are settled before resetting operation
        // state, so this cannot mask an in-flight write's `_isOperating`.
        this._isOperating = false;
        this._applyQueue = Promise.resolve();
        this._documentOperationQueue = Promise.resolve();
        this._baseText = null;
        this._ganttData = null;
        this._bindDocumentListener();
        this._restoreFocusAfterNextUpdate = restoreFocusAfterUpdate;
        this._panel.webview.html = this._buildHtml();
        // The rebuilt webview sends `ready`, which synchronizes the new document.
      })
      .catch(() => { /* keep switch queue alive */ })
      .finally(() => {
        if (requestId === this._switchRequestId) {
          this._isSwitchPending = false;
        }
      });
  }

  // ── Message routing ──────────────────────────────────────────────────────

  private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
    if (this._isSwitchPending) return;
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
        this._editTask(msg.si, msg.ti, msg.patch);
        break;
      case 'addTask':
        this._addTask(msg.si, msg.afterTi, msg.task);
        break;
      case 'deleteTask':
        this._deleteTask(msg.si, msg.ti);
        break;
      case 'editSection':
        this._editSection(msg.si, msg.name);
        break;
      case 'addSection':
        this._addSection(msg.name);
        break;
      case 'structuralEdit':
        this._structuralEdit(msg.gantt);
        break;
      case 'save':
        await this._saveDocument();
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

  // All gantt edits funnel through `_enqueueGantt`, which runs the cache
  // mutation AND the write inside the same serialized queue step. This is what
  // keeps index-based edits (editTask etc.) consistent: a `structuralEdit` that
  // replaces `_ganttData` can never slip in between an index edit's mutation
  // and its write, so stale (si, ti) indices can no longer hit the wrong task.

  private _editTask(si: number, ti: number, patch: Partial<GanttTask>): void {
    this._enqueueGantt(() => {
      const task = this._ganttData?.sections[si]?.tasks[ti];
      if (task) Object.assign(task, patch);
    });
  }

  private _addTask(si: number, afterTi: number, task: GanttTask): void {
    this._enqueueGantt(() => {
      this._ganttData?.sections[si]?.tasks.splice(afterTi + 1, 0, task);
    });
  }

  private _deleteTask(si: number, ti: number): void {
    this._enqueueGantt(() => {
      this._ganttData?.sections[si]?.tasks.splice(ti, 1);
    });
  }

  private _editSection(si: number, name: string): void {
    this._enqueueGantt(() => {
      const sec = this._ganttData?.sections[si];
      if (sec) sec.name = name;
    });
  }

  private _addSection(name: string): void {
    this._enqueueGantt(() => {
      this._ganttData?.sections.push({ name, tasks: [] });
    });
  }

  /**
   * Full-state edit: replace the cached gantt wholesale, then write. This is the
   * path the webview uses for every operation — it always holds the complete
   * `ganttData`, so replacing rather than index-patching the cache removes any
   * chance of stale (si, ti) indices applying to the wrong task after a reorder.
   */
  private _structuralEdit(gantt: GanttData): void {
    // `allowNullCache` because a full replacement is self-contained and must
    // proceed even if no prior cache exists yet.
    this._enqueueGantt(() => { this._ganttData = gantt; }, true);
  }

  /**
   * Serialize a cache mutation followed by a write. The mutation runs inside the
   * queue so concurrent ops can't interleave their cache changes; the write then
   * uses the freshly-mutated cache. On write failure (conflict resolved as "load
   * latest" or applyEdit false) the webview is re-synced to the document state so
   * it never silently keeps unsaved, out-of-sync content.
   */
  private _enqueueGantt(mutate: () => void, allowNullCache = false): void {
    this._applyQueue = this._applyQueue
      .then(async () => {
        if (!this._ganttData && !allowNullCache) return;
        mutate();
        if (this._ganttData) await this._doApplyGanttData(this._ganttData);
      })
      .catch(() => { /* keep queue alive */ });
  }

  private async _doApplyGanttData(data: GanttData): Promise<void> {
    const newCode = ganttToCode(data);
    const docText = this._document.getText();
    const newDocText = ganttApply(docText, this._document.fileName, newCode);
    const wrote = await this._writeDocument(newDocText);
    if (!wrote) {
      // Write abandoned (conflict "load latest") or applyEdit failed. Re-sync the
      // webview to the authoritative document so it stops showing unsaved state.
      this._sendGanttUpdate();
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
      case 'initFlowchart':    await this._initFlowchart(); break;
      case 'editNode':         await this._flowOp(c => editNodeLabel(c, msg.nodeId, msg.label)); break;
      case 'addNode':          await this._addFlowNode(); break;
      case 'deleteNode':       await this._flowOp(c => deleteNode(c, msg.nodeId)); break;
      case 'changeNodeShape':  await this._flowOp(c => changeNodeShape(c, msg.nodeId, msg.shape)); break;
      case 'addEdge':          await this._flowOp(c => addEdge(c, msg.from, msg.to, undefined, msg.style)); break;
      case 'editEdge':         await this._flowOp(c => editEdgeLabel(c, msg.from, msg.to, msg.idx, msg.label)); break;
      case 'deleteEdge':       await this._flowOp(c => deleteEdge(c, msg.from, msg.to, msg.idx)); break;
      case 'changeEdgeStyle':  await this._flowOp(c => changeEdgeStyle(c, msg.from, msg.to, msg.idx, msg.style)); break;
      case 'changeDirection':  await this._flowOp(c => setDirection(c, msg.direction)); break;
      case 'undo':             await this._applyFlowRaw(msg.code); break;
      case 'export':           await this._handleExport(msg.format, msg.data); break;
      case 'save':
        await this._saveDocument();
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

  private async _handleExport(format: 'svg' | 'png', data: string): Promise<void> {
    const defaultUri = vscode.Uri.file(exportDefaultPath(this._document.uri.fsPath, format));
    const filters = format === 'svg' ? { 'SVG Image': ['svg'] } : { 'PNG Image': ['png'] };
    const uri = await vscode.window.showSaveDialog({ defaultUri, filters });
    if (!uri) return;
    const bytes = Buffer.from(data, exportEncoding(format));
    await vscode.workspace.fs.writeFile(uri, bytes);
    vscode.window.showInformationMessage(`エクスポートしました: ${uri.fsPath}`);
  }

  private async _initFlowchart(): Promise<void> {
    // 遅延分離ポリシーに合わせ、ノードは単独宣言・エッジはID参照のみで挿入する
    const template =
      '```mermaid\n' +
      'flowchart TD\n' +
      '    A[開始]\n' +
      '    B{条件}\n' +
      '    C[処理A]\n' +
      '    D[終了]\n' +
      '    A --> B\n' +
      '    B -->|はい| C\n' +
      '    B -->|いいえ| D\n' +
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

    // Record the base snapshot the displayed state derives from, so the next
    // write can detect concurrent external edits against it. This runs on every
    // sync (ready / external change) — while an operation suppresses the sync,
    // base stays put, so a write after the operation still catches the change.
    this._baseText = normalizeText(this._document.getText());

    if (this._type === 'gantt') {
      this._sendGanttUpdate();
    } else if (this._type === 'flowchart') {
      this._sendFlowchartUpdate();
    } else {
      this._panel.webview.postMessage({ type: 'empty' });
    }
    this._restoreFocusIfRequested();
  }

  private _restoreFocusIfRequested(): void {
    if (!this._restoreFocusAfterNextUpdate) return;
    this._restoreFocusAfterNextUpdate = false;
    this._panel.reveal(this._panel.viewColumn, false);
  }

  // ── Write helpers ─────────────────────────────────────────────────────────

  private async _insertTemplate(template: string, errMsg: string): Promise<void> {
    const docText = this._document.getText();
    const newText = docText.trim() === '' ? template : docText + '\n\n' + template;

    let wrote = false;
    try {
      wrote = await this._writeDocument(newText);
    } catch {
      vscode.window.showErrorMessage(errMsg);
      return;
    }
    if (!wrote) return; // applyEdit failed, or a conflict was resolved as "load latest"
    this._sendUpdate();
  }

  private _enqueueWrite(newDocText: string): void {
    this._applyQueue = this._applyQueue
      .then(() => this._doWrite(newDocText))
      .catch(() => { /* keep queue alive */ });
  }

  private async _doWrite(newDocText: string): Promise<void> {
    await this._writeDocument(newDocText);
    // Flowchart: after write (or after a conflict reload), send the current
    // rawCode so the webview re-renders from the authoritative document state.
    if (this._type === 'flowchart') {
      this._sendFlowchartUpdate();
    }
  }

  private _runDocumentOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this._documentOperationQueue.then(async () => {
      this._isOperating = true;
      try {
        return await operation();
      } finally {
        this._isOperating = false;
      }
    });
    this._documentOperationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private _saveDocument(): Promise<boolean> {
    return this._runDocumentOperation(async () => {
      await this._refreshDocument();
      return this._document.save();
    });
  }

  // ── Optimistic concurrency control (lost-update prevention) ────────────────

  /**
   * The single full-document write primitive. Before overwriting, it verifies
   * the document has not been changed concurrently (shared drive / Git pull /
   * an external edit that arrived while `_isOperating` suppressed the sync). On
   * conflict it asks the user how to resolve, prioritizing "no silent data
   * loss". Returns true if the new content was written, false if the write was
   * abandoned (conflict resolved as "load latest") or applyEdit failed.
   */
  private _writeDocument(newDocText: string): Promise<boolean> {
    return this._runDocumentOperation(async () => {
      await this._refreshDocument();
      if (await this._hasConcurrentChange(newDocText)) {
        const proceed = await this._resolveConflict(newDocText);
        if (!proceed) return false; // user chose "load latest" — abandon this write
      }

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
      if (!ok) return false;
      await this._document.save();
      // The write succeeded — this content is now the base for the next edit.
      this._baseText = normalizeText(newDocText);
      this._panel.webview.postMessage({ type: 'saved' });
      return true;
    });
  }

  /**
   * True when the live document or the on-disk file no longer matches the base
   * snapshot the displayed state was derived from — i.e. a concurrent external
   * edit exists. The disk is read in addition to the in-memory TextDocument
   * because on shared drives VS Code's TextDocument can lag behind the file.
   */
  private async _hasConcurrentChange(outgoing: string): Promise<boolean> {
    if (this._baseText === null) return false;

    const liveText = this._document.getText();
    if (detectConflict(this._baseText, liveText, outgoing)) return true;

    let diskText: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(this._document.uri);
      diskText = Buffer.from(bytes).toString('utf8');
    } catch {
      // File missing/unreadable (e.g. deleted) — treat as no detectable
      // conflict and let the normal write path recreate it.
      return false;
    }
    return detectConflict(this._baseText, diskText, outgoing);
  }

  /**
   * Concurrent edit detected. Ask the user how to resolve, prioritizing "no
   * silent data loss". Returns true if the caller should proceed with the
   * overwrite ("keep mine"), false if the write must be abandoned ("load
   * latest"). The discarded side is backed up to a sibling file first.
   */
  private async _resolveConflict(outgoing: string): Promise<boolean> {
    const loadLatest = '最新を読み込む（自分の編集は破棄）';
    const overwrite = '自分の変更で上書き（他者の変更は破棄）';

    const choice = await vscode.window.showWarningMessage(
      `別の場所で「${path.basename(this._document.uri.fsPath)}」が変更されています。` +
        'エディタの編集をそのまま保存すると、他の変更が失われる可能性があります。',
      { modal: true },
      loadLatest,
      overwrite
    );

    if (choice === overwrite) {
      // Back up the other person's version before we discard it.
      await this._backupConflict('remote', this._document.getText());
      return true;
    }

    // Default (including dismissal): keep remote, discard our edit — the safe
    // choice. Back up our serialized edit so it is not lost outright.
    await this._backupConflict('mine', outgoing);
    await this._reloadFromDisk();
    return false;
  }

  /** Write a timestamped backup beside the document so neither side is lost. */
  private async _backupConflict(which: 'mine' | 'remote', content: string): Promise<void> {
    try {
      const stamp = backupTimestamp(new Date());
      const dir = path.dirname(this._document.uri.fsPath);
      const backupName = backupFileName(this._document.uri.fsPath, which, stamp);
      const backupUri = vscode.Uri.file(path.join(dir, backupName));
      await vscode.workspace.fs.writeFile(backupUri, Buffer.from(content, 'utf8'));
    } catch {
      // Backup is best-effort; never let it block conflict resolution.
    }
  }

  /**
   * Refresh the backing TextDocument reference. When the source editor is
   * closed, VS Code may dispose the backing TextDocument, leaving
   * this._document a stale/closed reference whose save() is a no-op.
   * openTextDocument returns the already-loaded instance if present and loads
   * (without revealing an editor) otherwise, so save() lands on the current
   * instance and applyEdit targets the loaded doc rather than forcing a fresh
   * editor to open.
   */
  private async _refreshDocument(): Promise<void> {
    this._document = await vscode.workspace.openTextDocument(this._document.uri);
  }

  /** Reload the document from disk and re-sync the panel to that state. */
  private async _reloadFromDisk(): Promise<void> {
    try {
      await this._refreshDocument();
      const bytes = await vscode.workspace.fs.readFile(this._document.uri);
      const diskText = Buffer.from(bytes).toString('utf8');
      // Bring the in-memory TextDocument up to date if it lags the disk.
      if (normalizeText(this._document.getText()) !== normalizeText(diskText)) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          this._document.uri,
          new vscode.Range(
            this._document.positionAt(0),
            this._document.positionAt(this._document.getText().length)
          ),
          diskText
        );
        await vscode.workspace.applyEdit(edit);
        await this._document.save();
      }
    } catch {
      // If the disk read fails, fall back to the current TextDocument state.
    }
    // _sendUpdate re-parses, re-renders the panel and refreshes the base.
    this._sendUpdate();
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

    this._panel.title = `Gantt エディタ — ${path.basename(this._document.fileName)}`;
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

    this._panel.title = `フローチャート エディタ — ${path.basename(this._document.fileName)}`;
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
    <button id="btn-fit">⊡ リセット</button>
    <button id="btn-export">⬇ エクスポート</button>
    <span class="toolbar-sep"></span>
    <label class="toolbar-label" for="sel-direction">方向</label>
    <select id="sel-direction" disabled>
      <option value="TD">上→下 (TD)</option>
      <option value="LR">左→右 (LR)</option>
      <option value="BT">下→上 (BT)</option>
      <option value="RL">右→左 (RL)</option>
    </select>
    <span class="toolbar-sep"></span>
    <label class="toolbar-label" for="sel-edge-style" title="ポートからドラッグして追加する新しいエッジの既定線種（ビューア表示中のみ保持・MDには保存されません）">既定エッジ</label>
    <select id="sel-edge-style" disabled title="ポートからドラッグして追加する新しいエッジの既定線種（ビューア表示中のみ保持・MDには保存されません）">
      <option value="solid-arrow">実線矢印 (--&gt;)</option>
      <option value="dotted-arrow">点線矢印 (-.-&gt;)</option>
      <option value="thick-arrow">太線矢印 (==&gt;)</option>
      <option value="solid-no-arrow">矢印なし実線 (---)</option>
      <option value="dotted-no-arrow">矢印なし点線 (-.-)</option>
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

    this._panel.title = `Mermaid エディタ — ${path.basename(this._document.fileName)}`;
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
    clearTimeout(this._debounceTimer);
    this._documentChangeDisposable?.dispose();
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
  }
}

function nonce32(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
