/**
 * ComfyUI-Block-Space V2 Adapter
 * 
 * Production-ready implementation for Vue-based DOM interface (ComfyUI V2 / Nodes 2.0).
 * Implements high-fidelity connection routing, animated flow tracing, active slot rings,
 * and global event interception to bypass Vue DOM stopPropagation boundaries.
 */

import {
  clampNumber,
  rangesOverlap,
  getNodeBounds,
  buildDimensionClusters,
  pickNearestMoveCluster,
  pickDirectionalCluster,
  getRaycastNeighbors,
  getSettingValue,
  getHSnapMargin,
  getVSnapMargin,
  getSnapThreshold,
  isSnappingEnabled,
  getMoveSnapStrength,
  getResizeSnapStrength,
  getMoveYSnapStrength,
  getDimensionTolerancePx,
  getHighlightEnabled,
  getHighlightColor,
  getFeedbackEnabled,
  getFeedbackPulseMs,
  getFeedbackColorX,
  getFeedbackColorY,
  getFeedbackColorXY,
} from './core-math.js';
import { onAnySettingChanged } from './settings-events.js';

const V2_ADAPTER_VERSION = "2.0.0";
const CONNECTOR_FAN_SPACING = 9;

// ============================================================================
// Focus State Management
// ============================================================================

const focusState = {
  activeCanvas: null,
  activeNodeId: null,
  isHolding: false,
  animationTime: 0,
  rafId: null,
};

const defaultFocusSettings = {
  pulseColor: "#ff00ae",
  connectorStubLength: 34,
  connectorStyle: "hybrid",
  enabled: true,
};

const V2State = {
  settingsUnsubscribe: null,
  pointerdownHandler: null,
  pointerupHandler: null,
  blurHandler: null,
  keydownHandler: null,
  originalRenderLink: null,
  globalAnimationId: null,
};

function startGlobalAnimationLoop() {
  if (V2State.globalAnimationId) return;
  
  const tick = () => {
    const canvas = getLGraphCanvas();
    const settings = getFocusSettings();
    if (canvas && settings.enabled) {
      const hasActiveNode = canvas.current_node || (canvas.selected_nodes && Object.keys(canvas.selected_nodes).length > 0);
      if (hasActiveNode && !focusState.isHolding) {
        focusState.animationTime += 16;
        markCanvasDirty(canvas);
      }
    }
    V2State.globalAnimationId = requestAnimationFrame(tick);
  };
  V2State.globalAnimationId = requestAnimationFrame(tick);
}

function stopGlobalAnimationLoop() {
  if (V2State.globalAnimationId) {
    cancelAnimationFrame(V2State.globalAnimationId);
    V2State.globalAnimationId = null;
  }
}

function getFocusSettings() {
  if (!window.ConnectionFocusSettings || typeof window.ConnectionFocusSettings !== "object") {
    window.ConnectionFocusSettings = {};
  }
  const settings = window.ConnectionFocusSettings;
  if (typeof settings.pulseColor !== "string" || !settings.pulseColor.trim()) {
    settings.pulseColor = defaultFocusSettings.pulseColor;
  }
  if (typeof settings.connectorStubLength !== "number" || !isFinite(settings.connectorStubLength)) {
    settings.connectorStubLength = defaultFocusSettings.connectorStubLength;
  }
  settings.connectorStubLength = Math.max(10, Math.min(80, settings.connectorStubLength));
  const style = settings.connectorStyle;
  if (style !== "straight" && style !== "hybrid" && style !== "angled" && style !== "hidden") {
    settings.connectorStyle = defaultFocusSettings.connectorStyle;
  }
  if (typeof settings.enabled !== "boolean") {
    settings.enabled = defaultFocusSettings.enabled;
  }
  return settings;
}

function getLGraphCanvas() {
  return window.app?.canvas || window.LGraphCanvas?.active_canvas || window.graphcanvas;
}

function markCanvasDirty(canvas) {
  if (canvas?.setDirty) canvas.setDirty(true, true);
}

function animationTick() {
  if (!focusState.isHolding) {
    focusState.rafId = null;
    return;
  }
  focusState.animationTime += 16; // increment animation clock
  markCanvasDirty(focusState.activeCanvas);
  focusState.rafId = window.requestAnimationFrame(animationTick);
}

function startAnimationLoop() {
  if (focusState.rafId) return;
  focusState.rafId = window.requestAnimationFrame(animationTick);
}

function stopAnimationLoop() {
  if (focusState.rafId) {
    window.cancelAnimationFrame(focusState.rafId);
    focusState.rafId = null;
  }
}

function clearFocusState() {
  const canvas = focusState.activeCanvas;
  focusState.activeCanvas = null;
  focusState.activeNodeId = null;
  focusState.isHolding = false;
  stopAnimationLoop();
  markCanvasDirty(canvas);
}

function setFocusState(canvas, nodeId) {
  focusState.activeCanvas = canvas || null;
  focusState.activeNodeId = nodeId;
  focusState.isHolding = !!canvas && nodeId != null;
  if (focusState.isHolding) {
    startAnimationLoop();
    markCanvasDirty(canvas);
  } else {
    clearFocusState();
  }
}

// ============================================================================
// Focus Helpers & Cable Routing Calculations
// ============================================================================

function extractLinkInfo(argsLike) {
  for (let i = 0; i < argsLike.length; i++) {
    const candidate = argsLike[i];
    if (candidate && typeof candidate === "object" && "origin_id" in candidate && "target_id" in candidate) {
      return candidate;
    }
  }
  return null;
}

function addLinkLaneOffsets(links, byKey) {
  if (!Array.isArray(links) || !links.length || !byKey) return;
  links.sort((a, b) => {
    const aNode = a.peerNodeId != null ? Number(a.peerNodeId) : 0;
    const bNode = b.peerNodeId != null ? Number(b.peerNodeId) : 0;
    if (aNode !== bNode) return aNode - bNode;
    const aSlot = a.peerSlot != null ? Number(a.peerSlot) : 0;
    const bSlot = b.peerSlot != null ? Number(b.peerSlot) : 0;
    if (aSlot !== bSlot) return aSlot - bSlot;
    return String(a.key).localeCompare(String(b.key));
  });

  const center = (links.length - 1) * 0.5;
  for (let i = 0; i < links.length; i++) {
    byKey[String(links[i].key)] = (i - center) * CONNECTOR_FAN_SPACING;
  }
}

function getActiveFocus(canvas) {
  if (!canvas) return null;
  if (!canvas.graph?.getNodeById) return null;

  let activeNode = null;
  
  // 1. If actively dragging/holding, use the held node
  if (focusState.isHolding && focusState.activeCanvas === canvas && focusState.activeNodeId != null) {
    activeNode = canvas.graph.getNodeById(focusState.activeNodeId);
  }
  
  // 2. Fallback: Use the currently active/selected node on the canvas if present in selected_nodes
  if (!activeNode) {
    const hasSelectedNodes = canvas.selected_nodes && Object.keys(canvas.selected_nodes).length > 0;
    if (hasSelectedNodes) {
      const currentInSelected = canvas.current_node && canvas.selected_nodes[canvas.current_node.id];
      activeNode = currentInSelected ? canvas.current_node : Object.values(canvas.selected_nodes)[0];
    }
  }

  if (!activeNode || activeNode.constructor?.name === "LGraphGroup") return null;

  const graph = canvas.graph;

  const connectedNodeIds = {}, connectedLinkIds = {}, targetInputsByNode = {}, sourceOutputSlotsByNode = {};
  const activeOutputSlots = {}, activeInputSlots = {}, outgoingGroups = {}, incomingGroups = {}, linkLaneOffsets = {};

  if (graph.links) {
    for (const linkId in graph.links) {
      if (!Object.prototype.hasOwnProperty.call(graph.links, linkId)) continue;
      const link = graph.links[linkId];
      if (!link) continue;
      const linkKey = link.id != null ? link.id : linkId;

      if (link.origin_id === activeNode.id) {
        connectedNodeIds[link.target_id] = true;
        connectedLinkIds[linkKey] = true;
        activeOutputSlots[link.origin_slot] = true;
        if (!targetInputsByNode[link.target_id]) targetInputsByNode[link.target_id] = {};
        targetInputsByNode[link.target_id][link.target_slot] = true;
        const outGroupKey = String(link.origin_slot);
        if (!outgoingGroups[outGroupKey]) outgoingGroups[outGroupKey] = [];
        outgoingGroups[outGroupKey].push({ key: linkKey, peerNodeId: link.target_id, peerSlot: link.target_slot });
      }

      if (link.target_id === activeNode.id) {
        connectedNodeIds[link.origin_id] = true;
        connectedLinkIds[linkKey] = true;
        activeInputSlots[link.target_slot] = true;
        if (!sourceOutputSlotsByNode[link.origin_id]) sourceOutputSlotsByNode[link.origin_id] = {};
        sourceOutputSlotsByNode[link.origin_id][link.origin_slot] = true;
        const inGroupKey = String(link.target_slot);
        if (!incomingGroups[inGroupKey]) incomingGroups[inGroupKey] = [];
        incomingGroups[inGroupKey].push({ key: linkKey, peerNodeId: link.origin_id, peerSlot: link.origin_slot });
      }
    }
  }

  for (const outKey in outgoingGroups) {
    if (Object.prototype.hasOwnProperty.call(outgoingGroups, outKey)) {
      addLinkLaneOffsets(outgoingGroups[outKey], linkLaneOffsets);
    }
  }
  for (const inKey in incomingGroups) {
    if (Object.prototype.hasOwnProperty.call(incomingGroups, inKey)) {
      addLinkLaneOffsets(incomingGroups[inKey], linkLaneOffsets);
    }
  }

  return {
    activeNodeId: activeNode.id, connectedNodeIds, connectedLinkIds, targetInputsByNode,
    sourceOutputSlotsByNode, activeOutputSlots, activeInputSlots, linkLaneOffsets,
    animationTime: focusState.animationTime,
  };
}

function getSlotColor(node, isInput, slotIndex) {
  if (!node) return null;
  const slots = isInput ? node.inputs : node.outputs;
  if (slots?.[slotIndex]) {
    const slot = slots[slotIndex];
    if (typeof slot.color === "string" && slot.color) return slot.color;
    if (slot.type && typeof slot.type === "string") {
      const slotType = slot.type;
      const lg = window.LiteGraph;
      if (lg?.type_colors?.[slotType]) return lg.type_colors[slotType];
      const constName = slotType.toUpperCase() + "_COLOR";
      if (lg?.[constName]) return lg[constName];
      const typeMap = {
        "MODEL": "#B39DDB", "CLIP": "#FFD166", "VAE": "#FF6B6B", "LATENT": "#FF6B9D",
        "IMAGE": "#4ECDC4", "MASK": "#95E1D3", "CONDITIONING": "#FFA07A",
        "FLOAT": "#AAEE88", "INT": "#AAEE88", "STRING": "#F7DC6F", "BOOLEAN": "#87CEEB",
      };
      if (typeMap[slotType]) return typeMap[slotType];
    }
  }
  return null;
}

// ============================================================================
// Canvas Cable Drawing Functions
// ============================================================================

function drawSlotRingAtPoint(ctx, x, y, color) {
  if (!ctx) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.arc(x, y, 6.2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.arc(x, y, 4.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawHardAngleLink(argsLike, sourceOffset, targetOffset, color, styleOverride) {
  if (!argsLike?.length) return;
  const ctx = argsLike[0];
  if (!ctx) return;
  const a = argsLike[1], b = argsLike[2];
  if (!a || !b || a.length < 2 || b.length < 2) return;

  const settings = getFocusSettings();
  const style = styleOverride || settings.connectorStyle;

  ctx.save();
  if (color) ctx.strokeStyle = color;
  ctx.lineJoin = "miter";
  ctx.lineCap = "round";
  drawConfiguredPath(ctx, a[0], a[1], b[0], b[1], settings.connectorStubLength, style, sourceOffset || 0, targetOffset || 0);
  ctx.stroke();
  ctx.restore();
}

function drawConfiguredPath(ctx, ax, ay, bx, by, stub, style, sourceOffset, targetOffset) {
  const so = Number(sourceOffset) || 0;
  const to = Number(targetOffset) || 0;
  
  if (style === "hidden") {
    return; // Draw nothing
  }

  switch (style) {
    case "straight":
      drawStraightPath(ctx, ax, ay, bx, by, stub, so, to);
      break;
    case "angled":
      drawAngledPath(ctx, ax, ay, bx, by, stub, so, to);
      break;
    default:
      drawHybridPath(ctx, ax, ay, bx, by, stub);
      break;
  }
}

function drawStraightPath(ctx, ax, ay, bx, by, stub, sourceOffset, targetOffset) {
  const sourceY = ay + (Number(sourceOffset) || 0);
  const targetY = by + (Number(targetOffset) || 0);
  const startX = ax + stub;
  const endX = bx - stub;
  const needsDetour = endX <= startX + 8;
  const laneX = Math.max(startX, endX) + stub;
  const midX = (startX + endX) * 0.5;

  ctx.beginPath();
  ctx.moveTo(ax, ay);
  if (sourceY !== ay) ctx.lineTo(ax, sourceY);
  ctx.lineTo(startX, sourceY);
  if (needsDetour) {
    ctx.lineTo(laneX, sourceY);
    ctx.lineTo(laneX, targetY);
  } else {
    ctx.lineTo(midX, sourceY);
    ctx.lineTo(midX, targetY);
  }
  ctx.lineTo(endX, targetY);
  ctx.lineTo(bx, targetY);
  if (targetY !== by) ctx.lineTo(bx, by);
}

function drawAngledPath(ctx, ax, ay, bx, by, stub, sourceOffset, targetOffset) {
  const sourceY = ay + (Number(sourceOffset) || 0);
  const targetY = by + (Number(targetOffset) || 0);
  const startX = ax + stub;
  const endX = bx - stub;
  const needsDetour = endX <= startX + 8;
  const laneX = Math.max(startX, endX) + stub;

  ctx.beginPath();
  ctx.moveTo(ax, ay);
  if (sourceY !== ay) ctx.lineTo(ax, sourceY);
  ctx.lineTo(startX, sourceY);
  if (needsDetour) {
    ctx.lineTo(laneX, sourceY);
    ctx.lineTo(laneX, targetY);
    ctx.lineTo(endX, targetY);
  } else {
    ctx.lineTo(endX, targetY);
  }
  ctx.lineTo(bx, targetY);
  if (targetY !== by) ctx.lineTo(bx, by);
}

function drawHybridPath(ctx, ax, ay, bx, by, stub) {
  const startX = ax + stub;
  const endX = bx - stub;
  const needsDetour = endX <= startX + 8;
  const laneX = Math.max(startX, endX) + stub;
  const dx = Math.max(20, Math.min(140, Math.abs(endX - startX) * 0.5));

  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(startX, ay);
  if (needsDetour) {
    ctx.bezierCurveTo(laneX, ay, laneX, by, endX, by);
  } else {
    ctx.bezierCurveTo(startX + dx, ay, endX - dx, by, endX, by);
  }
  ctx.lineTo(bx, by);
}

function drawFlowOverlay(canvas, argsLike, animationTime, sourceOffset, targetOffset, styleOverride) {
  if (!canvas || !argsLike?.length) return;
  const ctx = argsLike[0];
  if (!ctx?.setLineDash) return;
  const a = argsLike[1], b = argsLike[2];
  if (!a || !b || a.length < 2 || b.length < 2) return;

  const ax = a[0], ay = a[1], bx = b[0], by = b[1];
  const settings = getFocusSettings();
  const dashOffset = -((animationTime || 0) * 0.028);
  const prevLineWidth = ctx.lineWidth || 1;
  const stub = settings.connectorStubLength;
  const style = styleOverride || settings.connectorStyle;

  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = Math.max(1.2, prevLineWidth + 0.4);
  ctx.strokeStyle = "#ffffff";
  ctx.setLineDash([6, 10]);
  ctx.lineDashOffset = dashOffset;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  drawConfiguredPath(ctx, ax, ay, bx, by, stub, style, sourceOffset || 0, targetOffset || 0);
  ctx.stroke();
  ctx.restore();
}

// ============================================================================
// Canvas Patches Installation
// ============================================================================

function initV2ConnectionFocusPatches() {
  if (!window.LGraphCanvas?.prototype || window.LGraphCanvas.prototype.__connectionFocusPatched) return;

  V2State.originalRenderLink = window.LGraphCanvas.prototype.renderLink;

  window.LGraphCanvas.prototype.renderLink = function(ctx, a, b) {
    const settings = getFocusSettings();
    if (!settings.enabled) return V2State.originalRenderLink.apply(this, arguments);

    const link = extractLinkInfo(arguments);
    if (!link) return V2State.originalRenderLink.apply(this, arguments);

    const originNode = this.graph.getNodeById(link.origin_id);
    const slotColor = getSlotColor(originNode, false, link.origin_slot);
    const focus = getActiveFocus(this);
    const isHiddenStyle = settings.connectorStyle === "hidden";

    // Visibility Check: If style is hidden and no node is being interacted with, draw nothing.
    if (isHiddenStyle && !focus) return;

    if (!focus) {
      return drawHardAngleLink(arguments, 0, 0, slotColor);
    }

    const linkKey = link.id != null ? link.id : null;
    const isConnected = focus.connectedLinkIds[linkKey] || focus.connectedLinkIds[String(linkKey)];

    // Unconnected links are invisible in Hidden mode, dimmed in others.
    if (!isConnected) {
      if (isHiddenStyle) return;
      ctx.save();
      ctx.globalAlpha *= 0.12;
      const result = drawHardAngleLink(arguments, 0, 0, slotColor);
      ctx.restore();
      return result;
    }

    // Resolve effective style
    const effectiveStyle = isHiddenStyle ? "hybrid" : settings.connectorStyle;
    
    let sourceOffset = 0, targetOffset = 0;
    if ((effectiveStyle === "straight" || effectiveStyle === "angled") && linkKey != null) {
      const laneOffset = Number(focus.linkLaneOffsets?.[String(linkKey)]) || 0;
      if (link.origin_id === focus.activeNodeId) sourceOffset = laneOffset;
      else if (link.target_id === focus.activeNodeId) targetOffset = laneOffset;
    }

    drawHardAngleLink(arguments, sourceOffset, targetOffset, slotColor, effectiveStyle);
    
    // Marching ants overlay on active links
    if (link.origin_id === focus.activeNodeId || link.target_id === focus.activeNodeId) {
      drawFlowOverlay(this, arguments, focus.animationTime || 0, sourceOffset, targetOffset, effectiveStyle);
      
      // Draw glowing port accents directly at wire endpoints on canvas for Nodes 2.0 alignment
      const pulseColor = slotColor || settings.pulseColor;
      if (link.origin_id === focus.activeNodeId) {
        drawSlotRingAtPoint(ctx, a[0], a[1] + sourceOffset, pulseColor);
      }
      if (link.target_id === focus.activeNodeId) {
        drawSlotRingAtPoint(ctx, b[0], b[1] + targetOffset, pulseColor);
      }
    }
  };

  window.LGraphCanvas.prototype.__connectionFocusPatched = true;
}

// ============================================================================
// Version 2 Setting Event Handlers & Dom Hooks
// ============================================================================

function handleSettingChange(settingId, value) {
  console.log('[BlockSpace V2] Setting changed:', settingId, '=', value);
  
  const visualSettings = [
    "BlockSpace.Snap.HighlightEnabled",
    "BlockSpace.Snap.HighlightColor",
    "BlockSpace.Snap.FeedbackPulseMs",
    "BlockSpace.EnableCustomConnectors",
    "BlockSpace.ConnectorStyle",
    "BlockSpace.ConnectorStubLength",
  ];

  if (visualSettings.includes(settingId)) {
    const canvas = getLGraphCanvas();
    if (canvas) markCanvasDirty(canvas);
  }
}

/**
 * Initialize V2 Adapter
 */
export function initV2Adapter() {
  console.log('[BlockSpace] V2 Adapter loaded (version:', V2_ADAPTER_VERSION, ')');
  
  exposeCoreMath();
  initV2ConnectionFocusPatches();

  // Pointer event handlers with capture-phase document listeners
  // This safely captures pointer clicks before Vue components stopPropagation
  const handlePointerdown = (event) => {
    if (!getFocusSettings().enabled) return;
    
    const nodeEl = event.target.closest("[data-node-id]");
    const canvas = getLGraphCanvas();
    
    if (nodeEl && canvas) {
      const nodeId = Number(nodeEl.getAttribute("data-node-id"));
      if (!isNaN(nodeId)) {
        setFocusState(canvas, nodeId);
      }
    } else {
      // If clicked on canvas background, clear focus unless clicking UI menu
      const isClickingUI = event.target.closest(".comfy-menu") || event.target.closest(".smart-drop-menu");
      if (!isClickingUI && canvas) {
        clearFocusState();
      }
    }
  };

  const handlePointerup = () => {
    if (focusState.isHolding) {
      clearFocusState();
    }
  };

  const handleBlur = () => {
    clearFocusState();
  };

  const handleKeydown = (event) => {
    if (event?.key === "Escape") {
      clearFocusState();
    }
  };

  // Keep references for clean hotswapping removal
  V2State.pointerdownHandler = handlePointerdown;
  V2State.pointerupHandler = handlePointerup;
  V2State.blurHandler = handleBlur;
  V2State.keydownHandler = handleKeydown;

  // Add event listeners on document in capture phase (true)
  document.addEventListener("pointerdown", handlePointerdown, true);
  document.addEventListener("pointerup", handlePointerup, true);
  window.addEventListener("blur", handleBlur, true);
  document.addEventListener("keydown", handleKeydown, true);

  // Subscribe to settings updates
  V2State.settingsUnsubscribe = onAnySettingChanged(handleSettingChange);
  
  // Start continuous global selection highlighting loop
  startGlobalAnimationLoop();
  
  return true;
}

/**
 * Cleanup V2 Adapter
 */
export function cleanupV2Adapter() {
  console.log('[BlockSpace] V2 Adapter cleanup');
  
  // Unsubscribe settings
  if (V2State.settingsUnsubscribe) {
    V2State.settingsUnsubscribe();
    V2State.settingsUnsubscribe = null;
  }

  // Remove capture phase document event listeners
  if (V2State.pointerdownHandler) {
    document.removeEventListener("pointerdown", V2State.pointerdownHandler, true);
    V2State.pointerdownHandler = null;
  }
  if (V2State.pointerupHandler) {
    document.removeEventListener("pointerup", V2State.pointerupHandler, true);
    V2State.pointerupHandler = null;
  }
  if (V2State.blurHandler) {
    window.removeEventListener("blur", V2State.blurHandler, true);
    V2State.blurHandler = null;
  }
  if (V2State.keydownHandler) {
    document.removeEventListener("keydown", V2State.keydownHandler, true);
    V2State.keydownHandler = null;
  }

  // Unpatch renderLink
  if (V2State.originalRenderLink) {
    window.LGraphCanvas.prototype.renderLink = V2State.originalRenderLink;
    V2State.originalRenderLink = null;
  }
  if (window.LGraphCanvas?.prototype) {
    window.LGraphCanvas.prototype.__connectionFocusPatched = false;
  }

  stopAnimationLoop();
  stopGlobalAnimationLoop();
  clearFocusState();
}

/**
 * Expose core math functions for other V2 extensions
 */
function exposeCoreMath() {
  if (typeof window !== 'undefined') {
    window.BlockSpaceCoreMathV2 = {
      // Settings
      getSettingValue,
      getHSnapMargin,
      getVSnapMargin,
      getSnapThreshold,
      isSnappingEnabled,
      getMoveSnapStrength,
      getResizeSnapStrength,
      getMoveYSnapStrength,
      getDimensionTolerancePx,
      getHighlightEnabled,
      getHighlightColor,
      getFeedbackEnabled,
      getFeedbackPulseMs,
      getFeedbackColorX,
      getFeedbackColorY,
      getFeedbackColorXY,
      // Math
      clampNumber,
      rangesOverlap,
      // Geometry
      getNodeBounds,
      // Clustering
      buildDimensionClusters,
      pickNearestMoveCluster,
      pickDirectionalCluster,
      // Raycasting
      getRaycastNeighbors,
    };
  }
}

/**
 * Placeholder for future V2 node tracking
 */
export function trackV2Node(nodeId) {
  console.warn('[BlockSpace] trackV2Node not implemented');
}

/**
 * Placeholder for future V2 snap application
 */
export function applyV2Snap(nodeId, x, y) {
  console.warn('[BlockSpace] applyV2Snap not implemented');
}

export default {
  initV2Adapter,
  cleanupV2Adapter,
  trackV2Node,
  applyV2Snap,
  version: V2_ADAPTER_VERSION,
};
