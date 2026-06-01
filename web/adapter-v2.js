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
  getNodeBounds as getNodeBoundsMath,
  buildDimensionClusters,
  pickNearestMoveCluster,
  pickDirectionalCluster,
  getRaycastNeighbors,
  getRaycastNeighborsMulti,
  computeWinningXCandidate,
  getSettingValue,
  getHSnapMargin,
  getVSnapMargin,
  getSnapThreshold,
  isSnappingEnabled,
  getMoveSnapStrength,
  getResizeSnapStrength,
  getMoveYSnapStrength,
  getExitThresholdMultiplier,
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
// V2 Bounding Box helper - Accounts for V2 card's 40px title bar height
// ============================================================================
function getNodeBounds(node) {
  if (!node || !node.pos || !node.size) return null;
  const left = Number(node.pos[0]) || 0;
  const top = Number(node.pos[1]) || 0;
  const width = Math.max(0, Number(node.size[0]) || 0);
  const contentHeight = Math.max(0, Number(node.size[1]) || 0);
  const totalHeight = contentHeight + 40;

  return {
    left: left,
    right: left + width,
    top: top,
    bottom: top + totalHeight,
    centerX: left + width * 0.5,
    centerY: top + (totalHeight * 0.5),
  };
}

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
  pointermoveHandler: null,
  blurHandler: null,
  keydownHandler: null,
  originalRenderLink: null,
  globalAnimationId: null,
  originalProcessMouseMove: null,
  originalProcessMouseUp: null,
  originalProcessMouseDown: null,
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
  initNodeSnappingPatches();
  initUnifiedMouseUpHandler();

  // Pointer event handlers with capture-phase document listeners
  // This safely captures pointer clicks before Vue components stopPropagation
  const handlePointerdown = (event) => {
    const target = event.target;
    if (target) {
      // 1. Exclude ports/sockets so we don't snap/move nodes while dragging connections in Nodes 2.0
      const isPort = target.closest(".lg-port") || 
                     target.closest(".comfy-port") || 
                     target.closest(".port") || 
                     target.closest(".socket") || 
                     target.closest("[data-port-name]") || 
                     target.closest("[data-port-type]") || 
                     target.closest("[data-slot]") || 
                     target.closest(".slot") || 
                     target.closest(".lg-node-port") || 
                     target.closest(".lg-node-slot") || 
                     target.closest(".port-circle");

      // 2. Exclude interactive form inputs and custom widgets
      const isInput = target.tagName === "INPUT" || 
                      target.tagName === "TEXTAREA" || 
                      target.tagName === "SELECT" || 
                      target.tagName === "BUTTON" || 
                      target.tagName === "CANVAS";

      const isWidgetElement = target.closest(".comfy-node-widgets") || 
                              target.closest(".node-widgets") || 
                              target.closest("[data-widget-name]") ||
                              target.classList.contains("comfy-widget") ||
                              target.closest(".comfy-widget") ||
                              target.closest(".lg-widget") ||
                              target.closest(".custom-widget");

      if (isPort || isInput || isWidgetElement) {
        if (isInput || isWidgetElement) {
          event.stopPropagation();
        }
        return; // Exit early: do not initiate node snapping/dragging
      }
    }

    const focusEnabled = getFocusSettings().enabled;
    const snapEnabled = isSnappingEnabled();
    if (!focusEnabled && !snapEnabled) return;
    
    let nodeEl = event.target.closest("[data-node-id]");
    const canvas = getLGraphCanvas();
    
    // Fallback: If clicked on a selection outline or overlay that blocks data-node-id,
    // but the click is physically inside the already selected node's bounds, use that!
    if (!nodeEl && canvas) {
      const activeNode = canvas.current_node || (canvas.selected_nodes && Object.values(canvas.selected_nodes)[0]);
      if (activeNode) {
        const bounds = getNodeBounds(activeNode);
        if (bounds) {
          const mouseGraph = clientToGraph(canvas, event.clientX, event.clientY);
          if (mouseGraph.x >= bounds.left && mouseGraph.x <= bounds.right &&
              mouseGraph.y >= bounds.top && mouseGraph.y <= bounds.bottom) {
            nodeEl = document.querySelector(`[data-node-id="${activeNode.id}"]`);
          }
        }
      }
    }
    
    if (nodeEl && canvas) {
      const nodeIdAttr = nodeEl.getAttribute("data-node-id");
      let nodeId = Number(nodeIdAttr);
      if (isNaN(nodeId)) {
        nodeId = nodeIdAttr;
      }
      if (nodeId != null) {
        setFocusState(canvas, nodeId);
        
        // Track the initial drag offsets
        const activeNode = canvas.graph?.getNodeById(nodeId);
        if (activeNode && activeNode.pos) {
          const mouseGraph = clientToGraph(canvas, event.clientX, event.clientY);
          focusState.dragOffsetX = mouseGraph.x - activeNode.pos[0];
          focusState.dragOffsetY = mouseGraph.y - activeNode.pos[1];
        }
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
    const canvas = focusState.activeCanvas || getLGraphCanvas();
    if (canvas) {
      const nodeHint = canvas.resizing_node || (focusState.activeNodeId != null ? canvas.graph?.getNodeById(focusState.activeNodeId) : null);
      if (nodeHint) {
        maybeCommitSnapOnMouseUp(canvas, nodeHint);
      }
      clearSnapVisual(canvas);
      clearSnapFeedbackState(canvas);
      canvas.__blockSpacePrevDragPoint = null;
      canvas.__blockSpaceMoveXPointMemory = null;
      canvas.__blockSpaceMoveYPointMemory = null;
      canvas.__blockSpacePrevResizeSize = null;
      canvas.__blockSpaceResizeDimensionMemory = null;
      canvas.__blockSpaceResizeDebugStatus = null;
      canvas.__blockSpaceRecentSnap = null;
      renderResizeDebugHud(canvas);
    }
    
    if (focusState.isHolding) {
      clearFocusState();
    }
  };

  const handlePointermove = (event) => {
    const focusEnabled = getFocusSettings().enabled;
    const snapEnabled = isSnappingEnabled();
    if (!focusEnabled && !snapEnabled) return;
    if (event.shiftKey) return;
    
    if (focusState.isHolding && focusState.activeCanvas && focusState.activeNodeId != null) {
      const canvas = focusState.activeCanvas;
      const activeNode = canvas.graph?.getNodeById(focusState.activeNodeId);
      
      if (activeNode && snapEnabled && focusState.dragOffsetX != null && focusState.dragOffsetY != null) {
        const mouseGraph = clientToGraph(canvas, event.clientX, event.clientY);
        const unsnappedX = mouseGraph.x - focusState.dragOffsetX;
        const unsnappedY = mouseGraph.y - focusState.dragOffsetY;
        
        const snap = calculateV2Snap(activeNode, unsnappedX, unsnappedY);
        
        // Update debug HUD status synchronously so outlines render immediately
        canvas.__blockSpaceResizeDebugStatus = {
          active: true,
          axis: "move",
          activeNode: activeNode,
          xDidSnap: snap.xDidSnapMove,
          yDidSnap: snap.yDidSnapMove,
          xWinnerNodes: snap.xWinnerNodes,
          yWinnerNodes: snap.yWinnerNodes,
          activeCenterX: snap.centerX,
          activeCenterY: snap.centerY,
        };
        
        if (snap.didSnap) {
          rememberRecentSnap(canvas, {
            kind: "move",
            nodeId: activeNode.id,
            threshold: Math.max(snap.thresholdCanvasX, snap.thresholdCanvasY),
            xDidSnap: snap.xDidSnapMove,
            yDidSnap: snap.yDidSnapMove,
            xTarget: snap.xDidSnapMove ? snap.snappedX : null,
            yTarget: snap.yDidSnapMove ? snap.snappedY : null,
          });
          triggerSnapFeedback(canvas, activeNode, snap.xDidSnapMove, snap.yDidSnapMove);
          
          // Modify PointerEvent clientX and clientY synchronously using defineProperty
          const snappedMouseGraphX = snap.xDidSnapMove ? (snap.snappedX + focusState.dragOffsetX) : mouseGraph.x;
          const snappedMouseGraphY = snap.yDidSnapMove ? (snap.snappedY + focusState.dragOffsetY) : mouseGraph.y;
          const snappedClient = graphToClient(canvas, snappedMouseGraphX, snappedMouseGraphY);
          
          if (snappedClient) {
            try {
              Object.defineProperty(event, 'clientX', { value: snappedClient.x, configurable: true });
              Object.defineProperty(event, 'clientY', { value: snappedClient.y, configurable: true });
            } catch (err) {
              // Ignore defineProperty errors on read-only event objects
            }
          }
          
          // Apply snapped position reactively so Vue updates the DOM element
          activeNode.pos = [snap.snappedX, snap.snappedY];
        } else {
          canvas.__blockSpaceRecentSnap = null;
        }
        
        updateSnapFeedback(canvas);
        renderResizeDebugHud(canvas);
        markCanvasDirty(canvas);
      }
    }
  };

  const handleBlur = (event) => {
    if (event && event.target !== window && event.target !== document) {
      return;
    }
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
  V2State.pointermoveHandler = handlePointermove;
  V2State.blurHandler = handleBlur;
  V2State.keydownHandler = handleKeydown;

  // Add event listeners on document in capture phase (true)
  document.addEventListener("pointerdown", handlePointerdown, true);
  document.addEventListener("pointerup", handlePointerup, true);
  document.addEventListener("pointermove", handlePointermove, true); // capture phase to intercept even if propagation is stopped
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
  if (V2State.pointermoveHandler) {
    document.removeEventListener("pointermove", V2State.pointermoveHandler, true);
    V2State.pointermoveHandler = null;
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

  // Unpatch processMouseMove / processMouseUp
  if (V2State.originalProcessMouseMove) {
    window.LGraphCanvas.prototype.processMouseMove = V2State.originalProcessMouseMove;
    V2State.originalProcessMouseMove = null;
  }
  if (V2State.originalProcessMouseUp) {
    window.LGraphCanvas.prototype.processMouseUp = V2State.originalProcessMouseUp;
    V2State.originalProcessMouseUp = null;
  }
  if (window.LGraphCanvas?.prototype) {
    window.LGraphCanvas.prototype.__blockSpaceNodeSnapPatched = false;
  }

  clearDimensionAssociationLayer();
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

// ============================================================================
// Node Snapping Helper Functions
// ============================================================================

const SNAP_THRESHOLD = 10;
const SNAP_MOUSEUP_GRACE_MS = 220;
const SNAP_MOUSEUP_TOLERANCE_MULTIPLIER = 1.8;
const DIMENSION_ASSOC_LAYER_ID = "block-space-dimension-association-layer";

function getCanvasScale(canvas) {
  const scale = canvas && canvas.ds ? Number(canvas.ds.scale) : 1;
  return isFinite(scale) && scale > 0 ? scale : 1;
}

function isLeftMouseDown(event) {
  if (!event) return false;
  const buttons = Number(event.buttons);
  if (isFinite(buttons) && buttons >= 0) return (buttons & 1) === 1;
  const which = Number(event.which);
  return which === 1;
}

function getActiveDraggedNode(canvas, event) {
  if (!canvas) return null;
  if (canvas.dragging_canvas || canvas.resizing_node || canvas.selected_group_resizing) return null;
  if (canvas.node_dragged && canvas.node_dragged.pos && canvas.node_dragged.size) return canvas.node_dragged;
  // Fallback is disabled in V2 to prevent the connection-dragging node-jumping bug.
  // V2 node dragging snapping is handled natively by handlePointermove.
  return null;
}

function getGraphNodes(canvas) {
  if (!canvas || !canvas.graph || !Array.isArray(canvas.graph._nodes)) return [];
  return canvas.graph._nodes;
}

function ensureResizeDimensionMemory(canvas, resizingNode) {
  if (!canvas || !resizingNode) return null;
  const memory = canvas.__blockSpaceResizeDimensionMemory;
  if (memory && memory.nodeId === resizingNode.id) return memory;

  const allNodes = getGraphNodes(canvas);
  const activeBounds = getNodeBounds(resizingNode);
  if (!activeBounds) return null;

  const padding = 300;
  const targetNodes = [];
  for (const n of allNodes) {
    if (!n || n === resizingNode || n.constructor?.name === "LGraphGroup") continue;
    const b = getNodeBounds(n);
    if (!b) continue;
    const isNearX = b.right >= (activeBounds.left - padding) && b.left <= (activeBounds.right + padding);
    const isNearY = b.bottom >= (activeBounds.top - padding) && b.top <= (activeBounds.bottom + padding);
    if (isNearX && isNearY) targetNodes.push(n);
  }

  const widthSamples = [], heightSamples = [], rightEdgeSamples = [], bottomEdgeSamples = [];
  const hSnapMargin = getHSnapMargin();
  const vSnapMargin = getVSnapMargin();

  for (const node of targetNodes) {
    const bounds = getNodeBounds(node);
    if (!bounds) continue;
    const targetWidth = bounds.right - bounds.left;
    const targetHeight = bounds.bottom - bounds.top;
    if (isFinite(targetWidth) && targetWidth > 0) widthSamples.push({ value: targetWidth, node });
    if (isFinite(targetHeight) && targetHeight > 0) heightSamples.push({ value: targetHeight, node });
    rightEdgeSamples.push({ value: bounds.right, node }, { value: bounds.left, node }, { value: bounds.left - hSnapMargin, node });
    bottomEdgeSamples.push({ value: bounds.bottom, node }, { value: bounds.top, node });
    bottomEdgeSamples.push({ value: bounds.top - vSnapMargin, node, edge: 'top' });
  }

  const tolerancePx = getDimensionTolerancePx();
  const newMemory = {
    nodeId: resizingNode.id,
    tolerancePx,
    widthClusters: buildDimensionClusters(widthSamples, tolerancePx),
    heightClusters: buildDimensionClusters(heightSamples, tolerancePx),
    rightEdgeClusters: buildDimensionClusters(rightEdgeSamples, tolerancePx),
    bottomEdgeClusters: buildDimensionClusters(bottomEdgeSamples, tolerancePx),
    sampleNodeCount: Math.max(widthSamples.length, heightSamples.length),
    createdAt: Date.now(),
  };
  canvas.__blockSpaceResizeDimensionMemory = newMemory;
  return newMemory;
}

function ensureMoveYPointMemory(canvas, activeNode, vSnapMargin) {
  if (!canvas || !activeNode) return null;
  const memory = canvas.__blockSpaceMoveYPointMemory;
  if (memory && memory.nodeId === activeNode.id) return memory;

  const allNodes = getGraphNodes(canvas);
  const activeBounds = getNodeBounds(activeNode);
  if (!activeBounds) return null;

  const selectedNodesMap = canvas.selected_nodes || null;
  const padding = 2000;
  const points = [];
  const activeHeight = activeBounds.bottom - activeBounds.top;

  for (const node of allNodes) {
    if (!node || node === activeNode || node.constructor?.name === "LGraphGroup") continue;
    if (selectedNodesMap && node.id != null && selectedNodesMap[node.id]) continue;
    const bounds = getNodeBounds(node);
    if (!bounds) continue;
    const isNearX = bounds.right >= (activeBounds.left - padding) && bounds.left <= (activeBounds.right + padding);
    const isNearY = bounds.bottom >= (activeBounds.top - padding) && bounds.top <= (activeBounds.bottom + padding);
    if (isNearX && isNearY) {
      points.push({ value: bounds.top, node, type: "top_flush" });
      points.push({ value: bounds.bottom - activeHeight, node, type: "bottom_flush" });
      points.push({ value: bounds.bottom + vSnapMargin, node, type: "stack_below" });
      points.push({ value: bounds.top - vSnapMargin - activeHeight, node, type: "stack_above" });
    }
  }

  const newMemory = { nodeId: activeNode.id, tolerancePx: getDimensionTolerancePx(), points, createdAt: Date.now() };
  canvas.__blockSpaceMoveYPointMemory = newMemory;
  return newMemory;
}

function ensureMoveXPointMemory(canvas, activeNode, hSnapMargin) {
  if (!canvas || !activeNode) return null;
  const memory = canvas.__blockSpaceMoveXPointMemory;
  if (memory && memory.nodeId === activeNode.id) return memory;

  const allNodes = getGraphNodes(canvas);
  const activeBounds = getNodeBounds(activeNode);
  if (!activeBounds) return null;

  const selectedNodesMap = canvas.selected_nodes || null;
  const padding = 2000;
  const points = [];
  const activeWidth = activeBounds.right - activeBounds.left;

  for (const node of allNodes) {
    if (!node || node === activeNode || node.constructor?.name === "LGraphGroup") continue;
    if (selectedNodesMap && node.id != null && selectedNodesMap[node.id]) continue;
    const bounds = getNodeBounds(node);
    if (!bounds) continue;
    const isNearX = bounds.right >= (activeBounds.left - padding) && bounds.left <= (activeBounds.right + padding);
    const isNearY = bounds.bottom >= (activeBounds.top - padding) && bounds.top <= (activeBounds.bottom + padding);
    if (isNearX && isNearY) {
      points.push({ value: bounds.left, node, type: "left_flush" });
      points.push({ value: bounds.right - activeWidth, node, type: "right_flush" });
      points.push({ value: bounds.left + (bounds.right - bounds.left) * 0.5 - activeWidth * 0.5, node, type: "center_flush" });
      points.push({ value: bounds.right + hSnapMargin, node, type: "stack_right" });
      points.push({ value: bounds.left - hSnapMargin - activeWidth, node, type: "stack_left" });
    }
  }

  const newMemory = { nodeId: activeNode.id, tolerancePx: getDimensionTolerancePx(), points, createdAt: Date.now() };
  canvas.__blockSpaceMoveXPointMemory = newMemory;
  return newMemory;
}

function getDragDelta(canvas, event) {
  if (!canvas || !event || typeof event.canvasX !== "number" || typeof event.canvasY !== "number") return { dx: 0, dy: 0 };
  const prev = canvas.__blockSpacePrevDragPoint;
  const current = { x: event.canvasX, y: event.canvasY };
  canvas.__blockSpacePrevDragPoint = current;
  if (!prev) return { dx: 0, dy: 0 };
  return { dx: current.x - prev.x, dy: current.y - prev.y };
}

function getResizeDelta(canvas, node) {
  if (!canvas || !node || !node.size || node.size.length < 2) return { dw: 0, dh: 0 };
  const current = { id: node.id != null ? node.id : null, w: Number(node.size[0]) || 0, h: Number(node.size[1]) || 0 };
  const prev = canvas.__blockSpacePrevResizeSize;
  canvas.__blockSpacePrevResizeSize = current;
  if (!prev || prev.id !== current.id) return { dw: 0, dh: 0 };
  return { dw: current.w - prev.w, dh: current.h - prev.h };
}

function getNodeMinSize(node) {
  let minWidth = 10, minHeight = 10;
  if (!node) return [minWidth, minHeight];
  if (node.min_size && node.min_size.length >= 2) {
    minWidth = Math.max(minWidth, Number(node.min_size[0]) || minWidth);
    minHeight = Math.max(minHeight, Number(node.min_size[1]) || minHeight);
  }
  return [minWidth, minHeight];
}

function applyResizeSnapping(canvas, resizingNode) {
  if (!canvas || !resizingNode || resizingNode.constructor?.name === "LGraphGroup") return false;
  const bounds = getNodeBounds(resizingNode);
  if (!bounds) return false;

  const thresholdCanvas = (SNAP_THRESHOLD / Math.max(0.0001, getCanvasScale(canvas))) * getResizeSnapStrength() * 1.5;
  const exitThresholdCanvas = thresholdCanvas * getExitThresholdMultiplier();
  const currentWidth = bounds.right - bounds.left;
  const currentHeight = bounds.bottom - bounds.top;
  const currentRight = bounds.right;
  const currentBottom = bounds.bottom;
  const minSize = getNodeMinSize(resizingNode);
  const memory = ensureResizeDimensionMemory(canvas, resizingNode);

  const widthWinner = memory ? pickDirectionalCluster(memory.widthClusters, currentWidth, "steady") : null;
  const heightWinner = memory ? pickDirectionalCluster(memory.heightClusters, currentHeight, "steady") : null;
  const rightEdgeWinner = memory ? pickNearestMoveCluster(memory.rightEdgeClusters, currentRight) : null;
  const bottomEdgeWinner = memory ? pickNearestMoveCluster(memory.bottomEdgeClusters, currentBottom) : null;

  let didSnap = false;
  let bestXWidth = null, bestXDelta = Infinity, bestXMode = null, bestXNodes = [];

  if (widthWinner) {
    bestXDelta = Math.abs(currentWidth - widthWinner.center);
    bestXWidth = widthWinner.center;
    bestXMode = "dimension_match";
    const closest = widthWinner.members.slice().sort((a, b) => {
      const boundsA = a.node ? getNodeBounds(a.node) : null;
      const boundsB = b.node ? getNodeBounds(b.node) : null;
      if (!boundsA) return 1;
      if (!boundsB) return -1;
      const distA = Math.hypot(boundsA.centerX - bounds.centerX, boundsA.centerY - bounds.centerY);
      const distB = Math.hypot(boundsB.centerX - bounds.centerX, boundsB.centerY - bounds.centerY);
      return distA - distB;
    })[0];
    if (closest?.node) bestXNodes = [closest.node];
  }
  if (rightEdgeWinner) {
    const edgeDelta = Math.abs(currentRight - rightEdgeWinner.center);
    if (edgeDelta < (bestXDelta - 2)) {
      bestXDelta = edgeDelta;
      bestXWidth = rightEdgeWinner.center - bounds.left;
      bestXMode = "edge_align_right";
      const closest = rightEdgeWinner.members.slice().sort((a, b) => {
        const boundsA = a.node ? getNodeBounds(a.node) : null;
        const boundsB = b.node ? getNodeBounds(b.node) : null;
        if (!boundsA) return 1;
        if (!boundsB) return -1;
        const distA = Math.hypot(boundsA.centerX - bounds.centerX, boundsA.centerY - bounds.centerY);
        const distB = Math.hypot(boundsB.centerX - bounds.centerX, boundsB.centerY - bounds.centerY);
        return distA - distB;
      })[0];
      if (closest?.node) bestXNodes = [closest.node];
    }
  }

  const recentSnap = canvas.__blockSpaceRecentSnap;
  const wasSnappedX = recentSnap && recentSnap.kind === "resize" && recentSnap.nodeId === resizingNode.id && recentSnap.xDidSnap;
  const currentThresholdX = wasSnappedX ? exitThresholdCanvas : thresholdCanvas;

  if (bestXWidth !== null && bestXDelta <= currentThresholdX) {
    const nextWidth = Math.max(minSize[0], bestXWidth);
    if (isFinite(nextWidth) && Math.abs(nextWidth - currentWidth) > 0.01) {
      resizingNode.size[0] = nextWidth;
      didSnap = true;
    }
  }

  let bestYHeight = null, bestYDelta = Infinity, bestYMode = null, bestYNodes = [];
  const titleH = 40;

  if (heightWinner) {
    bestYDelta = Math.abs(currentHeight - heightWinner.center);
    bestYHeight = heightWinner.center;
    bestYMode = "dimension_match";
    const closest = heightWinner.members.slice().sort((a, b) => {
      const boundsA = a.node ? getNodeBounds(a.node) : null;
      const boundsB = b.node ? getNodeBounds(b.node) : null;
      if (!boundsA) return 1;
      if (!boundsB) return -1;
      const distA = Math.hypot(boundsA.centerX - bounds.centerX, boundsA.centerY - bounds.centerY);
      const distB = Math.hypot(boundsB.centerX - bounds.centerX, boundsB.centerY - bounds.centerY);
      return distA - distB;
    })[0];
    if (closest?.node) bestYNodes = [closest.node];
  }
  if (bottomEdgeWinner) {
    const edgeDeltaY = Math.abs(currentBottom - bottomEdgeWinner.center);
    if (edgeDeltaY < (bestYDelta - 2)) {
      bestYDelta = edgeDeltaY;
      bestYHeight = bottomEdgeWinner.center - bounds.top;
      bestYMode = "edge_align_bottom";
      const closest = bottomEdgeWinner.members.slice().sort((a, b) => {
        const boundsA = a.node ? getNodeBounds(a.node) : null;
        const boundsB = b.node ? getNodeBounds(b.node) : null;
        if (!boundsA) return 1;
        if (!boundsB) return -1;
        const distA = Math.hypot(boundsA.centerX - bounds.centerX, boundsA.centerY - bounds.centerY);
        const distB = Math.hypot(boundsB.centerX - bounds.centerX, boundsB.centerY - bounds.centerY);
        return distA - distB;
      })[0];
      if (closest?.node) bestYNodes = [closest.node];
    }
  }

  const wasSnappedY = recentSnap && recentSnap.kind === "resize" && recentSnap.nodeId === resizingNode.id && recentSnap.yDidSnap;
  const currentThresholdY = wasSnappedY ? exitThresholdCanvas : thresholdCanvas;

  if (bestYHeight !== null && bestYDelta <= currentThresholdY) {
    const nextContentHeight = bestYHeight;
    if (isFinite(nextContentHeight) && Math.abs(nextContentHeight - resizingNode.size[1]) > 0.01) {
      resizingNode.size[1] = nextContentHeight;
      didSnap = true;
    }
  }

  const xDidSnap = bestXWidth !== null && bestXDelta <= currentThresholdX;
  const yDidSnap = bestYHeight !== null && bestYDelta <= currentThresholdY;
  
  canvas.__blockSpaceResizeDebugStatus = {
    active: true,
    axis: "resize",
    activeNode: resizingNode,
    xDidSnap: xDidSnap,
    yDidSnap: yDidSnap,
    xWinnerNodes: bestXNodes,
    yWinnerNodes: bestYNodes,
    activeLeft: bounds.left,
    activeTop: bounds.top,
    xTarget: xDidSnap ? bestXWidth : null,
    yTarget: yDidSnap ? bestYHeight : null,
  };

  return didSnap;
}

function clearSnapVisual(canvas) {
  if (!canvas || !canvas.__blockSpaceWinnerHighlight) return;
  canvas.__blockSpaceWinnerHighlight = null;
  canvas.dirty_canvas = true;
  canvas.dirty_bgcanvas = true;
}

function resetPersistedHighlightArtifacts(canvas) {
  clearSnapFeedbackState(canvas, true);
  if (!canvas) return;
  const nodes = getGraphNodes(canvas);
  let changed = false;
  for (const node of nodes) {
    if (!node || node.constructor?.name === "LGraphGroup") continue;
    if (Object.prototype.hasOwnProperty.call(node, "boxcolor")) {
      delete node.boxcolor;
      changed = true;
    }
  }
  if (changed) {
    canvas.dirty_canvas = true;
    canvas.dirty_bgcanvas = true;
  }
}

function rememberRecentSnap(canvas, snap) {
  if (!canvas || !snap) return;
  snap.at = Date.now();
  canvas.__blockSpaceRecentSnap = snap;
}

function getNodeById(nodes, id) {
  if (!nodes || id == null) return null;
  for (const node of nodes) {
    if (node && node.id === id) return node;
  }
  return null;
}

function maybeCommitSnapOnMouseUp(canvas, nodeHint) {
  if (!canvas) return false;
  const snap = canvas.__blockSpaceRecentSnap;
  if (!snap || !snap.at || Date.now() - snap.at > SNAP_MOUSEUP_GRACE_MS) return false;

  let node = nodeHint;
  if (!node || (snap.nodeId != null && node.id !== snap.nodeId)) {
    node = getNodeById(getGraphNodes(canvas), snap.nodeId);
  }
  if (!node || node.constructor?.name === "LGraphGroup" || !node.pos || !node.size) return false;

  const bounds = getNodeBounds(node);
  if (!bounds) return false;

  const tolerance = Math.max(2, (Number(snap.threshold) || 0) * SNAP_MOUSEUP_TOLERANCE_MULTIPLIER);
  let appliedX = false, appliedY = false;

  if (snap.kind === "move") {
    if (snap.xDidSnap && typeof snap.xTarget === "number" && Math.abs(bounds.left - snap.xTarget) <= tolerance) {
      node.pos[0] = snap.xTarget;
      appliedX = true;
    }
    if (snap.yDidSnap && typeof snap.yTarget === "number" && Math.abs(bounds.top - snap.yTarget) <= tolerance) {
      node.pos[1] = snap.yTarget;
      appliedY = true;
    }
  } else if (snap.kind === "resize") {
    const minSize = getNodeMinSize(node);
    const titleH = 40;
    if (snap.xDidSnap && typeof snap.xTargetRight === "number" && Math.abs(bounds.right - snap.xTargetRight) <= tolerance) {
      node.size[0] = Math.max(minSize[0], snap.xTargetRight - bounds.left);
      appliedX = true;
    }
    if (snap.yDidSnap && typeof snap.yTargetBottom === "number" && Math.abs(bounds.bottom - snap.yTargetBottom) <= tolerance) {
      node.size[1] = snap.yTargetBottom - bounds.top;
      appliedY = true;
    }
  }

  return appliedX || appliedY;
}

function ensureDimensionAssociationLayer() {
  let layer = document.getElementById(DIMENSION_ASSOC_LAYER_ID);
  if (layer) return layer;
  layer = document.createElement("div");
  layer.id = DIMENSION_ASSOC_LAYER_ID;
  layer.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;";
  document.body.appendChild(layer);
  return layer;
}

function clearDimensionAssociationLayer() {
  const layer = document.getElementById(DIMENSION_ASSOC_LAYER_ID);
  if (layer?.parentNode) layer.parentNode.removeChild(layer);
}

function graphToClient(canvas, x, y) {
  if (window.app?.positionConversion?.canvasPosToClientPos) {
    const res = window.app.positionConversion.canvasPosToClientPos([x, y]);
    return { x: res[0], y: res[1] };
  }
  if (!canvas?.canvas) return null;
  const rect = canvas.canvas.getBoundingClientRect();
  const scale = getCanvasScale(canvas);
  const offset = canvas.ds?.offset || [0, 0];
  return {
    x: rect.left + (x + (Number(offset[0]) || 0)) * scale,
    y: rect.top + (y + (Number(offset[1]) || 0)) * scale,
  };
}

function clientToGraph(canvas, clientX, clientY) {
  if (window.app?.positionConversion?.clientPosToCanvasPos) {
    const res = window.app.positionConversion.clientPosToCanvasPos([clientX, clientY]);
    return { x: res[0], y: res[1] };
  }
  if (!canvas?.canvas) return { x: clientX, y: clientY };
  const rect = canvas.canvas.getBoundingClientRect();
  const scale = getCanvasScale(canvas);
  const offset = canvas.ds?.offset || [0, 0];
  return {
    x: (clientX - rect.left) / scale - (Number(offset[0]) || 0),
    y: (clientY - rect.top) / scale - (Number(offset[1]) || 0),
  };
}

function renderDimensionAssociationHighlights(canvas, status) {
  const layer = ensureDimensionAssociationLayer();
  if (!layer) return;
  while (layer.firstChild) layer.removeChild(layer.firstChild);
  if (!canvas || !status?.active) return;
  if (!getHighlightEnabled()) return;

  const scale = getCanvasScale(canvas);
  const borderW = 2;
  const guideColor = getHighlightColor();

  function appendLine(x, y, w, h, color) {
    const line = document.createElement("div");
    line.style.cssText = `position:fixed;left:${Math.round(x)}px;top:${Math.round(y)}px;width:${Math.max(0, Math.round(w))}px;height:${Math.max(0, Math.round(h))}px;border:${borderW}px dotted ${color};box-sizing:border-box;opacity:0.95;`;
    layer.appendChild(line);
  }

  const nodeMap = {};
  function trackNode(node, axis) {
    if (!node?.id) return;
    const key = String(node.id);
    if (!nodeMap[key]) nodeMap[key] = { node, width: false, height: false };
    nodeMap[key][axis] = true;
  }

  const xNodes = status.xDidSnap ? (status.xWinnerNodes || []) : [];
  const yNodes = status.yDidSnap ? (status.yWinnerNodes || []) : [];
  for (const n of xNodes) trackNode(n, "width");
  for (const n of yNodes) trackNode(n, "height");

  const titleH = 40;

  for (const key in nodeMap) {
    if (!Object.prototype.hasOwnProperty.call(nodeMap, key)) continue;
    const item = nodeMap[key];
    const bounds = getNodeBounds(item.node);
    if (!bounds) continue;

    const el = document.querySelector(`[data-node-id="${item.node.id}"]`);
    let left, right, width, height, top, bottom;
    let useDOM = false;

    if (el) {
      const rect = el.getBoundingClientRect();
      left = rect.left;
      right = rect.right;
      width = rect.width;
      height = rect.height;
      top = rect.top;
      bottom = rect.bottom;
      useDOM = true;
    } else {
      const topLeftFull = graphToClient(canvas, bounds.left, bounds.top);
      if (!topLeftFull) continue;
      left = topLeftFull.x;
      width = Math.max(0, (bounds.right - bounds.left) * scale);
      right = left + width;
      
      top = graphToClient(canvas, bounds.left, bounds.top).y;
      bottom = graphToClient(canvas, bounds.left, bounds.bottom).y;
      height = bottom - top;
    }

    if (item.width) {
      if (status && status.axis === "move") {
        const activeCenterX = status.activeCenterX ?? bounds.left;
        const targetCenterX = bounds.left + (bounds.right - bounds.left) / 2;
        const useLeft = activeCenterX < targetCenterX;
        
        let lineXClient = useLeft ? left : right;
        if (!useLeft) lineXClient -= borderW;
        appendLine(lineXClient, top, borderW, height, guideColor);
      } else {
        appendLine(left, top, borderW, height, guideColor);
        appendLine(right - borderW, top, borderW, height, guideColor);
      }
    }
    if (item.height) {
      if (status && status.axis === "move") {
        const activeCenterY = status.activeCenterY ?? bounds.top;
        const targetCenterY = bounds.top + (bounds.bottom - bounds.top) / 2;
        const useTop = activeCenterY < targetCenterY;
        
        const anchorCanvasY = useTop ? top : bottom;
        appendLine(left, anchorCanvasY, width, borderW, guideColor);
      } else {
        appendLine(left, top, width, borderW, guideColor);
        appendLine(left, bottom, width, borderW, guideColor);
      }
    }
  }
}

function renderResizeDebugHud(canvas) {
  const s = canvas?.__blockSpaceResizeDebugStatus;
  if (!s?.active) {
    clearDimensionAssociationLayer();
    return;
  }
  renderDimensionAssociationHighlights(canvas, s);
}

function ensureSnapFeedbackState(canvas) {
  if (!canvas) return null;
  if (!canvas.__blockSpaceSnapFeedbackState) canvas.__blockSpaceSnapFeedbackState = { pulses: {} };
  return canvas.__blockSpaceSnapFeedbackState;
}

function buildSnapFeedbackPayload(xDidSnap, yDidSnap) {
  if (!xDidSnap && !yDidSnap) return null;
  if (xDidSnap && yDidSnap) return { axisLabel: "XY", color: getFeedbackColorXY() };
  if (xDidSnap) return { axisLabel: "X", color: getFeedbackColorX() };
  return { axisLabel: "Y", color: getFeedbackColorY() };
}

function triggerSnapFeedback(canvas, node, xDidSnap, yDidSnap) {
  if (!canvas || !node || !getFeedbackEnabled()) return;
  const payload = buildSnapFeedbackPayload(!!xDidSnap, !!yDidSnap);
  if (!payload) return;
  const state = ensureSnapFeedbackState(canvas);
  if (!state) return;
  const now = Date.now();
  const nodeId = node.id != null ? String(node.id) : null;
  if (!nodeId) return;

  const pulseMs = getFeedbackPulseMs();
  let pulse = state.pulses[nodeId];
  if (!pulse) {
    pulse = { node, hadBoxcolor: Object.prototype.hasOwnProperty.call(node, "boxcolor"), boxcolor: node.boxcolor, expiresAt: now + pulseMs };
    state.pulses[nodeId] = pulse;
  } else {
    pulse.node = node;
    pulse.expiresAt = now + pulseMs;
  }
  pulse.color = payload.color;
  node.boxcolor = payload.color;
  canvas.dirty_canvas = true;
  canvas.dirty_bgcanvas = true;
}

function clearSnapFeedbackState(canvas) {
  if (!canvas?.__blockSpaceSnapFeedbackState) return;
  const state = canvas.__blockSpaceSnapFeedbackState;
  const pulses = state.pulses || {};
  for (const key in pulses) {
    const pulse = pulses[key];
    if (!pulse?.node) continue;
    if (pulse.hadBoxcolor) pulse.node.boxcolor = pulse.boxcolor;
    else delete pulse.node.boxcolor;
  }
  canvas.__blockSpaceSnapFeedbackState = { pulses: {} };
  canvas.dirty_canvas = true;
  canvas.dirty_bgcanvas = true;
}

function updateSnapFeedback(canvas) {
  if (!canvas) return;
  if (!getFeedbackEnabled()) {
    clearSnapFeedbackState(canvas);
    return;
  }
  const state = ensureSnapFeedbackState(canvas);
  if (!state) return;
  const now = Date.now();
  const pulses = state.pulses || {};
  for (const key in pulses) {
    const pulse = pulses[key];
    if (!pulse?.node || !getNodeBounds(pulse.node)) {
      delete pulses[key];
      continue;
    }
    if (now <= pulse.expiresAt) pulse.node.boxcolor = pulse.color;
    else {
      if (pulse.hadBoxcolor) pulse.node.boxcolor = pulse.boxcolor;
      else delete pulse.node.boxcolor;
      delete pulses[key];
    }
  }
}

function initNodeSnappingPatches() {
  if (!window.LGraphCanvas?.prototype || window.LGraphCanvas.prototype.__blockSpaceNodeSnapPatched) return;

  V2State.originalProcessMouseMove = window.LGraphCanvas.prototype.processMouseMove;

  window.LGraphCanvas.prototype.processMouseMove = function(event) {
    if (!this.__blockSpaceResetPersistedHighlightDone) {
      resetPersistedHighlightArtifacts(this);
      this.__blockSpaceResetPersistedHighlightDone = true;
    }

    let dragSnapshot = null;
    if (this.node_dragged || (this.last_mouse_dragging && this.current_node)) {
      const primary = this.node_dragged || this.current_node;
      if (primary?.pos) {
        dragSnapshot = { anchor: primary, anchorX: primary.pos[0], anchorY: primary.pos[1], nodes: [] };
        if (this.selected_nodes) {
          for (const id in this.selected_nodes) {
            const n = this.selected_nodes[id];
            if (n?.pos && n !== primary) dragSnapshot.nodes.push({ node: n, x: n.pos[0], y: n.pos[1] });
          }
        }
      }
    }

    const resizingNodeBefore = this.resizing_node || null;
    const result = V2State.originalProcessMouseMove.apply(this, arguments);
    this.__blockSpaceCursorX = event?.canvasX ?? event?.clientX;
    this.__blockSpaceCursorY = event?.canvasY ?? event?.clientY;

    if (event?.shiftKey || !isSnappingEnabled()) {
      renderResizeDebugHud(this);
      updateSnapFeedback(this);
      return result;
    }

    const resizingNode = this.resizing_node || resizingNodeBefore;
    if (resizingNode?.pos && resizingNode?.size && !this.dragging_canvas) {
      applyResizeSnapping(this, resizingNode);
      updateSnapFeedback(this);
      renderResizeDebugHud(this);
      return result;
    }

    this.__blockSpaceResizeDebugStatus = null;
    renderResizeDebugHud(this);
    this.__blockSpacePrevResizeSize = null;
    this.__blockSpaceResizeDimensionMemory = null;
    this.__blockSpaceMoveYPointMemory = null;

    const activeNode = getActiveDraggedNode(this, event);
    if (!activeNode || activeNode.constructor?.name === "LGraphGroup") {
      clearSnapVisual(this);
      updateSnapFeedback(this);
      this.__blockSpacePrevDragPoint = null;
      renderResizeDebugHud(this);
      return result;
    }

    const activeBounds = getNodeBounds(activeNode);
    if (!activeBounds) {
      updateSnapFeedback(this);
      return result;
    }

    const hSnapMargin = getHSnapMargin();
    const vSnapMargin = getVSnapMargin();
    const baseMoveThreshold = (getSnapThreshold() * 1.5) / Math.max(0.0001, getCanvasScale(this));
    const exitThresholdCanvas = baseMoveThreshold * getExitThresholdMultiplier();
    const thresholdCanvasX = baseMoveThreshold * getMoveSnapStrength();
    const thresholdCanvasY = baseMoveThreshold * getMoveSnapStrength();

    const recentSnap = this.__blockSpaceRecentSnap;
    const wasSnappedX = recentSnap?.kind === "move" && recentSnap.nodeId === activeNode.id && recentSnap.xDidSnap;
    const wasSnappedY = recentSnap?.kind === "move" && recentSnap.nodeId === activeNode.id && recentSnap.yDidSnap;
    const currentThresholdX = wasSnappedX ? (exitThresholdCanvas * getMoveSnapStrength()) : thresholdCanvasX;
    const currentThresholdY = wasSnappedY ? (exitThresholdCanvas * getMoveSnapStrength()) : thresholdCanvasY;

    const nodes = getGraphNodes(this);
    const selectedNodesMap = this.selected_nodes || null;
    let didSnap = false, xDidSnapMove = false, yDidSnapMove = false;

    const moveXMemory = ensureMoveXPointMemory(this, activeNode, hSnapMargin);
    const moveXClusters = moveXMemory ? buildDimensionClusters(moveXMemory.points, moveXMemory.tolerancePx) : [];
    const xWinner = pickNearestMoveCluster(moveXClusters, activeBounds.left);

    if (xWinner && Math.abs(activeBounds.left - xWinner.center) <= currentThresholdX) {
      activeNode.pos[0] = xWinner.center;
      didSnap = true;
      xDidSnapMove = true;
    }

    const moveYMemory = ensureMoveYPointMemory(this, activeNode, vSnapMargin);
    const moveYClusters = buildDimensionClusters(moveYMemory?.points || [], moveYMemory?.tolerancePx || 12);
    const yWinner = pickNearestMoveCluster(moveYClusters, activeBounds.top);

    if (yWinner && Math.abs(activeBounds.top - yWinner.center) <= currentThresholdY) {
      activeNode.pos[1] = yWinner.center;
      didSnap = true;
      yDidSnapMove = true;
    }

    const raycastXWinners = [];
    const raycastYWinners = [];
    if (!xDidSnapMove || !yDidSnapMove) {
      const raycastNeighbors = getRaycastNeighborsMulti(
        activeNode,
        activeBounds,
        nodes,
        { maxSearchDistance: 1000, count: 2, selectedNodesMap }
      );

      for (const neighbor of raycastNeighbors) {
        if (!neighbor || !neighbor.bounds) continue;

        const nBounds = neighbor.bounds;
        const threshold = Math.min(currentThresholdX, currentThresholdY) * 1.5;

        if (!xDidSnapMove && neighbor.axis === "x") {
          const activeWidth = activeBounds.right - activeBounds.left;
          let targetX = null;

          if (neighbor.direction === "left") {
            targetX = nBounds.left - hSnapMargin - activeWidth;
            if (Math.abs(activeBounds.left - targetX) <= threshold) {
              activeNode.pos[0] = targetX;
              didSnap = true;
              xDidSnapMove = true;
              raycastXWinners.push(neighbor.node);
            }
          } else if (neighbor.direction === "right") {
            targetX = nBounds.right + hSnapMargin;
            if (Math.abs(activeBounds.left - targetX) <= threshold) {
              activeNode.pos[0] = targetX;
              didSnap = true;
              xDidSnapMove = true;
              raycastXWinners.push(neighbor.node);
            }
          }
        }

        if (!yDidSnapMove && neighbor.axis === "y") {
          const activeHeight = activeBounds.bottom - activeBounds.top;
          let targetY = null;

          if (neighbor.direction === "above") {
            targetY = nBounds.top - vSnapMargin - activeHeight;
            if (Math.abs(activeBounds.top - targetY) <= threshold) {
              activeNode.pos[1] = targetY;
              didSnap = true;
              yDidSnapMove = true;
              raycastYWinners.push(neighbor.node);
            }
          } else if (neighbor.direction === "below") {
            targetY = nBounds.bottom + vSnapMargin;
            if (Math.abs(activeBounds.top - targetY) <= threshold) {
              activeNode.pos[1] = targetY;
              didSnap = true;
              yDidSnapMove = true;
              raycastYWinners.push(neighbor.node);
            }
          }
        }
      }
    }

    if (dragSnapshot?.anchor === activeNode) {
      const totalMoveX = activeNode.pos[0] - dragSnapshot.anchorX;
      const totalMoveY = activeNode.pos[1] - dragSnapshot.anchorY;
      for (const entry of dragSnapshot.nodes) {
        if (entry.node?.pos) {
          entry.node.pos[0] = entry.x + totalMoveX;
          entry.node.pos[1] = entry.y + totalMoveY;
        }
      }
    }

    const activeBoundsForGuide = getNodeBounds(activeNode);
    const xWinnerNodes = [];
    if (xWinner?.members?.length && activeBoundsForGuide) {
      const validMembers = xWinner.members.filter(m => m.node && getNodeBounds(m.node));
      if (validMembers.length) {
        const closest = validMembers.sort((a, b) => {
          const boundsA = getNodeBounds(a.node);
          const boundsB = getNodeBounds(b.node);
          const distA = Math.hypot(boundsA.centerX - activeBoundsForGuide.centerX, boundsA.centerY - activeBoundsForGuide.centerY);
          const distB = Math.hypot(boundsB.centerX - activeBoundsForGuide.centerX, boundsB.centerY - activeBoundsForGuide.centerY);
          return distA - distB;
        })[0];
        if (closest?.node) xWinnerNodes.push(closest.node);
      }
    }
    for (const node of raycastXWinners) {
      if (node?.id && !xWinnerNodes.some(n => n.id === node.id)) {
        xWinnerNodes.push(node);
      }
    }

    const yWinnerNodes = [];
    if (yWinner?.members?.length && activeBoundsForGuide) {
      const validMembers = yWinner.members.filter(m => m.node && getNodeBounds(m.node));
      if (validMembers.length) {
        const closest = validMembers.sort((a, b) => {
          const boundsA = getNodeBounds(a.node);
          const boundsB = getNodeBounds(b.node);
          const distA = Math.hypot(boundsA.centerX - activeBoundsForGuide.centerX, boundsA.centerY - activeBoundsForGuide.centerY);
          const distB = Math.hypot(boundsB.centerX - activeBoundsForGuide.centerX, boundsB.centerY - activeBoundsForGuide.centerY);
          return distA - distB;
        })[0];
        if (closest?.node) yWinnerNodes.push(closest.node);
      }
    }
    for (const node of raycastYWinners) {
      if (node?.id && !yWinnerNodes.some(n => n.id === node.id)) {
        yWinnerNodes.push(node);
      }
    }

    this.__blockSpaceResizeDebugStatus = {
      active: true,
      axis: "move",
      activeNode: activeNode,
      xDidSnap: xDidSnapMove,
      yDidSnap: yDidSnapMove,
      xWinnerNodes: xWinnerNodes,
      yWinnerNodes: yWinnerNodes,
      activeCenterX: activeBounds.centerX,
      activeCenterY: activeBounds.centerY,
    };

    if (didSnap) {
      rememberRecentSnap(this, {
        kind: "move", nodeId: activeNode.id,
        threshold: Math.max(thresholdCanvasX, thresholdCanvasY),
        xDidSnap: xDidSnapMove, yDidSnap: yDidSnapMove,
        xTarget: xDidSnapMove ? activeNode.pos[0] : null,
        yTarget: yDidSnapMove ? activeNode.pos[1] : null,
      });
      triggerSnapFeedback(this, activeNode, xDidSnapMove, yDidSnapMove);
    }
    updateSnapFeedback(this);
    renderResizeDebugHud(this);
    return result;
  };

  window.LGraphCanvas.prototype.__blockSpaceNodeSnapPatched = true;
  window.BlockSpaceNodeSnap = window.BlockSpaceNodeSnap || {};
  window.BlockSpaceNodeSnap.resetPersistedHighlightArtifacts = (canvas) => resetPersistedHighlightArtifacts(canvas || window.app?.canvas);
  window.BlockSpaceNodeSnap.getHSnapMargin = getHSnapMargin;
  window.BlockSpaceNodeSnap.getVSnapMargin = getVSnapMargin;
}

function initUnifiedMouseUpHandler() {
  V2State.originalProcessMouseUp = window.LGraphCanvas.prototype.processMouseUp;

  window.LGraphCanvas.prototype.processMouseUp = function(event) {
    const result = V2State.originalProcessMouseUp.apply(this, arguments);

    const nodeHint = this.resizing_node || this.node_dragged || this.current_node;
    maybeCommitSnapOnMouseUp(this, nodeHint);
    clearSnapVisual(this);
    clearSnapFeedbackState(this);
    this.__blockSpacePrevDragPoint = null;
    this.__blockSpaceMoveXPointMemory = null;
    this.__blockSpaceMoveYPointMemory = null;
    this.__blockSpacePrevResizeSize = null;
    this.__blockSpaceResizeDimensionMemory = null;
    this.__blockSpaceResizeDebugStatus = null;
    this.__blockSpaceRecentSnap = null;
    renderResizeDebugHud(this);

    clearFocusState();

    return result;
  };
}

function calculateV2Snap(activeNode, x, y) {
  const canvas = getLGraphCanvas();
  if (!canvas || !canvas.graph) {
    return { snappedX: x, snappedY: y, xDidSnapMove: false, yDidSnapMove: false, xWinnerNodes: [], yWinnerNodes: [], centerX: x, centerY: y, thresholdCanvasX: 0, thresholdCanvasY: 0, didSnap: false };
  }

  const width = Math.max(0, Number(activeNode.size[0]) || 0);
  const totalHeight = Math.max(0, Number(activeNode.size[1]) || 0);

  const tempBounds = {
    left: x,
    right: x + width,
    top: y,
    bottom: y + totalHeight,
    centerX: x + width * 0.5,
    centerY: y + totalHeight * 0.5,
  };

  const hSnapMargin = getHSnapMargin();
  const vSnapMargin = getVSnapMargin();
  const baseMoveThreshold = (getSnapThreshold() * 1.5) / Math.max(0.0001, getCanvasScale(canvas));
  const exitThresholdCanvas = baseMoveThreshold * getExitThresholdMultiplier();
  const thresholdCanvasX = baseMoveThreshold * getMoveSnapStrength();
  const thresholdCanvasY = baseMoveThreshold * getMoveSnapStrength();

  const recentSnap = canvas.__blockSpaceRecentSnap;
  const wasSnappedX = recentSnap?.kind === "move" && recentSnap.nodeId === activeNode.id && recentSnap.xDidSnap;
  const wasSnappedY = recentSnap?.kind === "move" && recentSnap.nodeId === activeNode.id && recentSnap.yDidSnap;
  const currentThresholdX = wasSnappedX ? (exitThresholdCanvas * getMoveSnapStrength()) : thresholdCanvasX;
  const currentThresholdY = wasSnappedY ? (exitThresholdCanvas * getMoveSnapStrength()) : thresholdCanvasY;

  const nodes = getGraphNodes(canvas);
  const selectedNodesMap = canvas.selected_nodes || null;
  let didSnap = false, xDidSnapMove = false, yDidSnapMove = false;
  let snappedX = x;
  let snappedY = y;

  const moveXMemory = ensureMoveXPointMemory(canvas, activeNode, hSnapMargin);
  const moveXClusters = moveXMemory ? buildDimensionClusters(moveXMemory.points, moveXMemory.tolerancePx) : [];
  const xWinner = pickNearestMoveCluster(moveXClusters, tempBounds.left);

  if (xWinner && Math.abs(tempBounds.left - xWinner.center) <= currentThresholdX) {
    snappedX = xWinner.center;
    didSnap = true;
    xDidSnapMove = true;
  }

  const moveYMemory = ensureMoveYPointMemory(canvas, activeNode, vSnapMargin);
  const moveYClusters = buildDimensionClusters(moveYMemory?.points || [], moveYMemory?.tolerancePx || 12);
  const yWinner = pickNearestMoveCluster(moveYClusters, tempBounds.top);

  if (yWinner && Math.abs(tempBounds.top - yWinner.center) <= currentThresholdY) {
    snappedY = yWinner.center;
    didSnap = true;
    yDidSnapMove = true;
  }

  const raycastXWinners = [];
  const raycastYWinners = [];
  if (!xDidSnapMove || !yDidSnapMove) {
    const raycastBounds = {
      left: snappedX,
      right: snappedX + width,
      top: snappedY,
      bottom: snappedY + totalHeight,
      centerX: snappedX + width * 0.5,
      centerY: snappedY + totalHeight * 0.5,
    };
    
    const raycastNeighbors = getRaycastNeighborsMulti(
      activeNode,
      raycastBounds,
      nodes,
      { maxSearchDistance: 1000, count: 2, selectedNodesMap }
    );

    for (const neighbor of raycastNeighbors) {
      if (!neighbor || !neighbor.bounds) continue;
      const nBounds = neighbor.bounds;
      const threshold = Math.min(currentThresholdX, currentThresholdY) * 1.5;

      if (!xDidSnapMove && neighbor.axis === "x") {
        const activeWidth = raycastBounds.right - raycastBounds.left;
        let targetX = null;

        if (neighbor.direction === "left") {
          targetX = nBounds.left - hSnapMargin - activeWidth;
          if (Math.abs(raycastBounds.left - targetX) <= threshold) {
            snappedX = targetX;
            didSnap = true;
            xDidSnapMove = true;
            raycastXWinners.push(neighbor.node);
          }
        } else if (neighbor.direction === "right") {
          targetX = nBounds.right + hSnapMargin;
          if (Math.abs(raycastBounds.left - targetX) <= threshold) {
            snappedX = targetX;
            didSnap = true;
            xDidSnapMove = true;
            raycastXWinners.push(neighbor.node);
          }
        }
      }

      if (!yDidSnapMove && neighbor.axis === "y") {
        const activeHeight = raycastBounds.bottom - raycastBounds.top;
        let targetY = null;

        if (neighbor.direction === "above") {
          targetY = nBounds.top - vSnapMargin - activeHeight;
          if (Math.abs(raycastBounds.top - targetY) <= threshold) {
            snappedY = targetY;
            didSnap = true;
            yDidSnapMove = true;
            raycastYWinners.push(neighbor.node);
          }
        } else if (neighbor.direction === "below") {
          targetY = nBounds.bottom + vSnapMargin;
          if (Math.abs(raycastBounds.top - targetY) <= threshold) {
            snappedY = targetY;
            didSnap = true;
            yDidSnapMove = true;
            raycastYWinners.push(neighbor.node);
          }
        }
      }
    }
  }

  const activeBoundsForGuide = {
    left: snappedX,
    right: snappedX + width,
    top: snappedY,
    bottom: snappedY + totalHeight,
    centerX: snappedX + width * 0.5,
    centerY: snappedY + totalHeight * 0.5,
  };

  const xWinnerNodes = [];
  if (xWinner?.members?.length && activeBoundsForGuide) {
    const validMembers = xWinner.members.filter(m => m.node && getNodeBounds(m.node));
    if (validMembers.length) {
      const closest = validMembers.sort((a, b) => {
        const boundsA = getNodeBounds(a.node);
        const boundsB = getNodeBounds(b.node);
        const distA = Math.hypot(boundsA.centerX - activeBoundsForGuide.centerX, boundsA.centerY - activeBoundsForGuide.centerY);
        const distB = Math.hypot(boundsB.centerX - activeBoundsForGuide.centerX, boundsB.centerY - activeBoundsForGuide.centerY);
        return distA - distB;
      })[0];
      if (closest?.node) xWinnerNodes.push(closest.node);
    }
  }
  for (const node of raycastXWinners) {
    if (node?.id && !xWinnerNodes.some(n => n.id === node.id)) {
      xWinnerNodes.push(node);
    }
  }

  const yWinnerNodes = [];
  if (yWinner?.members?.length && activeBoundsForGuide) {
    const validMembers = yWinner.members.filter(m => m.node && getNodeBounds(m.node));
    if (validMembers.length) {
      const closest = validMembers.sort((a, b) => {
        const boundsA = getNodeBounds(a.node);
        const boundsB = getNodeBounds(b.node);
        const distA = Math.hypot(boundsA.centerX - activeBoundsForGuide.centerX, boundsA.centerY - activeBoundsForGuide.centerY);
        const distB = Math.hypot(boundsB.centerX - activeBoundsForGuide.centerX, boundsB.centerY - activeBoundsForGuide.centerY);
        return distA - distB;
      })[0];
      if (closest?.node) yWinnerNodes.push(closest.node);
    }
  }
  for (const node of raycastYWinners) {
    if (node?.id && !yWinnerNodes.some(n => n.id === node.id)) {
      yWinnerNodes.push(node);
    }
  }

  return {
    snappedX,
    snappedY,
    didSnap,
    xDidSnapMove,
    yDidSnapMove,
    xWinnerNodes,
    yWinnerNodes,
    centerX: activeBoundsForGuide.centerX,
    centerY: activeBoundsForGuide.centerY,
    thresholdCanvasX,
    thresholdCanvasY
  };
}



/**
 * Placeholder for future V2 node tracking
 */
export function trackV2Node(nodeId) {
  console.warn('[BlockSpace] trackV2Node not implemented');
}

/**
 * High-fidelity V2 snap application for Vue/DOM-based dragging
 */
export function applyV2Snap(nodeId, x, y) {
  const canvas = getLGraphCanvas();
  if (!canvas || !canvas.graph) return { x, y };
  const activeNode = canvas.graph.getNodeById(nodeId);
  if (!activeNode) return { x, y };
  const snap = calculateV2Snap(activeNode, x, y);
  return { x: snap.snappedX, y: snap.snappedY };
}

export default {
  initV2Adapter,
  cleanupV2Adapter,
  trackV2Node,
  applyV2Snap,
  version: V2_ADAPTER_VERSION,
};
