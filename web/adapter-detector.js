/**
 * Environment Detector for ComfyUI V1/V2
 * Defaults to V1 immediately, switches to V2 if detected
 */

const BLOCKSPACE_VERSION = "1.0.6";
const cacheBuster = `?v=${BLOCKSPACE_VERSION}`;

// Detection state
let currentAdapter = 'v1';
let v2Detected = false;

/**
 * Check for V2 DOM nodes (data-node-id attribute) or V2 global structures.
 * This is 100% robust and works even on empty graphs.
 */
function checkV2DOMNodes() {
  if (typeof window === 'undefined') return false;
  return document.querySelector('[data-node-id]') !== null || 
         !!(window.app?.positionConversion || window.comfyAPI || window.__COMFYUI_FRONTEND_VERSION__);
}

/**
 * Load V1 adapter immediately (default)
 */
function loadV1Adapter() {
  import(`./adapter-v1.js${cacheBuster}`)
    .then(({ initV1Adapter }) => {
      initV1Adapter();
      console.log('[BlockSpace] V1 adapter loaded (default)');
    })
    .catch(err => {
      console.error('[BlockSpace] Failed to load V1 adapter:', err);
    });
}

/**
 * Switch to V2 adapter
 */
function switchToV2Adapter() {
  if (v2Detected) return; // Already switched
  v2Detected = true;
  currentAdapter = 'v2';
  
  console.log('[BlockSpace] V2 detected, switching adapter...');
  
  // 1. Clean up V1 first
  import(`./adapter-v1.js${cacheBuster}`)
    .then(({ cleanupV1Adapter }) => {
      try {
        cleanupV1Adapter();
        console.log('[BlockSpace] V1 adapter cleaned up successfully');
      } catch (err) {
        console.error('[BlockSpace] Error during V1 adapter cleanup:', err);
      }
      
      // 2. Load and initialize V2
      return import(`./adapter-v2.js${cacheBuster}`);
    })
    .then(({ initV2Adapter }) => {
      initV2Adapter();
      console.log('[BlockSpace] Switched to V2 adapter');
    })
    .catch(err => {
      console.error('[BlockSpace] Failed to transition to V2 adapter:', err);
    });
}

/**
 * Poll for V2 detection (V2 DOM renders async)
 */
function startV2DetectionPolling() {
  // Check immediately first
  if (checkV2DOMNodes()) {
    switchToV2Adapter();
    return;
  }
  
  const maxAttempts = 200; // 4 seconds total (20ms * 200)
  let attempts = 0;
  
  const poll = () => {
    attempts++;
    
    if (checkV2DOMNodes()) {
      switchToV2Adapter();
      return;
    }
    
    if (attempts < maxAttempts) {
      setTimeout(poll, 20);
    }
    // No timeout warning - V1 default is the expected behavior
  };
  
  setTimeout(poll, 20);
}

/**
 * Manual detection check (for debugging)
 */
function detectEnvironment() {
  return checkV2DOMNodes() ? 'v2' : currentAdapter;
}

/**
 * Force load a specific adapter (for testing)
 */
function forceLoadAdapter(version) {
  if (version === 'v2' && !v2Detected) {
    switchToV2Adapter();
  } else if (version === 'v1' && currentAdapter !== 'v1') {
    console.log('[BlockSpace] Forcing V1 adapter reload...');
    
    // Clean up V2
    import(`./adapter-v2.js${cacheBuster}`)
      .then(({ cleanupV2Adapter }) => {
        try {
          cleanupV2Adapter();
          console.log('[BlockSpace] V2 adapter cleaned up successfully');
        } catch (err) {
          console.error('[BlockSpace] Error during V2 adapter cleanup:', err);
        }
        
        // Load and initialize V1
        return import(`./adapter-v1.js${cacheBuster}`);
      })
      .then(({ initV1Adapter }) => {
        initV1Adapter();
        v2Detected = false;
        currentAdapter = 'v1';
        console.log('[BlockSpace] Forcing V1 adapter reload complete');
      })
      .catch(err => {
        console.error('[BlockSpace] Failed to transition back to V1 adapter:', err);
      });
  }
}

// Initialize: Load V1 immediately, poll for V2 in background
if (typeof window !== 'undefined') {
  // V1 loads immediately - no delay
  loadV1Adapter();
  
  // V2 detection happens in background
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => startV2DetectionPolling());
  } else {
    setTimeout(startV2DetectionPolling, 10);
  }
}

// Export for manual use
window.BlockSpaceDetect = detectEnvironment;
window.BlockSpaceForceLoad = forceLoadAdapter;
window.BlockSpaceVersion = BLOCKSPACE_VERSION;

export { BLOCKSPACE_VERSION, detectEnvironment, forceLoadAdapter };
