import * as vscode from 'vscode';
import { CallTreeNode, EChartsTreeNode } from './types';

/**
 * Task 4.1: 蝴蝶结形态（Butterfly）全景调用拓扑图
 * Callers orient:RL (左) + Callees orient:LR (右)
 */
export class CallGraphWebview {
    private panel: vscode.WebviewPanel | undefined;

    render(symbol: string, callersTree: CallTreeNode[], calleesTree: CallTreeNode[]): void {
        const callersData = callersTree.map(n => this.toEChartsNode(n));
        const calleesData = calleesTree.map(n => this.toEChartsNode(n));
        this.createOrReveal(symbol, callersData, calleesData);
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = undefined;
    }

    // ── 内部实现 ────────────────────────────────────────────────
    private toEChartsNode(node: CallTreeNode): EChartsTreeNode {
        const file = this.shortFile(node.uri);
        const colors = getThemeColors();
        const isRoot = node.nodeType === 'root';
        const isCaller = node.direction === 'callers';
        const fill = isRoot ? colors.rootFill : isCaller ? colors.callerFill : colors.calleeFill;
        const border = isRoot ? colors.rootBorder : isCaller ? colors.callerBorder : colors.calleeBorder;
        const prefix = node.isManual ? '$(link) ' : '';

        return {
            name: `${prefix}${node.name}`,
            value: `${file}:${node.line + 1}`,
            symbolSize: isRoot ? 18 : node.isManual ? 12 : 10,
            itemStyle: { color: fill, borderColor: border },
            lineStyle: {
                color: node.isManual ? colors.manualLine : colors.line,
            },
            label: { color: colors.label },
            children: node.children.map(c => this.toEChartsNode(c)),
            _uri: node.uri,
            _line: node.line,
        };
    }

    private createOrReveal(symbol: string, callersData: EChartsTreeNode[], calleesData: EChartsTreeNode[]): void {
        if (this.panel) {
            this.panel.title = `Call Graph: ${symbol}`;
            this.panel.webview.html = this.buildHtml(this.panel.webview, symbol, callersData, calleesData);
            this.panel.reveal(vscode.ViewColumn.Beside);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'cppNavigator.callGraph',
            `Call Graph: ${symbol}`,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true }
        );

        this.panel.webview.html = this.buildHtml(this.panel.webview, symbol, callersData, calleesData);

        this.panel.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'openFile') {
                this.openFileAt(msg.uri, msg.line);
            }
        });

        this.panel.onDidDispose(() => { this.panel = undefined; });
    }

    private async openFileAt(uri: string, line: number): Promise<void> {
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            const pos = new vscode.Position(line, 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        } catch { /* ignore */ }
    }

    private shortFile(uri: string): string {
        return vscode.Uri.parse(uri).fsPath.split(/[/\\]/).pop() ?? '';
    }

    private buildHtml(
        webview: vscode.Webview,
        symbol: string,
        callersData: EChartsTreeNode[],
        calleesData: EChartsTreeNode[]
    ): string {
        const csp = webview.cspSource;
        const c = getThemeColors();
        const rootValue = this.shortFile(
            calleesData[0]?._uri ?? callersData[0]?._uri ?? ''
        );

        return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src 'unsafe-inline' ${csp};
                 script-src 'unsafe-inline' https://cdn.jsdelivr.net ${csp};
                 connect-src https://cdn.jsdelivr.net;">
  <style>
    * { box-sizing: border-box; margin:0; padding:0; }
    html, body { width:100%; height:100%; overflow:hidden;
      font-family:var(--vscode-font-family); background:${c.bg}; color:${c.fg};
      /* 防止 VS Code 拦截滚轮和拖拽 */
      overscroll-behavior: contain; touch-action: none; }
    #chart { width:100%; height:100%; cursor:grab; }
    #chart.dragging { cursor:grabbing; }
    #toolbar { position:fixed; top:10px; right:10px; z-index:100; display:flex; gap:4px;
               pointer-events:auto; }
    .btn { padding:5px 10px; border-radius:3px; border:1px solid ${c.border};
           background:${c.bg}; color:${c.fg}; cursor:pointer; font-size:12px;
           font-family:var(--vscode-font-family); pointer-events:auto;
           user-select:none; -webkit-user-select:none; }
    .btn:hover { background:${c.border}; }
    .btn:active { background:${c.fg}22; }
    #legend { position:fixed; bottom:10px; left:10px; z-index:100; font-size:12px;
              color:${c.fgMuted}; background:${c.bg}; border:1px solid ${c.border};
              border-radius:4px; padding:5px 12px; display:flex; gap:14px;
              align-items:center; pointer-events:none; }
    .dot { display:inline-block; width:10px; height:10px; border-radius:50%;
           margin-right:3px; vertical-align:middle; }
    .dot-root   { background:${c.rootFill}; }
    .dot-caller { background:${c.callerFill}; }
    .dot-callee { background:${c.calleeFill}; }
    .dot-manual { background:${c.manualLine}; }
  </style>
</head>
<body>
  <div id="chart"></div>
  <div id="toolbar">
    <button class="btn" onclick="doZoom(1.3)" title="Zoom In">＋</button>
    <button class="btn" onclick="doZoom(0.77)" title="Zoom Out">－</button>
    <button class="btn" onclick="doFit()" title="Fit to View">⊞ Fit</button>
    <button class="btn" onclick="doPan(-100,0)" title="Pan Left">◀</button>
    <button class="btn" onclick="doPan(100,0)" title="Pan Right">▶</button>
    <button class="btn" onclick="doPan(0,-100)" title="Pan Up">▲</button>
    <button class="btn" onclick="doPan(0,100)" title="Pan Down">▼</button>
    <button class="btn" onclick="expandAll()" title="Expand All">⊟ Expand</button>
    <button class="btn" onclick="collapseAll()" title="Collapse All">⊞ Collapse</button>
  </div>
  <div id="legend">
    <span><span class="dot dot-root"></span>${escapeHtml(symbol)}</span>
    <span><span class="dot dot-caller"></span>Callers</span>
    <span><span class="dot dot-callee"></span>Callees</span>
    <span><span class="dot dot-manual"></span>Manual</span>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
  <script>
    // ── 缩放/平移状态 ─────────────────────────────────────────
    var zoom = 1;
    var panX = 0, panY = 0;
    var isDragging = false, dragStartX = 0, dragStartY = 0, dragPanX = 0, dragPanY = 0;
    var BASE_W = 800, BASE_H = 600;
    var chartW = BASE_W, chartH = BASE_H;
    var MIN_SIDE_WIDTH = 320;
    var LEVEL_GAP = 180;
    var ROW_GAP = 34;
    var EDGE_MARGIN_Y = 72;

    var vscode = acquireVsCodeApi();
    var chart = echarts.init(document.getElementById('chart'), null, { renderer:'canvas' });
    var callersData = ${JSON.stringify(callersData)};
    var calleesData = ${JSON.stringify(calleesData)};

    var rootNode = {
      name: '${escapeHtml(symbol)}', value: '${escapeHtml(rootValue)}',
      symbolSize: 18,
      itemStyle: { color:'${c.rootFill}', borderColor:'${c.rootBorder}' },
      lineStyle:  { color:'${c.line}' },
      label: { color:'${c.label}' },
      _isRoot: true,
      children: []
    };

    function countLeaves(nodes) {
      if (!nodes || nodes.length === 0) return 1;
      var total = 0;
      nodes.forEach(function(node) {
        total += node.children && node.children.length ? countLeaves(node.children) : 1;
      });
      return total;
    }
    function maxDepth(nodes) {
      if (!nodes || nodes.length === 0) return 1;
      var depth = 1;
      nodes.forEach(function(node) {
        depth = Math.max(depth, 1 + maxDepth(node.children || []));
      });
      return depth;
    }
    function nodeCount(nodes) {
      if (!nodes || nodes.length === 0) return 0;
      var total = 0;
      nodes.forEach(function(node) {
        total += 1 + nodeCount(node.children || []);
      });
      return total;
    }
    function formatNodeName(p) {
      return p.data && p.data._isRoot ? '' : (p.data.name || '');
    }

    function buildOption() {
      // 根据缩放和平移计算实际布局尺寸
      var visibleLeaves = Math.max(countLeaves(callersData), countLeaves(calleesData), 4);
      var visibleDepth = Math.max(maxDepth(callersData), maxDepth(calleesData), 2);
      var totalNodes = nodeCount(callersData) + nodeCount(calleesData);
      var autoInitialDepth = totalNodes > 80 ? 2 : 3;
      var layoutH = Math.max(chartH * zoom, visibleLeaves * ROW_GAP + EDGE_MARGIN_Y * 2);
      var sideWidth = Math.max(MIN_SIDE_WIDTH, visibleDepth * LEVEL_GAP * zoom);
      var centerX = chartW / 2 + panX;
      var top = (chartH - layoutH) / 2 + panY;
      var labelBase = {
        verticalAlign:'middle',
        fontSize:12,
        width:150,
        overflow:'truncate',
        fontFamily:'var(--vscode-font-family)',
        color:'${c.label}',
        formatter: formatNodeName
      };
      return {
        tooltip: {
          trigger:'item', backgroundColor:'${c.bg}', borderColor:'${c.border}',
          textStyle:{ color:'${c.fg}', fontFamily:'var(--vscode-font-family)' },
          formatter: function(p) {
            return '<b>'+(p.data.name||'')+'</b>'+(p.data.value?'<br/><small>'+p.data.value+'</small>':'');
          }
        },
        series: [
          { type:'tree', data:[{name:rootNode.name, value:rootNode.value, symbolSize:rootNode.symbolSize,
              itemStyle:rootNode.itemStyle, lineStyle:rootNode.lineStyle, label:rootNode.label,
              _isRoot:rootNode._isRoot,
              children:callersData}],
            orient:'RL',
            top: top+'px', height: layoutH+'px',
            left: (centerX - sideWidth)+'px', width: sideWidth+'px',
            symbol:'circle', symbolSize:10, initialTreeDepth:autoInitialDepth,
            label:Object.assign({}, labelBase, { position:'left', align:'right', distance:8 }),
            leaves:{ label:{ position:'left', align:'right', width:170, overflow:'truncate' } },
            labelLayout:{ hideOverlap:true },
            lineStyle:{ color:'${c.line}', width:1.5 },
            expandAndCollapse:true, animationDuration:200 },
          { type:'tree', data:[{name:rootNode.name, value:rootNode.value, symbolSize:rootNode.symbolSize,
              itemStyle:rootNode.itemStyle, lineStyle:rootNode.lineStyle, label:rootNode.label,
              _isRoot:rootNode._isRoot,
              children:calleesData}],
            orient:'LR',
            top: top+'px', height: layoutH+'px',
            left: centerX+'px', width: sideWidth+'px',
            symbol:'circle', symbolSize:10, initialTreeDepth:autoInitialDepth,
            label:Object.assign({}, labelBase, { position:'right', align:'left', distance:8 }),
            leaves:{ label:{ position:'right', align:'left', width:170, overflow:'truncate' } },
            labelLayout:{ hideOverlap:true },
            lineStyle:{ color:'${c.line}', width:1.5 },
            expandAndCollapse:true, animationDuration:200 }
        ]
      };
    }

    chart.setOption(buildOption());

    // ── 缩放/平移 API ─────────────────────────────────────────
    function doZoom(factor) {
      zoom = Math.max(0.2, Math.min(5, zoom * factor));
      chart.setOption(buildOption());
    }
    function doPan(dx, dy) {
      panX += dx; panY += dy;
      chart.setOption(buildOption());
    }
    function doFit() {
      zoom = 1; panX = 0; panY = 0;
      chart.setOption(buildOption());
    }

    // ── 鼠标滚轮缩放 ──────────────────────────────────────────
    var chartEl = document.getElementById('chart');
    chartEl.addEventListener('wheel', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var factor = e.deltaY < 0 ? 1.15 : 0.87;
      doZoom(factor);
    }, { passive: false, capture: true });

    // ── 鼠标拖拽平移 ──────────────────────────────────────────
    chartEl.addEventListener('pointerdown', function(e) {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      dragStartX = e.clientX; dragStartY = e.clientY;
      dragPanX = panX; dragPanY = panY;
      chartEl.classList.add('dragging');
      chartEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    chartEl.addEventListener('pointermove', function(e) {
      if (!isDragging) return;
      panX = dragPanX + (e.clientX - dragStartX);
      panY = dragPanY + (e.clientY - dragStartY);
      chart.setOption(buildOption());
    });
    chartEl.addEventListener('pointerup', function(e) {
      isDragging = false;
      chartEl.classList.remove('dragging');
    });

    // ── 点击跳转 ──────────────────────────────────────────────
    chart.on('click', function(params) {
      if (params.data && params.data._uri) {
        vscode.postMessage({ command:'openFile', uri:params.data._uri, line:params.data._line });
      }
    });

    // ── 展开/折叠 ─────────────────────────────────────────────
    function expandAll() {
      var option = chart.getOption();
      var updates = option.series.map(function(series) {
        var d = series.data[0];
        walk(d, false);
        return { data: [d] };
      });
      chart.setOption({ series: updates });
    }
    function collapseAll() {
      var option = chart.getOption();
      var updates = option.series.map(function(series) {
        var d = series.data[0];
        if (d.children) d.children.forEach(function(c){ walk(c, true); });
        return { data: [d] };
      });
      chart.setOption({ series: updates });
    }
    function walk(n, collapsed) {
      n.collapsed = collapsed;
      if (n.children) n.children.forEach(function(c){ walk(c, collapsed); });
    }

    // ── 窗口缩放 ──────────────────────────────────────────────
    window.addEventListener('resize', function(){
      chart.resize();
      // 更新基准尺寸
      var rect = chartEl.getBoundingClientRect();
      chartW = rect.width; chartH = rect.height;
      chart.setOption(buildOption());
    });

    // 初始化基准尺寸
    (function(){
      var rect = chartEl.getBoundingClientRect();
      chartW = rect.width || BASE_W;
      chartH = rect.height || BASE_H;
      chart.setOption(buildOption());
    })();
  </script>
</body>
</html>`;
    }
}

// ── Theme helpers ────────────────────────────────────────────────
interface ThemeColors {
    bg: string; fg: string; fgMuted: string; border: string;
    rootFill: string; rootBorder: string;
    callerFill: string; callerBorder: string;
    calleeFill: string; calleeBorder: string;
    line: string; manualLine: string; label: string;
}

const THEMES: Record<string, ThemeColors> = {
    light: {
        bg:'#ffffff', fg:'#333333', fgMuted:'#666666', border:'#d4d4d4',
        rootFill:'#007acc', rootBorder:'#005f9e',
        callerFill:'#e8a838', callerBorder:'#c48820',
        calleeFill:'#4ec9b0', calleeBorder:'#38a89d',
        line:'#999999', manualLine:'#c586c0', label:'#333333',
    },
    dark: {
        bg:'#1e1e1e', fg:'#cccccc', fgMuted:'#808080', border:'#404040',
        rootFill:'#569cd6', rootBorder:'#3d8ec4',
        callerFill:'#dcdcaa', callerBorder:'#b8b896',
        calleeFill:'#4ec9b0', calleeBorder:'#38a89d',
        line:'#555555', manualLine:'#c586c0', label:'#cccccc',
    },
    'hc-black': {
        bg:'#000000', fg:'#ffffff', fgMuted:'#cccccc', border:'#6fc3df',
        rootFill:'#569cd6', rootBorder:'#6fc3df',
        callerFill:'#dcdcaa', callerBorder:'#6fc3df',
        calleeFill:'#4ec9b0', calleeBorder:'#6fc3df',
        line:'#6fc3df', manualLine:'#c586c0', label:'#ffffff',
    },
    'hc-light': {
        bg:'#ffffff', fg:'#000000', fgMuted:'#444444', border:'#007acc',
        rootFill:'#007acc', rootBorder:'#005f9e',
        callerFill:'#e8a838', callerBorder:'#c48820',
        calleeFill:'#4ec9b0', calleeBorder:'#38a89d',
        line:'#007acc', manualLine:'#c586c0', label:'#000000',
    },
};

function getThemeColors(): ThemeColors {
    const kind = vscode.window.activeColorTheme.kind;
    if (kind === vscode.ColorThemeKind.Light) return THEMES.light;
    if (kind === vscode.ColorThemeKind.HighContrast) return THEMES['hc-black'];
    if (kind === vscode.ColorThemeKind.HighContrastLight) return THEMES['hc-light'];
    return THEMES.dark;
}

function escapeHtml(v: string): string {
    return v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
