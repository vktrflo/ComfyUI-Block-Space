/**
 * ComfyUI-Block-Space Core Math Module
 * 
 * Pure spatial logic and calculations, UI-agnostic.
 * Can be used in both V1 (LiteGraph) and V2 (Vue/DOM) environments.
 */

// ============================================================================
// Constants (mirroring node-snapping.js defaults)
// ============================================================================

// Snap aggressiveness presets (keys match setting values)
const SNAP_AGGRESSIVENESS = {
  "Low": {
    moveSnapStrength: 0.2,   // Used for both X and Y axis
    resizeSnapStrength: 0.4,
    exitMultiplier: 5.0
  },
  "Medium": {
    moveSnapStrength: 0.8,   // Used for both X and Y axis
    resizeSnapStrength: 1.3,
    exitMultiplier: 2.0
  },
  "High": {
    moveSnapStrength: 1.0,   // Used for both X and Y axis
    resizeSnapStrength: 1.8,
    exitMultiplier: 1.5
  }
};

const SNAP_THRESHOLD = 10;
const EXIT_THRESHOLD_MULTIPLIER = 1.5; // Legacy fallback
const DEFAULT_H_SNAP_MARGIN = 60;
const DEFAULT_V_SNAP_MARGIN = 40;
const DEFAULT_MOVE_SNAP_STRENGTH = 1.0;
const DEFAULT_RESIZE_SNAP_STRENGTH = 1.5; // Reduced from 2.4
const DEFAULT_DIMENSION_TOLERANCE_PX = 12;
const DEFAULT_HIGHLIGHT_ENABLED = true;
const DEFAULT_HIGHLIGHT_COLOR = "#1a3a6b";
const DEFAULT_FEEDBACK_ENABLED = true;
const DEFAULT_FEEDBACK_PULSE_MS = 160;
const DEFAULT_FEEDBACK_COLOR_X = "#1a3a6b";
const DEFAULT_FEEDBACK_COLOR_Y = "#b57cff";
const DEFAULT_FEEDBACK_COLOR_XY = "#1a6b35";

const HIGHLIGHT_COLOR_MAP = {
  "Comfy Blue": "#1a3a6b",
  "Cyber Purple": "#b57cff",
  "Neon Green": "#39ff14",
  "Hot Pink": "#ff00ae",
  "Ghost White": "#ffffff",
  "Amber Gold": "#ffd700",
  "Signal Orange": "#ff4500",
};

// ============================================================================
// Universal Settings Helper (V2 first, V1 fallback)
// ============================================================================

/**
 * Get a setting value from ComfyUI settings.
 * Tries V2 API first (extensionManager.setting.get), then V1 (ui.settings.getSettingValue).
 * @param {string} settingId - The setting identifier
 * @param {*} fallback - Default value if setting not found
 * @returns {*} The setting value or fallback
 */
export function getSettingValue(settingId, fallback) {
  try {
    const v2Getter = window.app?.extensionManager?.setting?.get;
    if (typeof v2Getter === "function") {
      const value = v2Getter(settingId);
      return value ?? fallback;
    }
    
    const v1Getter = window.app?.ui?.settings?.getSettingValue;
    if (typeof v1Getter === "function") {
      const value = v1Getter(settingId);
      return value ?? fallback;
    }
  } catch {
    // Ignore setting read failures
  }
  return fallback;
}

// ============================================================================
// Setting Getters
// ============================================================================

export function getHSnapMargin() {
  return clampNumber(
    getSettingValue("BlockSpace.Snap.HMarginPx", DEFAULT_H_SNAP_MARGIN),
    0,
    500,
    DEFAULT_H_SNAP_MARGIN
  );
}

export function getVSnapMargin() {
  return clampNumber(
    getSettingValue("BlockSpace.Snap.VMarginPx", DEFAULT_V_SNAP_MARGIN),
    0,
    500,
    DEFAULT_V_SNAP_MARGIN
  );
}

export function getSnapThreshold() {
  return clampNumber(
    getSettingValue("BlockSpace.Snap.Sensitivity", SNAP_THRESHOLD),
    2,
    50,
    SNAP_THRESHOLD
  );
}

export function isSnappingEnabled() {
  return !!getSettingValue("BlockSpace.Snap.Enabled", true);
}

const AGGRESSIVENESS_LEVELS = ["Low", "Medium", "High"];

export function getSnapAggressiveness() {
  const value = getSettingValue("BlockSpace.Snap.Aggressiveness", "Medium");
  return AGGRESSIVENESS_LEVELS.includes(value) ? value : "Medium";
}

export function getMoveSnapStrength() {
  const aggressiveness = getSnapAggressiveness();
  const baseStrength = SNAP_AGGRESSIVENESS[aggressiveness].moveSnapStrength;
  return clampNumber(
    getSettingValue("BlockSpace.Snap.MoveStrength", baseStrength),
    0.1,
    5,
    baseStrength
  );
}

export function getResizeSnapStrength() {
  const aggressiveness = getSnapAggressiveness();
  const baseStrength = SNAP_AGGRESSIVENESS[aggressiveness].resizeSnapStrength;
  return clampNumber(
    getSettingValue("BlockSpace.Snap.ResizeStrength", baseStrength),
    0.1,
    5,
    baseStrength
  );
}

export function getMoveYSnapStrength() {
  // Y-axis now uses same strength as X-axis for parity
  return getMoveSnapStrength();
}

export function getExitThresholdMultiplier() {
  const aggressiveness = getSnapAggressiveness();
  return SNAP_AGGRESSIVENESS[aggressiveness].exitMultiplier;
}

export function getDimensionTolerancePx() {
  return clampNumber(
    getSettingValue("BlockSpace.Snap.DimensionTolerancePx", DEFAULT_DIMENSION_TOLERANCE_PX),
    1,
    64,
    DEFAULT_DIMENSION_TOLERANCE_PX
  );
}

export function getHighlightEnabled() {
  return !!getSettingValue("BlockSpace.Snap.HighlightEnabled", DEFAULT_HIGHLIGHT_ENABLED);
}

export function getHighlightColor() {
  const value = getSettingValue("BlockSpace.Snap.HighlightColor", "Comfy Blue");
  return HIGHLIGHT_COLOR_MAP[value] ?? (value?.trim() || DEFAULT_HIGHLIGHT_COLOR);
}

export function getFeedbackEnabled() {
  return isSnappingEnabled();
}

export function getFeedbackPulseMs() {
  return clampNumber(
    getSettingValue("BlockSpace.Snap.FeedbackPulseMs", DEFAULT_FEEDBACK_PULSE_MS),
    60,
    3000,
    DEFAULT_FEEDBACK_PULSE_MS
  );
}

function getFeedbackColor(settingId, defaultColor) {
  const value = getSettingValue(settingId, defaultColor);
  return value?.trim() || defaultColor;
}

export function getFeedbackColorX() {
  return getFeedbackColor("BlockSpace.Snap.FeedbackColorX", DEFAULT_FEEDBACK_COLOR_X);
}

export function getFeedbackColorY() {
  return getFeedbackColor("BlockSpace.Snap.FeedbackColorY", DEFAULT_FEEDBACK_COLOR_Y);
}

export function getFeedbackColorXY() {
  return getFeedbackColor("BlockSpace.Snap.FeedbackColorXY", DEFAULT_FEEDBACK_COLOR_XY);
}

// ============================================================================
// Pure Math Functions
// ============================================================================

/**
 * Clamp a number between min and max, with fallback for invalid inputs.
 * @param {*} value - The value to clamp
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @param {*} fallback - Fallback value if input is not a valid number
 * @returns {number} The clamped value
 */
export function clampNumber(value, min, max, fallback) {
  let n = Number(value);
  if (!isFinite(n)) {
    n = fallback;
  }
  if (min != null && n < min) {
    n = min;
  }
  if (max != null && n > max) {
    n = max;
  }
  return n;
}

/**
 * Check if two ranges overlap.
 * @param {number} aMin - Start of range A
 * @param {number} aMax - End of range A
 * @param {number} bMin - Start of range B
 * @param {number} bMax - End of range B
 * @param {number} tolerance - Allowable gap between ranges
 * @returns {boolean} True if ranges overlap
 */
export function rangesOverlap(aMin, aMax, bMin, bMax, tolerance) {
  const tol = Number(tolerance) || 0;
  return Math.min(aMax, bMax) - Math.max(aMin, bMin) >= -tol;
}

// ============================================================================
// Node Geometry
// ============================================================================

/**
 * Calculate the bounding box of a node.
 * Accounts for title bar height (LiteGraph.NODE_TITLE_HEIGHT).
 * @param {Object} node - The node with pos [x, y] and size [width, contentHeight]
 * @returns {Object|null} Bounds object with left, right, top, bottom, centerX, centerY
 */
export function getNodeBounds(node) {
  if (!node || !node.pos || !node.size) {
    return null;
  }
  const left = Number(node.pos[0]) || 0;
  const top = Number(node.pos[1]) || 0;
  const width = Math.max(0, Number(node.size[0]) || 0);
  const contentHeight = Math.max(0, Number(node.size[1]) || 0);

  // In V1, LiteGraph node.size[1] represents content height only, so title height must be added.
  // In V2, the Vue-rendered DOM elements store total height in node.size[1].
  const isV2 = window.BlockSpaceAdapterMode === "v2" ||
               (typeof window.BlockSpaceDetect === "function" && window.BlockSpaceDetect() === "v2") ||
               (typeof document !== "undefined" && document.querySelector("[data-node-id], .lg-node") !== null);
  const totalHeight = isV2 ? contentHeight : (contentHeight + (Number(window.LiteGraph && window.LiteGraph.NODE_TITLE_HEIGHT) || 24));

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
// Clustering Algorithms
// ============================================================================

/**
 * Build dimension clusters from samples.
 * Groups similar dimension values together using tolerance-based clustering.
 * @param {Array} samples - Array of {value, node} objects or plain numbers
 * @param {number} tolerancePx - Maximum distance between values to be in same cluster
 * @returns {Array} Array of cluster objects with center, count, min, max, members
 */
export function buildDimensionClusters(samples, tolerancePx) {
  if (!Array.isArray(samples) || !samples.length) {
    return [];
  }

  const sorted = samples
    .map(function (entry) {
      if (entry && typeof entry === "object") {
        const n = Number(entry.value);
        if (isFinite(n)) {
          // Preserve additional fields like 'type' for guide rendering
          return { value: n, node: entry.node || null, type: entry.type };
        }
        return null;
      }
      const numeric = Number(entry);
      if (isFinite(numeric)) {
        return { value: numeric, node: null };
      }
      return null;
    })
    .filter(function (entry) {
      return !!entry;
    })
    .sort(function (a, b) {
      return a.value - b.value;
    });

  if (!sorted.length) {
    return [];
  }

  const clusters = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const sample = sorted[i];
    const value = sample.value;
    const cluster = clusters.length ? clusters[clusters.length - 1] : null;

    if (!cluster || Math.abs(value - cluster.center) > tolerancePx) {
      clusters.push({
        center: value,
        count: 1,
        min: value,
        max: value,
        sum: value,
        members: [sample],
      });
      continue;
    }

    cluster.count += 1;
    cluster.sum += value;
    cluster.center = cluster.sum / cluster.count;
    cluster.min = Math.min(cluster.min, value);
    cluster.max = Math.max(cluster.max, value);
    cluster.members.push(sample);
  }

  return clusters;
}

/**
 * Pick the cluster nearest to a target value for move operations.
 * @param {Array} clusters - Array of clusters
 * @param {number} currentValue - The target value to snap to
 * @returns {Object|null} The nearest cluster or null
 */
export function pickNearestMoveCluster(clusters, currentValue) {
  if (!Array.isArray(clusters) || !clusters.length || !isFinite(currentValue)) {
    return null;
  }

  const sorted = clusters.slice().sort(function (a, b) {
    const da = Math.abs(Number(a.center) - currentValue);
    const db = Math.abs(Number(b.center) - currentValue);
    if (da !== db) return da - db;
    if ((a.count || 0) !== (b.count || 0)) return (b.count || 0) - (a.count || 0);
    return (b.center || 0) - (a.center || 0);
  });

  return sorted[0];
}

/**
 * Pick a cluster based on directional intent (expand, shrink, or steady).
 * @param {Array} clusters - Array of clusters
 * @param {number} currentDim - Current dimension value
 * @param {string} intent - "expand", "shrink", or "steady"
 * @returns {Object|null} The best matching cluster or null
 */
export function pickDirectionalCluster(clusters, currentDim, intent) {
  if (!Array.isArray(clusters) || !clusters.length || !isFinite(currentDim)) {
    return null;
  }

  const filtered = [];
  for (let i = 0; i < clusters.length; i += 1) {
    const c = clusters[i];
    if (!c || !isFinite(c.center)) {
      continue;
    }
    if (intent === "expand") {
      if (c.center > currentDim) filtered.push(c);
    } else if (intent === "shrink") {
      if (c.center < currentDim) filtered.push(c);
    } else {
      // "steady" or "neutral" - include everything to find closest
      filtered.push(c);
    }
  }

  if (!filtered.length) {
    return null;
  }

  filtered.sort(function (a, b) {
    const da = Math.abs(a.center - currentDim);
    const db = Math.abs(b.center - currentDim);
    if (da !== db) return da - db;
    if (a.count !== b.count) return b.count - a.count;
    return b.center - a.center;
  });

  return filtered[0];
}

// ============================================================================
// Raycasting / Topological Search
// ============================================================================

/**
 * Collect valid snap targets along a specific axis and direction.
 * Filters by spatial relationship and search distance.
 * @param {Object} activeNode - The node being dragged
 * @param {Object} activeBounds - Bounds of the active node
 * @param {Array} allNodes - All nodes in the graph
 * @param {number} maxSearchDistance - Maximum distance to search
 * @param {string} axis - "x" or "y"
 * @param {string} direction - For x: "left" or "right"; for y: "above" or "below"
 * @param {boolean} ignoreMaxSearchDistance - If true, don't limit by distance
 * @param {Object} selectedNodesMap - Map of selected node IDs to exclude
 * @returns {Array} Valid targets with node, bounds, axis, direction, distance
 */
export function collectValidTargetsForAxis(
  activeNode,
  activeBounds,
  allNodes,
  maxSearchDistance,
  axis,
  direction,
  ignoreMaxSearchDistance,
  selectedNodesMap
) {
  const valid = [];

  for (let i = 0; i < allNodes.length; i += 1) {
    const target = allNodes[i];
    if (!target || target === activeNode) {
      continue;
    }
    // Exclude groups (check if constructor matches LGraphGroup)
    if (target.constructor && target.constructor.name === "LGraphGroup") {
      continue;
    }
    // Exclude other selected nodes from being snap targets
    if (selectedNodesMap && target.id != null && selectedNodesMap[target.id]) {
      continue;
    }

    const targetBounds = getNodeBounds(target);
    if (!targetBounds) {
      continue;
    }

    let emptySpace = 0;

    if (axis === "x") {
      if (direction === "left") {
        if (!(targetBounds.centerX < activeBounds.centerX)) continue;
        emptySpace = activeBounds.left - targetBounds.right;
      } else {
        // RIGHT DIRECTION
        if (!(targetBounds.centerX > activeBounds.centerX)) continue;
        emptySpace = targetBounds.left - activeBounds.right;
      }
      if (!rangesOverlap(activeBounds.top, activeBounds.bottom, targetBounds.top, targetBounds.bottom, 0)) {
        continue;
      }
    } else {
      // axis === "y"
      if (direction === "above") {
        if (!(targetBounds.centerY < activeBounds.centerY)) {
          continue;
        }
        emptySpace = activeBounds.top - targetBounds.bottom;
      } else {
        if (!(targetBounds.centerY > activeBounds.centerY)) {
          continue;
        }
        emptySpace = targetBounds.top - activeBounds.bottom;
      }
      if (!rangesOverlap(activeBounds.left, activeBounds.right, targetBounds.left, targetBounds.right, 0)) {
        continue;
      }
    }

    if (!(emptySpace >= 0 && (ignoreMaxSearchDistance || emptySpace <= maxSearchDistance))) {
      continue;
    }

    valid.push({
      node: target,
      bounds: targetBounds,
      axis: axis,
      direction: direction,
      distance: Math.abs(activeBounds.top - targetBounds.top),
    });
  }

  return valid;
}

/**
 * Get raycast neighbors for snapping - finds the best target node in each direction.
 * This is the main entry point for topological/adjacency-based snapping.
 * @param {Object} activeNode - The node being dragged
 * @param {Object} activeBounds - Bounds of the active node
 * @param {Array} allNodes - All nodes in the graph
 * @param {Object} options - Search options
 * @param {number} options.maxSearchDistance - Maximum distance to search
 * @param {string} options.primaryAxis - Primary axis to search ("x" or "y")
 * @param {string} options.primaryDirection - Primary direction
 * @param {string} options.fallbackDirection - Fallback direction if primary finds nothing
 * @param {boolean} options.ignoreMaxSearchDistance - Ignore distance limits
 * @param {Object} options.selectedNodesMap - Map of selected node IDs
 * @returns {Object|null} The winning target with node, bounds, axis, direction, distance
 */
export function getRaycastNeighbors(
  activeNode,
  activeBounds,
  allNodes,
  options
) {
  const {
    maxSearchDistance = 100,
    primaryAxis = "y",
    primaryDirection = "above",
    fallbackDirection = "below",
    ignoreMaxSearchDistance = false,
    selectedNodesMap = null,
  } = options || {};

  // Try primary direction first
  let valid = collectValidTargetsForAxis(
    activeNode,
    activeBounds,
    allNodes,
    maxSearchDistance,
    primaryAxis,
    primaryDirection,
    ignoreMaxSearchDistance,
    selectedNodesMap
  );

  // If nothing found, try fallback direction
  if (!valid.length && fallbackDirection) {
    valid = collectValidTargetsForAxis(
      activeNode,
      activeBounds,
      allNodes,
      maxSearchDistance,
      primaryAxis,
      fallbackDirection,
      ignoreMaxSearchDistance,
      selectedNodesMap
    );
  }

  if (!valid.length) {
    return null;
  }

  // Sort by distance and return the closest
  valid.sort(function (a, b) {
    return a.distance - b.distance;
  });

  return valid[0];
}

/**
 * Get multiple raycast neighbors - finds the closest N targets in all directions.
 * This is used for the always-on raycasting snapping feature.
 * @param {Object} activeNode - The node being dragged
 * @param {Object} activeBounds - Bounds of the active node
 * @param {Array} allNodes - All nodes in the graph
 * @param {Object} options - Search options
 * @param {number} options.maxSearchDistance - Maximum distance to search
 * @param {number} options.count - Number of neighbors to return (default 2)
 * @param {Object} options.selectedNodesMap - Map of selected node IDs to exclude
 * @returns {Array} Array of closest targets, sorted by distance
 */
export function getRaycastNeighborsMulti(
  activeNode,
  activeBounds,
  allNodes,
  options
) {
  const {
    maxSearchDistance = 2000,
    count = 2,
    selectedNodesMap = null,
  } = options || {};

  // Search in all 4 directions
  const directions = [
    { axis: "x", direction: "left" },
    { axis: "x", direction: "right" },
    { axis: "y", direction: "above" },
    { axis: "y", direction: "below" },
  ];

  let allValid = [];

  for (const { axis, direction } of directions) {
    const targets = collectValidTargetsForAxis(
      activeNode,
      activeBounds,
      allNodes,
      maxSearchDistance,
      axis,
      direction,
      false,
      selectedNodesMap
    );
    allValid = allValid.concat(targets);
  }

  if (!allValid.length) {
    return [];
  }

  // Sort by distance and return top N
  allValid.sort(function (a, b) {
    return a.distance - b.distance;
  });

  // Return unique nodes (in case a node appears in multiple directions)
  const seen = new Set();
  const result = [];
  for (const target of allValid) {
    if (target.node?.id && !seen.has(target.node.id)) {
      seen.add(target.node.id);
      result.push(target);
      if (result.length >= count) break;
    }
  }

  return result;
}

// ============================================================================
// Additional Geometry Helpers
// ============================================================================

/**
 * Compute winning X candidate for snapping.
 * Returns the best snap candidate based on alignment mode.
 * @param {Object} activeBounds - Bounds of the active node
 * @param {Object} winner - The winning target
 * @param {number} snapMargin - The snap margin to use
 * @param {boolean} useTopBottomFallback - Whether to use top/bottom fallback logic
 * @returns {Object|null} The best candidate with targetX, delta, mode
 */
export function computeWinningXCandidate(activeBounds, winner, snapMargin, useTopBottomFallback) {
  const winnerBounds = winner.bounds;
  const activeWidth = activeBounds.right - activeBounds.left;
  const candidates = [];

  if (useTopBottomFallback) {
    candidates.push({
      targetX: winnerBounds.left,
      delta: Math.abs(activeBounds.left - winnerBounds.left),
      mode: "align_left",
    });
    candidates.push({
      targetX: winnerBounds.right - activeWidth,
      delta: Math.abs(activeBounds.left - (winnerBounds.right - activeWidth)),
      mode: "align_right",
    });
    candidates.push({
      targetX: winnerBounds.centerX - activeWidth * 0.5,
      delta: Math.abs(activeBounds.left - (winnerBounds.centerX - activeWidth * 0.5)),
      mode: "align_center",
    });
  } else {
    const side = winner.direction || "left";
    if (side === "left") {
      candidates.push({
        targetX: winnerBounds.right + snapMargin,
        delta: Math.abs(activeBounds.left - (winnerBounds.right + snapMargin)),
        mode: "margin_right",
      });
      candidates.push({
        targetX: winnerBounds.right,
        delta: Math.abs(activeBounds.left - winnerBounds.right),
        mode: "flush_right",
      });
    } else {
      const marginX = winnerBounds.left - snapMargin - activeWidth;
      candidates.push({
        targetX: marginX,
        delta: Math.abs(activeBounds.left - marginX),
        mode: "margin_left",
      });
      const flushX = winnerBounds.left - activeWidth;
      candidates.push({
        targetX: flushX,
        delta: Math.abs(activeBounds.left - flushX),
        mode: "flush_left",
      });
    }
  }

  candidates.sort(function (a, b) {
    return a.delta - b.delta;
  });

  return candidates[0] || null;
}

// ============================================================================
// Module exports for non-ESM environments (IIFE fallback)
// ============================================================================

if (typeof window !== "undefined") {
  window.BlockSpaceCoreMath = {
    // Settings
    getSettingValue,
    getHSnapMargin,
    getVSnapMargin,
    getSnapThreshold,
    isSnappingEnabled,
    getSnapAggressiveness,
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
    collectValidTargetsForAxis,
    getRaycastNeighbors,
    getRaycastNeighborsMulti,
    computeWinningXCandidate,
  };
}
