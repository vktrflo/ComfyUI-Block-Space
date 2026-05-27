import { app } from "/scripts/app.js";
import { emitSettingChanged } from "../../settings-events.js";

const ASSET_VERSION = "2026-03-01-adapter-v2";

function addSetting(definition) {
  const add = app?.ui?.settings?.addSetting;
  if (typeof add !== "function") return;
  try {
    add(definition);
  } catch {
    // Ignore per-setting registration errors
  }
}

function getSettingValue(id, fallback) {
  const get = app?.ui?.settings?.getSettingValue;
  if (typeof get !== "function") return fallback;
  try {
    return get(id) ?? fallback;
  } catch {
    return fallback;
  }
}

function applyConnectorSettingsAndEmit(settingId, value) {
  // Update the global settings object with the new value
  window.ConnectionFocusSettings ??= {};
  
  // Update the specific setting that changed (use passed value or read from store)
  if (settingId === "BlockSpace.EnableCustomConnectors") {
    window.ConnectionFocusSettings.enabled = value !== undefined ? value : getSettingValue(settingId, true);
  } else if (settingId === "BlockSpace.ConnectorStyle") {
    window.ConnectionFocusSettings.connectorStyle = value !== undefined ? value : getSettingValue(settingId, "hybrid");
  } else if (settingId === "BlockSpace.ConnectorStubLength") {
    window.ConnectionFocusSettings.connectorStubLength = value !== undefined ? value : getSettingValue(settingId, 34);
  } else {
    // Initial load - read all settings
    window.ConnectionFocusSettings.enabled = getSettingValue("BlockSpace.EnableCustomConnectors", true);
    window.ConnectionFocusSettings.connectorStyle = getSettingValue("BlockSpace.ConnectorStyle", "hybrid");
    window.ConnectionFocusSettings.connectorStubLength = getSettingValue("BlockSpace.ConnectorStubLength", 34);
  }
  
  // Emit event for real-time updates in adapters
  if (settingId) {
    const emitValue = value !== undefined ? value : getSettingValue(settingId, null);
    emitSettingChanged(settingId, emitValue);
  }
}

function registerBlockSpaceSettings() {
  addSetting({
    id: "BlockSpace.EnableCustomConnectors",
    name: "Enable Custom Connectors",
    type: "boolean",
    defaultValue: true,
    onChange: (value) => applyConnectorSettingsAndEmit("BlockSpace.EnableCustomConnectors", value),
    tooltip: "Toggle high-fidelity connector rendering with animated flow tracing.",
  });
  
  addSetting({
    id: "BlockSpace.ConnectorStyle",
    name: "Connector Style",
    type: "combo",
    options: ["hybrid", "straight", "angled", "hidden"],
    defaultValue: "hybrid",
    onChange: (value) => applyConnectorSettingsAndEmit("BlockSpace.ConnectorStyle", value),
    tooltip: "Choose the routing algorithm for node wires. Hybrid is recommended for most workflows.",
  });

  addSetting({
    id: "BlockSpace.ConnectorStubLength",
    name: "Connector Stub Length",
    type: "slider",
    attrs: { min: 10, max: 80, step: 1 },
    defaultValue: 34,
    onChange: (value) => applyConnectorSettingsAndEmit("BlockSpace.ConnectorStubLength", value),
    tooltip: "Adjust the length of the straight wire segment emerging from node ports.",
  });

  addSetting({
    id: "BlockSpace.Snap.Enabled",
    name: "Enable Snapping",
    type: "boolean",
    defaultValue: true,
    onChange: (value) => emitSettingChanged("BlockSpace.Snap.Enabled", value),
    tooltip: "Enable automatic node alignment and resizing guides.",
  });

  addSetting({
    id: "BlockSpace.Snap.Aggressiveness",
    name: "Snap Aggressiveness",
    type: "combo",
    options: ["Low", "Medium", "High"],
    defaultValue: "Low",
    onChange: (value) => emitSettingChanged("BlockSpace.Snap.Aggressiveness", value),
    tooltip: "Controls how strongly nodes snap to alignment. Low = easier free movement, High = stronger snapping.",
  });

  addSetting({
    id: "BlockSpace.Snap.Sensitivity",
    name: "Snap Sensitivity (px)",
    type: "slider",
    attrs: { min: 4, max: 30, step: 1 },
    defaultValue: 10,
    onChange: (value) => emitSettingChanged("BlockSpace.Snap.Sensitivity", value),
    tooltip: "The distance in pixels at which nodes will pull into alignment.",
  });

  addSetting({
    id: "BlockSpace.Snap.HMarginPx",
    name: "Horizontal Snap Margin",
    type: "slider",
    attrs: { min: 0, max: 200, step: 2 },
    defaultValue: 60,
    onChange: (value) => emitSettingChanged("BlockSpace.Snap.HMarginPx", value),
    tooltip: "The preferred gap distance when snapping nodes side-by-side.",
  });

  addSetting({
    id: "BlockSpace.Snap.VMarginPx",
    name: "Vertical Snap Margin",
    type: "slider",
    attrs: { min: 0, max: 200, step: 2 },
    defaultValue: 60,
    onChange: (value) => emitSettingChanged("BlockSpace.Snap.VMarginPx", value),
    tooltip: "The preferred gap distance when snapping nodes vertically.",
  });

  addSetting({
    id: "BlockSpace.Snap.HighlightEnabled",
    name: "Show Alignment Guides",
    type: "boolean",
    defaultValue: true,
    onChange: (value) => emitSettingChanged("BlockSpace.Snap.HighlightEnabled", value),
    tooltip: "Display dotted lines showing exactly which nodes are being used for alignment.",
  });

  addSetting({
    id: "BlockSpace.Snap.FeedbackPulseMs",
    name: "Snap Pulse Duration (ms)",
    type: "slider",
    attrs: { min: 0, max: 1000, step: 20 },
    defaultValue: 160,
    onChange: (value) => emitSettingChanged("BlockSpace.Snap.FeedbackPulseMs", value),
    tooltip: "How long the node border glows after a successful snap. Set to 0 to disable.",
  });

  addSetting({
    id: "BlockSpace.Snap.HighlightColor",
    name: "Guide Line Color",
    type: "combo",
    options: [
      "Comfy Blue",
      "Cyber Purple",
      "Neon Green",
      "Hot Pink",
      "Ghost White",
      "Amber Gold",
      "Signal Orange",
    ],
    defaultValue: "Comfy Blue",
    onChange: (value) => emitSettingChanged("BlockSpace.Snap.HighlightColor", value),
    tooltip: "Choose the color for snapping alignment guides.",
  });
  
  applyConnectorSettingsAndEmit(null);
}

function injectSettingsIcon() {
  const styleId = "block-space-icon-style";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.innerHTML = `
      .block-space-nav-icon {
        display: inline-block;
        vertical-align: text-bottom;
        margin-right: 8px;
        width: 18px;
        height: 18px;
      }
      .block-space-menu-icon {
        display: inline-block;
        width: 16px;
        height: 16px;
        background-image: url('data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4H10V10H4V4Z" fill="%2357b1ff" rx="1"/><path d="M14 14H20V20H14V14Z" fill="%238dff57" rx="1"/><path d="M14 4H20V10H14V4Z" fill="transparent" rx="1" stroke="%2357b1ff" stroke-width="2"/><path d="M4 14H10V20H4V14Z" fill="transparent" rx="1" stroke="%238dff57" stroke-width="2"/><line x1="10" y1="10" x2="14" y2="14" stroke="%23b57cff" stroke-width="2" stroke-linecap="round" stroke-dasharray="2 3"/></svg>');
        background-size: contain;
        background-repeat: no-repeat;
        vertical-align: middle;
        margin-right: 6px;
      }
      .comfy-setting-row:has([id^="BlockSpace."]) .comfy-help-icon,
      tr:has([id^="BlockSpace."]) .comfy-help-icon {
        cursor: help !important;
      }
      .block-space-tooltip {
        position: fixed;
        z-index: 10000;
        background-color: #2e3033;
        color: #ffffff;
        padding: 6px 10px;
        border-radius: 6px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        font-weight: 500;
        line-height: 1.35;
        text-align: center;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        pointer-events: none;
        opacity: 0;
        transform: translate(-50%, -6px);
        transition: opacity 0.15s ease, transform 0.15s ease;
        white-space: pre-line;
      }
      .block-space-tooltip.visible {
        opacity: 1;
        transform: translate(-50%, 0);
      }
      .block-space-tooltip::after {
        content: "";
        position: absolute;
        bottom: -4px;
        left: 50%;
        transform: translateX(-50%);
        border-width: 4px 4px 0;
        border-style: solid;
        border-color: #2e3033 transparent;
        display: block;
        width: 0;
      }
    `;
    document.head.appendChild(style);
  }

  const svgIcon = `
    <svg class="block-space-nav-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 4H10V10H4V4Z" fill="#57b1ff" rx="1"/>
      <path d="M14 14H20V20H14V14Z" fill="#8dff57" rx="1"/>
      <path d="M14 4H20V10H14V4Z" fill="transparent" rx="1" stroke="#57b1ff" stroke-width="2"/>
      <path d="M4 14H10V20H4V14Z" fill="transparent" rx="1" stroke="#8dff57" stroke-width="2"/>
      <line x1="10" y1="10" x2="14" y2="14" stroke="#b57cff" stroke-width="2" stroke-linecap="round" stroke-dasharray="2 3"/>
    </svg>
  `;

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
          let n;
          while ((n = walker.nextNode())) {
            const text = n.nodeValue ? n.nodeValue.trim() : "";
            if (text === "BlockSpace" || text === "BlockSpace.Snap") {
              n.nodeValue = " Block Space";
              const parentElement = n.parentElement;
              if (parentElement && !parentElement.querySelector('.block-space-nav-icon')) {
                parentElement.insertAdjacentHTML('afterbegin', svgIcon);
              }
            }
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

async function loadScript(url, options = {}) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = false;
    if (options.type) {
      script.type = options.type;
    }
    script.onload = () => resolve(url);
    script.onerror = () => reject(new Error("Failed to load script: " + url));
    document.body.appendChild(script);
  });
}

function loadBlockSpaceAdapter(baseUrl) {
  const indexUrl = new URL("../../index.js", baseUrl).toString() + "?v=" + ASSET_VERSION;
  
  // Non-blocking script load
  const script = document.createElement("script");
  script.src = indexUrl;
  script.type = "module";
  script.async = true; // Non-blocking
  script.onload = () => {
    console.log("[BlockSpace] Module loaded, adapter will auto-initialize");
  };
  script.onerror = () => {
    console.error("[BlockSpace] Failed to load module. Try hard refresh (Ctrl+F5)");
  };
  document.head.appendChild(script);
}

function arrangeSelection(canvas) {
  const selected = canvas.selected_nodes;
  if (!selected) return;

  const nodes = Object.values(selected).filter(n => n?.pos && n?.size);
  if (nodes.length < 2) return;

  canvas.graph?.beforeChange?.();

  const math = window.BlockSpaceCoreMath;
  const hMargin = math ? math.getHSnapMargin() : 60;
  const vMargin = math ? math.getVSnapMargin() : 40;
  const isV2 = window.BlockSpaceAdapterMode === "v2" ||
               (typeof window.BlockSpaceDetect === "function" && window.BlockSpaceDetect() === "v2") ||
               (typeof document !== "undefined" && document.querySelector("[data-node-id]") !== null);
  const titleH = isV2 ? 40 : (Number(window.LiteGraph?.NODE_TITLE_HEIGHT) || 24);

  const getNodeBounds = (node) => {
    if (!node || !node.pos || !node.size) return null;
    const h = titleH;
    return {
      left: node.pos[0],
      right: node.pos[0] + node.size[0],
      top: node.pos[1],
      bottom: node.pos[1] + node.size[1] + h,
      centerX: node.pos[0] + node.size[0] * 0.5,
      centerY: node.pos[1] + (node.size[1] + h) * 0.5
    };
  };

  const anchor = [...nodes].sort((a, b) => Math.abs(a.pos[1] - b.pos[1]) > 50 ? a.pos[1] - b.pos[1] : a.pos[0] - b.pos[0])[0];
  const startX = anchor.pos[0];
  const startY = anchor.pos[1];

  // --- HYBRID BLOCK-GRID ALGORITHM (FULL PROPORTIONAL WIDTH & HEIGHT) ---

  // 1. Identify Layout Bounds to detect wide "Spanning" nodes
  let minX = Infinity, maxX = -Infinity;
  nodes.forEach(n => {
    const b = getNodeBounds(n);
    if (b) {
      if (b.left < minX) minX = b.left;
      if (b.right > maxX) maxX = b.right;
    }
  });
  const totalSpan = maxX - minX;

  // 2. Sort nodes Top-to-Bottom
  const sortedNodes = [...nodes].sort((a, b) => a.pos[1] - b.pos[1]);

  // 3. Partition into Sections (Spanning vs Grid Block)
  const sections = [];
  let currentGridNodes = [];

  for (const node of sortedNodes) {
    const isSpanning = node.size[0] > totalSpan * 0.6;
    if (isSpanning) {
      if (currentGridNodes.length > 0) {
        sections.push({ type: 'grid', nodes: currentGridNodes });
        currentGridNodes = [];
      }
      sections.push({ type: 'spanning', node: node });
    } else {
      currentGridNodes.push(node);
    }
  }
  if (currentGridNodes.length > 0) {
    sections.push({ type: 'grid', nodes: currentGridNodes });
  }

  // 4. Process Grid Sections & Find Target Global Width
  let globalMaxWidth = 0;

  for (const sec of sections) {
    if (sec.type === 'spanning') {
      const w = sec.node.size[0];
      if (w > globalMaxWidth) globalMaxWidth = w;
    } else {
      // Group grid nodes into columns
      const cols = [];
      const sortedByX = [...sec.nodes].sort((a, b) => a.pos[0] - b.pos[0]);
      for (const n of sortedByX) {
        let placed = false;
        for (const col of cols) {
          const avgX = col.reduce((sum, node) => sum + node.pos[0], 0) / col.length;
          if (Math.abs(n.pos[0] - avgX) < 150) { 
            col.push(n);
            placed = true;
            break;
          }
        }
        if (!placed) cols.push([n]);
      }
      
      cols.sort((a, b) => a[0].pos[0] - b[0].pos[0]);
      cols.forEach(col => col.sort((a, b) => a.pos[1] - b.pos[1]));

      sec.columns = cols;
      
      // Calculate natural section width
      let naturalWidth = (cols.length - 1) * hMargin;
      cols.forEach(col => {
        const maxColWidth = Math.max(...col.map(n => n.size[0]));
        naturalWidth += maxColWidth;
      });

      if (naturalWidth > globalMaxWidth) globalMaxWidth = naturalWidth;
    }
  }

  // 5. Apply Layout with Proportional Scaling (Widths AND Heights)
  let currentY = startY;

  for (const sec of sections) {
    if (sec.type === 'spanning') {
      sec.node.pos = [startX, currentY];
      sec.node.size = [globalMaxWidth, sec.node.size[1]];
      
      currentY += sec.node.size[1] + titleH + vMargin;
    } else {
      const cols = sec.columns;
      const numCols = cols.length;
      
      // --- COLUMN WIDTH PROPORTIONS ---
      const colNaturalWidths = cols.map(col => Math.max(...col.map(n => n.size[0])));
      const totalNaturalWidth = colNaturalWidths.reduce((sum, w) => sum + w, 0);
      const targetAvailableWidth = globalMaxWidth - (numCols - 1) * hMargin;

      // --- FIND TARGET BLOCK HEIGHT ---
      let maxColHeight = 0;
      cols.forEach(col => {
        let colNaturalHeight = (col.length - 1) * vMargin;
        col.forEach(n => {
           const b = getNodeBounds(n);
           colNaturalHeight += b ? (b.bottom - b.top) : (n.size[1] + titleH);
        });
        if (colNaturalHeight > maxColHeight) maxColHeight = colNaturalHeight;
      });

      // Layout columns
      let currentX = startX;
      for (let i = 0; i < cols.length; i++) {
        const col = cols[i];
        const numNodes = col.length;
        
        // Determine this column's proportional width
        const targetColWidth = totalNaturalWidth === 0 
            ? targetAvailableWidth / numCols 
            : (colNaturalWidths[i] / totalNaturalWidth) * targetAvailableWidth;

        // --- NODE HEIGHT PROPORTIONS ---
        const nodeNaturalHeights = col.map(n => {
          const b = getNodeBounds(n);
          return b ? (b.bottom - b.top) : (n.size[1] + titleH);
        });
        const totalNaturalHeight = nodeNaturalHeights.reduce((sum, h) => sum + h, 0);
        const targetAvailableHeight = maxColHeight - (numNodes - 1) * vMargin;

        let colY = currentY;
        for (let j = 0; j < numNodes; j++) {
          const node = col[j];
          
          // Determine this specific node's proportional height
          // Enable vertical stretching for both V1 and V2 to keep the grid squared
          const targetNodeHeight = (totalNaturalHeight === 0)
              ? nodeNaturalHeights[j]
              : (nodeNaturalHeights[j] / totalNaturalHeight) * targetAvailableHeight;

          node.pos = [currentX, colY];
          node.size = [targetColWidth, Math.max(10, targetNodeHeight - titleH)];

          colY += targetNodeHeight + vMargin;
        }
        currentX += targetColWidth + hMargin;
      }
      currentY += maxColHeight + vMargin;
    }
  }

  canvas.graph?.afterChange?.();
  canvas.dirty_canvas = true;
  canvas.dirty_bgcanvas = true;
  if (canvas.setDirty) {
    canvas.setDirty(true, true);
  }
}

app.registerExtension({
  name: "Block Space",
  commands: [
    {
      id: "block-space.harmonize",
      label: "Harmonize Block",
      icon: "block-space-menu-icon",
      tooltip: "Align and clean up selected node layout proportions into a grid (Ctrl+Alt+Space).",
      description: "Align and clean up selected node layout proportions into a grid (Ctrl+Alt+Space).",
      function: () => {
        if (app.canvas) arrangeSelection(app.canvas);
      }
    }
  ],
  getSelectionToolboxCommands(selectedItem) {
    const selected = app.canvas?.selected_nodes;
    if (selected && Object.keys(selected).length > 1) {
      return ["block-space.harmonize"];
    }
    return [];
  },
  setup() {
    // Load settings script (non-blocking)
    const settingsUrl = new URL("../../better-nodes-settings.js", import.meta.url).toString() + "?v=" + ASSET_VERSION;
    const settingsScript = document.createElement("script");
    settingsScript.src = settingsUrl;
    settingsScript.async = true;
    settingsScript.onload = () => {
      if (window.BetterNodesSettings && typeof window.BetterNodesSettings.__setComfyUIRuntime === "function") {
        window.BetterNodesSettings.__setComfyUIRuntime(true);
      }
    };
    document.head.appendChild(settingsScript);

    // Load adapter (non-blocking, auto-detects V1/V2)
    loadBlockSpaceAdapter(import.meta.url);

    // Reset any persisted artifacts from previous sessions
    setTimeout(() => {
      if (
        window.BlockSpaceNodeSnap &&
        typeof window.BlockSpaceNodeSnap.resetPersistedHighlightArtifacts === "function"
      ) {
        window.BlockSpaceNodeSnap.resetPersistedHighlightArtifacts(app && app.canvas);
      }
    }, 1000);

    registerBlockSpaceSettings();
    injectSettingsIcon();

    // Keyboard shortcut (Ctrl+Alt+Spacebar) for Harmonize Selected Blocks layout
    window.addEventListener("keydown", (e) => {
      if (
        e.ctrlKey &&
        e.altKey &&
        !e.shiftKey &&
        !e.metaKey &&
        (e.code === "Space" || e.key === " " || e.keyCode === 32)
      ) {
        // Prevent triggering when typing in inputs/textareas
        const activeEl = document.activeElement;
        if (
          activeEl &&
          (activeEl.tagName === "INPUT" ||
            activeEl.tagName === "TEXTAREA" ||
            activeEl.isContentEditable)
        ) {
          return;
        }

        const selected = app.canvas?.selected_nodes;
        if (selected && Object.keys(selected).length > 1) {
          e.preventDefault();
          e.stopPropagation();
          if (app.canvas) {
            arrangeSelection(app.canvas);
          }
        }
      }
    });

    // Custom pixel-identical ComfyUI tooltip helper for the selection toolbox button
    let activeTooltip = null;

    const showTooltip = (button, text) => {
      if (activeTooltip) return;
      
      const tooltip = document.createElement("div");
      tooltip.className = "block-space-tooltip";
      tooltip.innerText = text; // Preserves newlines
      document.body.appendChild(tooltip);
      
      const rect = button.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      
      const x = rect.left + rect.width / 2;
      const y = rect.top - tooltipRect.height - 8;
      
      tooltip.style.left = `${x}px`;
      tooltip.style.top = `${y}px`;
      
      // Force reflow
      tooltip.offsetHeight;
      tooltip.classList.add("visible");
      activeTooltip = tooltip;
    };

    const hideTooltip = () => {
      if (activeTooltip) {
        const tooltip = activeTooltip;
        activeTooltip = null;
        tooltip.classList.remove("visible");
        setTimeout(() => {
          tooltip.remove();
        }, 150);
      }
    };

    document.addEventListener("pointerover", (event) => {
      if (!event.target) return;
      const icon = typeof event.target.closest === "function" && event.target.closest(".block-space-menu-icon");
      if (icon) {
        const button = (typeof icon.closest === "function" && icon.closest("button")) || icon;
        if (button) {
          showTooltip(button, "Harmonize Selected Blocks (Ctrl+Alt+Space)\nAlign and clean up selected node layout proportions into a grid.");
        }
      }
    }, true);

    document.addEventListener("pointerout", (event) => {
      if (!event.target) return;
      const icon = typeof event.target.closest === "function" && event.target.closest(".block-space-menu-icon");
      if (icon) {
        hideTooltip();
      }
    }, true);

    document.addEventListener("pointerdown", () => {
      hideTooltip();
    }, true);
  },
  getNodeMenuItems(node) {
    const selected = app.canvas?.selected_nodes;
    if (selected && Object.keys(selected).length > 1 && selected[node.id]) {
      return [
        {
          content: `<span title="Align and clean up selected node layout proportions into a grid (Ctrl+Alt+Space)." style="display:inline-flex;align-items:center;font-weight:bold;">
            <svg class="block-space-nav-icon" viewBox="0 0 24 24" fill="none" style="width:16px;height:16px;margin-right:8px;vertical-align:middle;display:inline-block;">
              <path d="M4 4H10V10H4V4Z" fill="#57b1ff" rx="1"/>
              <path d="M14 14H20V20H14V14Z" fill="#8dff57" rx="1"/>
              <path d="M14 4H20V10H14V4Z" fill="transparent" rx="1" stroke="#57b1ff" stroke-width="2"/>
              <path d="M4 14H10V20H4V14Z" fill="transparent" rx="1" stroke="#8dff57" stroke-width="2"/>
              <line x1="10" y1="10" x2="14" y2="14" stroke="#b57cff" stroke-width="2" stroke-linecap="round" stroke-dasharray="2 3"/>
            </svg>Harmonize Block</span>`,
          callback: () => {
            if (app.canvas) arrangeSelection(app.canvas);
          }
        }
      ];
    }
    return null;
  },
  getCanvasMenuItems(canvas) {
    const selected = app.canvas?.selected_nodes;
    if (selected && Object.keys(selected).length > 1) {
      return [
        {
          content: `<span title="Align and clean up selected node layout proportions into a grid (Ctrl+Alt+Space)." style="display:inline-flex;align-items:center;font-weight:bold;">
            <svg class="block-space-nav-icon" viewBox="0 0 24 24" fill="none" style="width:16px;height:16px;margin-right:8px;vertical-align:middle;display:inline-block;">
              <path d="M4 4H10V10H4V4Z" fill="#57b1ff" rx="1"/>
              <path d="M14 14H20V20H14V14Z" fill="#8dff57" rx="1"/>
              <path d="M14 4H20V10H14V4Z" fill="transparent" rx="1" stroke="#57b1ff" stroke-width="2"/>
              <path d="M4 14H10V20H4V14Z" fill="transparent" rx="1" stroke="#8dff57" stroke-width="2"/>
              <line x1="10" y1="10" x2="14" y2="14" stroke="#b57cff" stroke-width="2" stroke-linecap="round" stroke-dasharray="2 3"/>
            </svg>Harmonize Selected Blocks</span>`,
          callback: () => {
            if (app.canvas) arrangeSelection(app.canvas);
          }
        }
      ];
    }
    return null;
  }
});
