// Face camera component with robust camera resolution and world-space alignment
AFRAME.registerComponent("face-camera", {
  init: function () {
    this._tmp = new THREE.Vector3();
    this._cameraEl = null;
  },
  tick: function () {
    // Resolve camera lazily in case it isn't ready at init
    if (!this._cameraEl || !this._cameraEl.object3D) {
      this._cameraEl = document.querySelector("[camera]") || document.getElementById("cam");
      if (!this._cameraEl || !this._cameraEl.object3D) return;
    }
    // Use world position to avoid parent transform discrepancies
    this._cameraEl.object3D.getWorldPosition(this._tmp);
    this.el.object3D.lookAt(this._tmp);
  },
});

// Optimized global helper with caching + debouncing for rounded image masking (transparent corners)
const IMAGE_MASK_CACHE = new Map(); // key: src|radius|bw|color -> dataURL
function applyRoundedMaskToAImage(aImgEl, styleCfg, force = false) {
  try {
    if (!aImgEl || !styleCfg) return Promise.resolve();
    const src = aImgEl.getAttribute("src");
    if (!src) return Promise.resolve();
    const key =
      src +
      "|" +
      (styleCfg.borderRadius || 0) +
      "|" +
      (styleCfg.borderWidth || 0) +
      "|" +
      (styleCfg.borderColor || "");
    if (!force && aImgEl.dataset.roundedAppliedRadius === key)
      return Promise.resolve();
    if (IMAGE_MASK_CACHE.has(key)) {
      const cached = IMAGE_MASK_CACHE.get(key);
      if (!aImgEl.dataset.originalSrc) aImgEl.dataset.originalSrc = src;
      aImgEl.setAttribute("src", cached);
      aImgEl.setAttribute(
        "material",
        (aImgEl.getAttribute("material") || "") +
          "; transparent:true; shader:flat; alphaTest:0.01; side:double"
      );
      aImgEl.dataset.roundedAppliedRadius = key;
      return Promise.resolve();
    }
    if (aImgEl._maskTimer) clearTimeout(aImgEl._maskTimer);
    return new Promise((resolve) => {
      aImgEl._maskTimer = setTimeout(() => {
        let originalSrc;
        try {
          originalSrc = aImgEl.getAttribute("src");
        } catch (_) {
          return resolve();
        }
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const w = img.naturalWidth || 0;
            const h = img.naturalHeight || 0;
            if (!w || !h) return resolve();
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            ctx.clearRect(0, 0, w, h);
            const r = Math.max(
              0,
              Math.min(w / 2, (styleCfg.borderRadius || 0) * w)
            );
            const bw = Math.max(0, (styleCfg.borderWidth || 0) * w);
            ctx.beginPath();
            ctx.moveTo(r, 0);
            ctx.lineTo(w - r, 0);
            ctx.quadraticCurveTo(w, 0, w, r);
            ctx.lineTo(w, h - r);
            ctx.quadraticCurveTo(w, h, w - r, h);
            ctx.lineTo(r, h);
            ctx.quadraticCurveTo(0, h, 0, h - r);
            ctx.lineTo(0, r);
            ctx.quadraticCurveTo(0, 0, r, 0);
            ctx.closePath();
            ctx.clip();
            try {
              ctx.drawImage(img, 0, 0, w, h);
            } catch (_) {
              return resolve();
            }
            if (bw > 0) {
              ctx.lineWidth = bw * 2;
              ctx.strokeStyle = styleCfg.borderColor || "#FFFFFF";
              ctx.stroke();
            }
            try {
              ctx.getImageData(0, 0, 1, 1);
            } catch (_) {
              return resolve();
            }
            const masked = canvas.toDataURL("image/png");
            IMAGE_MASK_CACHE.set(key, masked);
            if (!aImgEl.dataset.originalSrc)
              aImgEl.dataset.originalSrc = originalSrc;
            aImgEl.setAttribute("src", masked);
            aImgEl.setAttribute(
              "material",
              (aImgEl.getAttribute("material") || "") +
                "; transparent:true; shader:flat; alphaTest:0.01; side:double"
            );
            aImgEl.dataset.roundedAppliedRadius = key;
          } catch (_) {
            /* ignore */
          }
          resolve();
        };
        img.onerror = () => resolve();
        img.src = originalSrc;
      }, 60); // debounce to batch rapid style edits
    });
  } catch (e) {
    return Promise.resolve();
  }
}

// Hotspot Editor Manager
class HotspotEditor {
  constructor() {
    this.hotspots = [];
    this.editMode = false;
    this.selectedHotspotType = "text";
    this.hotspotIdCounter = 0;
    this.selectedHotspotId = null;
    this.scenes = {
      scene1: {
        name: "Scene 1",
        type: "image", // NEW: "image" or "video"
        image: "./images/scene1.jpg",
        videoSrc: null, // NEW: video source for video scenes
        videoVolume: 0.5, // NEW: 0-1 volume control
        hotspots: [],
        startingPoint: null, // { rotation: { x: 0, y: 0, z: 0 } }
        globalSound: null, // { audio: string|File, volume: number, enabled: boolean }
      },
    };
    this.currentScene = "scene1";
    this.navigationMode = false; // false = edit mode, true = navigation mode
    this.editorGlobalSoundEnabled = false; // For editor controls - start disabled
    this.editorGlobalAudio = null; // For editor audio playback
    this.editorProgressInterval = null; // For editor progress tracking

    // CSS Customization Settings
    this.customStyles = {
      hotspot: {
        infoButton: {
          backgroundColor: "#4A90E2", // Blue background for i icon
          textColor: "#FFFFFF",
          fontSize: 12, // Larger font for i icon
          opacity: 0.9,
          size: 0.4, // Size of the i icon circle
        },
        popup: {
          backgroundColor: "#333333",
          textColor: "#FFFFFF",
          borderColor: "#555555",
          borderWidth: 0,
          borderRadius: 0,
          opacity: 0.95,
          fontSize: 1,
          padding: 0.2,
        },
        closeButton: {
          size: 0.4,
          opacity: 1.0,
        },
      },
      audio: {
        buttonColor: "#FFFFFF",
        buttonOpacity: 1.0,
      },
      buttonImages: {
        play: "images/play.png",
        pause: "images/pause.png",
      },
      navigation: {
        ringColor: "#005500",
        ringOuterRadius: 0.6,
        ringThickness: 0.02,
        weblinkRingColor: "#001f5b",
        // Hover label (portal title)
        labelColor: "#FFFFFF",
        labelBackgroundColor: "#000000",
        labelOpacity: 0.8,
      },
      image: {
        borderColor: "#FFFFFF",
        borderWidth: 0.02, // world units
        borderRadius: 0.05, // corner rounding approximation (not yet used if simple plane)
        opacity: 1.0,
      },
    };

    console.log(
      "🔄 INIT: Editor sound initialized as:",
      this.editorGlobalSoundEnabled ? "ENABLED" : "DISABLED"
    );

    // Cache for data URLs of image Files to avoid re-encoding identical uploads
    this._imageDataURLCache = new Map();
  this._videoPreviewCache = new Map();

    this.init();
  }
  // Generate and cache a small preview image from a video's first frame
  async _ensureVideoPreview(sceneId) {
    try {
      if (this._videoPreviewCache.has(sceneId)) return this._videoPreviewCache.get(sceneId);
      const sc = this.scenes[sceneId];
      if (!sc || sc.type !== 'video' || !sc.videoSrc) return null;
      // Create or reuse a hidden worker video element
      let v = document.getElementById('video-thumb-worker');
      if (!v) {
        v = document.createElement('video');
        v.id = 'video-thumb-worker';
        v.muted = true; v.playsInline = true; v.setAttribute('webkit-playsinline','');
        v.crossOrigin = 'anonymous'; v.preload = 'auto'; v.style.display = 'none';
        const assets = document.querySelector('a-assets') || document.body;
        assets.appendChild(v);
      }
      if (v.src !== sc.videoSrc) {
        v.src = sc.videoSrc;
        // Loading metadata
        await new Promise((res, rej) => {
          const onErr = () => { v.removeEventListener('error', onErr); res(null); };
          v.addEventListener('loadeddata', () => res(true), { once: true });
          v.addEventListener('error', onErr, { once: true });
        });
      }
      // Try to seek a bit into the video for a stable frame
      try {
        v.currentTime = Math.min(1, (v.duration || 1) * 0.1);
        await new Promise((res) => v.addEventListener('seeked', () => res(true), { once: true }));
      } catch (_) { /* ignore */ }
      const vw = v.videoWidth || 1024; const vh = v.videoHeight || 512;
      const cw = 512; const ch = Math.max(1, Math.round((vh / vw) * cw));
      const c = document.createElement('canvas'); c.width = cw; c.height = ch;
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0, cw, ch);
      const url = c.toDataURL('image/png');
      this._videoPreviewCache.set(sceneId, url);
      return url;
    } catch (_) {
      return null;
    }
  }

  init() {
    this.bindEvents();
    this.setupHotspotTypeSelection();
    this.setupSceneManagement();

    // Load saved CSS styles
    this.loadCSSFromLocalStorage();

    // Load saved scenes and hotspots data
    this.loadScenesData();

    // Update the scene dropdown to show all loaded scenes
    this.updateSceneDropdown();

    // Update navigation targets dropdown to ensure it's populated on load
    this.updateNavigationTargets();

    // Apply loaded styles to ensure they take effect
    this.refreshAllHotspotStyles();

    // Try to persist storage for larger assets
    this.requestPersistentStorage();

    // Rehydrate any image/video/audio blob URLs from IndexedDB, then load the scene
    this.rehydrateImageSourcesFromIDB()
      .catch(() => {})
      .then(() => this.rehydrateVideoSourcesFromIDB())
      .catch(() => {})
      .then(() => this.rehydrateAudioSourcesFromIDB())
      .catch(() => {})
      .finally(() => {
        this.loadCurrentScene();
      });
    
    // Prompt to change default scene image (only if still using default)
    this.promptForSceneImageChange();

    // Migrate any legacy image width/height fields to scale
    this.migrateLegacyImageDimensions();

    // Initialize editor sound controls
    this.updateEditorSoundButton();
  }

  // ===== IndexedDB asset storage helpers (videos + images) =====
  openVideoDB() {
    if (this._videoDBPromise) return this._videoDBPromise;
    this._videoDBPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return resolve(null);
      // Bump DB version to 3 to add 'images' and 'audio' stores alongside 'videos'
      const req = indexedDB.open('vr-hotspots', 3);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('videos')) {
          db.createObjectStore('videos', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('images')) {
          db.createObjectStore('images', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('audio')) {
          db.createObjectStore('audio', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return this._videoDBPromise;
  }

  async saveVideoToIDB(key, file) {
    try {
      const db = await this.openVideoDB(); if (!db) return false;
      return await new Promise((resolve) => {
        const tx = db.transaction('videos', 'readwrite');
        const store = tx.objectStore('videos');
        const rec = { key, name: file.name, type: file.type, size: file.size, updated: Date.now(), blob: file };
        store.put(rec);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (_) { return false; }
  }

  async getVideoFromIDB(key) {
    try {
      const db = await this.openVideoDB(); if (!db) return null;
      return await new Promise((resolve) => {
        const tx = db.transaction('videos', 'readonly');
        const store = tx.objectStore('videos');
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (_) { return null; }
  }

  async deleteVideoFromIDB(key) {
    try {
      const db = await this.openVideoDB(); if (!db) return false;
      return await new Promise((resolve) => {
        const tx = db.transaction('videos', 'readwrite');
        const store = tx.objectStore('videos');
        store.delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (_) { return false; }
  }

  async clearAllVideosFromIDB() {
    try {
      const db = await this.openVideoDB(); if (!db) return false;
      return await new Promise((resolve) => {
        const tx = db.transaction('videos', 'readwrite');
        const store = tx.objectStore('videos');
        store.clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (_) { return false; }
  }

  // ===== IndexedDB images storage helpers =====
  async saveImageToIDB(key, fileOrBlob) {
    try {
      const db = await this.openVideoDB(); if (!db) return false;
      const name = (fileOrBlob && fileOrBlob.name) ? fileOrBlob.name : 'image.png';
      const type = (fileOrBlob && fileOrBlob.type) ? fileOrBlob.type : 'image/png';
      const size = (fileOrBlob && fileOrBlob.size) ? fileOrBlob.size : 0;
      const blob = fileOrBlob;
      return await new Promise((resolve) => {
        const tx = db.transaction('images', 'readwrite');
        const store = tx.objectStore('images');
        const rec = { key, name, type, size, updated: Date.now(), blob };
        store.put(rec);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (_) { return false; }
  }

  async getImageFromIDB(key) {
    try {
      const db = await this.openVideoDB(); if (!db) return null;
      return await new Promise((resolve) => {
        const tx = db.transaction('images', 'readonly');
        const store = tx.objectStore('images');
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (_) { return null; }
  }

  async deleteImageFromIDB(key) {
    try {
      const db = await this.openVideoDB(); if (!db) return false;
      return await new Promise((resolve) => {
        const tx = db.transaction('images', 'readwrite');
        const store = tx.objectStore('images');
        store.delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (_) { return false; }
  }

  async clearAllImagesFromIDB() {
    try {
      const db = await this.openVideoDB(); if (!db) return false;
      return await new Promise((resolve) => {
        const tx = db.transaction('images', 'readwrite');
        const store = tx.objectStore('images');
        store.clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (_) { return false; }
  }

  // ===== IndexedDB audio storage helpers =====
  async saveAudioToIDB(key, fileOrBlob) {
    try {
      const db = await this.openVideoDB(); if (!db) return false;
      const name = (fileOrBlob && fileOrBlob.name) ? fileOrBlob.name : 'audio.mp3';
      const type = (fileOrBlob && fileOrBlob.type) ? fileOrBlob.type : 'audio/mpeg';
      const size = (fileOrBlob && fileOrBlob.size) ? fileOrBlob.size : 0;
      const blob = fileOrBlob;
      return await new Promise((resolve) => {
        const tx = db.transaction('audio', 'readwrite');
        const store = tx.objectStore('audio');
        const rec = { key, name, type, size, updated: Date.now(), blob };
        store.put(rec);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (_) { return false; }
  }

  async getAudioFromIDB(key) {
    try {
      const db = await this.openVideoDB(); if (!db) return null;
      return await new Promise((resolve) => {
        const tx = db.transaction('audio', 'readonly');
        const store = tx.objectStore('audio');
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (_) { return null; }
  }

  async clearAllAudiosFromIDB() {
    try {
      const db = await this.openVideoDB(); if (!db) return false;
      return await new Promise((resolve) => {
        const tx = db.transaction('audio', 'readwrite');
        const store = tx.objectStore('audio');
        store.clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (_) { return false; }
  }

  async downloadRemoteVideoToLocal(sceneId) {
    const scene = this.scenes[sceneId];
    if (!scene || scene.type !== "video" || !scene.videoSrc) {
      alert("Invalid scene or not a video scene.");
      return;
    }

    const remoteURL = scene.videoSrc;
    if (!remoteURL.startsWith("http://") && !remoteURL.startsWith("https://")) {
      alert("Video is already local or not a remote URL.");
      return;
    }

    this.showLoadingIndicator("Downloading remote video...");

    try {
      // Attempt client-side fetch
      const response = await fetch(remoteURL, { mode: "cors" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const blob = await response.blob();
      const fileName = remoteURL.split("/").pop() || "remote-video.mp4";
      const file = new File([blob], fileName, { type: blob.type || "video/mp4" });

      // Save to IndexedDB
      const storageKey = `video_${sceneId}`;
      const saved = await this.saveVideoToIDB(storageKey, file);
      if (!saved) {
        throw new Error("Failed to save video to IndexedDB.");
      }

      // Create blob URL and update scene
      const blobURL = URL.createObjectURL(blob);
      scene.videoSrc = blobURL;
      scene.videoStorageKey = storageKey;
      
      // Clear old preview if any
      if (this._videoPreviewCache && this._videoPreviewCache.has(sceneId)) {
        this._videoPreviewCache.delete(sceneId);
      }

      this.saveScenesData();
      this.hideLoadingIndicator();

      alert(`Video downloaded and saved locally!\n\nYou can now:\n• Generate thumbnails for navigation previews\n• Export this scene offline\n• Remove the original remote URL`);

      // Reload scene manager to reflect "Local (IDB)" status
      this.showSceneManager();

      // Reload current scene if this is the active scene
      if (this.currentScene === sceneId) {
        this.loadCurrentScene();
      }

    } catch (error) {
      this.hideLoadingIndicator();
      console.error("Failed to download remote video:", error);
      
      let errorMessage = "Failed to download remote video.\n\n";
      
      if (error.message.includes("CORS") || error.message.includes("NetworkError") || error.name === "TypeError") {
        errorMessage += "❌ CORS Error: The remote server doesn't allow browser downloads.\n\n";
        errorMessage += "💡 Would you like to try downloading via the server instead?\n";
        errorMessage += "(This bypasses CORS restrictions)";
        
        const tryServerDownload = confirm(errorMessage);
        if (tryServerDownload) {
          this.downloadRemoteVideoViaServer(sceneId, remoteURL);
        }
      } else {
        errorMessage += `Error: ${error.message}\n\n`;
        errorMessage += "The video may not be accessible or the URL may be incorrect.";
        alert(errorMessage);
      }
    }
  }

  async autoDownloadRemoteVideo(sceneId, remoteURL) {
    const scene = this.scenes[sceneId];
    if (!scene) return;

    this.showLoadingIndicator("Downloading video to local storage...");

    try {
      // Try client-side fetch first
      const response = await fetch(remoteURL, { mode: "cors" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const blob = await response.blob();
      const fileName = remoteURL.split("/").pop() || "remote-video.mp4";
      const file = new File([blob], fileName, { type: blob.type || "video/mp4" });

      // Save to IndexedDB
      const storageKey = `video_${sceneId}`;
      const saved = await this.saveVideoToIDB(storageKey, file);
      if (!saved) {
        throw new Error("Failed to save video to IndexedDB.");
      }

      // Create blob URL and update scene
      const blobURL = URL.createObjectURL(blob);
      scene.videoSrc = blobURL;
      scene.videoStorageKey = storageKey;
      
      this.saveScenesData();
      this.hideLoadingIndicator();

      console.log(`✅ Video downloaded successfully for scene ${sceneId}`);

    } catch (error) {
      console.warn("Client-side fetch failed, trying server-side:", error);
      
      // Silently try server-side fetch
      try {
        const response = await fetch("/fetch-video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: remoteURL })
        });

        if (!response.ok) {
          throw new Error(`Server returned ${response.status}`);
        }

        const blob = await response.blob();
        const fileName = remoteURL.split("/").pop() || "remote-video.mp4";
        const file = new File([blob], fileName, { type: blob.type || "video/mp4" });

        // Save to IndexedDB
        const storageKey = `video_${sceneId}`;
        const saved = await this.saveVideoToIDB(storageKey, file);
        if (!saved) {
          throw new Error("Failed to save video to IndexedDB.");
        }

        // Create blob URL and update scene
        const blobURL = URL.createObjectURL(blob);
        scene.videoSrc = blobURL;
        scene.videoStorageKey = storageKey;
        
        this.saveScenesData();
        this.hideLoadingIndicator();

        console.log(`✅ Video downloaded via server for scene ${sceneId}`);

      } catch (serverError) {
        // If both fail, keep remote URL but hide loader
        this.hideLoadingIndicator();
        console.error("Both client and server download failed:", serverError);
        
        // Show user-friendly message
        alert(
          `⚠️ Unable to download video automatically.\n\n` +
          `The video will stream from the remote URL, but:\n` +
          `• Thumbnails may not be available\n` +
          `• Export will reference the remote URL (requires internet)\n\n` +
          `You can manually download and re-upload the video file for full offline support.`
        );
      }
    }
  }

  async downloadRemoteVideoViaServer(sceneId, remoteURL) {
    const scene = this.scenes[sceneId];
    if (!scene) return;

    this.showLoadingIndicator("Downloading video via server...");

    try {
      // Use server endpoint to fetch video
      const response = await fetch("/fetch-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: remoteURL })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(errorData.error || `Server returned ${response.status}`);
      }

      const blob = await response.blob();
      const fileName = remoteURL.split("/").pop() || "remote-video.mp4";
      const file = new File([blob], fileName, { type: blob.type || "video/mp4" });

      // Save to IndexedDB
      const storageKey = `video_${sceneId}`;
      const saved = await this.saveVideoToIDB(storageKey, file);
      if (!saved) {
        throw new Error("Failed to save video to IndexedDB.");
      }

      // Create blob URL and update scene
      const blobURL = URL.createObjectURL(blob);
      scene.videoSrc = blobURL;
      scene.videoStorageKey = storageKey;
      
      // Clear old preview if any
      if (this._videoPreviewCache && this._videoPreviewCache.has(sceneId)) {
        this._videoPreviewCache.delete(sceneId);
      }

      this.saveScenesData();
      this.hideLoadingIndicator();

      alert(`✅ Video downloaded successfully via server!\n\nYou can now:\n• Generate thumbnails for navigation previews\n• Export this scene offline\n• The video is stored locally`);

      // Reload scene manager
      this.showSceneManager();

      // Reload current scene if this is the active scene
      if (this.currentScene === sceneId) {
        this.loadCurrentScene();
      }

    } catch (error) {
      this.hideLoadingIndicator();
      console.error("Server-side download failed:", error);
      alert(`❌ Server download failed:\n\n${error.message}\n\nPlease check:\n• The URL is correct and accessible\n• The server is running\n• The video file isn't too large (max 500MB)`);
    }
  }

  async rehydrateVideoSourcesFromIDB() {
    try {
      const entries = Object.entries(this.scenes || {});
      if (!entries.length) return;
      let changed = false;
      for (const [sceneId, scene] of entries) {
        if (!scene || scene.type !== 'video') continue;
        const key = scene.videoStorageKey || sceneId;
        // Skip if remote URL
        if (scene.videoSrc && (scene.videoSrc.startsWith('http://') || scene.videoSrc.startsWith('https://'))) continue;
        const rec = await this.getVideoFromIDB(key);
        if (rec && rec.blob) {
          try {
            const url = URL.createObjectURL(rec.blob);
            scene.videoSrc = url;
            if (!scene.videoFileName) scene.videoFileName = rec.name || '';
            changed = true;
          } catch (_) { /* ignore */ }
        } else {
          // If no record found and no remote URL, keep src null; we’ll prompt on first load
        }
      }
      if (changed) this.saveScenesData();
    } catch (_) { /* ignore */ }
  }

  async requestPersistentStorage() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        await navigator.storage.persist();
      }
    } catch (_) { /* ignore */ }
  }

  // ===== Crossfade helpers (Editor) =====
  _ensureCrossfadeOverlay() {
    let overlay = document.getElementById("scene-crossfade");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "scene-crossfade";
      overlay.style.cssText = `
        position: fixed; inset: 0; background: #000; opacity: 0; pointer-events: none;
        transition: opacity 300ms ease; z-index: 100000;
      `;
      document.body.appendChild(overlay);
    }
    return overlay;
  }

  _startCrossfadeOverlay() {
    return new Promise((resolve) => {
      const overlay = this._ensureCrossfadeOverlay();
      // allow layout flush
      requestAnimationFrame(() => {
        overlay.style.pointerEvents = "auto";
        overlay.style.opacity = "1";
        setTimeout(resolve, 320);
      });
    });
  }

  _endCrossfadeOverlay() {
    const overlay = this._ensureCrossfadeOverlay();
    overlay.style.opacity = "0";
    setTimeout(() => {
      overlay.style.pointerEvents = "none";
    }, 320);
  }

  // ===== Loading Indicator =====
  _ensureLoadingIndicator() {
    let indicator = document.getElementById("loading-indicator");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.id = "loading-indicator";
      indicator.style.cssText = `
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.8); color: white; padding: 20px 30px;
        border-radius: 8px; font-family: Arial, sans-serif; font-size: 16px;
        z-index: 100001; opacity: 0; pointer-events: none;
        transition: opacity 300ms ease; display: flex; align-items: center; gap: 15px;
      `;

      // Add spinning loader
      const spinner = document.createElement("div");
      spinner.style.cssText = `
        width: 20px; height: 20px; border: 2px solid #ffffff40;
        border-top: 2px solid #ffffff; border-radius: 50%;
        animation: spin 1s linear infinite;
      `;

      const text = document.createElement("span");
      text.id = "loading-text";
      text.textContent = "Loading...";

      indicator.appendChild(spinner);
      indicator.appendChild(text);

      // Add CSS animation for spinner
      if (!document.getElementById("loading-spinner-style")) {
        const style = document.createElement("style");
        style.id = "loading-spinner-style";
        style.textContent = `
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `;
        document.head.appendChild(style);
      }

      document.body.appendChild(indicator);
    }
    return indicator;
  }

  showLoadingIndicator(message = "Loading...") {
    const indicator = this._ensureLoadingIndicator();
    const textEl = document.getElementById("loading-text");
    if (textEl) textEl.textContent = message;

    indicator.style.pointerEvents = "auto";
    indicator.style.opacity = "1";
  }

  hideLoadingIndicator() {
    const indicator = this._ensureLoadingIndicator();
    indicator.style.opacity = "0";
    setTimeout(() => {
      indicator.style.pointerEvents = "none";
    }, 300);
  }

  hideSceneLoadingOverlay() {
    const overlay = document.getElementById("scene-loading-overlay");
    if (overlay) {
      overlay.style.opacity = "0";
      setTimeout(() => {
        overlay.style.display = "none";
      }, 500);
    }
  }

  updateVideoControls(videoEl, scene) {
    const controls = document.getElementById("video-controls");
    if (!controls) return;

    controls.style.display = "flex";

    // Play/Pause button
    const playPauseBtn = document.getElementById("video-play-pause");
    playPauseBtn.onclick = () => {
      if (videoEl.paused) {
        videoEl.play();
        playPauseBtn.textContent = "⏸ Pause";
      } else {
        videoEl.pause();
        playPauseBtn.textContent = "▶ Play";
      }
    };

    // Mute/Unmute button
    const muteBtn = document.getElementById("video-mute");
    muteBtn.onclick = () => {
      videoEl.muted = !videoEl.muted;
      muteBtn.textContent = videoEl.muted ? "🔇 Muted" : "🔊 Sound";
      muteBtn.style.background = videoEl.muted ? "#28a745" : "#ffc107";
    };

    // Progress bar
    const progressBar = document.getElementById("video-progress");
    const currentTimeEl = document.getElementById("video-time-current");
    const totalTimeEl = document.getElementById("video-time-total");

    videoEl.addEventListener("loadedmetadata", () => {
      totalTimeEl.textContent = this.formatTime(videoEl.duration);
    });

    videoEl.addEventListener("timeupdate", () => {
      const progress = (videoEl.currentTime / videoEl.duration) * 100;
      progressBar.value = progress;
      currentTimeEl.textContent = this.formatTime(videoEl.currentTime);
    });

    progressBar.addEventListener("input", (e) => {
      const time = (e.target.value / 100) * videoEl.duration;
      videoEl.currentTime = time;
    });

    // Volume control
    const volumeSlider = document.getElementById("video-volume");
    volumeSlider.value = (scene.videoVolume || 0.5) * 100;
    videoEl.volume = scene.videoVolume || 0.5;

    volumeSlider.addEventListener("input", (e) => {
      const volume = e.target.value / 100;
      videoEl.volume = volume;
      scene.videoVolume = volume;
      this.saveScenesData();
    });
  }

  hideVideoControls() {
    const controls = document.getElementById("video-controls");
    if (controls) {
      controls.style.display = "none";
    }
  }

  formatTime(seconds) {
    if (isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  _dispatchSceneLoaded() {
    try {
      const ev = new CustomEvent("vrhotspots:scene-loaded");
      window.dispatchEvent(ev);
    } catch (e) {
      // ignore
    }
  }

  // ===== Navigation Preview (Editor) =====
  _ensureNavPreview() {
    let box = document.getElementById("nav-preview");
    if (!box) {
      box = document.createElement("div");
      box.id = "nav-preview";
      box.style.cssText = `
        position: fixed; top: 0; left: 0; transform: translate(12px, 12px);
        display: none; pointer-events: none; z-index: 100001;
        background: rgba(0,0,0,0.9); color: #fff; border: 1px solid #4CAF50;
        border-radius: 8px; overflow: hidden; width: 220px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        font-family: Arial, sans-serif; backdrop-filter: blur(2px);
      `;
      const img = document.createElement("img");
      img.style.cssText =
        "display:block; width: 100%; height: 120px; object-fit: cover; background:#111;";
      img.id = "nav-preview-img";
      const caption = document.createElement("div");
      caption.id = "nav-preview-caption";
      caption.style.cssText =
        "padding: 8px 10px; font-size: 12px; color: #ddd; border-top: 1px solid rgba(255,255,255,0.08);";
      box.appendChild(img);
      box.appendChild(caption);
      document.body.appendChild(box);
    }
    return box;
  }

  _positionNavPreview(x, y) {
    const box = this._ensureNavPreview();
    // Keep within viewport edges
    const rectW = box.offsetWidth || 220;
    const rectH = box.offsetHeight || 160;
    const pad = 12;
    const maxX = window.innerWidth - rectW - pad;
    const maxY = window.innerHeight - rectH - pad;
    const nx = Math.min(Math.max(x + 12, pad), maxX);
    const ny = Math.min(Math.max(y + 12, pad), maxY);
    box.style.left = nx + "px";
    box.style.top = ny + "px";
  }

  _getEditorPreviewSrc(sceneId) {
    const sc = this.scenes[sceneId];
    if (!sc) return null;
    // If target scene is a video, return special flag so caller can show icon
    if (sc.type === 'video') return 'VIDEO_ICON';
    const img = sc.image || "";
    if (
      img.startsWith("http://") ||
      img.startsWith("https://") ||
      img.startsWith("data:") ||
      img.startsWith("blob:") ||
      img.startsWith("#")
    )
      return img;
    return img.startsWith("./") ? img : `./${img}`;
  }

  // Ensure there's an <img> in <a-assets> for a given preview src and return its selector id
  _ensurePreviewAsset(src, key) {
    try {
      let assets = document.querySelector('a-assets');
      if (!assets) {
        assets = document.createElement('a-assets');
        const scene = document.querySelector('a-scene') || document.body;
        scene.insertBefore(assets, scene.firstChild);
      }
      const safeKey = String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
      const id = `nav-preview-${safeKey}`;
      let img = document.getElementById(id);
      if (!img) {
        img = document.createElement('img');
        img.id = id;
        img.crossOrigin = 'anonymous';
        assets.appendChild(img);
      }
      if (img.getAttribute('src') !== src) {
        img.setAttribute('src', src);
      }
      return `#${id}`;
    } catch (e) {
      console.warn('[Preview][Assets] Failed to ensure asset', e);
      return src; // fallback to raw src
    }
  }

  _showNavPreview(sceneId) {
    const box = this._ensureNavPreview();
    const imgEl = document.getElementById("nav-preview-img");
    const cap = document.getElementById("nav-preview-caption");
    const sc = this.scenes[sceneId];
    if (!sc) return;
    const src = this._getEditorPreviewSrc(sceneId);
      if (src === 'VIDEO_ICON') {
        // Attempt to create a thumbnail for the video
        (async () => {
          const thumb = await this._ensureVideoPreview(sceneId);
          if (thumb) imgEl.src = thumb; else {
            const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="128" height="128"><rect rx="4" ry="4" x="2" y="6" width="14" height="12" fill="#111" stroke="#2ae" stroke-width="2"/><polygon points="16,10 22,7 22,17 16,14" fill="#2ae"/></svg>');
            imgEl.src = 'data:image/svg+xml;charset=UTF-8,' + svg;
          }
        })();
      } else if (src) {
        imgEl.src = src;
    }
    cap.textContent = `Go to: ${sc.name || sceneId}`;
    box.style.display = "block";
    // Begin tracking mouse
    if (!this._navPreviewMove) {
      this._navPreviewMove = (e) =>
        this._positionNavPreview(e.clientX || 0, e.clientY || 0);
    }
    window.addEventListener("mousemove", this._navPreviewMove);
  }

  _hideNavPreview() {
    const box = this._ensureNavPreview();
    box.style.display = "none";
    if (this._navPreviewMove) {
      window.removeEventListener("mousemove", this._navPreviewMove);
    }
  }
  bindEvents() {
    // Add hotspot button
    document.getElementById("add-hotspot").addEventListener("click", () => {
      this.enterEditMode();
    });

    // Clear hotspots button
    document.getElementById("clear-hotspots").addEventListener("click", () => {
      this.clearAllHotspots();
    });

    // Clear data button
    document.getElementById("clear-data").addEventListener("click", () => {
      if (
        confirm(
          "This will clear all saved data (scenes, hotspots, and styles) and reload the page. Are you sure?"
        )
      ) {
        clearLocalStorage();
      }
    });

    // Save template button
    document.getElementById("save-template").addEventListener("click", () => {
      this.saveTemplate();
    });

    // Load template button
    document.getElementById("load-template").addEventListener("click", () => {
      this.loadTemplate();
    });

    // Student submission button
    document
      .getElementById("submit-to-professor")
      .addEventListener("click", () => {
        StudentSubmission.showSubmissionDialog();
      });

    // CSS Settings button
    document.getElementById("css-settings").addEventListener("click", () => {
      this.openStyleEditor();
    });

    // Check if returning from style editor
    this.checkForStyleUpdates();

    // Sky click event for placing or repositioning hotspots
    document.getElementById("skybox").addEventListener("click", (evt) => {
      // Reposition has highest precedence
      if (this.repositioningHotspotId) {
        this.applyReposition(evt);
        return;
      }
      if (this.editMode) {
        this.placeHotspot(evt);
      }
    });

    // Edit mode toggle
    document
      .getElementById("edit-mode-toggle")
      .addEventListener("change", (e) => {
        this.navigationMode = !e.target.checked;
        this.updateModeIndicator();
        this._updateAddHotspotButtonState();
        // Auto-collapse hotspot type when leaving edit mode; expand when entering
        this._setHotspotTypeCollapsed(!e.target.checked);
        // Hide hotspot properties when not in edit mode
        this._setHotspotPropertiesVisible(!!e.target.checked);
        // Sync visible toggle button text/help
        this._syncEditModeToggleUI();
      });

    // Scene management
    document.getElementById("add-scene").addEventListener("click", () => {
      this.addNewScene();
    });

    document.getElementById("manage-scenes").addEventListener("click", () => {
      this.showSceneManager();
    });

    document.getElementById("current-scene").addEventListener("change", (e) => {
      this.switchToScene(e.target.value);
    });

  // Ensure initial button state matches toggle on load
  this._updateAddHotspotButtonState();

    // Visible switch -> flip hidden checkbox and dispatch change
    try {
      const sw = document.getElementById('edit-mode-switch');
      if (sw) {
        const activate = () => {
          const toggle = document.getElementById('edit-mode-toggle');
          if (!toggle) return;
          toggle.checked = !toggle.checked;
          toggle.dispatchEvent(new Event('change', { bubbles: true }));
          this._syncEditModeToggleUI();
        };
        sw.addEventListener('click', activate);
        sw.addEventListener('keydown', (e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            activate();
          }
        });
      }
    } catch (_) { /* ignore */ }

    // Setup collapsible Hotspot Type section
  this._initHotspotTypeCollapsible();

    // Initialize Hotspot Properties visibility based on toggle
    try {
      const toggle = document.getElementById('edit-mode-toggle');
      this._setHotspotPropertiesVisible(toggle ? !!toggle.checked : true);
      this._syncEditModeToggleUI();
    } catch (_) { /* ignore */ }

  // Starting point controls
    document
      .getElementById("set-starting-point")
      .addEventListener("click", () => {
        this.setStartingPoint();
      });

    document
      .getElementById("clear-starting-point")
      .addEventListener("click", () => {
        this.clearStartingPoint();
      });

    // Audio input coordination - clear URL when file is selected
    document.getElementById("hotspot-audio").addEventListener("change", () => {
      if (document.getElementById("hotspot-audio").files.length > 0) {
        document.getElementById("hotspot-audio-url").value = "";
      }
    });

    // Audio URL coordination - clear file when URL is entered
    document
      .getElementById("hotspot-audio-url")
      .addEventListener("input", () => {
        if (document.getElementById("hotspot-audio-url").value.trim()) {
          document.getElementById("hotspot-audio").value = "";
        }
      });

    // Global sound controls (hidden native checkbox)
    document
      .getElementById("global-sound-enabled")
      .addEventListener("change", (e) => {
        this.toggleGlobalSoundControls(e.target.checked);
        this._syncGlobalSoundToggleUI();
      });

    // Global sound file/URL coordination
    document
      .getElementById("global-sound-file")
      .addEventListener("change", () => {
        if (document.getElementById("global-sound-file").files.length > 0) {
          document.getElementById("global-sound-url").value = "";
        }
        this.updateGlobalSound();
      });

    document
      .getElementById("global-sound-url")
      .addEventListener("input", () => {
        if (document.getElementById("global-sound-url").value.trim()) {
          document.getElementById("global-sound-file").value = "";
        }
        this.updateGlobalSound();
      });

    document
      .getElementById("global-sound-volume")
      .addEventListener("input", () => {
        this.updateGlobalSound();
      });

    // Editor global sound control
    document
      .getElementById("editor-sound-control")
      .addEventListener("click", () => {
        this.toggleEditorGlobalSound();
      });

    // Visible Global Sound switch -> flip hidden checkbox and dispatch change
    try {
      const gs = document.getElementById('global-sound-switch');
      if (gs) {
        const activateGS = () => {
          const chk = document.getElementById('global-sound-enabled');
          if (!chk) return;
          chk.checked = !chk.checked;
          chk.dispatchEvent(new Event('change', { bubbles: true }));
          this._syncGlobalSoundToggleUI();
        };
        gs.addEventListener('click', activateGS);
        gs.addEventListener('keydown', (e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            activateGS();
          }
        });
      }
    } catch (_) { /* ignore */ }

    // Initial sync for global sound switch
    this._syncGlobalSoundToggleUI();

    this.setupEditorProgressBar();
  }

  _updateAddHotspotButtonState() {
    try {
      const btn = document.getElementById("add-hotspot");
      const toggle = document.getElementById("edit-mode-toggle");
      if (!btn || !toggle) return;
      const enabled = !!toggle.checked;
      btn.disabled = !enabled;
      btn.setAttribute("aria-disabled", String(!enabled));
      // Visual affordances for disabled state
      btn.style.opacity = enabled ? "" : "0.5";
      // Show a cross/forbidden cursor on hover when disabled
      btn.style.cursor = enabled ? "" : "not-allowed";
      if (!enabled) {
        btn.title = "Enable Edit Mode to add hotspots.";
      } else {
        btn.removeAttribute("title");
      }
    } catch (_) { /* ignore */ }
  }

  _initHotspotTypeCollapsible() {
    try {
      const section = document.getElementById('hotspot-type-section');
      const title = document.getElementById('hotspot-type-title');
      const caret = document.getElementById('hotspot-type-caret');
      if (!section || !title || !caret) return;

      // Click to toggle
      title.addEventListener('click', () => {
        const currentlyCollapsed = section.dataset.collapsed === 'true';
        this._setHotspotTypeCollapsed(!currentlyCollapsed);
      });

      // Initial collapsed state based on Edit Mode toggle
      const toggle = document.getElementById('edit-mode-toggle');
      const collapsed = toggle ? !toggle.checked : false;
      this._setHotspotTypeCollapsed(collapsed);
    } catch (_) { /* ignore */ }
  }

  _setHotspotTypeCollapsed(collapsed) {
    try {
      const section = document.getElementById('hotspot-type-section');
      const caret = document.getElementById('hotspot-type-caret');
      if (!section || !caret) return;
      section.dataset.collapsed = String(!!collapsed);
      // Hide/show all hotspot type rows inside the section (leave title visible)
      const rows = section.querySelectorAll('.hotspot-type');
      rows.forEach((row) => {
        row.style.display = collapsed ? 'none' : '';
      });
      // Also hide/show the merged properties group when collapsing
      const propsGroup = document.getElementById('hotspot-properties-group');
      if (propsGroup) propsGroup.style.display = collapsed ? 'none' : '';
      caret.textContent = collapsed ? '▲' : '▼';
      caret.style.transform = collapsed ? 'rotate(180deg)' : '';
      caret.style.transition = 'transform 120ms ease-out';
    } catch (_) { /* ignore */ }
  }

  _setHotspotPropertiesVisible(visible) {
    try {
      // Prefer merged group inside Hotspot Type section; fallback to legacy separate section
      const props = document.getElementById('hotspot-properties-group') || document.getElementById('hotspot-properties-section');
      if (!props) return;
      props.style.display = visible ? '' : 'none';
    } catch (_) { /* ignore */ }
  }

  _syncEditModeToggleUI() {
    try {
      const toggle = document.getElementById('edit-mode-toggle');
      const sw = document.getElementById('edit-mode-switch');
      const thumb = sw ? sw.querySelector('.thumb') : null;
      const label = document.getElementById('edit-mode-label');
      const help = document.getElementById('edit-mode-help');
      if (!toggle || !sw || !thumb || !label) return;
      const isEdit = !!toggle.checked;

      // Update visuals
      sw.setAttribute('aria-checked', String(isEdit));
      sw.style.background = isEdit ? '#4caf50' : '#777';
      thumb.style.left = isEdit ? '26px' : '2px';

      // Update text
      label.textContent = isEdit ? '🛠️ Edit Mode: ON' : '🧭 Navigation Mode: ON';
      if (help) help.textContent = isEdit ? 'Click to switch to Navigation Mode' : 'Click to switch to Edit Mode';
    } catch (_) { /* ignore */ }
  }

  _syncGlobalSoundToggleUI() {
    try {
      const chk = document.getElementById('global-sound-enabled');
      const sw = document.getElementById('global-sound-switch');
      const thumb = sw ? sw.querySelector('.thumb') : null;
      const label = document.getElementById('global-sound-label');
      const help = document.getElementById('global-sound-help');
      if (!chk || !sw || !thumb || !label) return;
      const isOn = !!chk.checked;

      // Update visuals
      sw.setAttribute('aria-checked', String(isOn));
      sw.style.background = isOn ? '#4caf50' : '#777';
      thumb.style.left = isOn ? '26px' : '2px';

      // Update texts
      label.textContent = isOn ? '🎵 Scene Audio: ON' : '🔇 Scene Audio: OFF';
      if (help) help.textContent = isOn ? 'Click to disable ambient sound for this scene' : 'Click to enable ambient sound for this scene';
    } catch (_) { /* ignore */ }
  }

  setupHotspotTypeSelection() {
    const typeElements = document.querySelectorAll(".hotspot-type");
    typeElements.forEach((element) => {
      element.addEventListener("click", () => {
        // Remove selected class from all
        typeElements.forEach((el) => el.classList.remove("selected"));
        // Add selected class to clicked element
        element.classList.add("selected");
        // Update radio button
        const radio = element.querySelector('input[type="radio"]');
        radio.checked = true;
        this.selectedHotspotType = radio.value;

        // Update field requirements visibility
        this.updateFieldRequirements();
      });
    });

    // Initialize field requirements for default selection
    this.updateFieldRequirements();
  }

  updateFieldRequirements() {
    const textGroup = document.querySelector(
      'label[for="hotspot-text"]'
    ).parentElement;
    const audioGroup = document.querySelector(
      'label[for="hotspot-audio"]'
    ).parentElement;
    const audioUrlGroup = document.querySelector(
      'label[for="hotspot-audio-url"]'
    ).parentElement;
    const navigationGroup = document.getElementById("navigation-target-group");
    // Weblink groups
    const weblinkUrlGroup = document.getElementById("weblink-url-group");
    const weblinkTitleGroup = document.getElementById("weblink-title-group");
    const weblinkImgFileGroup = document.getElementById(
      "weblink-image-file-group"
    );
    const weblinkImgUrlGroup = document.getElementById(
      "weblink-image-url-group"
    );
    const textLabel = document.querySelector('label[for="hotspot-text"]');
    const audioLabel = document.querySelector('label[for="hotspot-audio"]');

    // Reset labels
    textLabel.innerHTML = "Text Content:";
    audioLabel.innerHTML = "Audio File:";

    // Reset visibility
    textGroup.style.display = "block";
    audioGroup.style.display = "block";
    audioUrlGroup.style.display = "block";
    navigationGroup.style.display = "none";
    if (weblinkUrlGroup) weblinkUrlGroup.style.display = "none";
    if (weblinkTitleGroup) weblinkTitleGroup.style.display = "none";
    if (weblinkImgFileGroup) weblinkImgFileGroup.style.display = "none";
    if (weblinkImgUrlGroup) weblinkImgUrlGroup.style.display = "none";
    const imgFileGrpReset = document.getElementById("image-file-group");
    const imgUrlGrpReset = document.getElementById("image-url-group");
    const imgSizeGrpReset = document.getElementById("image-size-group");
    if (imgFileGrpReset) imgFileGrpReset.style.display = "none";
    if (imgUrlGrpReset) imgUrlGrpReset.style.display = "none";
    if (imgSizeGrpReset) imgSizeGrpReset.style.display = "none";

    switch (this.selectedHotspotType) {
      case "text":
        textLabel.innerHTML =
          'Text Content: <span style="color: #f44336;">*Required</span>';
        audioGroup.style.display = "none";
        audioUrlGroup.style.display = "none";
        break;

      case "audio":
        audioLabel.innerHTML =
          'Audio File: <span style="color: #f44336;">*Required</span>';
        textGroup.style.display = "none";
        break;

      case "text-audio":
        textLabel.innerHTML =
          'Text Content: <span style="color: #f44336;">*Required</span>';
        audioLabel.innerHTML =
          'Audio File: <span style="color: #f44336;">*Required</span>';
        break;

      case "navigation":
        textGroup.style.display = "none";
        audioGroup.style.display = "none";
        audioUrlGroup.style.display = "none";
        navigationGroup.style.display = "block";
        // Removed stray labelLabel reference (was undefined)
        this.updateNavigationTargets();
        break;
      case "weblink":
        textGroup.style.display = "none";
        audioGroup.style.display = "none";
        audioUrlGroup.style.display = "none";
        navigationGroup.style.display = "none";
        if (weblinkUrlGroup) weblinkUrlGroup.style.display = "block";
        if (weblinkTitleGroup) weblinkTitleGroup.style.display = "block";
        if (weblinkImgFileGroup) weblinkImgFileGroup.style.display = "block";
        if (weblinkImgUrlGroup) weblinkImgUrlGroup.style.display = "block";
        break;
      case "image":
        textGroup.style.display = "none";
        audioGroup.style.display = "none";
        audioUrlGroup.style.display = "none";
        navigationGroup.style.display = "none";
        const imgFileGrp = document.getElementById("image-file-group");
        const imgUrlGrp = document.getElementById("image-url-group");
        const imgSizeGrp = document.getElementById("image-size-group");
        if (imgFileGrp) imgFileGrp.style.display = "block";
        if (imgUrlGrp) imgUrlGrp.style.display = "block";
        if (imgSizeGrp) imgSizeGrp.style.display = "block";
        break;
    }
  }

  enterEditMode() {
    // Gate entering edit mode by the UI toggle to prevent accidental placement
    const toggle = document.getElementById("edit-mode-toggle");
    // If the toggle exists and is unchecked, do not allow entering edit mode (button appears disabled)
    if (toggle && !toggle.checked) {
      return;
    }

    this.editMode = true;
    document.getElementById("edit-indicator").style.display = "block";
    this.updateModeIndicator(); // Keep instructions consistent
  }

  exitEditMode() {
    this.editMode = false;
    document.getElementById("edit-indicator").style.display = "none";
    this.updateModeIndicator(); // Keep instructions consistent
  }

  placeHotspot(evt) {
    if (!this.editMode) return;

    // Validate required fields based on hotspot type
    const validationResult = this.validateHotspotData();
    if (!validationResult.valid) {
      alert(validationResult.message);
      return;
    }

    // Get intersection point from the click event
    const intersection = evt.detail.intersection;
    if (!intersection) return;

    // Get camera for position calculation
    const camera = document.querySelector("#cam");

    // Use the optimal coordinate calculation method
    const optimizedPosition = this.calculateOptimalPosition(
      intersection,
      camera
    );

    // Create hotspot data with optimized positioning
    const hotspotData = {
      id: ++this.hotspotIdCounter,
      type: this.selectedHotspotType,
      position: `${optimizedPosition.x.toFixed(
        2
      )} ${optimizedPosition.y.toFixed(2)} ${optimizedPosition.z.toFixed(2)}`,
      text: document.getElementById("hotspot-text").value || "",
      audio: this.getSelectedAudioFile(),
      scene: this.currentScene,
      navigationTarget:
        document.getElementById("navigation-target").value || null,
      image: null,
      imageScale: 1,
      weblinkUrl: null,
      weblinkTitle: null,
      weblinkPreview: null,
    };

    // Default popup sizing for text-based hotspots (used by editor/runtime components)
    if (
      this.selectedHotspotType === "text" ||
      this.selectedHotspotType === "text-audio"
    ) {
      hotspotData.popupWidth = 4;
      hotspotData.popupHeight = 2.5;
    }

    if (this.selectedHotspotType === "image") {
      const imgFileEl = document.getElementById("hotspot-image-file");
      const imgUrlEl = document.getElementById("hotspot-image-url");
      const scaleEl = document.getElementById("hotspot-image-scale");
      const s = parseFloat(scaleEl?.value || "1") || 1;
      hotspotData.imageScale = Math.max(0.1, Math.min(10, s));
      if (imgUrlEl?.value.trim()) hotspotData.image = imgUrlEl.value.trim();
      else if (imgFileEl?.files?.[0]) hotspotData.image = imgFileEl.files[0];
    }
    if (this.selectedHotspotType === "weblink") {
      const url = (document.getElementById("weblink-url")?.value || "").trim();
      const title = (
        document.getElementById("weblink-title")?.value || ""
      ).trim();
      const wImgUrl = (
        document.getElementById("weblink-image-url")?.value || ""
      ).trim();
      const wImgFile =
        document.getElementById("weblink-image-file")?.files?.[0];
      hotspotData.weblinkUrl = url || null;
      hotspotData.weblinkTitle = title || null;
      hotspotData.weblinkPreview = wImgFile ? wImgFile : wImgUrl || null;
    }

    this.createHotspotElement(hotspotData);
    this.hotspots.push(hotspotData);
    this.scenes[this.currentScene].hotspots.push(hotspotData);
    this.updateHotspotList();
    this.saveScenesData(); // Save after adding hotspot

    // If the audio is a File, persist it into IndexedDB similar to images
    if ((hotspotData.type === "audio" || hotspotData.type === "text-audio") && hotspotData.audio instanceof File) {
      (async () => {
        try {
          const fileRef = hotspotData.audio;
          const storageKey = hotspotData.audioStorageKey || `audio_hotspot_${hotspotData.id}`;
          const saved = await this.saveAudioToIDB(storageKey, fileRef);
          if (saved) {
            hotspotData.audioStorageKey = storageKey;
            hotspotData.audioFileName = fileRef.name || null;
            // Create blob URL for immediate playback
            const blobURL = URL.createObjectURL(fileRef);
            hotspotData.audio = blobURL;
            const scH = this.scenes[this.currentScene].hotspots.find((h) => h.id === hotspotData.id);
            if (scH) {
              scH.audioStorageKey = storageKey;
              scH.audioFileName = fileRef.name || null;
              scH.audio = blobURL;
            }
            this.saveScenesData();
          }
        } catch (err) {
          console.warn("[AudioHotspot] Failed to save audio to IndexedDB", err);
        }
      })();
    }

    // If the image is a File, persist it into IndexedDB to avoid localStorage bloat
    if (hotspotData.type === "image" && hotspotData.image instanceof File) {
      (async () => {
        try {
          const fileRef = hotspotData.image;
          const storageKey = hotspotData.imageStorageKey || `image_hotspot_${hotspotData.id}`;
          const saved = await this.saveImageToIDB(storageKey, fileRef);
          if (saved) {
            hotspotData.imageStorageKey = storageKey;
            hotspotData.imageFileName = fileRef.name || null;
            // Create blob URL for immediate display
            const blobURL = URL.createObjectURL(fileRef);
            hotspotData.image = blobURL;
            // Update scene hotspot reference too
            const sceneHs = this.scenes[this.currentScene].hotspots.find((h) => h.id === hotspotData.id);
            if (sceneHs) {
              sceneHs.imageStorageKey = storageKey;
              sceneHs.imageFileName = fileRef.name || null;
              sceneHs.image = blobURL;
            }
            // Update existing entity's image src
            const el = document.getElementById(`hotspot-${hotspotData.id}`);
            const imgEnt = el?.querySelector(".static-image-hotspot");
            if (imgEnt) imgEnt.setAttribute("src", blobURL);
            // Persist again with stripped blobs (saveScenesData will strip blob URLs when storageKey exists)
            this.saveScenesData();
          }
        } catch (err) {
          console.warn("[ImageHotspot] Failed to save image to IndexedDB", err);
        }
      })();
    }
    // If weblink preview is a File, convert to data URL to persist
    if (
      hotspotData.type === "weblink" &&
      hotspotData.weblinkPreview instanceof File
    ) {
      const f = hotspotData.weblinkPreview;
      this._fileToDataURL(f)
        .then((dataUrl) => {
          hotspotData.weblinkPreview = dataUrl;
          const scH = this.scenes[this.currentScene].hotspots.find(
            (h) => h.id === hotspotData.id
          );
          if (scH) scH.weblinkPreview = dataUrl;
          this.saveScenesData();
        })
        .catch(() => {});
    }
    this.exitEditMode();

    // Clear form fields
    document.getElementById("hotspot-text").value = "";
    document.getElementById("hotspot-audio").value = "";
    document.getElementById("hotspot-audio-url").value = "";
    document.getElementById("navigation-target").value = "";
    const imageFileEl = document.getElementById("hotspot-image-file");
    if (imageFileEl) imageFileEl.value = "";
    const imageUrlEl = document.getElementById("hotspot-image-url");
    if (imageUrlEl) imageUrlEl.value = "";
    const imageScaleEl = document.getElementById("hotspot-image-scale");
    if (imageScaleEl) imageScaleEl.value = "1";
  }

  validateHotspotData() {
    const type = this.selectedHotspotType;
    const textContent = document.getElementById("hotspot-text").value.trim();
    const audioFile = document.getElementById("hotspot-audio").files[0];
    const audioUrl = document.getElementById("hotspot-audio-url").value.trim();
    const navigationTarget = document.getElementById("navigation-target").value;
    const weblinkUrl = (
      document.getElementById("weblink-url")?.value || ""
    ).trim();
    const weblinkTitle = (
      document.getElementById("weblink-title")?.value || ""
    ).trim();
    const weblinkImgFile =
      document.getElementById("weblink-image-file")?.files?.[0];
    const weblinkImgUrl = (
      document.getElementById("weblink-image-url")?.value || ""
    ).trim();
    const imageFileInput = document.getElementById("hotspot-image-file");
    const imageUrlInput = document.getElementById("hotspot-image-url");
    const imageFile = imageFileInput ? imageFileInput.files[0] : null;
    const imageUrl = imageUrlInput ? imageUrlInput.value.trim() : "";

    switch (type) {
      case "text":
        if (!textContent) {
          return {
            valid: false,
            message: "Text popup type requires text content to be filled.",
          };
        }
        break;

      case "audio":
        if (!audioFile && !audioUrl) {
          return {
            valid: false,
            message:
              "Audio only type requires an audio file or audio URL to be provided.",
          };
        }
        break;

      case "text-audio":
        if (!textContent || (!audioFile && !audioUrl)) {
          return {
            valid: false,
            message:
              "Text + Audio type requires both text content and audio (file or URL).",
          };
        }
        break;

      case "navigation":
        if (!navigationTarget) {
          return {
            valid: false,
            message: "Navigation hotspots require a target scene.",
          };
        }
        break;
      case "weblink":
        if (!weblinkUrl || !/^https?:\/\//i.test(weblinkUrl)) {
          return {
            valid: false,
            message:
              "Weblink portal requires a valid URL starting with http:// or https://.",
          };
        }
        break;
      case "image":
        if (!imageFile && !imageUrl) {
          return {
            valid: false,
            message: "Image hotspot requires an image file or image URL.",
          };
        }
        break;
    }

    return { valid: true };
  }

  getSelectedAudioFile() {
    const audioFile = document.getElementById("hotspot-audio").files[0];
    const audioUrl = document.getElementById("hotspot-audio-url").value.trim();

    if (audioUrl) {
      return audioUrl; // Return URL string for online audio
    }
    return audioFile ? audioFile : null; // Return file object for uploaded audio
  }

  createHotspotElement(data) {
    const container = document.getElementById("hotspot-container");
    // Track whether this image hotspot should lazy-load its blob from IndexedDB after element creation
    let _imageHasStorageKey = false;
    // Candidate key to use when loading image blobs from IndexedDB (supports legacy key naming)
    let _imageLoadKey = null;
    let hotspotEl;
    if (data.type === "navigation" || data.type === "weblink") {
      // Parent container
      hotspotEl = document.createElement("a-entity");
      hotspotEl.setAttribute("face-camera", "");

      // Transparent circle collider to capture pointer inside the circle
      const collider = document.createElement("a-entity");
      // Use customizable ring size
      const navStyles =
        (this.customStyles && this.customStyles.navigation) || {};
      const ringOuter =
        typeof navStyles.ringOuterRadius === "number"
          ? navStyles.ringOuterRadius
          : 0.6;
      const ringThickness =
        typeof navStyles.ringThickness === "number"
          ? navStyles.ringThickness
          : 0.02;
      const ringInner = Math.max(0.001, ringOuter - ringThickness);
      const ringColor =
        data.type === "weblink"
          ? navStyles.weblinkRingColor || "#001f5b"
          : navStyles.ringColor || "rgb(0, 85, 0)";
      collider.setAttribute(
        "geometry",
        `primitive: circle; radius: ${ringOuter}`
      );
      // Prevent invisible collider from occluding preview via depth writes
      collider.setAttribute(
        "material",
        "opacity: 0; transparent: true; depthWrite: false; side: double"
      );
      collider.classList.add("clickable");
      hotspotEl.appendChild(collider);

      // Visible green border ring (approx. 3px) with transparent center
      const ring = document.createElement("a-entity");
      ring.setAttribute(
            "geometry",
            `primitive: ring; radiusInner: ${ringInner}; radiusOuter: ${ringOuter}`
          );
          // Double-sided to ensure visibility regardless of facing, flat shader for crisp edges
          ring.setAttribute(
            "material",
            `color: ${ringColor}; opacity: 1; transparent: true; shader: flat; side: double`
          );
          // Nudge closer to the camera so it renders in front of nearby UI
          ring.setAttribute("position", "0 0 0.2");
      ring.classList.add("nav-ring");
      hotspotEl.appendChild(ring);

      // Inline preview circle (hidden by default), shows destination scene image (or weblink preview image) inside the ring
      const preview = document.createElement("a-entity");
      preview.setAttribute(
        "geometry",
        `primitive: circle; radius: ${ringInner}`
      );
      preview.setAttribute(
        "material",
        "transparent: true; opacity: 1; shader: flat; side: double; alphaTest: 0.01; npot: true"
      );
      preview.setAttribute("visible", "false");
      // Keep preview just behind the ring but still well in front of other UI
      preview.setAttribute("position", "0 0 0.14");
      preview.setAttribute("scale", "0.01 0.01 0.01");
      preview.classList.add("nav-preview-circle");
      hotspotEl.appendChild(preview);

      // If this is a weblink with a configured preview, set the texture immediately so the image object exists from the start
      if (data.type === "weblink") {
        try {
          let src = null;
          if (data.weblinkPreview instanceof File) {
            try {
              src = URL.createObjectURL(data.weblinkPreview);
            } catch (_) {}
          } else if (
            typeof data.weblinkPreview === "string" &&
            data.weblinkPreview
          ) {
            src = data.weblinkPreview;
          }
          if (src) {
            preview.setAttribute("material", "src", src);
            preview.setAttribute("material", "transparent", true);
            preview.setAttribute("material", "opacity", 1);
            preview.setAttribute("material", "shader", "flat");
            preview.setAttribute("material", "side", "double");
            preview.setAttribute("material", "alphaTest", 0.01);
          }
        } catch (err) {
          console.warn("[Weblink][Create] failed to set preview", err);
        }
      }

      // Hover title label above the ring
      const labelGroup = document.createElement("a-entity");
      labelGroup.setAttribute("visible", "false");
      labelGroup.classList.add("nav-label");
      // place above the ring using ringOuter as reference
      const labelY = ringOuter + 0.35;
      // Push the label well forward so it clearly appears in front of audio/text hotspots
      labelGroup.setAttribute("position", `0 ${labelY} 0.3`);
      const labelBg = document.createElement("a-plane");
      labelBg.setAttribute("width", "1.8");
      labelBg.setAttribute("height", "0.35");
      const lblBG = (navStyles && navStyles.labelBackgroundColor) || "#000";
      const lblOP =
        typeof navStyles.labelOpacity === "number"
          ? navStyles.labelOpacity
          : 0.8;
      labelBg.setAttribute(
        "material",
        `shader:flat; color: ${lblBG}; opacity: ${lblOP}; transparent: true`
      );
      labelBg.setAttribute("position", "0 0 0");
      const labelText = document.createElement("a-text");
      labelText.setAttribute("value", "");
      labelText.setAttribute("align", "center");
      const lblColor = (navStyles && navStyles.labelColor) || "#fff";
      labelText.setAttribute("color", lblColor);
      labelText.setAttribute("width", "5");
      labelText.setAttribute("position", "0 0 0.01");
      labelGroup.appendChild(labelBg);
      labelGroup.appendChild(labelText);
      hotspotEl.appendChild(labelGroup);
      } else {
      // For non-navigation hotspots use a transparent plane for click targeting, except image hotspots
      hotspotEl = document.createElement("a-entity");
      if (data.type !== "image") {
        hotspotEl.setAttribute(
          "geometry",
          "primitive: plane; width: 0.7; height: 0.7"
        );
        // Prevent the fully transparent plane from occluding portals by disabling depth writes/tests
        hotspotEl.setAttribute(
          "material",
          "opacity: 0; transparent: true; depthWrite: false; depthTest: false; side: double"
        );
        hotspotEl.classList.add("clickable");
      }
      // Always face camera for consistent UI orientation
      hotspotEl.setAttribute("face-camera", "");
    }
  hotspotEl.setAttribute("id", `hotspot-${data.id}`);
    hotspotEl.setAttribute("position", data.position);
    // Only navigation parent is clickable; others use child elements for clicks
    if (data.type === "navigation" || data.type === "weblink") {
      hotspotEl.setAttribute("class", "clickable");
    }

    // Create spot component attributes based on type
    let spotConfig = `type:${data.type}`;

    if (data.type === "text" || data.type === "text-audio") {
      const pw = typeof data.popupWidth === "number" ? data.popupWidth : 4;
      const ph = typeof data.popupHeight === "number" ? data.popupHeight : 2.5;
      spotConfig += `;popup:${data.text};popupWidth:${pw};popupHeight:${ph};popupColor:#333333`;
    }

    if (data.type === "audio" || data.type === "text-audio") {
      // Use custom audio URL if available, otherwise use default
      let audioSrc = data.audio || "#default-audio";

      // If it's a File object, create a blob URL for the editor
      if (
        data.audio &&
        typeof data.audio === "object" &&
        data.audio instanceof File
      ) {
        audioSrc = URL.createObjectURL(data.audio);
      }

      // If the audio source is a transient blob/data URL, place it into <a-assets>
      // and reference it by ID to avoid occasional blob fetch failures in A-Frame.
      if (typeof audioSrc === "string" && (audioSrc.startsWith("blob:") || audioSrc.startsWith("data:"))) {
        try {
          const assets = document.querySelector('a-assets') || (function(){
            const scn = document.querySelector('a-scene') || document.querySelector('scene, a-scene');
            const a = document.createElement('a-assets');
            if (scn) scn.insertBefore(a, scn.firstChild);
            return a;
          })();
          const assetId = `audio_hs_${data.id}`;
          let assetEl = assets.querySelector(`#${assetId}`);
          if (!assetEl) {
            assetEl = document.createElement('audio');
            assetEl.setAttribute('id', assetId);
            assetEl.setAttribute('crossorigin', 'anonymous');
            assets.appendChild(assetEl);
          }
          // Always set/update src in case the blob changed
          assetEl.setAttribute('src', audioSrc);
          // Reference via asset ID for stable loading
          audioSrc = `#${assetId}`;
        } catch (_) { /* non-fatal; fall back to direct blob URL */ }
      }

      spotConfig += `;audio:${audioSrc}`;
    }

    if (data.type === "navigation") {
      spotConfig += `;navigation:${data.navigationTarget}`;
    }
    if (data.type === "weblink") {
      // custom schema fields will be carried via editor-spot as additional attrs for later retrieval
      const url = (data.weblinkUrl || "").replace(
        /;/g,
        encodeURIComponent(";")
      );
      spotConfig += `;weblink:${url}`;
      if (data.weblinkTitle)
        spotConfig += `;weblinkTitle:${(data.weblinkTitle || "").replace(
          /;/g,
          encodeURIComponent(";")
        )}`;
      if (data.weblinkPreview) {
        let psrc = data.weblinkPreview;
        if (psrc instanceof File) {
          try {
            psrc = URL.createObjectURL(psrc);
          } catch (_) {}
        }
        if (typeof psrc === "string" && psrc.includes(";"))
          psrc = encodeURIComponent(psrc);
        spotConfig += `;weblinkPreview:${psrc}`;
      }
    }

    if (data.type === "image") {
      let imgSrc = "";
      // If we have an image stored in IDB (from a previous session), resolve it lazily
      // Prefer explicit key, but fall back to legacy pattern image_hotspot_<id>
      _imageLoadKey = data.imageStorageKey || (typeof data.id === 'number' ? `image_hotspot_${data.id}` : null);
      _imageHasStorageKey = !!_imageLoadKey && (!data.image || typeof data.image !== 'string' || data.image.startsWith('blob:'));
      if (data.image instanceof File) {
        try {
          imgSrc = URL.createObjectURL(data.image);
          console.log(
            "[ImageHotspot] Created object URL for file",
            data.image.name,
            imgSrc
          );
          // Preload to compute aspect ratio ASAP, so init can use it
          try {
            const preload = new Image();
            preload.onload = () => {
              const nW = preload.naturalWidth || 0;
              const nH = preload.naturalHeight || 0;
              const ar = nW > 0 && nH > 0 ? nH / nW : 0;
              console.log(
                `[ImageHotspot][Preload] id=${data.id} file=${data.image.name} natural=${nW}x${nH} ar=${ar}`
              );
              if (ar && isFinite(ar) && ar > 0) {
                data.imageAspectRatio = ar; // seed for component init
                this._persistImageAspectRatio(data.id, ar);
                // If entity already exists, enforce immediately
                const el = document.getElementById(`hotspot-${data.id}`);
                const imgEl = el?.querySelector(".static-image-hotspot");
                const scl =
                  typeof data.imageScale === "number" ? data.imageScale : 1;
                if (imgEl) {
                  imgEl.dataset.aspectRatio = String(ar);
                  imgEl.setAttribute("width", 1);
                  imgEl.setAttribute("height", ar);
                  imgEl.setAttribute("position", `0 ${(ar / 2) * scl} 0.05`);
                  console.log(
                    `[ImageHotspot][Preload-Apply] id=hotspot-${
                      data.id
                    } -> w=1 h=${ar} y=${(ar / 2) * scl}`
                  );
                }
              }
            };
            preload.onerror = () =>
              console.warn(
                "[ImageHotspot][Preload] failed to read image size for",
                data.image.name
              );
            preload.src = imgSrc;
          } catch (e) {
            console.warn("[ImageHotspot][Preload] exception", e);
          }
        } catch (e) {
          console.warn(
            "[ImageHotspot] Failed to create object URL, attempting FileReader fallback",
            e
          );
          try {
            const fr = new FileReader();
            fr.onload = () => {
              const el = document.getElementById(`hotspot-${data.id}`);
              if (el) {
                const imgEnt = el.querySelector(".static-image-hotspot");
                if (imgEnt) imgEnt.setAttribute("src", fr.result);
              }
            };
            fr.readAsDataURL(data.image);
          } catch (frErr) {
            console.error("[ImageHotspot] Fallback FileReader failed", frErr);
          }
        }
      } else if (typeof data.image === "string") imgSrc = data.image;
          // If we have a stored image key but the src is a stale blob URL from a previous session,
          // start with a tiny transparent pixel so the element initializes cleanly, and we'll
          // swap in the fresh blob from IndexedDB right after append.
          if (_imageHasStorageKey && (!imgSrc || (typeof imgSrc === 'string' && imgSrc.startsWith('blob:')))) {
            imgSrc = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
          }
      const scale = typeof data.imageScale === "number" ? data.imageScale : 1;
      const encodedImgSrc =
        imgSrc && imgSrc.includes(";") ? encodeURIComponent(imgSrc) : imgSrc;
      const ar =
        typeof data.imageAspectRatio === "number" &&
        isFinite(data.imageAspectRatio) &&
        data.imageAspectRatio > 0
          ? data.imageAspectRatio
          : typeof data._aspectRatio === "number" &&
            isFinite(data._aspectRatio) &&
            data._aspectRatio > 0
          ? data._aspectRatio
          : 0;
      spotConfig +=
        `;imageSrc:${encodedImgSrc};imageScale:${scale}` +
        (ar ? `;imageAspectRatio:${ar}` : "");
      try {
        console.log(
          `[ImageHotspot][Create] id=${
            data.id
          } scale=${scale} ar=${ar} src=${encodedImgSrc?.slice(0, 64)}`
        );
      } catch (_) {}
      // Schedule integrity check & fallback to data URL if texture fails to materialize
      if (data.image instanceof File) {
        const scheduleFallback = (delay) => {
          setTimeout(() => {
            const el = document.getElementById(`hotspot-${data.id}`);
            if (!el) return;
            const imgEnt = el.querySelector(".static-image-hotspot");
            if (!imgEnt) return;
            let needsFallback = false;
            try {
              const mesh = imgEnt.getObject3D("mesh");
              const texImg =
                mesh &&
                mesh.material &&
                mesh.material.map &&
                mesh.material.map.image;
              if (!texImg || !texImg.naturalWidth) needsFallback = true;
            } catch (err) {
              needsFallback = true;
            }
            if (needsFallback) {
              console.log(
                "[ImageHotspot] Fallback triggered; converting file to data URL for",
                data.image.name
              );
              const fr2 = new FileReader();
              fr2.onload = () => {
                // only replace if still same id and still not loaded
                const el2 = document.getElementById(`hotspot-${data.id}`);
                const imgEnt2 = el2?.querySelector(".static-image-hotspot");
                if (imgEnt2) imgEnt2.setAttribute("src", fr2.result);
              };
              try {
                fr2.readAsDataURL(data.image);
              } catch (_) {}
            } else {
              // Texture fine
              // Optionally revoke object URL later (not revoking to allow editing reuse)
            }
          }, delay);
        };
        scheduleFallback(800);
        scheduleFallback(2000);
      }
  }

    hotspotEl.setAttribute("editor-spot", spotConfig);

    // Add in-scene edit and move buttons for easier access (visible only in edit mode)
    this.addInSceneEditButton(hotspotEl, data);

    // Add navigation click handler if not in edit mode
    if (data.type === "navigation" || data.type === "weblink") {
      const targetEl = hotspotEl.querySelector(".clickable") || hotspotEl;
      targetEl.addEventListener("click", (e) => {
        if (!this.navigationMode) return; // Only navigate when not in edit mode
        e.stopPropagation();
        if (data.type === "navigation")
          this.navigateToScene(data.navigationTarget);
        else if (data.type === "weblink") {
          const url = data.weblinkUrl;
          if (url) {
            try {
              window.open(url, "_blank");
            } catch (_) {
              location.href = url;
            }
          }
        }
      });

      // Hover preview of destination scene INSIDE the circle
      const previewEl = hotspotEl.querySelector(".nav-preview-circle");
      targetEl.addEventListener("mouseenter", () => {
        if (previewEl) {
          let src = null;
          if (data.type === "navigation") {
            src = this._getEditorPreviewSrc(data.navigationTarget);
          }
          else if (data.type === "weblink") {
            if (data.weblinkPreview instanceof File) {
              try {
                src = URL.createObjectURL(data.weblinkPreview);
              } catch (_) {}
            } else if (
              typeof data.weblinkPreview === "string" &&
              data.weblinkPreview
            ) {
              src = data.weblinkPreview;
            }
          }
          if (src === 'VIDEO_ICON') {
            // Try to generate a thumbnail from the destination video
            (async () => {
              const thumb = await this._ensureVideoPreview(data.navigationTarget);
              const matSrc = thumb || 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="128" height="128"><rect rx="4" ry="4" x="2" y="6" width="14" height="12" fill="#111" stroke="#2ae" stroke-width="2"/><polygon points="16,10 22,7 22,17 16,14" fill="#2ae"/></svg>');
              previewEl.setAttribute("material", "src", matSrc);
              previewEl.setAttribute("material", "transparent", true);
              previewEl.setAttribute("material", "opacity", 1);
              previewEl.setAttribute("material", "shader", "flat");
              previewEl.setAttribute("material", "side", "double");
              previewEl.setAttribute("material", "alphaTest", 0.01);
              previewEl.setAttribute("material", "npot", true);
              // Debug: verify texture binding shortly after
              setTimeout(() => {
                try {
                  const mesh = previewEl.getObject3D('mesh');
                  const ok = !!(mesh && mesh.material && mesh.material.map && mesh.material.map.image && mesh.material.map.image.naturalWidth);
                  console.log('[Preview][Check][VideoThumb]', { ok, matSrc, hasMesh: !!mesh });
                } catch (_) {}
              }, 120);
            })();
            previewEl.setAttribute("material", "transparent", true);
            previewEl.setAttribute("material", "opacity", 1);
            previewEl.setAttribute("material", "shader", "flat");
            previewEl.setAttribute("material", "side", "double");
            previewEl.setAttribute("material", "alphaTest", 0.01);
            previewEl.setAttribute("material", "npot", true);
          } else if (src) {
            console.log("[Preview][Hover][Editor]", {
              id: data.id,
              type: data.type,
              srcType: src.startsWith("data:") ? "dataURL" : "url",
              len: src.length,
            });
            previewEl.setAttribute("material", "src", src);
            previewEl.setAttribute("material", "transparent", true);
            previewEl.setAttribute("material", "opacity", 1);
            previewEl.setAttribute("material", "shader", "flat");
            previewEl.setAttribute("material", "side", "double");
            previewEl.setAttribute("material", "alphaTest", 0.01);
            previewEl.setAttribute("material", "npot", true);
            // Debug: verify texture binding shortly after
            setTimeout(() => {
              try {
                const mesh = previewEl.getObject3D('mesh');
                const m = mesh && mesh.material;
                const img = m && m.map && m.map.image;
                console.log('[Preview][Check]', {
                  hasMesh: !!mesh,
                  hasMap: !!(m && m.map),
                  imgW: img && img.naturalWidth,
                  imgH: img && img.naturalHeight,
                  color: m && m.color && m.color.getHexString && m.color.getHexString(),
                  npot: m && m.npot,
                });
                // If still no map image dimensions, try to nudge material by reassigning src once
                if (!(img && img.naturalWidth)) {
                  // Create or reuse an <img> asset and point the material to it
                  const assetSel = this._ensurePreviewAsset(src, data.navigationTarget || data.id);
                  previewEl.setAttribute('material', 'src', assetSel);
                  // Re-check once more
                  setTimeout(() => {
                    try {
                      const mesh2 = previewEl.getObject3D('mesh');
                      const m2 = mesh2 && mesh2.material;
                      const img2 = m2 && m2.map && m2.map.image;
                      console.log('[Preview][Check][Asset]', {
                        ok: !!(img2 && img2.naturalWidth),
                        assetSel,
                        imgW: img2 && img2.naturalWidth,
                        imgH: img2 && img2.naturalHeight,
                      });
                    } catch (_) {}
                  }, 120);
                }
              } catch (_) {}
            }, 150);
          } else if (data.type === "weblink") {
            // Fallback: subtle fill to indicate active portal when no preview image is provided
            previewEl.setAttribute("material", "color", "#000");
            previewEl.setAttribute("material", "transparent", true);
            previewEl.setAttribute("material", "opacity", 0.15);
            previewEl.setAttribute("material", "shader", "flat");
            previewEl.setAttribute("material", "side", "double");
          }
          previewEl.setAttribute("visible", "true");
          previewEl.removeAttribute("animation__shrink");
          previewEl.setAttribute("scale", "0.01 0.01 0.01");
          previewEl.setAttribute("animation__grow", {
            property: "scale",
            to: "1 1 1",
            dur: 180,
            easing: "easeOutCubic",
          });
          try {
            console.log(
              "[Preview][MaterialAfterSet][Editor]",
              previewEl.getAttribute("material")
            );
          } catch (_) {}
        }
        // Show label title
        try {
          const label = hotspotEl.querySelector(".nav-label");
          const txt = label?.querySelector("a-text");
          if (label && txt) {
            if (data.type === "navigation") {
              const sc = this.scenes[data.navigationTarget];
              txt.setAttribute(
                "value",
                `Portal to ${sc?.name || data.navigationTarget}`
              );
            } else {
              const title =
                data.weblinkTitle && data.weblinkTitle.trim()
                  ? data.weblinkTitle.trim()
                  : "Open Link";
              txt.setAttribute("value", title);
            }
            // Dynamically size the label background using a tighter char-based estimate (spaces discounted), clamped by text width
            try {
              const bg = label.querySelector("a-plane");
              const minW = 1.7; // tighter compact width
              const maxW = 10; // safety cap
              const tW = parseFloat(txt.getAttribute("width") || "0") || minW; // your chosen text width (e.g., 5)
              const val = (txt.getAttribute("value") || "").toString();
              const spaces = (val.match(/\s/g) || []).length;
              const letters = Math.max(0, val.length - spaces);
              const effChars = letters + 0.4 * spaces; // spaces count less toward width
              // Heuristic: ~0.095 world units per effective char + small padding
              const est = 0.095 * effChars + 0.25;
              const nextW = Math.min(maxW, Math.max(minW, Math.min(tW, est)));
              if (bg) bg.setAttribute("width", String(nextW));
            } catch (_) {}
            label.setAttribute("visible", "true");
          }
        } catch (_) {}
      });
      targetEl.addEventListener("mouseleave", () => {
        if (previewEl) {
          previewEl.removeAttribute("animation__grow");
          previewEl.setAttribute("animation__shrink", {
            property: "scale",
            to: "0.01 0.01 0.01",
            dur: 120,
            easing: "easeInCubic",
          });
          setTimeout(() => {
            previewEl.setAttribute("visible", "false");
          }, 130);
        }
        // Hide label title
        try {
          const label = hotspotEl.querySelector(".nav-label");
          if (label) {
            label.setAttribute("visible", "false");
            // Reset background width back to default for next hover
            const bg = label.querySelector("a-plane");
            if (bg) bg.setAttribute("width", "1.8");
          }
        } catch (_) {}
      });
    }

    container.appendChild(hotspotEl);
    if (data.type === "image") {
      // If we need to resolve an image from IDB, do it after entity creation
      if (_imageHasStorageKey) {
        (async () => {
          try {
            const rec = await this.getImageFromIDB(_imageLoadKey);
            if (rec && rec.blob) {
              const url = URL.createObjectURL(rec.blob);
              const imgEnt = hotspotEl.querySelector('.static-image-hotspot');
              if (imgEnt) {
                imgEnt.setAttribute('src', url);
                // mark into data so subsequent saves can strip the blob (storageKey persisted separately)
                data.image = url;
                // If rounded corners are enabled, re-apply mask now that real image is in place
                try {
                  const istyleNow = this.customStyles && this.customStyles.image;
                  if (istyleNow && istyleNow.borderRadius && istyleNow.borderRadius > 0) {
                    applyRoundedMaskToAImage(imgEnt, istyleNow, true);
                  }
                } catch(_) {}
                // Re-evaluate aspect ratio based on the real texture once it binds
                const applyRealAR = () => {
                  try {
                    const mesh = imgEnt.getObject3D('mesh');
                    const texImg = mesh && mesh.material && mesh.material.map && mesh.material.map.image;
                    const nW = texImg && (texImg.naturalWidth || texImg.width) || 0;
                    const nH = texImg && (texImg.naturalHeight || texImg.height) || 0;
                    const ratio = nW > 0 && nH > 0 ? nH / nW : 0;
                    if (ratio && isFinite(ratio) && ratio > 0) {
                      imgEnt.dataset.aspectRatio = String(ratio);
                      const scl = (typeof data.imageScale === 'number' ? data.imageScale : 1);
                      imgEnt.setAttribute('width', 1);
                      imgEnt.setAttribute('height', ratio);
                      imgEnt.setAttribute('position', `0 ${(ratio / 2) * scl} 0.05`);
                      // Adjust border frame if present
                      const frame = hotspotEl.querySelector('.static-image-border');
                      if (frame) {
                        const bw = (this.customStyles && this.customStyles.image && this.customStyles.image.borderWidth) || 0;
                        frame.setAttribute('width', 1 * scl + bw * 2);
                        frame.setAttribute('height', ratio * scl + bw * 2);
                        frame.setAttribute('position', `0 ${(ratio / 2) * scl} 0.0`);
                      }
                      // Persist to model
                      try {
                        if (window.hotspotEditor) window.hotspotEditor._persistImageAspectRatio(data.id, ratio);
                      } catch(_) {}
                      return true;
                    }
                  } catch(_) {}
                  return false;
                };
                // Listen for texture ready and also poll shortly after
                const onTexReady = () => { applyRealAR(); };
                imgEnt.addEventListener('materialtextureloaded', onTexReady, { once: true });
                setTimeout(applyRealAR, 150);
                setTimeout(applyRealAR, 500);
                // If we loaded using a legacy-derived key, persist it onto the data model for future sessions
                if (!_imageLoadKey || !data) { /* no-op */ }
                else {
                  if (!data.imageStorageKey) {
                    data.imageStorageKey = _imageLoadKey;
                    try {
                      // Update the saved scene hotspot as well
                      const scHs = (this.scenes[this.currentScene] && this.scenes[this.currentScene].hotspots || []).find(h => h && h.id === data.id);
                      if (scHs && !scHs.imageStorageKey) scHs.imageStorageKey = _imageLoadKey;
                      this.saveScenesData();
                    } catch(_) {}
                  }
                }
              }
            }
          } catch (_) { /* ignore */ }
        })();
      }
      // After entity is created, hook into the a-image to persist AR to model once known
      setTimeout(() => {
        try {
          const imgEnt = hotspotEl.querySelector(".static-image-hotspot");
          if (!imgEnt) return;
          const id = data.id;
          const persist = (ratio) => {
            if (window.hotspotEditor)
              window.hotspotEditor._persistImageAspectRatio(id, ratio);
          };
          // If dataset already has AR, persist immediately
          const dAR = parseFloat(imgEnt.dataset.aspectRatio || "");
          if (dAR && isFinite(dAR) && dAR > 0) persist(dAR);
          imgEnt.addEventListener(
            "load",
            () => {
              const ar =
                imgEnt.naturalHeight && imgEnt.naturalWidth
                  ? imgEnt.naturalHeight / imgEnt.naturalWidth
                  : parseFloat(imgEnt.getAttribute("height")) || 1;
              if (ar && isFinite(ar) && ar > 0) {
                imgEnt.dataset.aspectRatio = String(ar);
                persist(ar);
              }
            },
            { once: true }
          );
        } catch (_) {}
      }, 100);
      const istyle = this.customStyles?.image;
      if (istyle && istyle.borderRadius && istyle.borderRadius > 0) {
        console.log(
          "[ImageRound] Scheduling post-append mask for hotspot",
          data.id
        );
        // Wait for component init + image entity creation
        setTimeout(() => {
          const imgEnt = hotspotEl.querySelector(".static-image-hotspot");
          if (imgEnt) {
            console.log(
              "[ImageRound] Post-append mask attempt (query success)",
              data.id
            );
            applyRoundedMaskToAImage(imgEnt, istyle, true);
          } else {
            console.log(
              "[ImageRound] Post-append mask deferred (no img yet)",
              data.id
            );
          }
        }, 250);
        // Second attempt fallback
        setTimeout(() => {
          const imgEnt = hotspotEl.querySelector(".static-image-hotspot");
          if (imgEnt && !imgEnt.dataset.roundedAppliedRadius) {
            console.log("[ImageRound] Second mask attempt", data.id);
            applyRoundedMaskToAImage(imgEnt, istyle, true);
          }
        }, 800);
      }
    }
  }

  addInSceneEditButton(hotspotEl, data) {
    // Create container for both buttons
    const buttonContainer = document.createElement("a-entity");
    buttonContainer.setAttribute("face-camera", "");
    buttonContainer.setAttribute("position", "0.8 0.6 0.05"); // default; will adjust for image hotspots

    // EDIT BUTTON (Gear icon)
    const editButton = document.createElement("a-entity");
    editButton.setAttribute("class", "in-scene-edit-btn clickable");
    editButton.setAttribute("position", "-0.15 0 0"); // Left position
    editButton.setAttribute("visible", "true");

    // Edit button background
    editButton.setAttribute("geometry", "primitive: circle; radius: 0.12");
    editButton.setAttribute("material", "color: #4CAF50; opacity: 1.0");

    // Edit icon using inline SVG image (reliable vs text/emoji)
    const editIcon = document.createElement("a-image");
    editIcon.setAttribute("src", this._getEditIconDataURI());
    editIcon.setAttribute("position", "0 0 0.01");
    editIcon.setAttribute("width", "0.16");
    editIcon.setAttribute("height", "0.16");
    editIcon.setAttribute("material", "shader: flat; transparent: true");
    editButton.appendChild(editIcon);

    // MOVE BUTTON (Location pin)
    const moveButton = document.createElement("a-entity");
    moveButton.setAttribute("class", "in-scene-move-btn clickable");
    moveButton.setAttribute("position", "0.15 0 0"); // Right position
    moveButton.setAttribute("visible", "true");

    // Move button background
    moveButton.setAttribute("geometry", "primitive: circle; radius: 0.12");
    moveButton.setAttribute("material", "color: #2196F3; opacity: 1.0"); // Blue color

    // Move icon using inline SVG image (reliable vs text/emoji)
    const moveIcon = document.createElement("a-image");
    moveIcon.setAttribute("src", this._getMoveIconDataURI());
    moveIcon.setAttribute("position", "0 0 0.01");
    moveIcon.setAttribute("width", "0.16");
    moveIcon.setAttribute("height", "0.16");
    moveIcon.setAttribute("material", "shader: flat; transparent: true");
    moveButton.appendChild(moveIcon);

    // Add buttons to container
    buttonContainer.appendChild(editButton);
    buttonContainer.appendChild(moveButton);
    hotspotEl.appendChild(buttonContainer);

    // EDIT BUTTON EVENTS
    editButton.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      console.log("🔧 Edit button clicked for hotspot:", data.id);
      this.showEditHotspotDialog(data.id);
    });

    editButton.addEventListener("mouseenter", (e) => {
      e.stopPropagation();
      editButton.setAttribute("animation__scale", {
        property: "scale",
        to: "1.3 1.3 1.3",
        dur: 150,
        easing: "easeOutQuad",
      });
    });

    editButton.addEventListener("mouseleave", (e) => {
      e.stopPropagation();
      editButton.setAttribute("animation__scale", {
        property: "scale",
        to: "1 1 1",
        dur: 150,
        easing: "easeOutQuad",
      });
    });

    // MOVE BUTTON EVENTS
    moveButton.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      console.log("� Move button clicked for hotspot:", data.id);
      this.startReposition(data.id);
    });

    moveButton.addEventListener("mouseenter", (e) => {
      e.stopPropagation();
      moveButton.setAttribute("animation__scale", {
        property: "scale",
        to: "1.3 1.3 1.3",
        dur: 150,
        easing: "easeOutQuad",
      });
    });

    moveButton.addEventListener("mouseleave", (e) => {
      e.stopPropagation();
      moveButton.setAttribute("animation__scale", {
        property: "scale",
        to: "1 1 1",
        dur: 150,
        easing: "easeOutQuad",
      });
    });

    // Store reference for easy access
    hotspotEl.inSceneButtonContainer = buttonContainer;

    // Show/hide buttons based on edit mode
    const showButtons = () => {
      console.log(
        "🔧 Showing buttons, editMode:",
        this.editMode,
        "navigationMode:",
        this.navigationMode
      );
      if (!this.navigationMode) {
        buttonContainer.setAttribute("visible", "true");
      }
    };

    const hideButtons = () => {
      console.log("🔧 Hiding buttons");
      if (this.navigationMode) {
        buttonContainer.setAttribute("visible", "false");
      }
    };

    // Add hover listeners to main hotspot element
    const mainElement = hotspotEl.querySelector(".clickable") || hotspotEl;
    mainElement.addEventListener("mouseenter", (e) => {
      console.log("🖱️ Hotspot hover enter, calling showButtons");
      showButtons();
    });

    hotspotEl.addEventListener("mouseleave", (e) => {
      console.log("🖱️ Hotspot hover leave");
      // Don't hide immediately, let user move to buttons
      setTimeout(() => {
        if (!buttonContainer.matches(":hover")) {
          hideButtons();
        }
      }, 200);
    });

    // Update visibility when edit mode changes
    hotspotEl.updateEditButtonVisibility = () => {
      console.log(
        "🔧 Updating button visibility, editMode:",
        this.editMode,
        "navigationMode:",
        this.navigationMode
      );
      if (!this.navigationMode) {
        buttonContainer.setAttribute("visible", "true");
      } else {
        buttonContainer.setAttribute("visible", "false");
      }
    };

    // Initial visibility setup
    showButtons();

    // If this is an image hotspot, adjust buttons to sit slightly BELOW the image, centered
    if (data.type === "image") {
      const adjustButtons = () => {
        try {
          const img = hotspotEl.querySelector("a-image");
          const scl = typeof data.imageScale === "number" ? data.imageScale : 1;
          if (img) {
            const w = parseFloat(img.getAttribute("width")) || scl;
            const h = parseFloat(img.getAttribute("height")) || scl;
            const x = 0; // centered horizontally
            const y = -0.25; // below the bottom edge (slightly)
            buttonContainer.setAttribute("position", `${x} ${y} 0.05`);
          }
        } catch (e) {
          /* silent */
        }
      };
      adjustButtons();
      const img = hotspotEl.querySelector("a-image");
      if (img)
        img.addEventListener("load", () => setTimeout(adjustButtons, 20));
      hotspotEl._repositionEditButtons = adjustButtons;
    }
  }

  updateHotspotList() {
    const listContainer = document.getElementById("hotspot-list");
    // Prevent horizontal overflow regardless of content length
    if (listContainer) {
      listContainer.style.overflowX = "hidden";
      listContainer.style.maxWidth = "100%";
    }

    if (this.hotspots.length === 0) {
      listContainer.innerHTML =
        '<div style="color: #888; text-align: center; padding: 20px;">No hotspots created yet</div>';
      return;
    }

    listContainer.innerHTML = "";

    this.hotspots.forEach((hotspot) => {
      const item = document.createElement("div");
      item.className = "hotspot-item";
      item.setAttribute("data-hotspot-id", hotspot.id);

      const typeIcon =
        hotspot.type === "text"
          ? "📝"
          : hotspot.type === "audio"
          ? "🔊"
          : hotspot.type === "text-audio"
          ? "🎵📝"
          : hotspot.type === "navigation"
          ? "🚪"
          : hotspot.type === "weblink"
          ? "🔗"
          : hotspot.type === "image"
          ? "🖼️"
          : "❓";

      let displayName = "";
      if (hotspot.type === "text" || hotspot.type === "text-audio") {
        displayName = hotspot.text
          ? hotspot.text.length > 30
            ? hotspot.text.substring(0, 30) + "..."
            : hotspot.text
          : "Text Hotspot";
      } else if (hotspot.type === "audio") {
        displayName = "Audio Hotspot";
      } else if (hotspot.type === "navigation") {
        if (hotspot.navigationTarget) {
          const targetScene = this.scenes[hotspot.navigationTarget];
          const targetLabel = targetScene?.name || hotspot.navigationTarget;
          displayName = `Portal to ${targetLabel}`;
        } else {
          displayName = "Navigation Portal";
        }
      } else if (hotspot.type === "weblink") {
        displayName = hotspot.weblinkTitle
          ? hotspot.weblinkTitle
          : hotspot.weblinkUrl
          ? hotspot.weblinkUrl
          : "Weblink Portal";
      } else if (hotspot.type === "image") {
        displayName = "Image";
      } else {
        displayName = "Hotspot";
      }

      item.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; max-width:100%;">
          <div style="flex: 1; min-width:0; overflow:hidden;">
            <div style="max-width:100%;">
              <strong style="display:block; max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${typeIcon} ${this._escapeHTML(
        displayName
      )}</strong>
            </div>
            <div style="font-size: 12px; color: #ccc; overflow-wrap:anywhere;">Type: ${
              hotspot.type
            }</div>
            <div style="font-size: 11px; color: #999; overflow-wrap:anywhere;">Position: ${
              hotspot.position
            }</div>
          </div>
          <div style="display:flex; gap:6px; flex:0 0 auto;">
            <button class="edit-hotspot-btn" data-hotspot-id="${
              hotspot.id
            }" style="
              background: #6a1b9a; color: white; border: none; border-radius: 6px; width: 28px; height: 28px;
              cursor: pointer; font-size: 14px; display:flex; align-items:center; justify-content:center;"
              title="Edit hotspot">📝</button>
            <button class="move-hotspot-btn" data-hotspot-id="${
              hotspot.id
            }" style="
              background: #1e88e5; color: white; border: none; border-radius: 6px; width: 28px; height: 28px;
              cursor: pointer; font-size: 14px; display:flex; align-items:center; justify-content:center;"
              title="Move hotspot">📍</button>
            <button class="delete-hotspot-btn" data-hotspot-id="${
              hotspot.id
            }" style="
              background: #f44336; color: white; border: none; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 12px;"
              title="Delete hotspot">✕</button>
          </div>
        </div>
      `;

      // Click to select/highlight hotspot (but not on delete button)
      item.addEventListener("click", (e) => {
        if (!e.target.classList.contains("delete-hotspot-btn")) {
          this.selectHotspot(hotspot.id);
        }
      });

      // Individual delete button
      const deleteBtn = item.querySelector(".delete-hotspot-btn");
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteHotspot(hotspot.id);
      });
      // Edit button
      const editBtn = item.querySelector(".edit-hotspot-btn");
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showEditHotspotDialog(hotspot.id);
      });
      // Move button
      const moveBtn = item.querySelector(".move-hotspot-btn");
      moveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.startReposition(hotspot.id);
      });

      // Hover effect for delete button
      deleteBtn.addEventListener("mouseenter", () => {
        deleteBtn.style.background = "#da190b";
      });

      deleteBtn.addEventListener("mouseleave", () => {
        deleteBtn.style.background = "#f44336";
      });

      listContainer.appendChild(item);
    });
  }

  showEditHotspotDialog(id) {
    const hotspot = this.hotspots.find((h) => h.id === id);
    if (!hotspot) return;

    const isNav = hotspot.type === "navigation";
    const isWeblink = hotspot.type === "weblink";
    const isAudioType =
      hotspot.type === "audio" || hotspot.type === "text-audio";
    const isTextType = hotspot.type === "text" || hotspot.type === "text-audio";
    const isImageType = hotspot.type === "image";

    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 10002;
      display: flex; align-items: center; justify-content: center; font-family: Arial;
    `;

    const dialog = document.createElement("div");
    dialog.style.cssText = `background: #2a2a2a; color: white; width: 520px; max-width: 90vw; border-radius: 10px; padding: 20px;`;
    dialog.innerHTML = `
      <h3 style="margin: 0 0 10px; color: #4CAF50;">Edit Hotspot</h3>
      <div style="display:flex; flex-direction: column; gap: 10px;">
        ${
          isTextType
            ? `
          <label style="font-size: 12px; color:#ccc;">Description
            <textarea id="edit-text" rows="4" style="width:100%; padding:8px; border-radius:6px; border:1px solid #555; background:#1f1f1f; color:#fff;">${this._escapeHTML(
              hotspot.text || ""
            )}</textarea>
          </label>

          <div style="display:flex; gap:10px;">
            <label style="flex:1; font-size:12px; color:#ccc;">Popup Width
              <input id="edit-popup-width" type="number" min="2" max="10" step="0.25" value="${
                typeof hotspot.popupWidth === "number" ? hotspot.popupWidth : 4
              }" style="width:100%; padding:8px; border-radius:6px; border:1px solid #555; background:#1f1f1f; color:#fff;" />
              <input id="edit-popup-width-range" type="range" min="2" max="10" step="0.1" value="${
                typeof hotspot.popupWidth === "number" ? hotspot.popupWidth : 4
              }" style="width:100%; margin-top:6px;" />
            </label>
            <label style="flex:1; font-size:12px; color:#ccc;">Popup Height
              <input id="edit-popup-height" type="number" min="1.5" max="10" step="0.25" value="${
                typeof hotspot.popupHeight === "number"
                  ? hotspot.popupHeight
                  : 2.5
              }" style="width:100%; padding:8px; border-radius:6px; border:1px solid #555; background:#1f1f1f; color:#fff;" />
              <input id="edit-popup-height-range" type="range" min="1.5" max="10" step="0.1" value="${
                typeof hotspot.popupHeight === "number"
                  ? hotspot.popupHeight
                  : 2.5
              }" style="width:100%; margin-top:6px;" />
            </label>
          </div>
        `
            : ""
        }
        ${
          isAudioType
            ? `
          <div>
            <div style="font-size: 12px; color:#ccc; margin-bottom:6px;">Audio</div>
            <input id="edit-audio-file" type="file" accept="audio/*" style="display:block; margin-bottom:6px; color:#ddd;">
            <input id="edit-audio-url" type="url" placeholder="https://example.com/audio.mp3" value="${
              typeof hotspot.audio === "string"
                ? this._escapeAttr(hotspot.audio)
                : ""
            }" style="width:100%; padding:8px; border-radius:6px; border:1px solid #555; background:#1f1f1f; color:#fff;">
            <div style="font-size:11px; color:#999; margin-top:4px;">Choose a file or enter a URL. Leaving both empty removes audio.</div>
          </div>
        `
            : ""
        }
        ${
          isNav
            ? `
          <label style="font-size: 12px; color:#ccc;">Navigation Target
            <select id="edit-nav-target" style="width:100%; padding:8px; border-radius:6px; border:1px solid #555; background:#1f1f1f; color:#fff;"></select>
          </label>
        `
            : ""
        }
        ${
          isWeblink
            ? `
          <div>
            <div style="font-size: 12px; color:#ccc; margin-bottom:6px;">Weblink Portal</div>
            <input id="edit-weblink-url" type="url" placeholder="https://example.com" value="${this._escapeAttr(
              hotspot.weblinkUrl || ""
            )}" style="width:100%; padding:8px; border-radius:6px; border:1px solid #555; background:#1f1f1f; color:#fff; margin-bottom:8px;" />
            <input id="edit-weblink-title" type="text" placeholder="Optional title (e.g., Open Link)" value="${this._escapeAttr(
              hotspot.weblinkTitle || ""
            )}" style="width:100%; padding:8px; border-radius:6px; border:1px solid #555; background:#1f1f1f; color:#fff; margin-bottom:8px;" />
            <div style="font-size: 12px; color:#ccc; margin:8px 0 6px;">Preview Image (optional)</div>
            <input id="edit-weblink-image-file" type="file" accept="image/*" style="display:block; margin-bottom:6px; color:#ddd;" />
            <input id="edit-weblink-image-url" type="url" placeholder="Image URL or data:..." value="${
              typeof hotspot.weblinkPreview === "string"
                ? this._escapeAttr(hotspot.weblinkPreview)
                : ""
            }" style="width:100%; padding:8px; border-radius:6px; border:1px solid #555; background:#1f1f1f; color:#fff;" />
            <div style="font-size:11px; color:#999; margin-top:4px;">Choose a file or enter a URL. Leave both empty to clear the preview.</div>
          </div>
        `
            : ""
        }
        ${
          isImageType
            ? `
          <div style="display:flex; gap:10px;">s
            <label style="flex:1; font-size:12px; color:#ccc;">Scale
              <input id="edit-image-scale" type="number" min="0.1" max="10" step="0.05" value="${
                typeof hotspot.imageScale === "number" ? hotspot.imageScale : 1
              }" style="width:100%; padding:8px; border-radius:6px; border:1px solid #555; background:#1f1f1f; color:#fff;" />
              <input id="edit-image-scale-range" type="range" min="0.1" max="10" step="0.01" value="${
                typeof hotspot.imageScale === "number"
                  ? Math.min(10, Math.max(0.1, hotspot.imageScale))
                  : 1
              }" style="width:100%; margin-top:6px;" />
              <div style="display:flex; justify-content:space-between; font-size:10px; color:#777; margin-top:2px;">
                <span>Small (0.1)</span><span id="edit-image-scale-live" style="color:#ccc; font-weight:bold;">${
                  typeof hotspot.imageScale === "number"
                    ? hotspot.imageScale.toFixed(2)
                    : "1.00"
                }</span><span>Large (10)</span>
              </div>
            </label>
          </div>
          <div id="edit-image-current" style="margin:8px 0 14px; padding:8px; background:#1d1d1d; border:1px solid #444; border-radius:6px;">
            <div style="font-size:11px; color:#999; margin-bottom:6px;">Current Image</div>
            <div style="display:flex; align-items:center; gap:10px;">
              <div style="width:72px; height:48px; background:#222; border:1px solid #333; display:flex; align-items:center; justify-content:center; overflow:hidden; border-radius:4px;">
                <img id="edit-image-thumb" src="${
                  typeof hotspot.image === "string"
                    ? this._escapeAttr(hotspot.image)
                    : ""
                }" style="max-width:100%; max-height:100%; object-fit:contain;" />
              </div>
              <div style="flex:1; min-width:0;">
                <div id="edit-image-label" style="font-size:12px; color:#ccc; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">&nbsp;</div>
                <div style="font-size:10px; color:#777;">Selecting a new file or URL will replace this image.</div>
              </div>
            </div>
          </div>
          <div>
            <div style="font-size:12px; color:#ccc; margin-bottom:6px;">Replace Image</div>
            <input id="edit-image-file" type="file" accept="image/*" style="display:block; margin-bottom:6px; color:#ddd;" />
            <input id="edit-image-url" type="url" placeholder="https://example.com/image.png" value="${
              typeof hotspot.image === "string" &&
              !hotspot.image.startsWith("data:")
                ? this._escapeAttr(hotspot.image)
                : ""
            }" style="width:100%; padding:8px; border-radius:6px; border:1px solid #555; background:#1f1f1f; color:#fff;" />
            <div style="font-size:11px; color:#999; margin-top:4px;">Provide a file or URL to change the image. Leave blank to keep original.</div>
          </div>
        `
            : ""
        }
        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top: 10px;">
          <button id="edit-cancel" style="background:#666; color:#fff; border:none; padding:8px 12px; border-radius:6px; cursor:pointer;">Cancel</button>
          <button id="edit-save" style="background:#4CAF50; color:#fff; border:none; padding:8px 12px; border-radius:6px; cursor:pointer;">Save</button>
        </div>
      </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Wire up audio coordination inside dialog
    const fileInput = dialog.querySelector("#edit-audio-file");
    const urlInput = dialog.querySelector("#edit-audio-url");
    if (fileInput && urlInput) {
      fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) urlInput.value = "";
      });
      urlInput.addEventListener("input", () => {
        if (urlInput.value.trim()) fileInput.value = "";
      });
    }

    // Populate navigation targets if needed
    if (isNav) {
      const sel = dialog.querySelector("#edit-nav-target");
      if (sel) {
        sel.innerHTML = "";
        Object.keys(this.scenes).forEach((sceneId) => {
          if (sceneId !== this.currentScene) {
            const opt = document.createElement("option");
            opt.value = sceneId;
            opt.textContent = this.scenes[sceneId].name;
            if (sceneId === (hotspot.navigationTarget || ""))
              opt.selected = true;
            sel.appendChild(opt);
          }
        });
      }
    }

    // Wire up weblink preview inputs (mutual exclusion similar to audio inputs)
    if (isWeblink) {
      const f = dialog.querySelector("#edit-weblink-image-file");
      const u = dialog.querySelector("#edit-weblink-image-url");
      if (f && u) {
        f.addEventListener("change", () => {
          if (f.files && f.files.length > 0) u.value = "";
        });
        u.addEventListener("input", () => {
          if (u.value.trim()) {
            try {
              if (f) f.value = "";
            } catch (_) {}
          }
        });
      }
    }

    // Live preview for popup sizing while editing (text/text-audio)
    if (isTextType) {
      const wInput = dialog.querySelector("#edit-popup-width");
      const hInput = dialog.querySelector("#edit-popup-height");
      const wRange = dialog.querySelector("#edit-popup-width-range");
      const hRange = dialog.querySelector("#edit-popup-height-range");
      const applyLive = () => {
        const w = parseFloat(wInput?.value || "");
        const h = parseFloat(hInput?.value || "");
        const width = isNaN(w)
          ? typeof hotspot.popupWidth === "number"
            ? hotspot.popupWidth
            : 4
          : Math.min(10, Math.max(2, w));
        const height = isNaN(h)
          ? typeof hotspot.popupHeight === "number"
            ? hotspot.popupHeight
            : 2.5
          : Math.min(10, Math.max(1.5, h));
        const el = document.getElementById(`hotspot-${hotspot.id}`);
        if (!el) return;
        const bg = el.querySelector(".popup-bg");
        const txt = el.querySelector(".popup-text");
        const closeBtn = el.querySelector(".popup-close");
        if (bg) {
          bg.setAttribute("width", width);
          bg.setAttribute("height", height);
        }
        if (txt) {
          txt.setAttribute("wrap-count", Math.floor(width * 8));
          txt.setAttribute("width", (width - 0.4).toString());
        }
        if (closeBtn) {
          const margin = 0.3;
          closeBtn.setAttribute(
            "position",
            `${width / 2 - margin} ${height / 2 - margin} 0.1`
          );
        }
        // keep ranges in sync when preview clamps values
        if (wRange) wRange.value = String(width);
        if (hRange) hRange.value = String(height);
      };
      if (wInput)
        wInput.addEventListener("input", () => {
          // clamp into range and sync slider
          const v = Math.min(10, Math.max(2, parseFloat(wInput.value || "")));
          if (!isNaN(v)) {
            wInput.value = String(v);
            if (wRange) wRange.value = String(v);
          }
          applyLive();
        });
      if (hInput)
        hInput.addEventListener("input", () => {
          const v = Math.min(10, Math.max(1.5, parseFloat(hInput.value || "")));
          if (!isNaN(v)) {
            hInput.value = String(v);
            if (hRange) hRange.value = String(v);
          }
          applyLive();
        });
      if (wRange)
        wRange.addEventListener("input", () => {
          wInput.value = String(wRange.value);
          applyLive();
        });
      if (hRange)
        hRange.addEventListener("input", () => {
          hInput.value = String(hRange.value);
          applyLive();
        });
    }

    // Live preview for image scale while editing
    if (isImageType) {
      const scaleInput = dialog.querySelector("#edit-image-scale");
      const scaleRange = dialog.querySelector("#edit-image-scale-range");
      const scaleLive = dialog.querySelector("#edit-image-scale-live");
      const originalScale =
        typeof hotspot.imageScale === "number" ? hotspot.imageScale : 1;

      // Label
      try {
        const lbl = dialog.querySelector("#edit-image-label");
        if (lbl) {
          let labelText = "—";
          if (hotspot.imageFileName) {
            labelText =
              hotspot.imageFileName +
              (typeof hotspot.image === "string" &&
              hotspot.image.startsWith("data:")
                ? " (embedded)"
                : "");
          } else if (typeof hotspot.image === "string") {
            if (hotspot.image.startsWith("data:")) labelText = "Embedded Image";
            else {
              try {
                const u = new URL(hotspot.image);
                labelText = u.hostname + u.pathname;
              } catch (_) {
                labelText = hotspot.image;
              }
            }
          }
          lbl.textContent = labelText;
        }
      } catch (e) {}

      // Capture aspect ratio once
      const hotspotEl = document.getElementById(`hotspot-${hotspot.id}`);
      const imgEnt = hotspotEl?.querySelector(".static-image-hotspot");
      if (imgEnt && typeof hotspot._aspectRatio !== "number") {
        const w = parseFloat(imgEnt.getAttribute("width")) || 1;
        const h = parseFloat(imgEnt.getAttribute("height")) || 1;
        if (w > 0 && h > 0) hotspot._aspectRatio = h / w;
        imgEnt.addEventListener(
          "load",
          () => {
            if (imgEnt.naturalWidth && imgEnt.naturalHeight)
              hotspot._aspectRatio = imgEnt.naturalHeight / imgEnt.naturalWidth;
          },
          { once: true }
        );
      }

      const clampScale = (v) => Math.min(10, Math.max(0.1, v));
      const applyScale = (s) => {
        const el = document.getElementById(`hotspot-${hotspot.id}`);
        if (!el) return;
        const img = el.querySelector(".static-image-hotspot");
        if (!img) return;
        const ratio =
          hotspot._aspectRatio || parseFloat(img.getAttribute("height")) || 1;
        img.setAttribute("scale", `${s} ${s} 1`);
        img.setAttribute("position", `0 ${(ratio / 2) * s} 0.05`);
        const frame = el.querySelector(".static-image-border");
        if (frame) {
          const bw = this.customStyles?.image?.borderWidth || 0;
          frame.setAttribute("width", 1 * s + bw * 2);
          frame.setAttribute("height", ratio * s + bw * 2);
          frame.setAttribute("position", `0 ${(ratio / 2) * s} 0.0`);
        }
      };

      if (scaleInput) {
        scaleInput.addEventListener("input", () => {
          const v = clampScale(parseFloat(scaleInput.value || ""));
          if (!isNaN(v)) {
            scaleInput.value = v.toString();
            if (scaleRange) scaleRange.value = v.toString();
            if (scaleLive) scaleLive.textContent = v.toFixed(2);
            applyScale(v);
          }
        });
      }
      if (scaleRange) {
        scaleRange.addEventListener("input", () => {
          const v = clampScale(parseFloat(scaleRange.value || ""));
          scaleInput.value = v.toString();
          if (scaleLive) scaleLive.textContent = v.toFixed(2);
          applyScale(v);
        });
      }
    }

    const close = () => {
      if (overlay && overlay.parentNode)
        overlay.parentNode.removeChild(overlay);
    };
    dialog.querySelector("#edit-cancel").onclick = close;

    dialog.querySelector("#edit-save").onclick = () => {
      const isImageEdit = hotspot.type === "image";
      const prevImageRef = isImageEdit ? hotspot.image : null;
      const prevScale = isImageEdit ? hotspot.imageScale : null;
      // Collect values
      const newText = isTextType
        ? (dialog.querySelector("#edit-text")?.value || "").trim()
        : hotspot.text;
      let newAudio = hotspot.audio;
      if (isAudioType) {
        const f = dialog.querySelector("#edit-audio-file");
        const u = dialog.querySelector("#edit-audio-url");
        const file = f && f.files ? f.files[0] : null;
        const url = u ? u.value.trim() : "";
        if (url) newAudio = url;
        else if (file) newAudio = file;
        else newAudio = null;
      }
      const newNavTarget = isNav
        ? dialog.querySelector("#edit-nav-target")?.value || ""
        : hotspot.navigationTarget;
      // Weblink fields
      let newWeblinkUrl = hotspot.weblinkUrl;
      let newWeblinkTitle = hotspot.weblinkTitle;
      let newWeblinkPreview = hotspot.weblinkPreview;
      if (isWeblink) {
        const u = dialog.querySelector("#edit-weblink-url");
        const t = dialog.querySelector("#edit-weblink-title");
        const pf = dialog.querySelector("#edit-weblink-image-file");
        const pu = dialog.querySelector("#edit-weblink-image-url");
        const url = u ? u.value.trim() : "";
        const title = t ? t.value.trim() : "";
        const file = pf && pf.files ? pf.files[0] : null;
        const purl = pu ? pu.value.trim() : "";
        newWeblinkUrl = url || "";
        newWeblinkTitle = title || "";
        if (purl) newWeblinkPreview = purl;
        else if (file) newWeblinkPreview = file;
        else newWeblinkPreview = null;
      }
      let newImage = hotspot.image;
      let newImageScale = hotspot.imageScale || 1;
      if (isImageType) {
        const sVal = parseFloat(
          dialog.querySelector("#edit-image-scale")?.value || ""
        );
        newImageScale = isNaN(sVal)
          ? hotspot.imageScale || 1
          : Math.min(10, Math.max(0.1, sVal));
        const f = dialog.querySelector("#edit-image-file");
        const u = dialog.querySelector("#edit-image-url");
        const file = f && f.files ? f.files[0] : null;
        const url = u ? u.value.trim() : "";
        if (url) newImage = url;
        else if (file) newImage = file;
      }

      // Popup sizing (for text-based hotspots)
      let newPopupWidth = hotspot.popupWidth;
      let newPopupHeight = hotspot.popupHeight;
      if (isTextType) {
        const w = parseFloat(
          dialog.querySelector("#edit-popup-width")?.value || ""
        );
        const h = parseFloat(
          dialog.querySelector("#edit-popup-height")?.value || ""
        );
        // apply defaults if missing
        newPopupWidth = isNaN(w)
          ? typeof hotspot.popupWidth === "number"
            ? hotspot.popupWidth
            : 4
          : w;
        newPopupHeight = isNaN(h)
          ? typeof hotspot.popupHeight === "number"
            ? hotspot.popupHeight
            : 2.5
          : h;
        // clamp ranges
        newPopupWidth = Math.min(10, Math.max(2, newPopupWidth));
        newPopupHeight = Math.min(10, Math.max(1.5, newPopupHeight));
      }

      // Validate
      const v = this._validateHotspotValues(hotspot.type, {
        text: newText,
        audio: newAudio,
        navigationTarget: newNavTarget,
        image: newImage,
        weblinkUrl: newWeblinkUrl,
      });
      if (!v.valid) {
        alert(v.message);
        return;
      }

      // Apply to data structures
      if (isTextType) {
        hotspot.text = newText;
        hotspot.popupWidth = newPopupWidth;
        hotspot.popupHeight = newPopupHeight;
      }
      if (isAudioType) hotspot.audio = newAudio;
      if (isNav) hotspot.navigationTarget = newNavTarget;
      if (isWeblink) {
        hotspot.weblinkUrl = newWeblinkUrl;
        hotspot.weblinkTitle = newWeblinkTitle;
        // Preview may be File or string/null; if File, convert to data URL for persistence
        if (newWeblinkPreview instanceof File) {
          const pending = newWeblinkPreview;
          this._fileToDataURL(pending)
            .then((dataUrl) => {
              hotspot.weblinkPreview = dataUrl;
              const sceneHs = this.scenes[this.currentScene].hotspots.find(
                (h) => h.id === hotspot.id
              );
              if (sceneHs) sceneHs.weblinkPreview = dataUrl;
              this._refreshHotspotEntity(hotspot);
              this.saveScenesData();
            })
            .catch(() => {});
        } else {
          hotspot.weblinkPreview = newWeblinkPreview || null;
        }
      }
      if (isImageType) {
        // If replacing with a File, store into IndexedDB and use a blob URL at runtime
        if (newImage instanceof File) {
          (async () => {
            try {
              const pendingFile = newImage;
              const storageKey = hotspot.imageStorageKey || `image_hotspot_${hotspot.id}`;
              const saved = await this.saveImageToIDB(storageKey, pendingFile);
              if (saved) {
                const blobUrl = URL.createObjectURL(pendingFile);
                hotspot.image = blobUrl;
                hotspot.imageScale = newImageScale;
                hotspot.imageFileName = pendingFile.name || null;
                hotspot.imageStorageKey = storageKey;
                delete hotspot.imageWidth;
                delete hotspot.imageHeight;

                const sceneHs = this.scenes[this.currentScene].hotspots.find(
                  (h) => h.id === hotspot.id
                );
                if (sceneHs) {
                  sceneHs.image = blobUrl;
                  sceneHs.imageScale = newImageScale;
                  sceneHs.imageFileName = pendingFile.name || null;
                  sceneHs.imageStorageKey = storageKey;
                  delete sceneHs.imageWidth;
                  delete sceneHs.imageHeight;
                }

                // Update existing entity's texture if present
                const el = document.getElementById(`hotspot-${hotspot.id}`);
                const imgEnt = el?.querySelector(".static-image-hotspot");
                if (imgEnt) imgEnt.setAttribute("src", blobUrl);

                // Persist (saveScenesData will strip blob: when storageKey exists)
                this._refreshHotspotEntity(hotspot);
                this.saveScenesData();
              } else {
                console.warn("[ImageHotspot] Failed to save edited image to IndexedDB");
              }
            } catch (err) {
              console.warn("[ImageHotspot] Edit save to IDB failed", err);
            }
          })();
        } else {
          // URL or unchanged
          hotspot.image = newImage;
          hotspot.imageScale = newImageScale;
          if (typeof newImage === "string" && !newImage.startsWith("data:")) {
            try {
              const urlObj = new URL(newImage);
              hotspot.imageFileName = urlObj.pathname.split("/").pop() || null;
              // If user switched to a URL, clear storageKey so we don't expect IDB
              hotspot.imageStorageKey = null;
            } catch (_) {
              hotspot.imageFileName = hotspot.imageFileName || null;
            }
          }
          delete hotspot.imageWidth;
          delete hotspot.imageHeight;
        }
      }

      // Update scene-specific copy
      const sceneHotspot = (this.scenes[this.currentScene].hotspots || []).find(
        (h) => h.id === id
      );
      if (sceneHotspot) {
        if (isTextType) {
          sceneHotspot.text = hotspot.text;
          sceneHotspot.popupWidth = hotspot.popupWidth;
          sceneHotspot.popupHeight = hotspot.popupHeight;
        }
        if (isAudioType) sceneHotspot.audio = hotspot.audio;
        if (isNav) sceneHotspot.navigationTarget = hotspot.navigationTarget;
        if (isWeblink) {
          sceneHotspot.weblinkUrl = hotspot.weblinkUrl;
          sceneHotspot.weblinkTitle = hotspot.weblinkTitle;
          if (!(newWeblinkPreview instanceof File)) {
            sceneHotspot.weblinkPreview = hotspot.weblinkPreview || null;
          }
        }
        if (isImageType) {
          if (!(newImage instanceof File)) {
            // For File path, we update after conversion above
            sceneHotspot.image = hotspot.image;
            sceneHotspot.imageScale = hotspot.imageScale;
            if (hotspot.imageFileName)
              sceneHotspot.imageFileName = hotspot.imageFileName;
            delete sceneHotspot.imageWidth;
            delete sceneHotspot.imageHeight;
          }
        }
      }

      // Decide whether we need a full rebuild (only needed if image source changed or non-image types)
      let needsRebuild = true;
      if (isImageType) {
        const imageChanged = hotspot.image !== prevImageRef; // data URL or URL actually changed
        const scaleChanged = hotspot.imageScale !== prevScale;
        if (!imageChanged && scaleChanged) {
          // Apply scale in place to avoid white flicker from tearing down entity
          this._applyImageScaleInPlace(hotspot);
          needsRebuild = false;
        } else if (!imageChanged && !scaleChanged) {
          // Nothing materially changed for image visual; skip rebuild
          needsRebuild = false;
        }
      }
      // For weblink, ensure rebuild so preview/label/click handlers update
      if (isWeblink) {
        needsRebuild = true;
      }
      if (needsRebuild) {
        this._refreshHotspotEntity(hotspot);
      }
      this.updateHotspotList();
      this.saveScenesData(); // Save after updating hotspot
      close();
      this.showStartingPointFeedback("Hotspot updated");
    };
  }

  _validateHotspotValues(
    type,
    { text, audio, navigationTarget, image, weblinkUrl }
  ) {
    switch (type) {
      case "text":
        if (!text)
          return {
            valid: false,
            message: "Text popup type requires description text.",
          };
        return { valid: true };
      case "audio":
        if (!audio)
          return {
            valid: false,
            message: "Audio-only hotspot requires an audio file or URL.",
          };
        return { valid: true };
      case "text-audio":
        if (!text || !audio)
          return {
            valid: false,
            message: "Text + Audio hotspot requires both text and audio.",
          };
        return { valid: true };
      case "navigation":
        if (!navigationTarget)
          return {
            valid: false,
            message: "Please choose a navigation target.",
          };
        return { valid: true };
      case "weblink":
        if (!weblinkUrl || !/^https?:\/\//i.test(weblinkUrl))
          return {
            valid: false,
            message:
              "Weblink portal requires a valid URL starting with http:// or https://.",
          };
        return { valid: true };
      case "image":
        if (!image)
          return {
            valid: false,
            message: "Image hotspot requires an image file or URL.",
          };
        return { valid: true };
      default:
        return { valid: true };
    }
  }

  _refreshHotspotEntity(hotspot) {
    const el = document.getElementById(`hotspot-${hotspot.id}`);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    // Ensure position persists
    const dataCopy = { ...hotspot };
    this.createHotspotElement(dataCopy);
  }

  _applyImageScaleInPlace(hotspot) {
    try {
      const el = document.getElementById(`hotspot-${hotspot.id}`);
      if (!el) return;
      const img = el.querySelector(".static-image-hotspot");
      if (!img) return;
      // Determine aspect ratio from existing geometry
      let ratio =
        typeof hotspot.imageAspectRatio === "number" &&
        isFinite(hotspot.imageAspectRatio) &&
        hotspot.imageAspectRatio > 0
          ? hotspot.imageAspectRatio
          : null;
      if (!ratio) ratio = parseFloat(img.dataset.aspectRatio || "") || null;
      if (!ratio) {
        const bw = parseFloat(img.getAttribute("width")) || 1;
        const bh = parseFloat(img.getAttribute("height")) || 1;
        ratio = bh / (bw || 1) || 1;
      }
      if (!isFinite(ratio) || ratio <= 0) ratio = 1;
      // Enforce base geometry from ratio (prevents squaring on style changes)
      img.setAttribute("width", 1);
      img.setAttribute("height", ratio);
      img.dataset.aspectRatio = String(ratio);
      const scl = hotspot.imageScale || 1;
      img.setAttribute("scale", `${scl} ${scl} 1`);
      img.setAttribute("position", `0 ${(ratio / 2) * scl} 0.05`);
      try {
        console.log(
          `[ImageHotspot][Scale] id=hotspot-${
            hotspot.id
          } ratio=${ratio} scale=${scl} -> w=1 h=${ratio} y=${
            (ratio / 2) * scl
          }`
        );
      } catch (_) {}
      const frame = el.querySelector(".static-image-border");
      if (frame) {
        const bw = this.customStyles?.image?.borderWidth || 0;
        frame.setAttribute("width", 1 * scl + bw * 2);
        frame.setAttribute("height", ratio * scl + bw * 2);
        frame.setAttribute("position", `0 ${(ratio / 2) * scl} 0.0`);
      }
      // Persist to model if missing
      if (
        typeof hotspot.imageAspectRatio !== "number" ||
        !isFinite(hotspot.imageAspectRatio) ||
        hotspot.imageAspectRatio <= 0
      ) {
        hotspot.imageAspectRatio = ratio;
        this._persistImageAspectRatio(hotspot.id, ratio);
      }
      if (el._repositionEditButtons)
        setTimeout(() => el._repositionEditButtons(), 20);
    } catch (e) {
      console.warn(
        "[ImageHotspot] apply scale in place failed, falling back to rebuild",
        e
      );
      this._refreshHotspotEntity(hotspot);
    }
  }

  migrateLegacyImageDimensions() {
    let changed = false;
    this.hotspots.forEach((h) => {
      if (h.type === "image") {
        if (typeof h.imageScale !== "number") {
          if (typeof h.imageWidth === "number") {
            h.imageScale = h.imageWidth; // reuse previous width number as scale
          } else {
            h.imageScale = 1;
          }
          delete h.imageWidth;
          delete h.imageHeight;
          changed = true;
        }
      }
    });
    if (changed) {
      console.log(
        "[Migration] Applied legacy image width/height -> scale conversion"
      );
      this.saveScenesData();
      // Refresh any existing entities to reposition buttons correctly
      this.hotspots
        .filter((h) => h.type === "image")
        .forEach((h) => this._refreshHotspotEntity(h));
    }
  }

  // Convert a File to a data URL with caching by name+size+lastModified
  _fileToDataURL(file) {
    if (!(file instanceof File)) return Promise.resolve(file);
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (this._imageDataURLCache.has(key)) {
      return Promise.resolve(this._imageDataURLCache.get(key));
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === "string") {
          this._imageDataURLCache.set(key, result);
          resolve(result);
        } else {
          reject(new Error("Unexpected FileReader result type"));
        }
      };
      reader.onerror = (e) => reject(e);
      try {
        reader.readAsDataURL(file);
      } catch (e) {
        reject(e);
      }
    });
  }

  getReadableImageLabel(hotspot) {
    if (!hotspot) return "";
    const img = hotspot.image;
    if (hotspot.imageFileName)
      return (
        hotspot.imageFileName +
        (typeof img === "string" && img.startsWith("data:")
          ? " (embedded)"
          : "")
      );
    if (typeof img === "string") {
      if (img.startsWith("data:")) return "Embedded Image";
      try {
        const u = new URL(img);
        return u.hostname + u.pathname;
      } catch (_) {
        return img;
      }
    }
    if (img instanceof File) return img.name;
    return "";
  }

  _escapeAttr(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  _escapeHTML(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }

  // ===== Inline SVG icon helpers (reliable in A-Frame) =====
  _getEditIconDataURI() {
    // White pencil icon sized to fit inside 0.12 radius circle
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <g fill="none" stroke="white" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 110l18-4 60-60c4-4 4-10 0-14l-0.5-0.5c-4-4-10-4-14 0l-60 60-3.5 19.5z" fill="white" stroke="none"/>
    <path d="M82 22l24 24" stroke="white"/>
  </g>
  <rect x="0" y="0" width="128" height="128" fill="none"/>
  <title>edit</title>
  <desc>pencil</desc>
  <metadata>inline</metadata>
  <style></style>
</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  _getMoveIconDataURI() {
    // White pin/locator icon
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <g fill="white">
    <path d="M64 10c-20 0-36 16-36 36 0 26 36 72 36 72s36-46 36-72c0-20-16-36-36-36zm0 52a16 16 0 1 1 0-32 16 16 0 0 1 0 32z"/>
  </g>
  <rect x="0" y="0" width="128" height="128" fill="none"/>
  <title>move</title>
  <desc>pin</desc>
</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  startReposition(id) {
    this.repositioningHotspotId = id;
    this.showRepositionNotice();
    this._setHotspotTranslucent(id, true);
  }

  showRepositionNotice() {
    // Simple inline notice under instructions
    const existing = document.getElementById("reposition-notice");
    if (existing) return;
    const n = document.createElement("div");
    n.id = "reposition-notice";
    n.style.cssText =
      "position:fixed; top:20px; right:380px; background: rgba(33,150,243,0.95); color:white; padding:8px 12px; border-radius:6px; z-index:10001; font-family:Arial; font-size:12px;";
    n.textContent =
      "Reposition mode: click on the 360° image to set new position • Press ESC to cancel";
    document.body.appendChild(n);
    // esc to cancel
    this._escCancelReposition = (e) => {
      if (e.key === "Escape") this.cancelReposition();
    };
    window.addEventListener("keydown", this._escCancelReposition);
  }

  hideRepositionNotice() {
    const n = document.getElementById("reposition-notice");
    if (n && n.parentNode) n.parentNode.removeChild(n);
    if (this._escCancelReposition) {
      window.removeEventListener("keydown", this._escCancelReposition);
      this._escCancelReposition = null;
    }
  }

  applyReposition(evt) {
    const id = this.repositioningHotspotId;
    if (!id) return;
    const hotspot = this.hotspots.find((h) => h.id === id);
    if (!hotspot) {
      this.cancelReposition();
      return;
    }

    const intersection = evt.detail.intersection;
    if (!intersection) return;
    const camera = document.querySelector("#cam");
    const pos = this.calculateOptimalPosition(intersection, camera);
    const newPos = `${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(
      2
    )}`;

    // Update data
    hotspot.position = newPos;
    const sceneHotspot = (this.scenes[this.currentScene].hotspots || []).find(
      (h) => h.id === id
    );
    if (sceneHotspot) sceneHotspot.position = newPos;

    // Update entity
    const el = document.getElementById(`hotspot-${id}`);
    if (el) el.setAttribute("position", newPos);

    this.saveScenesData(); // Save after moving hotspot
    this._setHotspotTranslucent(id, false);
    this.repositioningHotspotId = null;
    this.hideRepositionNotice();
    this.updateHotspotList();
    this.showStartingPointFeedback("Hotspot moved");
  }

  cancelReposition() {
    if (this.repositioningHotspotId) {
      this._setHotspotTranslucent(this.repositioningHotspotId, false);
    }
    this.repositioningHotspotId = null;
    this.hideRepositionNotice();
  }

  _setHotspotTranslucent(id, on) {
    const el = document.getElementById(`hotspot-${id}`);
    if (!el) return;
    try {
      if (on) {
        // Keep the main invisible plane completely invisible during repositioning
        el.setAttribute("material", {
          transparent: true,
          opacity: 0, // Keep invisible plane invisible
        });

        // Find and make only the visible info button semi-transparent
        const infoButton = el.querySelector(
          'a-entity[geometry*="circle"][material*="color"]'
        );
        if (infoButton) {
          const currentMaterial = infoButton.getAttribute("material") || {};
          // Store original material for restoration
          this._repositionPrevMaterial = {
            id,
            infoButtonMaterial: { ...currentMaterial },
          };

          // Make info button semi-transparent for visual feedback
          infoButton.setAttribute("material", {
            ...currentMaterial,
            opacity: 0.55,
            transparent: true,
          });
        }

        // Add subtle pulse animation to the entire hotspot for attention
        el.setAttribute("animation__pulse", {
          property: "scale",
          from: "1 1 1",
          to: "1.1 1.1 1.1",
          dur: 600,
          dir: "alternate",
          loop: true,
          easing: "easeInOutSine",
        });
      } else {
        // Restore invisible plane to completely invisible
        el.setAttribute("material", {
          transparent: true,
          opacity: 0,
        });

        // Restore info button to original appearance
        const infoButton = el.querySelector(
          'a-entity[geometry*="circle"][material*="color"]'
        );
        if (
          infoButton &&
          this._repositionPrevMaterial &&
          this._repositionPrevMaterial.id === id
        ) {
          const originalMaterial = this._repositionPrevMaterial
            .infoButtonMaterial || {
            color: "#4A90E2",
            opacity: 0.9,
            transparent: true,
          };
          infoButton.setAttribute("material", originalMaterial);
        } else if (infoButton) {
          // Fallback to default info button appearance
          infoButton.setAttribute("material", {
            color: "#4A90E2",
            opacity: 0.9,
            transparent: true,
          });
        }

        // Remove pulse animation
        el.removeAttribute("animation__pulse");
      }
    } catch (e) {
      if (!on) {
        // Error recovery: ensure invisible plane stays invisible
        el.setAttribute("material", { transparent: true, opacity: 0 });
        el.removeAttribute("animation__pulse");

        // Restore info button if possible
        const infoButton = el.querySelector(
          'a-entity[geometry*="circle"][material*="color"]'
        );
        if (infoButton) {
          infoButton.setAttribute("material", {
            color: "#4A90E2",
            opacity: 0.9,
            transparent: true,
          });
        }
      }
    }
  }

  selectHotspot(id) {
    // Remove previous selection
    document.querySelectorAll(".hotspot-item").forEach((item) => {
      item.classList.remove("selected");
    });

    // Add selection to current item
    const item = document.querySelector(`[data-hotspot-id="${id}"]`);
    if (item) {
      item.classList.add("selected");
      this.selectedHotspotId = id;

      // Highlight the hotspot in the scene
      const hotspotEl = document.getElementById(`hotspot-${id}`);
      if (hotspotEl) {
        // Add a temporary highlight effect
        hotspotEl.emit("highlight");
      }
    }
  }

  deleteHotspot(id) {
    const hotspot = this.hotspots.find((h) => h.id === id);
    if (!hotspot) return;

    if (confirm(`Delete this hotspot?`)) {
      // Remove from array
      this.hotspots = this.hotspots.filter((h) => h.id !== id);

      // Remove from scene
      const hotspotEl = document.getElementById(`hotspot-${id}`);
      if (hotspotEl) {
        hotspotEl.remove();
      }

      this.updateHotspotList();
      this.saveScenesData(); // Save after deleting hotspot
    }
  }

  clearAllHotspots() {
    if (this.hotspots.length === 0) return;

    if (confirm("Clear all hotspots?")) {
      this.hotspots.forEach((hotspot) => {
        const hotspotEl = document.getElementById(`hotspot-${hotspot.id}`);
        if (hotspotEl) {
          hotspotEl.remove();
        }
      });

      this.hotspots = [];
      this.updateHotspotList();
      this.saveScenesData(); // Save after clearing all hotspots
    }
  }

  async saveTemplate() {
    const templateName =
      document.getElementById("template-name").value ||
      `hotspot-project-${Date.now()}`;

    // Save directly as ZIP (no dialog needed)
    this.saveAsCompleteProject(templateName);
  }

  async saveAsCompleteProject(templateName) {
    try {
      // Show progress
      const progressDiv = this.showProgress("Creating complete project...");

      // Create JSZip instance
      const JSZip = window.JSZip || (await this.loadJSZip());
      const zip = new JSZip();

      // Get current skybox image - handle both data URLs and file paths
      const skyboxImg = document.querySelector("#main-panorama");
      const skyboxSrc = skyboxImg ? skyboxImg.src : "";

      // Create project structure with all scenes
      await this.addFilesToZip(zip, templateName, skyboxSrc);

      // Generate and download ZIP
      const content = await zip.generateAsync({ type: "blob" });
      this.downloadBlob(content, `${templateName}.zip`);

      this.hideProgress(progressDiv);
      alert(
        `Complete project "${templateName}.zip" created! Extract and open index.html to run.`
      );
    } catch (error) {
      alert(`Error creating project: ${error.message}`);
    }
  }

  async loadJSZip() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src =
        "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      script.onload = () => resolve(window.JSZip);
      script.onerror = () => reject(new Error("Failed to load JSZip"));
      document.head.appendChild(script);
    });
  }

  async addFilesToZip(zip, templateName, skyboxSrc) {
    // Add main HTML file
    const htmlContent = this.generateCompleteHTML(templateName);
    zip.file("index.html", htmlContent);

    // Add JavaScript file
    const jsContent = this.generateCompleteJS();
    zip.file("script.js", jsContent);

    // Add CSS file
    const cssContent = this.generateCSS();
    zip.file("style.css", cssContent);

    // Create folders
  const imagesFolder = zip.folder("images");
  const audioFolder = zip.folder("audio");
  const videosFolder = zip.folder("videos");

    // Add real assets from current project
    await this.addRealAssets(imagesFolder, audioFolder);

    // Add all scene images
    await this.addSceneImages(imagesFolder);

    // Add configuration with all scenes and hotspots (with corrected image/audio paths)
    const scenes = await this.normalizeScenePathsForExport(
      audioFolder,
      imagesFolder,
      videosFolder
    );
    const config = {
      name: templateName,
      created: new Date().toISOString(),
      scenes,
      currentScene: this.getFirstSceneId(), // Use first scene as starting scene
      version: "1.0",
    };
    zip.file("config.json", JSON.stringify(config, null, 2));

    // Add README
    const readmeContent = `# VR Hotspot Project: ${templateName}

## How to Use
1. Open index.html in a web browser
2. Click on hotspots to interact with content
3. Use mouse to look around the 360° environment
4. Compatible with VR headsets

## Files Structure
- index.html - Main project file
- script.js - Project functionality
- style.css - Styling
- config.json - Project configuration with all scenes
- images/ - Image assets including scene panoramas
- audio/ - Audio assets

## Requirements
- Modern web browser
- Internet connection (for A-Frame library)

Generated by VR Hotspot Editor on ${new Date().toLocaleDateString()}
`;
    zip.file("README.md", readmeContent);
  }

  async addSceneImages(imagesFolder) {
    for (const [sceneId, scene] of Object.entries(this.scenes)) {
      if (scene.image.startsWith("data:")) {
        // Convert data URL to blob
        const response = await fetch(scene.image);
        const blob = await response.blob();
        imagesFolder.file(`${sceneId}.jpg`, blob);
      } else if (scene.image.startsWith("./images/")) {
        // Copy existing image files
        try {
          const response = await fetch(scene.image);
          if (response.ok) {
            const blob = await response.blob();
            const filename = scene.image.split("/").pop();
            imagesFolder.file(filename, blob);
          }
        } catch (e) {
          console.warn(`Could not copy scene image: ${scene.image}`);
        }
      }
    }
  }

  async normalizeScenePathsForExport(audioFolder, imagesFolder, videosFolder) {
    const normalizedScenes = {};

    // Helper to sanitize filenames for export (decode %20 etc. and remove illegal chars)
    const sanitizeExportFileName = (name, fallbackExt = ".mp4") => {
      if (!name || typeof name !== "string") return `file${fallbackExt}`;
      let decoded = name;
      try { decoded = decodeURIComponent(name); } catch (_) { /* keep as-is if bad URI */ }
      // Trim and normalize whitespace
      decoded = decoded.trim().replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ");
      // Remove path fragments and illegal filename characters
      decoded = decoded.replace(/^.*[\\\/]/, ""); // drop any directories
      decoded = decoded.replace(/[\\/:*?"<>|]/g, "_"); // Windows-illegal
      // Ensure we keep a reasonable extension
      if (!/\.[a-zA-Z0-9]{2,5}$/.test(decoded) && fallbackExt) {
        decoded += fallbackExt;
      }
      return decoded;
    };

    for (const [sceneId, scene] of Object.entries(this.scenes)) {
      // Create new scene object without deep copying to preserve File objects
      const newScene = {
        name: scene.name,
        type: scene.type || "image", // Include scene type
        image: this.getExportImagePath(scene.image, sceneId),
        videoSrc: scene.videoSrc || null, // Include video source (may be replaced by exported path)
        videoVolume: scene.videoVolume || 0.5, // Include video volume
        hotspots: [],
        startingPoint: scene.startingPoint,
        globalSound: null,
      };

      // If this is an image scene and the source is local/IDB, export the blob
      if (newScene.type === 'image') {
        try {
          const isRemote = (typeof scene.image === 'string' && (scene.image.startsWith('http://') || scene.image.startsWith('https://')));
          if (!isRemote) {
            const key = scene.imageStorageKey || ('image_scene_' + sceneId);
            const rec = await this.getImageFromIDB(key);
            if (rec && rec.blob && imagesFolder) {
              const baseName = rec.name || (sceneId + '.jpg');
              const ext = (baseName && /\.[a-zA-Z0-9]{2,5}$/.test(baseName)) ? baseName.match(/\.[a-zA-Z0-9]{2,5}$/)[0] : '.jpg';
              const cleanName = sanitizeExportFileName(baseName, ext);
              imagesFolder.file(cleanName, rec.blob);
              newScene.image = './images/' + cleanName;
            }
          }
        } catch(_) { /* ignore */ }
      }

      // If this is a video scene and the source is a blob URL or local, try to export the actual file from IDB
      if (newScene.type === 'video') {
        try {
          const isBlobUrl = typeof scene.videoSrc === 'string' && scene.videoSrc.startsWith('blob:');
          const isDataUrl = typeof scene.videoSrc === 'string' && scene.videoSrc.startsWith('data:');
          if (isBlobUrl || isDataUrl || scene.videoStorageKey) {
            const db = await this.openVideoDB();
            if (db) {
              const rec = await this.getVideoFromIDB(scene.videoStorageKey || sceneId);
              if (rec && rec.blob) {
                const vFolder = videosFolder;
                if (vFolder) {
                  const baseName = rec.name || scene.videoFileName || (sceneId + '.mp4');
                  const ext = (baseName && /\.[a-zA-Z0-9]{2,5}$/.test(baseName)) ? baseName.match(/\.[a-zA-Z0-9]{2,5}$/)[0] : ".mp4";
                  const cleanName = sanitizeExportFileName(baseName, ext);
                  vFolder.file(cleanName, rec.blob);
                  newScene.videoSrc = './videos/' + cleanName;
                }
              }
            }
          }
        } catch (_) { /* ignore export video failure, keep original src */ }
      }

      // Handle global sound (export blobs/IDB to files)
      if (scene.globalSound && scene.globalSound.enabled) {
        const gs = scene.globalSound;
        let outPath = null;
        try {
          if (gs.audio instanceof File) {
            const baseName = sanitizeExportFileName(`global_${sceneId}_` + (gs.audio.name || 'audio.mp3'), '.mp3');
            if (audioFolder) audioFolder.file(baseName, gs.audio);
            outPath = './audio/' + baseName;
          } else if (typeof gs.audio === 'string') {
            if (gs.audio.startsWith('http://') || gs.audio.startsWith('https://')) {
              outPath = gs.audio; // keep remote URLs
            } else if (gs.audio.startsWith('./audio/')) {
              outPath = gs.audio; // already a packaged path
            } else if (gs.audio.startsWith('blob:') || gs.audio.startsWith('data:') || gs.audioStorageKey) {
              // Prefer IDB when available
              let rec = null;
              if (gs.audioStorageKey) {
                try { rec = await this.getAudioFromIDB(gs.audioStorageKey); } catch(_) {}
              }
              if (rec && rec.blob) {
                const baseName = sanitizeExportFileName(gs.audioFileName || (`global_${sceneId}.mp3`), '.mp3');
                if (audioFolder) audioFolder.file(baseName, rec.blob);
                outPath = './audio/' + baseName;
              } else {
                // Fallback: fetch blob/data URL and write it
                try {
                  const resp = await fetch(gs.audio);
                  const blob = await resp.blob();
                  const baseName = sanitizeExportFileName(gs.audioFileName || (`global_${sceneId}.mp3`), '.mp3');
                  if (audioFolder) audioFolder.file(baseName, blob);
                  outPath = './audio/' + baseName;
                } catch(_) { /* keep null */ }
              }
            }
          }
        } catch(_) { /* ignore */ }
        if (outPath) {
          newScene.globalSound = {
            audio: outPath,
            volume: gs.volume || 0.5,
            enabled: true,
          };
        }
      }

      // Process each hotspot, handling File objects properly
      if (Array.isArray(scene.hotspots)) {
        for (const origHotspot of scene.hotspots) {
          const newHotspot = {
            id: origHotspot.id,
            type: origHotspot.type,
            position: origHotspot.position,
            text: origHotspot.text,
            scene: origHotspot.scene,
            navigationTarget: origHotspot.navigationTarget,
            audio: null,
          };

          // Handle audio properly (export blobs/IDB to files)
          if (origHotspot.audio) {
            try {
              if (origHotspot.audio instanceof File) {
                const baseName = sanitizeExportFileName(`${sceneId}_${origHotspot.id}_` + (origHotspot.audio.name || 'audio.mp3'), '.mp3');
                if (audioFolder) audioFolder.file(baseName, origHotspot.audio);
                newHotspot.audio = './audio/' + baseName;
              } else if (typeof origHotspot.audio === 'string') {
                if (origHotspot.audio.startsWith('http://') || origHotspot.audio.startsWith('https://')) {
                  newHotspot.audio = origHotspot.audio; // remote URL
                } else if (origHotspot.audio.startsWith('./audio/')) {
                  newHotspot.audio = origHotspot.audio; // packaged path
                } else if (origHotspot.audio.startsWith('blob:') || origHotspot.audio.startsWith('data:') || origHotspot.audioStorageKey) {
                  // Prefer IDB when available
                  let rec = null;
                  if (origHotspot.audioStorageKey) {
                    try { rec = await this.getAudioFromIDB(origHotspot.audioStorageKey); } catch(_) {}
                  }
                  if (rec && rec.blob) {
                    const baseName = sanitizeExportFileName(origHotspot.audioFileName || `${sceneId}_${origHotspot.id}.mp3`, '.mp3');
                    if (audioFolder) audioFolder.file(baseName, rec.blob);
                    newHotspot.audio = './audio/' + baseName;
                  } else {
                    // Fallback: fetch blob/data URL and write it
                    try {
                      const resp = await fetch(origHotspot.audio);
                      const blob = await resp.blob();
                      const baseName = sanitizeExportFileName(origHotspot.audioFileName || `${sceneId}_${origHotspot.id}.mp3`, '.mp3');
                      if (audioFolder) audioFolder.file(baseName, blob);
                      newHotspot.audio = './audio/' + baseName;
                    } catch(_) {
                      newHotspot.audio = null;
                    }
                  }
                } else {
                  // Unknown relative; keep as-is
                  newHotspot.audio = origHotspot.audio;
                }
              }
            } catch(_) { newHotspot.audio = null; }
          } else {
            newHotspot.audio = null;
          }

          // Preserve popup sizing for text-based hotspots in export
          if (
            origHotspot.type === "text" ||
            origHotspot.type === "text-audio"
          ) {
            if (typeof origHotspot.popupWidth === "number") {
              newHotspot.popupWidth = Math.min(
                10,
                Math.max(2, origHotspot.popupWidth)
              );
            }
            if (typeof origHotspot.popupHeight === "number") {
              newHotspot.popupHeight = Math.min(
                10,
                Math.max(1.5, origHotspot.popupHeight)
              );
            }
          }

          // Image hotspot export with actual file copying / embedding
          if (origHotspot.type === "image") {
            if (typeof origHotspot.imageScale === "number") {
              newHotspot.imageScale = Math.min(
                10,
                Math.max(0.1, origHotspot.imageScale)
              );
            } else if (typeof origHotspot.imageWidth === "number") {
              const derived = Math.min(
                10,
                Math.max(0.1, origHotspot.imageWidth)
              );
              newHotspot.imageScale = derived;
            }
            if (
              typeof origHotspot.imageAspectRatio === "number" &&
              isFinite(origHotspot.imageAspectRatio) &&
              origHotspot.imageAspectRatio > 0
            ) {
              newHotspot.imageAspectRatio = origHotspot.imageAspectRatio;
            } else if (
              typeof origHotspot._aspectRatio === "number" &&
              isFinite(origHotspot._aspectRatio) &&
              origHotspot._aspectRatio > 0
            ) {
              newHotspot.imageAspectRatio = origHotspot._aspectRatio;
            }
            // Prefer IndexedDB record when available (supports legacy fallback key)
            const effImageKey = origHotspot.imageStorageKey || (typeof origHotspot.id === 'number' ? `image_hotspot_${origHotspot.id}` : null);
            if (effImageKey) {
              try {
                const rec = await this.getImageFromIDB(effImageKey);
                if (rec && rec.blob && imagesFolder) {
                  const baseName = rec.name || `${sceneId}_${origHotspot.id}.png`;
                  const ext = (baseName && /\.[a-zA-Z0-9]{2,5}$/.test(baseName)) ? baseName.match(/\.[a-zA-Z0-9]{2,5}$/)[0] : '.png';
                  const cleanName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
                  imagesFolder.file(cleanName, rec.blob);
                  newHotspot.image = `./images/${cleanName}`;
                }
              } catch(_) { /* try other strategies below */ }
            }
            if (!newHotspot.image && origHotspot.image instanceof File) {
              const cleanName = origHotspot.image.name.replace(
                /[^a-zA-Z0-9._-]/g,
                "_"
              );
              const imgFileName = `${sceneId}_${origHotspot.id}_${cleanName}`;
              if (imagesFolder) {
                imagesFolder.file(imgFileName, origHotspot.image);
                newHotspot.image = `./images/${imgFileName}`;
              } else {
                newHotspot.image = cleanName; // fallback
              }
            } else if (typeof origHotspot.image === "string") {
              if (origHotspot.image.startsWith("data:")) {
                // data URL -> keep inline for portability
                newHotspot.image = origHotspot.image;
              } else if (origHotspot.image.startsWith('blob:')) {
                // Blob URL from current session – fetch and package into images folder
                try {
                  const resp = await fetch(origHotspot.image);
                  if (resp.ok) {
                    const blob = await resp.blob();
                    if (imagesFolder) {
                      const baseName = (origHotspot.imageFileName && origHotspot.imageFileName.replace(/[^a-zA-Z0-9._-]/g, '_')) || `${sceneId}_${origHotspot.id}.png`;
                      imagesFolder.file(baseName, blob);
                      newHotspot.image = `./images/${baseName}`;
                    }
                  }
                } catch(_) { /* if fetch fails, leave unset to avoid broken refs */ }
              } else if (/^https?:\/\//i.test(origHotspot.image)) {
                newHotspot.image = origHotspot.image; // remote URL
              } else if (origHotspot.image.startsWith("./images/")) {
                newHotspot.image = origHotspot.image; // relative path
              } else {
                newHotspot.image = "./images/" + origHotspot.image; // assume relative filename
              }
            } else {
              newHotspot.image = null;
            }
          }

          // Weblink portal export: include URL, title, and preview (string only)
          if (origHotspot.type === "weblink") {
            if (typeof origHotspot.weblinkUrl === "string")
              newHotspot.weblinkUrl = origHotspot.weblinkUrl;
            if (typeof origHotspot.weblinkTitle === "string")
              newHotspot.weblinkTitle = origHotspot.weblinkTitle;
            if (typeof origHotspot.weblinkPreview === "string")
              newHotspot.weblinkPreview = origHotspot.weblinkPreview;
            else if (origHotspot.weblinkPreview instanceof File) {
              // For now, we keep preview inline only if it's already a data URL; copying file would require a name/path decision.
              // Convert file to data URL is not performed here to avoid async in normalization; preview will be omitted.
            }
          }

          newScene.hotspots.push(newHotspot);
        }
      }

      normalizedScenes[sceneId] = newScene;
    }
    return normalizedScenes;
  }

  getExportImagePath(imagePath, sceneId) {
    // If it's a URL (http:// or https://), use it directly
    if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
      return imagePath;
    }
    // For uploaded scenes (data URLs), save as sceneId.jpg
    else if (imagePath.startsWith("data:")) {
      return `./images/${sceneId}.jpg`;
    }
    // If it's already a proper path starting with ./images/, keep as-is
    else if (imagePath.startsWith("./images/")) {
      return imagePath;
    }
    // Fallback - assume it's a filename and prepend the images path
    else {
      return `./images/${imagePath}`;
    }
  }

  loadTemplate() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip";

    input.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (file.name.endsWith(".zip")) {
        this.loadZIPTemplate(file);
      } else {
        alert("Please select a ZIP template file.");
      }
    });

    input.click();
  }

  loadJSONTemplate(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const template = JSON.parse(e.target.result);
        this.clearAllHotspots();

        // Handle new format with scenes
        if (template.scenes) {
          this.scenes = template.scenes;
          this.currentScene = template.currentScene || "scene1";
          this.updateSceneDropdown();
          this.loadCurrentScene();
        }
        // Handle legacy format
        else if (template.hotspots) {
          template.hotspots.forEach((hotspotData) => {
            this.createHotspotElement(hotspotData);
            this.hotspots.push(hotspotData);
          });
          this.hotspotIdCounter = Math.max(
            ...this.hotspots.map((h) => h.id),
            0
          );
        }

        // Load custom styles if included
        if (template.customStyles) {
          this.customStyles = template.customStyles;
          this.saveCSSToLocalStorage(); // Save to localStorage
          this.applyStylesToExistingElements(); // Apply to current elements
        }

        this.updateHotspotList();
        this.updateNavigationTargets();
        this.updateStartingPointInfo();

        alert(`Template "${template.name}" loaded successfully!`);
      } catch (error) {
        alert("Error loading template file");
      }
    };
    reader.readAsText(file);
  }

  async loadZIPTemplate(file) {
    try {
      this.showLoadingIndicator("Loading template from ZIP...");
      
      // Load JSZip library
      const JSZip = window.JSZip || (await this.loadJSZip());
      
      // Read the ZIP file
      const arrayBuffer = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(arrayBuffer);
      
      // Extract config.json
      const configFile = zip.file("config.json");
      if (!configFile) {
        throw new Error("Invalid template: config.json not found");
      }
      
      const configText = await configFile.async("text");
      const config = JSON.parse(configText);
      
      // Clear existing editor state (without confirmation for template load)
      const container = document.getElementById("hotspot-container");
      if (container) container.innerHTML = "";
      this.hotspots = [];
      
      // Clear all old assets from IndexedDB before loading new ones (Replace behavior)
      await this.clearAllVideosFromIDB();
      if (typeof this.clearAllImagesFromIDB === 'function') {
        await this.clearAllImagesFromIDB();
      }
      if (typeof this.clearAllAudiosFromIDB === 'function') {
        await this.clearAllAudiosFromIDB();
      }
      
      // Load scenes and custom styles
      this.scenes = config.scenes || {};
      this.currentScene = config.currentScene || Object.keys(this.scenes)[0] || "scene1";
      this.customStyles = config.customStyles || this.customStyles;
      
  // Process images, videos, and audio from ZIP and store in IndexedDB
      const imagePromises = [];
      const videoPromises = [];
      const audioPromises = [];
      
      // Extract and convert all scene images
      for (const [sceneId, scene] of Object.entries(this.scenes)) {
        if (scene.type === "image" && scene.image) {
          // If image is embedded as data URL in config, convert directly
          if (typeof scene.image === 'string' && scene.image.startsWith('data:')) {
            imagePromises.push((async () => {
              try {
                const resp = await fetch(scene.image);
                const blob = await resp.blob();
                const fileName = `${sceneId}.jpg`;
                const storageKey = scene.imageStorageKey || `image_scene_${sceneId}`;
                await this.saveImageToIDB(storageKey, new File([blob], fileName, { type: blob.type || 'image/jpeg' }));
                const blobUrl = URL.createObjectURL(blob);
                scene.image = blobUrl;
                scene.imageStorageKey = storageKey;
                scene.imageFileName = fileName;
              } catch(_) {}
            })());
          } else {
            const imagePath = scene.image.replace("./images/", "");
            const imageFile = zip.file(`images/${imagePath}`);
            if (imageFile) {
              imagePromises.push(
                imageFile.async("blob").then(async (blob) => {
                  try {
                    const file = new File([blob], imagePath, { type: blob.type || 'image/png' });
                    const storageKey = scene.imageStorageKey || `image_scene_${sceneId}`;
                    await this.saveImageToIDB(storageKey, file);
                    const blobUrl = URL.createObjectURL(blob);
                    scene.image = blobUrl;
                    scene.imageStorageKey = storageKey;
                    scene.imageFileName = imagePath;
                  } catch(_) { /* ignore image store failure */ }
                })
              );
            }
          }
        } else if (scene.type === "video" && scene.videoSrc) {
          const videoPath = scene.videoSrc.replace("./videos/", "");
          const videoFile = zip.file(`videos/${videoPath}`);
          
          if (videoFile) {
            videoPromises.push(
              videoFile.async("blob").then(async (blob) => {
                // Store video in IndexedDB with proper storage key
                const storageKey = sceneId;
                const file = new File([blob], videoPath, { type: blob.type || "video/mp4" });
                await this.saveVideoToIDB(storageKey, file);
                
                // Create blob URL for immediate use
                const blobUrl = URL.createObjectURL(blob);
                scene.videoSrc = blobUrl;
                scene.videoStorageKey = storageKey; // Use the standard key name
                scene.videoFileName = videoPath;
              })
            );
          }
        }
      }
      
      // Extract hotspot images
      for (const scene of Object.values(this.scenes)) {
        if (scene.hotspots) {
          for (const hotspot of scene.hotspots) {
            if (hotspot.type === "image" && hotspot.image) {
              if (typeof hotspot.image === 'string' && hotspot.image.startsWith('data:')) {
                imagePromises.push((async () => {
                  try {
                    const resp = await fetch(hotspot.image);
                    const blob = await resp.blob();
                    const fileName = hotspot.imageFileName || `hotspot_${hotspot.id}.png`;
                    const storageKey = hotspot.imageStorageKey || `image_hotspot_${scene.name || 'scene'}_${hotspot.id}`;
                    await this.saveImageToIDB(storageKey, new File([blob], fileName, { type: blob.type || 'image/png' }));
                    const blobUrl = URL.createObjectURL(blob);
                    hotspot.image = blobUrl;
                    hotspot.imageStorageKey = storageKey;
                    hotspot.imageFileName = fileName;
                  } catch(_) {}
                })());
              } else if (typeof hotspot.image === 'string' && hotspot.image.startsWith("./images/")) {
                const imagePath = hotspot.image.replace("./images/", "");
                const imageFile = zip.file(`images/${imagePath}`);
                if (imageFile) {
                  imagePromises.push(
                    imageFile.async("blob").then(async (blob) => {
                      try {
                        const file = new File([blob], imagePath, { type: blob.type || 'image/png' });
                        const storageKey = hotspot.imageStorageKey || `image_hotspot_${scene.name || 'scene'}_${hotspot.id}`;
                        await this.saveImageToIDB(storageKey, file);
                        const blobUrl = URL.createObjectURL(blob);
                        hotspot.image = blobUrl;
                        hotspot.imageStorageKey = storageKey;
                        hotspot.imageFileName = imagePath;
                      } catch(_) { /* ignore */ }
                    })
                  );
                }
              }
            }

            // Extract hotspot audio (file path or data URL)
            if ((hotspot.type === 'audio' || hotspot.type === 'text-audio') && hotspot.audio) {
              if (typeof hotspot.audio === 'string' && hotspot.audio.startsWith('data:')) {
                audioPromises.push((async () => {
                  try {
                    const resp = await fetch(hotspot.audio);
                    const blob = await resp.blob();
                    const base = hotspot.audioFileName || `hotspot_${hotspot.id}.mp3`;
                    const storageKey = hotspot.audioStorageKey || `audio_hotspot_${scene.name || 'scene'}_${hotspot.id}`;
                    await this.saveAudioToIDB(storageKey, new File([blob], base, { type: blob.type || 'audio/mpeg' }));
                    const blobUrl = URL.createObjectURL(blob);
                    hotspot.audio = blobUrl;
                    hotspot.audioStorageKey = storageKey;
                    hotspot.audioFileName = base;
                  } catch(_) {}
                })());
              } else if (typeof hotspot.audio === 'string' && hotspot.audio.startsWith('./audio/')) {
                const audioPath = hotspot.audio.replace('./audio/', '');
                const audioFile = zip.file(`audio/${audioPath}`);
                if (audioFile) {
                  audioPromises.push(
                    audioFile.async('blob').then(async (blob) => {
                      try {
                        const file = new File([blob], audioPath, { type: blob.type || 'audio/mpeg' });
                        const storageKey = hotspot.audioStorageKey || `audio_hotspot_${scene.name || 'scene'}_${hotspot.id}`;
                        await this.saveAudioToIDB(storageKey, file);
                        const blobUrl = URL.createObjectURL(blob);
                        hotspot.audio = blobUrl;
                        hotspot.audioStorageKey = storageKey;
                        hotspot.audioFileName = audioPath;
                      } catch(_) {}
                    })
                  );
                }
              }
            }
          }
        }
      }

      // Extract global scene audio
      for (const [sceneId, scene] of Object.entries(this.scenes)) {
        if (scene.globalSound && scene.globalSound.audio) {
          const gs = scene.globalSound;
          if (typeof gs.audio === 'string' && gs.audio.startsWith('data:')) {
            audioPromises.push((async () => {
              try {
                const resp = await fetch(gs.audio);
                const blob = await resp.blob();
                const base = gs.audioFileName || `${sceneId}.mp3`;
                const storageKey = gs.audioStorageKey || `audio_global_${sceneId}`;
                await this.saveAudioToIDB(storageKey, new File([blob], base, { type: blob.type || 'audio/mpeg' }));
                const blobUrl = URL.createObjectURL(blob);
                gs.audio = blobUrl;
                gs.audioStorageKey = storageKey;
                gs.audioFileName = base;
              } catch(_) {}
            })());
          } else if (typeof gs.audio === 'string' && gs.audio.startsWith('./audio/')) {
            const audioPath = gs.audio.replace('./audio/', '');
            const audioFile = zip.file(`audio/${audioPath}`);
            if (audioFile) {
              audioPromises.push(
                audioFile.async('blob').then(async (blob) => {
                  try {
                    const file = new File([blob], audioPath, { type: blob.type || 'audio/mpeg' });
                    const storageKey = gs.audioStorageKey || `audio_global_${sceneId}`;
                    await this.saveAudioToIDB(storageKey, file);
                    const blobUrl = URL.createObjectURL(blob);
                    gs.audio = blobUrl;
                    gs.audioStorageKey = storageKey;
                    gs.audioFileName = audioPath;
                  } catch(_) {}
                })
              );
            }
          }
        }
      }
      
      // Wait for all assets to be processed
  await Promise.all([...imagePromises, ...videoPromises, ...audioPromises]);
      
      // Debug: Log loaded scenes structure
      console.log('Loaded scenes from ZIP:', this.scenes);
      console.log('Current scene:', this.currentScene);
      if (this.scenes[this.currentScene]) {
        console.log('Current scene hotspots:', this.scenes[this.currentScene].hotspots);
      }
      
      // IMPORTANT: Load current scene's hotspots into this.hotspots BEFORE saving
      // Otherwise saveScenesData() will overwrite scene hotspots with empty array
      const currentScene = this.scenes[this.currentScene];
      if (currentScene && Array.isArray(currentScene.hotspots)) {
        this.hotspots = [...currentScene.hotspots];
        console.log('Loaded hotspots into editor:', this.hotspots);
      }
      
      // Save to localStorage and update UI
      this.saveCSSToLocalStorage();
      this.saveScenesData();
      this.updateSceneDropdown();
      this.loadCurrentScene();
      this.updateHotspotList();
      this.updateNavigationTargets();
      this.updateStartingPointInfo();
      this.applyStylesToExistingElements();
      
      this.hideLoadingIndicator();
      alert(`Template "${config.name || 'Untitled'}" loaded successfully!`);
      
    } catch (error) {
      this.hideLoadingIndicator();
      console.error("Error loading ZIP template:", error);
      alert("Error loading template: " + error.message);
    }
  }

  // CSS Customization Methods
  openStyleEditor() {
    // Persist current work before navigating away
    // 1) Save scenes/hotspots so a just-loaded template or recent edits aren't lost
    try {
      this.saveScenesData();
    } catch (e) {
      console.warn(
        "Failed to save scenes data before opening style editor:",
        e
      );
    }

    // 2) Save current styles to localStorage before opening editor
    this.saveCSSToLocalStorage();

    // Open style editor without large URL parameters
    window.location.href = "style-editor.html";
  }

  checkForStyleUpdates() {
    const urlParams = new URLSearchParams(window.location.search);
    const stylesUpdated = urlParams.get("stylesUpdated");

    if (stylesUpdated === "true") {
      try {
        // Load styles from localStorage when returning from style editor
        this.loadCSSFromLocalStorage();

        // Apply styles to existing elements WITHOUT clearing anything
        this.refreshAllHotspotStyles();

        // Clean up URL parameters
        window.history.replaceState(
          {},
          document.title,
          window.location.pathname
        );

        // Show success message
        setTimeout(() => {
          alert("✅ Visual styles updated successfully!");
        }, 500);
      } catch (error) {
        console.warn("Failed to load styles from URL:", error);
      }
    }
  }

  applyStylesToExistingElements() {
    const styles = this.customStyles;

    // Update existing info buttons
    document
      .querySelectorAll(
        'a-entity[geometry*="primitive: plane"][material*="color"]'
      )
      .forEach((infoButton) => {
        const geometry = infoButton.getAttribute("geometry");
        if (
          geometry &&
          geometry.includes("width: 4") &&
          geometry.includes("height: 0.5")
        ) {
          // This is likely an info button
          infoButton.setAttribute(
            "material",
            `color: ${styles.hotspot.infoButton.backgroundColor}`
          );
          const textAttr = infoButton.getAttribute("text");
          if (textAttr) {
            infoButton.setAttribute("text", {
              value: styles.hotspot.infoButton.text,
              align: "center",
              color: styles.hotspot.infoButton.textColor,
              width: styles.hotspot.infoButton.fontSize,
              font: "roboto",
            });
          }
        }
      });

    // Update existing popups
    document.querySelectorAll("a-plane[width][height]").forEach((popup) => {
      const width = popup.getAttribute("width");
      const height = popup.getAttribute("height");
      if (width >= 3 && height >= 2) {
        // Likely a popup background
        popup.setAttribute("color", styles.hotspot.popup.backgroundColor);
        popup.setAttribute("opacity", styles.hotspot.popup.opacity);
      }
    });

    // Update popup text
    document.querySelectorAll("a-text[wrap-count]").forEach((textEl) => {
      if (textEl.getAttribute("wrap-count") === "35") {
        // Likely popup text
        textEl.setAttribute("color", styles.hotspot.popup.textColor);
      }
    });

    // Navigation portal styling removed - portals keep their default appearance

    // Update button images
    if (styles.buttonImages) {
      // Update play button images
      document
        .querySelectorAll('a-image[src="#play"], a-image[src*="play.png"]')
        .forEach((playBtn) => {
          playBtn.setAttribute("src", styles.buttonImages.play);
        });

      // Update pause button images
      document
        .querySelectorAll('a-image[src="#pause"], a-image[src*="pause.png"]')
        .forEach((pauseBtn) => {
          pauseBtn.setAttribute("src", styles.buttonImages.pause);
        });
    }

    // Update audio control buttons
    document.querySelectorAll(".audio-control").forEach((audioBtn) => {
      audioBtn.setAttribute("material", `color: ${styles.audio.buttonColor}`);
      audioBtn.setAttribute("opacity", styles.audio.buttonOpacity);
    });

    // Update image hotspots (static images)
    if (styles.image) {
      const istyle = styles.image;
      document.querySelectorAll(".static-image-hotspot").forEach((imgEl) => {
        try {
          const parent = imgEl.parentElement;
          const opacity =
            typeof istyle.opacity === "number" ? istyle.opacity : 1.0;
          // Apply opacity material
          const existingMat = imgEl.getAttribute("material") || "";
          imgEl.setAttribute(
            "material",
            `opacity:${opacity}; transparent:${
              opacity < 1 ? "true" : "false"
            }; side:double; ${existingMat}`
          );

          // Enforce original aspect ratio geometry so styles don't square the image
          const sclAttr = imgEl.getAttribute("scale") || "1 1 1";
          const scl = parseFloat(sclAttr.split(" ")[0]) || 1;
          let ratio = parseFloat(imgEl.dataset.aspectRatio || "");
          if (!ratio || !isFinite(ratio) || ratio <= 0) {
            // Try model data via element id
            const host = parent;
            const idStr = host && host.id ? host.id : "";
            const id = idStr.startsWith("hotspot-")
              ? parseInt(idStr.slice(8), 10)
              : NaN;
            if (!isNaN(id)) {
              const hs = this.hotspots.find(
                (h) => h && h.id === id && h.type === "image"
              );
              ratio =
                (hs && (hs.imageAspectRatio || hs._aspectRatio)) || ratio || 1;
            }
          }
          if (!ratio || !isFinite(ratio) || ratio <= 0) ratio = 1;
          // Apply base width/height and center vertically
          imgEl.setAttribute("width", 1);
          imgEl.setAttribute("height", ratio);
          imgEl.setAttribute("position", `0 ${(ratio / 2) * scl} 0.05`);
          imgEl.dataset.aspectRatio = String(ratio);
          try {
            console.log(
              `[ImageHotspot][Style] id=${
                parent?.id
              } ratio=${ratio} scale=${scl} -> w=1 h=${ratio} y=${
                (ratio / 2) * scl
              }`
            );
          } catch (_) {}

          // Border frame management: only show square frame when NO rounding and borderWidth>0.
          const numericRadius = parseFloat(istyle.borderRadius) || 0;
          if (numericRadius > 0) {
            parent
              .querySelectorAll(".static-image-border")
              .forEach((b) => b.remove());
          } else {
            if (istyle.borderWidth > 0) {
              let frame = parent.querySelector(".static-image-border");
              if (!frame) {
                frame = document.createElement("a-plane");
                frame.classList.add("static-image-border");
                parent.appendChild(frame);
              }
              // Determine image world size from enforced geometry and scale
              frame.setAttribute("width", 1 * scl + istyle.borderWidth * 2);
              frame.setAttribute(
                "height",
                ratio * scl + istyle.borderWidth * 2
              );
              // Align behind image
              const pos = imgEl.getAttribute("position") || "0 0 0";
              const parts = pos.split(" ");
              const y = parts.length > 1 ? parts[1] : "0";
              frame.setAttribute("position", `0 ${y} 0.0`);
              const borderColor = istyle.borderColor || "#FFFFFF";
              frame.setAttribute(
                "material",
                `shader:flat; color:${borderColor}; opacity:${opacity}; transparent:${
                  opacity < 1 ? "true" : "false"
                }; side:double`
              );
              try {
                console.log(
                  `[ImageHotspot][Style-Frame] id=${parent?.id} bw=${
                    istyle.borderWidth
                  } -> frame w=${1 * scl + istyle.borderWidth * 2} h=${
                    ratio * scl + istyle.borderWidth * 2
                  }`
                );
              } catch (_) {}
            } else {
              parent
                .querySelectorAll(".static-image-border")
                .forEach((b) => b.remove());
            }
          }

          // Re-mask if rounded corners requested and not yet applied OR radius changed
          if (istyle.borderRadius && istyle.borderRadius > 0) {
            // Delay lightly to allow any texture reload
            setTimeout(() => {
              applyRoundedMaskToAImage(imgEl, istyle, true)
                .then(() => {
                  imgEl.dataset.roundedAppliedRadius = radiusKey;
                })
                .catch(() => {});
            }, 60);
            const appliedKey = imgEl.dataset.roundedAppliedRadius || "";
            const radiusKey =
              String(istyle.borderRadius) +
              "|" +
              String(istyle.borderWidth) +
              "|" +
              (istyle.borderColor || "");
            if (appliedKey !== radiusKey) {
              // Reset source if previously masked to avoid compounding; store original in dataset
              if (!imgEl.dataset.originalSrc)
                imgEl.dataset.originalSrc = imgEl.getAttribute("src");
              if (imgEl.dataset.originalSrc)
                imgEl.setAttribute("src", imgEl.dataset.originalSrc);
              try {
                console.log(
                  `[ImageHotspot][Style-Mask] id=${parent?.id} radius=${istyle.borderRadius} bw=${istyle.borderWidth} color=${istyle.borderColor}`
                );
              } catch (_) {}
              applyRoundedMaskToAImage(imgEl, istyle)
                .then(() => {
                  imgEl.dataset.roundedAppliedRadius = radiusKey;
                })
                .catch(() => {});
            }
          } else {
            // If rounding disabled, restore original if stored
            if (imgEl.dataset.originalSrc) {
              imgEl.setAttribute("src", imgEl.dataset.originalSrc);
            }
            delete imgEl.dataset.roundedAppliedRadius;
          }
        } catch (e) {
          /* ignore individual failures */
        }
      });
    }

    console.log("✅ Applied custom styles to existing elements");
  }

  refreshAllHotspotStyles() {
    console.log("🎨 Refreshing all hotspot styles");

    // Refresh styles for all existing hotspots
    this.applyStylesToExistingElements();

    // Also refresh any in-memory hotspot data
    // Apply navigation ring customizations to existing navigation hotspots
    const navStyles = (this.customStyles && this.customStyles.navigation) || {};
    const ringOuter =
      typeof navStyles.ringOuterRadius === "number"
        ? navStyles.ringOuterRadius
        : 0.6;
    const ringThickness =
      typeof navStyles.ringThickness === "number"
        ? navStyles.ringThickness
        : 0.02;
    const ringInner = Math.max(0.001, ringOuter - ringThickness);
    const ringColor = navStyles.ringColor || "rgb(0, 85, 0)";

    this.hotspots.forEach((hotspot) => {
      if (hotspot.type !== "navigation") return;
      const el = document.getElementById(`hotspot-${hotspot.id}`);
      if (!el) return;

      // Update ring element
      const ringEl = el.querySelector(".nav-ring");
      if (ringEl) {
        ringEl.setAttribute(
          "geometry",
          `primitive: ring; radiusInner: ${ringInner}; radiusOuter: ${ringOuter}`
        );
        ringEl.setAttribute(
          "material",
          `color: ${ringColor}; opacity: 1; transparent: true; shader: flat`
        );
      }

      // Update preview circle
      const previewEl = el.querySelector(".nav-preview-circle");
      if (previewEl) {
        previewEl.setAttribute(
          "geometry",
          `primitive: circle; radius: ${ringInner}`
        );
      }

      // Update collider (assumes first child is collider)
      const colliderEl = el.querySelector('[geometry*="primitive: circle"]');
      if (colliderEl) {
        colliderEl.setAttribute(
          "geometry",
          `primitive: circle; radius: ${ringOuter}`
        );
      }

      // Update label group (color, opacity, position)
      const label = el.querySelector(".nav-label");
      if (label) {
        // Position above the ring using updated dimensions
        label.setAttribute("position", `0 ${ringOuter + 0.35} 0.3`);
        const bg = label.querySelector("a-plane");
        if (bg)
          bg.setAttribute(
            "material",
            `shader:flat; color: ${
              navStyles.labelBackgroundColor || "#000"
            }; opacity: ${
              typeof navStyles.labelOpacity === "number"
                ? navStyles.labelOpacity
                : 0.8
            }; transparent: true`
          );
        const txt = label.querySelector("a-text");
        if (txt) txt.setAttribute("color", navStyles.labelColor || "#fff");
      }
    });

    console.log("✅ Refreshed all hotspot styles");
    // Force remask pass if rounding enabled
    const istyle = this.customStyles?.image;
    if (istyle && istyle.borderRadius && istyle.borderRadius > 0) {
      document.querySelectorAll(".static-image-hotspot").forEach((imgEl) => {
        setTimeout(() => applyRoundedMaskToAImage(imgEl, istyle, true), 120);
      });
    }
  }

  saveCSSToLocalStorage() {
    localStorage.setItem(
      "vr-hotspot-css-styles",
      JSON.stringify(this.customStyles)
    );
  }

  saveScenesData() {
    // Save current scene hotspots before saving all data (only if current scene exists)
    if (this.scenes[this.currentScene]) {
      this.scenes[this.currentScene].hotspots = [...this.hotspots];
    }

    // Clone scenes and strip non-persistable blob: URLs for videos and images
    const scenesClone = JSON.parse(JSON.stringify(this.scenes));
    try {
      Object.values(scenesClone || {}).forEach((sc) => {
        if (!sc) return;
        if (sc.type === 'video' && typeof sc.videoSrc === 'string' && sc.videoSrc.startsWith('blob:')) {
          sc.videoSrc = null; // don’t persist ephemeral blob URLs
        }
        if (sc.type === 'image') {
          if (sc.imageStorageKey && typeof sc.image === 'string' && sc.image.startsWith('blob:')) {
            // Strip blob URL for images stored in IDB
            sc.image = null;
          }
        }
        // Global sound: strip blob if stored in IDB
        if (sc.globalSound && sc.globalSound.audioStorageKey && typeof sc.globalSound.audio === 'string' && sc.globalSound.audio.startsWith('blob:')) {
          sc.globalSound.audio = null;
        }
        // Also sanitize any image hotspot blobs
        if (Array.isArray(sc.hotspots)) {
          sc.hotspots.forEach(h => {
            if (h && h.type === 'image') {
              if (h.imageStorageKey && typeof h.image === 'string' && h.image.startsWith('blob:')) {
                h.image = null;
              }
            } else if (h && (h.type === 'audio' || h.type === 'text-audio')) {
              if (h.audioStorageKey && typeof h.audio === 'string' && h.audio.startsWith('blob:')) {
                h.audio = null;
              }
            }
          });
        }
      });
    } catch (_) { /* ignore */ }

    // Also persist a sanitized copy of the current scene's hotspots to avoid stale blob: URLs
    const sanitizedCurrentHotspots = (scenesClone[this.currentScene] && scenesClone[this.currentScene].hotspots)
      ? JSON.parse(JSON.stringify(scenesClone[this.currentScene].hotspots))
      : [];

    const scenesData = {
      scenes: scenesClone,
      currentScene: this.currentScene,
      hotspots: sanitizedCurrentHotspots,
    };

    localStorage.setItem("vr-hotspot-scenes-data", JSON.stringify(scenesData));
    console.log("✅ Saved scenes data to localStorage");
  }

  async rehydrateImageSourcesFromIDB() {
    try {
      const entries = Object.entries(this.scenes || {});
      if (!entries.length) return;
      let changed = false;
      for (const [sceneId, scene] of entries) {
        if (!scene || scene.type !== 'image') continue;
        // Only rehydrate if we have a storage key and not an explicit remote/data URL
        const hasRemote = (typeof scene.image === 'string' && (scene.image.startsWith('http://') || scene.image.startsWith('https://') || scene.image.startsWith('data:')));
        if (!scene.imageStorageKey || hasRemote) continue;
        const key = scene.imageStorageKey || ('image_scene_' + sceneId);
        const rec = await this.getImageFromIDB(key);
        if (rec && rec.blob) {
          try {
            const url = URL.createObjectURL(rec.blob);
            scene.image = url;
            if (!scene.imageFileName) scene.imageFileName = rec.name || '';
            changed = true;
          } catch (_) { /* ignore */ }
        }
      }
      if (changed) this.saveScenesData();
    } catch (_) { /* ignore */ }
  }

  async rehydrateAudioSourcesFromIDB() {
    try {
      const entries = Object.entries(this.scenes || {});
      if (!entries.length) return;
      let changed = false;
      for (const [sceneId, scene] of entries) {
        if (!scene) continue;
        // Global sound first
        if (scene.globalSound && scene.globalSound.audioStorageKey) {
          try {
            const rec = await this.getAudioFromIDB(scene.globalSound.audioStorageKey);
            if (rec && rec.blob) {
              scene.globalSound.audio = URL.createObjectURL(rec.blob);
              if (!scene.globalSound.audioFileName) scene.globalSound.audioFileName = rec.name || '';
              changed = true;
            }
          } catch (_) {}
        }
        // Hotspots
        if (Array.isArray(scene.hotspots)) {
          for (const h of scene.hotspots) {
            if (!h) continue;
            if ((h.type === 'audio' || h.type === 'text-audio') && h.audioStorageKey) {
              try {
                const rec = await this.getAudioFromIDB(h.audioStorageKey);
                if (rec && rec.blob) {
                  h.audio = URL.createObjectURL(rec.blob);
                  if (!h.audioFileName) h.audioFileName = rec.name || '';
                  changed = true;
                }
              } catch (_) {}
            }
          }
        }
      }
      if (changed) this.saveScenesData();
    } catch (_) { /* ignore */ }
  }

  // Persist aspect ratio for a specific image hotspot and optionally update both editor and scene copies
  _persistImageAspectRatio(hotspotId, ratio) {
    try {
      const r = parseFloat(ratio);
      if (!isFinite(r) || r <= 0) return;
      let changed = false;
      const hs = this.hotspots.find(
        (h) => h && h.id === hotspotId && h.type === "image"
      );
      if (hs && hs.imageAspectRatio !== r) {
        hs.imageAspectRatio = r;
        changed = true;
      }
      const sceneArr =
        (this.scenes[this.currentScene] &&
          this.scenes[this.currentScene].hotspots) ||
        [];
      const shs = sceneArr.find(
        (h) => h && h.id === hotspotId && h.type === "image"
      );
      if (shs && shs.imageAspectRatio !== r) {
        shs.imageAspectRatio = r;
        changed = true;
      }
      if (changed) this.saveScenesData();
    } catch (_) {
      /* ignore */
    }
  }

  loadScenesData() {
    const saved = localStorage.getItem("vr-hotspot-scenes-data");
    if (saved) {
      try {
        const data = JSON.parse(saved);
        this.scenes = data.scenes || this.scenes;
        this.currentScene = data.currentScene || this.currentScene;
        this.hotspots = data.hotspots || [];

        // Sanitize any stale blob: URLs in loaded hotspots (rehydrated later from IDB)
        try {
          if (Array.isArray(this.hotspots)) {
            this.hotspots.forEach((h) => {
              if (!h) return;
              if (h.type === 'image' && h.imageStorageKey && typeof h.image === 'string' && h.image.startsWith('blob:')) {
                h.image = null;
              }
              if ((h.type === 'audio' || h.type === 'text-audio') && h.audioStorageKey && typeof h.audio === 'string' && h.audio.startsWith('blob:')) {
                h.audio = null;
              }
            });
          }
        } catch (_) { /* ignore */ }

        // Migrate old scenes to include type field (backward compatibility)
        Object.values(this.scenes || {}).forEach((scene) => {
          if (!scene.type) {
            scene.type = "image"; // Default to image for existing scenes
          }
          if (scene.videoVolume === undefined) {
            scene.videoVolume = 0.5; // Default video volume
          }
          // Clear any stale blob URLs so we won’t try to load invalid sources after refresh
          if (scene.type === 'video' && typeof scene.videoSrc === 'string' && scene.videoSrc.startsWith('blob:')) {
            scene.videoSrc = null;
          }
        });

  // Seed any missing imageAspectRatio from legacy _aspectRatio to maintain continuity
        try {
          const seed = (arr) => {
            if (!Array.isArray(arr)) return;
            arr.forEach((h) => {
              if (h && h.type === "image") {
                if (
                  typeof h.imageAspectRatio !== "number" &&
                  typeof h._aspectRatio === "number"
                )
                  h.imageAspectRatio = h._aspectRatio;
              }
            });
          };
          Object.values(this.scenes || {}).forEach((sc) => seed(sc.hotspots));
          seed(this.hotspots);
        } catch (_) {}

        // Clean up orphaned navigation hotspots
        this.cleanupOrphanedNavigationHotspots();

        // Ensure hotspot IDs are present and unique across all scenes
        this.ensureUniqueHotspotIds();

        console.log("✅ Loaded scenes data from localStorage");
        return true;
      } catch (error) {
        console.warn("Failed to load scenes data from localStorage:", error);
        return false;
      }
    }
    console.log("ℹ️ No saved scenes data found in localStorage");
    return false;
  }

  // Helper to extract known aspect ratio from a hotspot-like object
  _getModelImageAR(hs) {
    if (!hs) return null;
    if (
      typeof hs.imageAspectRatio === "number" &&
      isFinite(hs.imageAspectRatio) &&
      hs.imageAspectRatio > 0
    )
      return hs.imageAspectRatio;
    if (
      typeof hs._aspectRatio === "number" &&
      isFinite(hs._aspectRatio) &&
      hs._aspectRatio > 0
    )
      return hs._aspectRatio;
    return null;
  }

  // Ensure each hotspot has a numeric unique id and sync the id counter
  ensureUniqueHotspotIds() {
    const seen = new Set();
    let maxId = 0;

    const fix = (hsArr) => {
      if (!Array.isArray(hsArr)) return;
      for (let i = 0; i < hsArr.length; i++) {
        const h = hsArr[i] || {};
        // Assign id if missing or invalid
        if (typeof h.id !== "number" || !isFinite(h.id) || h.id <= 0) {
          h.id = ++maxId || 1; // will be re-evaluated below
        }
        maxId = Math.max(maxId, h.id);
      }
    };

    // First pass: determine maxId and fill missing ids
    Object.values(this.scenes).forEach((sc) => fix(sc.hotspots));
    fix(this.hotspots);

    // Second pass: reassign duplicates
    const reassignIfDup = (hsArr) => {
      if (!Array.isArray(hsArr)) return;
      for (let i = 0; i < hsArr.length; i++) {
        const h = hsArr[i];
        if (!h) continue;
        if (seen.has(h.id)) {
          h.id = ++maxId;
        }
        seen.add(h.id);
      }
    };

    Object.values(this.scenes).forEach((sc) => reassignIfDup(sc.hotspots));
    reassignIfDup(this.hotspots);

    // Sync the editor's hotspot array with the current scene to reflect new ids
    if (this.scenes[this.currentScene]) {
      this.hotspots = [...this.scenes[this.currentScene].hotspots];
    }

    // Update the counter so new hotspots always get a fresh id
    this.hotspotIdCounter = Math.max(this.hotspotIdCounter || 0, maxId);

    // Persist any fixes
    this.saveScenesData();
  }

  cleanupOrphanedNavigationHotspots() {
    let cleanupCount = 0;

    // Get list of valid scene IDs
    const validSceneIds = Object.keys(this.scenes);

    // Clean up each scene's hotspots
    Object.keys(this.scenes).forEach((sceneId) => {
      const scene = this.scenes[sceneId];
      const originalCount = scene.hotspots.length;

      scene.hotspots = scene.hotspots.filter((hotspot) => {
        if (hotspot.type === "navigation" && hotspot.navigationTarget) {
          const isValid = validSceneIds.includes(hotspot.navigationTarget);
          if (!isValid) {
            console.warn(
              `🗑️ Removing orphaned navigation hotspot in scene "${scene.name}" - target scene "${hotspot.navigationTarget}" no longer exists`
            );
            cleanupCount++;
          }
          return isValid;
        }
        return true; // Keep non-navigation hotspots
      });
    });

    // Also clean up current hotspots array if we're in a scene
    if (this.currentScene && this.scenes[this.currentScene]) {
      this.hotspots = this.hotspots.filter((hotspot) => {
        if (hotspot.type === "navigation" && hotspot.navigationTarget) {
          const isValid = validSceneIds.includes(hotspot.navigationTarget);
          if (!isValid) {
            console.warn(
              `🗑️ Removing orphaned navigation hotspot from current scene - target "${hotspot.navigationTarget}" no longer exists`
            );
            cleanupCount++;
          }
          return isValid;
        }
        return true;
      });
    }

    if (cleanupCount > 0) {
      console.log(`🧹 Cleaned up ${cleanupCount} orphaned navigation hotspots`);
      // Save the cleaned data
      this.saveScenesData();
    }
  }

  loadCSSFromLocalStorage() {
    const saved = localStorage.getItem("vr-hotspot-css-styles");
    if (saved) {
      try {
        const loadedStyles = JSON.parse(saved);

        // Ensure buttonImages exists for backward compatibility
        if (!loadedStyles.buttonImages) {
          loadedStyles.buttonImages = {
            portal: "images/up-arrow.png",
            play: "images/play.png",
            pause: "images/pause.png",
          };
        }

        // Ensure navigation ring defaults exist
        if (!loadedStyles.navigation) loadedStyles.navigation = {};
        if (loadedStyles.navigation.ringColor === undefined)
          loadedStyles.navigation.ringColor = "#005500";
        if (loadedStyles.navigation.ringOuterRadius === undefined)
          loadedStyles.navigation.ringOuterRadius = 0.6;
        if (loadedStyles.navigation.ringThickness === undefined)
          loadedStyles.navigation.ringThickness = 0.02;
        if (loadedStyles.navigation.weblinkRingColor === undefined)
          loadedStyles.navigation.weblinkRingColor = "#001f5b";

        this.customStyles = loadedStyles;
        console.log(
          "✅ Loaded custom styles from localStorage",
          this.customStyles
        );
        console.log("🎨 Button images:", this.customStyles.buttonImages);
      } catch (error) {
        console.warn("Failed to load saved CSS styles, using defaults");
      }
    } else {
      console.log("ℹ️ No saved styles found in localStorage, using defaults");
    }
  }

  getCustomStyles() {
    return this.customStyles;
  }

  // Project export helper methods
  showProgress(message) {
    const progressDiv = document.createElement("div");
    progressDiv.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: rgba(0,0,0,0.9); color: white; padding: 20px;
      border-radius: 8px; z-index: 10001; font-family: Arial;
    `;
    progressDiv.innerHTML = `<div style="text-align: center;">${message}<br><div style="margin-top: 10px;">⏳ Please wait...</div></div>`;
    document.body.appendChild(progressDiv);
    return progressDiv;
  }

  hideProgress(progressDiv) {
    if (progressDiv && progressDiv.parentNode) {
      progressDiv.parentNode.removeChild(progressDiv);
    }
  }

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  generateCompleteHTML(templateName) {
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${templateName} - VR Hotspot Experience</title>
    <meta name="description" content="Interactive VR Hotspot Experience" />
    <script src="https://aframe.io/releases/1.7.0/aframe.min.js"></script>
    <script src="https://cdn.jsdelivr.net/gh/c-frame/aframe-extras@7.5.4/dist/aframe-extras.min.js"></script>
    <script src="script.js"></script>
    <link rel="stylesheet" href="style.css">
  </head>
  
  <body>
    <div id="project-info">
      <h1>${templateName}</h1>
      <p>Interactive VR Experience • Click on hotspots to explore</p>
    </div>

    <!-- Global Sound Control -->
    <div id="global-sound-control">
      <button id="global-sound-toggle" class="sound-btn">🔊 Sound: ON</button>
      <div id="audio-progress-container" class="audio-progress-container" style="display: none;">
        <div class="audio-info">
          <span id="current-time">0:00</span>
          <div class="progress-bar-container">
            <div class="progress-bar" id="progress-bar">
              <div class="progress-fill" id="progress-fill"></div>
              <div class="progress-handle" id="progress-handle"></div>
            </div>
          </div>
          <span id="total-time">0:00</span>
        </div>
      </div>
    </div>

    <a-scene background="color: #1a1a2e" id="main-scene">
      <a-entity
        laser-controls="hand: right"
        raycaster="objects: .clickable, .audio-control"
      ></a-entity>
      <a-entity
        laser-controls="hand: left"
        raycaster="objects: .clickable, .audio-control"
      ></a-entity>

      <a-assets>
        <img id="main-panorama" src="./images/scene1.jpg" />
        <audio id="default-audio" src="./audio/music.mp3"></audio>
        <img id="close" src="./images/close.png" />
        <img id="play" src="./images/play.png" />
        <img id="pause" src="./images/pause.png" />
        <!-- Video asset for 360° video scenes -->
        <video id="scene-video-dynamic" crossorigin="anonymous" loop muted playsinline webkit-playsinline style="display:none"></video>
      </a-assets>

      <a-entity id="hotspot-container"></a-entity>
      
      <!-- Initial loading environment -->
      <a-entity id="loading-environment" visible="true">
        <!-- Starfield background -->
        <a-entity position="0 0 0">
          <a-entity geometry="primitive: sphere; radius: 100" 
                   material="color: #0f0f23; transparent: true; opacity: 0.8"></a-entity>
        </a-entity>
        
        <!-- Floating orbs for visual interest -->
        <a-entity id="loading-orb-1" 
                 geometry="primitive: sphere; radius: 0.3" 
                 material="color: #4CAF50; emissive: #4CAF50; emissiveIntensity: 0.5"
                 position="3 2 -5"
                 animation="property: rotation; to: 360 360 0; dur: 8000; easing: linear; loop: true">
        </a-entity>
        
        <a-entity id="loading-orb-2" 
                 geometry="primitive: sphere; radius: 0.2" 
                 material="color: #2196F3; emissive: #2196F3; emissiveIntensity: 0.4"
                 position="-4 1 -3"
                 animation="property: rotation; to: -360 180 360; dur: 6000; easing: linear; loop: true">
        </a-entity>
        
        <a-entity id="loading-orb-3" 
                 geometry="primitive: sphere; radius: 0.15" 
                 material="color: #FF9800; emissive: #FF9800; emissiveIntensity: 0.3"
                 position="2 -1 -4"
                 animation="property: rotation; to: 180 -360 180; dur: 10000; easing: linear; loop: true">
        </a-entity>
        
   <!-- Central loading text -->
        <a-text id="loading-text" 
               value="Loading VR Experience..." 
               position="0 0 -3" 
               align="center" 
               color="#000"
     font="dejavu"
     material="transparent: true; opacity: 0"
               animation="property: rotation; to: 0 5 0; dur: 3000; easing: easeInOutSine; loop: true; dir: alternate">
        </a-text>
        
        <!-- Animated loading dots -->
        <a-text id="loading-dots" 
               value="●○○" 
               position="0 -0.5 -3" 
               align="center" 
               color="#4CAF50"
               font="dejavu"
               animation__dots="property: opacity; to: 0.3; dur: 800; easing: easeInOutSine; loop: true; dir: alternate">
        </a-text>
      </a-entity>
      
      <!-- Actual scene skybox - initially hidden -->
      <a-sky id="skybox" src="#main-panorama" visible="false"></a-sky>

      <a-entity id="cam" camera position="0 1.6 0" look-controls>
        <!-- Mouse-based cursor for non-VR mode -->
        <a-entity 
          cursor="rayOrigin: mouse; fuse: false"
          raycaster="objects: .clickable, .audio-control"
          id="mouse-cursor"
          visible="true">
        </a-entity>
        
        <!-- Gaze-based cursor for VR mode -->
        <a-entity
          cursor="fuse: true; fuseTimeout: 1500"
          raycaster="objects: .clickable, .audio-control"
          position="0 0 -1"
          geometry="primitive: ring; radiusInner: 0.005; radiusOuter: 0.01"
          material="color: white; shader: flat; opacity: 0.8"
          id="gaze-cursor"
          visible="true"
          animation__mouseenter="property: geometry.radiusOuter; to: 0.015; startEvents: mouseenter; dur: 1500; easing: easeInQuad"
          animation__mouseleave="property: geometry.radiusOuter; to: 0.01; startEvents: mouseleave; dur: 300; easing: easeOutQuad"
          animation__click="property: scale; to: 1.2 1.2 1.2; startEvents: click; dur: 150; easing: easeInOutQuad"
          animation__fusing="property: scale; to: 1.2 1.2 1.2; startEvents: fusing; dur: 1500; easing: easeInQuad"
          animation__fusecomplete="property: scale; to: 1 1 1; startEvents: click; dur: 150; easing: easeOutQuad">
        </a-entity>
      </a-entity>
    </a-scene>

    <!-- Video Controls (appears only for video scenes) -->
    <div id="video-controls" style="
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8);
      padding: 15px 25px;
      border-radius: 30px;
      display: none;
      gap: 15px;
      align-items: center;
      z-index: 1001;
      box-shadow: 0 4px 15px rgba(0,0,0,0.5);
    ">
      <button id="video-play-pause" style="
        background: #007bff;
        color: white;
        border: none;
        padding: 10px 20px;
        border-radius: 20px;
        cursor: pointer;
        font-size: 16px;
        font-weight: bold;
      ">⏸ Pause</button>
      
      <button id="video-mute" style="
        background: #28a745;
        color: white;
        border: none;
        padding: 10px 20px;
        border-radius: 20px;
        cursor: pointer;
        font-size: 16px;
      ">🔇 Muted</button>
      
      <div style="color: white; font-size: 14px;">
        <span id="video-time-current">0:00</span> / <span id="video-time-total">0:00</span>
      </div>
      
      <input type="range" id="video-progress" min="0" max="100" value="0" style="
        width: 200px;
        height: 6px;
        cursor: pointer;
      ">
      
      <input type="range" id="video-volume" min="0" max="100" value="50" style="
        width: 100px;
        height: 6px;
        cursor: pointer;
      " title="Volume">
    </div>
  </body>
</html>`;
  }

  generateCSS() {
    return `/* VR Hotspot Project Styles */
body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #000;
}

#project-info {
  position: fixed;
  top: 20px;
  left: 20px;
  background: rgba(0, 0, 0, 0.8);
  color: white;
  padding: 15px;
  border-radius: 8px;
  z-index: 999;
  max-width: 300px;
}

#project-info h1 {
  margin: 0 0 5px 0;
  font-size: 18px;
  color: #4CAF50;
}

#project-info p {
  margin: 0;
  font-size: 12px;
  color: #ccc;
}

/* Global Sound Control */
#global-sound-control {
  position: fixed;
  top: 20px;
  left: 20px;
  z-index: 1000;
  margin-top: 120px; /* Below project info */
}

.sound-btn {
  background: rgba(0, 0, 0, 0.8);
  color: white;
  border: 2px solid #4CAF50;
  padding: 10px 15px;
  border-radius: 8px;
  cursor: pointer;
  font-family: Arial, sans-serif;
  font-size: 14px;
  font-weight: bold;
  transition: all 0.3s ease;
  user-select: none;
  display: block;
  margin-bottom: 10px;
}

.sound-btn:hover {
  background: rgba(76, 175, 80, 0.2);
  border-color: #66BB6A;
  transform: translateY(-2px);
}

.sound-btn.muted {
  border-color: #f44336;
  color: #f44336;
}

.sound-btn.muted:hover {
  background: rgba(244, 67, 54, 0.2);
  border-color: #ef5350;
}

/* Audio Progress Bar */
.audio-progress-container {
  background: rgba(0, 0, 0, 0.8);
  border: 2px solid #4CAF50;
  border-radius: 8px;
  padding: 10px;
  min-width: 250px;
  font-family: Arial, sans-serif;
  color: white;
}

.audio-info {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.progress-bar-container {
  flex: 1;
  position: relative;
}

.progress-bar {
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 3px;
  position: relative;
  cursor: pointer;
}

.progress-fill {
  height: 100%;
  background: #4CAF50;
  border-radius: 3px;
  width: 0%;
  transition: width 0.1s ease;
}

.progress-handle {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 14px;
  height: 14px;
  background: #4CAF50;
  border: 2px solid white;
  border-radius: 50%;
  cursor: pointer;
  left: 0%;
  transition: left 0.1s ease;
  opacity: 0;
}

.progress-bar:hover .progress-handle {
  opacity: 1;
}

.progress-handle:hover {
  transform: translate(-50%, -50%) scale(1.2);
}

#current-time, #total-time {
  min-width: 35px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* Hotspot animations */
.clickable {
  cursor: pointer;
}

/* Animation for gaze feedback */
@keyframes hotspotPulse {
  0% { opacity: 0.8; }
  50% { opacity: 1.0; }
  100% { opacity: 0.8; }
}

.hotspot-animation {
  animation: hotspotPulse 2s infinite;
}

/* Navigation feedback animation */
@keyframes fadeInOut {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
  20% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  80% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
}

/* Responsive design */
@media (max-width: 768px) {
  #project-info {
    position: static;
    margin: 10px;
  }
  
  #global-sound-control {
    position: static;
    margin: 10px;
    text-align: center;
  }
  
  .audio-progress-container {
    min-width: auto;
    width: 100%;
  }
  
  .audio-info {
    flex-direction: column;
    gap: 8px;
  }
  
  .progress-bar-container {
    width: 100%;
  }
}`;
  }

  generateCompleteJS() {
    // Include custom styles in the generated code
    const customStylesJson = JSON.stringify(this.customStyles, null, 2);

    return `// VR Hotspot Project - Standalone Version
// Generated from VR Hotspot Editor

// Custom Styles Configuration
const CUSTOM_STYLES = ${customStylesJson};

// Helper (export build): reuse caching via local map to prevent reprocessing
const EXPORTED_IMAGE_MASK_CACHE = new Map();
const EXPORTED_VIDEO_THUMB_CACHE = new Map();
function applyRoundedMaskToAImage(aImgEl, styleCfg) {
  return new Promise(resolve => {
    try {
      const src = aImgEl.getAttribute('src');
      if (!src) return resolve();
      const key = src + '|' + (styleCfg.borderRadius||0) + '|' + (styleCfg.borderWidth||0) + '|' + (styleCfg.borderColor||'');
      if (aImgEl.dataset.roundedApplied === key) return resolve();
      if (EXPORTED_IMAGE_MASK_CACHE.has(key)) {
        aImgEl.setAttribute('src', EXPORTED_IMAGE_MASK_CACHE.get(key));
        aImgEl.dataset.roundedApplied = key;
        aImgEl.setAttribute('material', (aImgEl.getAttribute('material')||'') + '; transparent:true; shader:flat; alphaTest:0.01; side:double');
        return resolve();
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) return resolve();
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          const r = Math.max(0, Math.min(w/2, (styleCfg.borderRadius||0) * w));
          const bw = Math.max(0, (styleCfg.borderWidth||0) * w);
          ctx.beginPath();
          ctx.moveTo(r,0); ctx.lineTo(w-r,0); ctx.quadraticCurveTo(w,0,w,r);
          ctx.lineTo(w,h-r); ctx.quadraticCurveTo(w,h,w-r,h);
          ctx.lineTo(r,h); ctx.quadraticCurveTo(0,h,0,h-r);
          ctx.lineTo(0,r); ctx.quadraticCurveTo(0,0,r,0); ctx.closePath();
          ctx.clip();
          ctx.drawImage(img,0,0,w,h);
          if (bw>0){ ctx.lineWidth = bw*2; ctx.strokeStyle = styleCfg.borderColor||'#FFFFFF'; ctx.stroke(); }
          const newURL = canvas.toDataURL('image/png');
          EXPORTED_IMAGE_MASK_CACHE.set(key, newURL);
          aImgEl.setAttribute('src', newURL);
          aImgEl.dataset.roundedApplied = key;
          aImgEl.setAttribute('material', (aImgEl.getAttribute('material')||'') + '; transparent:true; shader:flat; alphaTest:0.01; side:double');
        } catch(_) { /* ignore */ }
        resolve();
      };
      img.onerror = () => resolve();
      img.src = src;
    } catch(_) { resolve(); }
  });
}

// Face camera component
AFRAME.registerComponent("face-camera", {
  init: function () {
    this.cameraObj = document.querySelector("[camera]").object3D;
  },
  tick: function () {
    if (this.cameraObj) {
      this.el.object3D.lookAt(this.cameraObj.position);
    }
  },
});

// Hotspot component for standalone projects
AFRAME.registerComponent("hotspot", {
  schema: {
    label: { type: "string", default: "" },
    audio: { type: "string", default: "" },
    popup: { type: "string", default: "" },
    popupWidth: { type: "number", default: 3 },
    popupHeight: { type: "number", default: 2 },
    popupColor: { type: "color", default: "#333333" },
    imageSrc: { type: "string", default: "" },
    imageScale: { type: "number", default: 1 },
    imageAspectRatio: { type: "number", default: 0 },
  },

  init: function () {
    const data = this.data;
    const el = this.el;

    // REMOVED: Main element hover animations to prevent conflicts with popup elements

    // Add popup functionality
    if (data.popup) {
      this.createPopup(data);
    }

    // Add audio functionality
    if (data.audio) {
      this.createAudio(data);
    }

    // Static image (non-interactive except face-camera)
    if (data.imageSrc) {
      const img = document.createElement('a-image');
      let _src = data.imageSrc;
      if (_src && _src.includes('%')) { try { _src = decodeURIComponent(_src); } catch(e){} }
      img.setAttribute('src', _src);
  const scl = data.imageScale || 1;
  // Base unit geometry then scale for consistent aspect handling
  const knownAR = (typeof data.imageAspectRatio === 'number' && isFinite(data.imageAspectRatio) && data.imageAspectRatio>0) ? data.imageAspectRatio : 1;
  img.setAttribute('width', 1);
  img.setAttribute('height', knownAR);
  img.setAttribute('scale', scl + ' ' + scl + ' 1');
  img.setAttribute('position', '0 ' + ((knownAR/2) * scl) + ' 0.05');
  if (knownAR !== 1) img.dataset.aspectRatio = String(knownAR);
      img.classList.add('static-image-hotspot');
      if (CUSTOM_STYLES && CUSTOM_STYLES.image) {
        const istyle = CUSTOM_STYLES.image;
        const opacity = (typeof istyle.opacity === 'number') ? istyle.opacity : 1.0;
        img.setAttribute('material', 'opacity:' + opacity + '; transparent:' + (opacity<1?'true':'false') + '; side:double');
        const radius = parseFloat(istyle.borderRadius) || 0;
        if (radius === 0 && istyle.borderWidth > 0) {
          const frame = document.createElement('a-plane');
          frame.classList.add('static-image-border');
          frame.setAttribute('width', (1 * scl) + (istyle.borderWidth*2));
          frame.setAttribute('height', (1 * scl) + (istyle.borderWidth*2));
          frame.setAttribute('position', '0 ' + (0.5*scl) + ' 0.0');
          frame.setAttribute('material', 'shader:flat; color:' + (istyle.borderColor||'#FFFFFF') + '; opacity:' + opacity + '; transparent:' + (opacity<1?'true':'false') + '; side:double');
          this.el.appendChild(frame);
        }
        // If rounding requested, schedule an initial mask attempt even before natural dimension adjustment
        if (radius > 0) {
          // store original src
          if (!img.dataset.originalSrc) img.dataset.originalSrc = img.getAttribute('src');
          setTimeout(()=>{ applyRoundedMaskToAImage(img, istyle).catch(()=>{}); }, 30);
        }
      }
      img.addEventListener('load', () => {
        try {
          const ratio = (img.naturalHeight && img.naturalWidth) ? (img.naturalHeight / img.naturalWidth) : (parseFloat(img.dataset.aspectRatio||'')||1);
          if (ratio && isFinite(ratio) && ratio>0) img.dataset.aspectRatio = String(ratio);
          img.setAttribute('width', 1);
          img.setAttribute('height', ratio);
          img.setAttribute('scale', scl + ' ' + scl + ' 1');
          img.setAttribute('position', '0 ' + ((ratio/2)*scl) + ' 0.05');
          if (CUSTOM_STYLES && CUSTOM_STYLES.image) {
            const istyle = CUSTOM_STYLES.image;
            const opacity = (typeof istyle.opacity === 'number') ? istyle.opacity : 1.0;
            const radius = parseFloat(istyle.borderRadius) || 0;
            if (radius === 0 && istyle.borderWidth > 0) {
              let frame = this.el.querySelector('.static-image-border');
              if (!frame) {
                frame = document.createElement('a-plane');
                frame.classList.add('static-image-border');
                this.el.appendChild(frame);
              }
              const bw = istyle.borderWidth;
              frame.setAttribute('width', (1 * scl) + (bw*2));
              frame.setAttribute('height', (ratio * scl) + (bw*2));
              frame.setAttribute('position', '0 ' + ((ratio/2)*scl) + ' 0.0');
              frame.setAttribute('material', 'shader:flat; color:' + (istyle.borderColor||'#FFFFFF') + '; opacity:' + opacity + '; transparent:' + (opacity<1?'true':'false') + '; side:double');
            } else {
              // Rounded: ensure any square frame removed & apply in-canvas mask + stroke
              this.el.querySelectorAll('.static-image-border').forEach(b=>b.remove());
              if (radius > 0) {
                // Re-apply original src before masking if previously processed
                if (img.dataset.originalSrc) img.setAttribute('src', img.dataset.originalSrc);
                else img.dataset.originalSrc = img.getAttribute('src');
                applyRoundedMaskToAImage(img, istyle).catch(()=>{});
              }
            }
          }
        } catch(e) { /* ignore */ }
      });
      this.el.appendChild(img);
    }
  },

  createPopup: function(data) {
    const el = this.el;

    const infoIcon = document.createElement("a-entity");
    // Create circular info icon instead of banner
    const iconSize = CUSTOM_STYLES.hotspot.infoButton.size || 0.4;
    infoIcon.setAttribute("geometry", "primitive: circle; radius: " + iconSize);
    
    // Use custom styles
    const infoBgColor = CUSTOM_STYLES.hotspot.infoButton.backgroundColor;
    const infoTextColor = CUSTOM_STYLES.hotspot.infoButton.textColor;
    const infoFontSize = CUSTOM_STYLES.hotspot.infoButton.fontSize;
    
    infoIcon.setAttribute("material", "color: " + infoBgColor + "; opacity: " + CUSTOM_STYLES.hotspot.infoButton.opacity);
    infoIcon.setAttribute("text", "value: i; align: center; color: " + infoTextColor + "; width: " + infoFontSize + "; font: roboto");
    infoIcon.setAttribute("position", "0 0.8 0");
    infoIcon.classList.add("clickable");
    
    // Add hover animations to info icon for better UX
    infoIcon.setAttribute("animation__hover_in", {
      property: "scale",
      to: "1.1 1.1 1",
      dur: 200,
      easing: "easeOutQuad",
      startEvents: "mouseenter",
    });

    infoIcon.setAttribute("animation__hover_out", {
      property: "scale",
      to: "1 1 1",
      dur: 200,
      easing: "easeOutQuad",
      startEvents: "mouseleave",
    });
    
    el.appendChild(infoIcon);

    const popup = document.createElement("a-entity");
    popup.setAttribute("visible", "false");
    popup.setAttribute("position", "0 1.5 0.2"); // Move forward to avoid z-fighting with info icon
    popup.setAttribute("look-at", "#cam");

    const background = document.createElement("a-plane");
    background.setAttribute("color", CUSTOM_STYLES.hotspot.popup.backgroundColor);
    background.setAttribute("width", data.popupWidth);
    background.setAttribute("height", data.popupHeight);
    background.setAttribute("opacity", CUSTOM_STYLES.hotspot.popup.opacity);
    popup.appendChild(background);

    const text = document.createElement("a-text");
    text.setAttribute("value", data.popup);
    text.setAttribute("wrap-count", Math.floor(data.popupWidth * 8)); // Dynamic wrap based on popup width
    text.setAttribute("color", CUSTOM_STYLES.hotspot.popup.textColor);
    text.setAttribute("position", "0 0 0.05"); // Increased z-spacing to prevent z-fighting
    text.setAttribute("align", "center");
    text.setAttribute("width", (data.popupWidth - 0.4).toString()); // Constrain to popup width with padding
    text.setAttribute("font", "roboto");
    popup.appendChild(text);

    const closeButton = document.createElement("a-image");
    closeButton.setAttribute("position", data.popupWidth/2-0.3 + " " + (data.popupHeight/2-0.3) + " 0.1"); // Increased z-spacing
    closeButton.setAttribute("src", "#close");
    closeButton.setAttribute("width", CUSTOM_STYLES.hotspot.closeButton.size.toString());
    closeButton.setAttribute("height", CUSTOM_STYLES.hotspot.closeButton.size.toString());
    closeButton.setAttribute("opacity", CUSTOM_STYLES.hotspot.closeButton.opacity.toString());
    closeButton.classList.add("clickable");
    
    // Add hover animations to close button for better UX
    closeButton.setAttribute("animation__hover_in", {
      property: "scale",
      to: "1.2 1.2 1",
      dur: 200,
      easing: "easeOutQuad",
      startEvents: "mouseenter",
    });

    closeButton.setAttribute("animation__hover_out", {
      property: "scale",
      to: "1 1 1",
      dur: 200,
      easing: "easeOutQuad",
      startEvents: "mouseleave",
    });
    
    popup.appendChild(closeButton);

    infoIcon.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      popup.setAttribute("visible", true);
      infoIcon.setAttribute("visible", false); // Hide info icon when popup is open
    });

    closeButton.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      popup.setAttribute("visible", false);
      setTimeout(() => {
        infoIcon.setAttribute("visible", true); // Show info icon when popup is closed
      }, 250);
    });

    el.appendChild(popup);
  },


  createAudio: function(data) {
    const el = this.el;
    const audioEl = document.createElement("a-sound");
    // Stabilize blob/data audio by routing through <a-assets>
    let aSrc = data.audio;
    if (typeof aSrc === 'string' && (aSrc.startsWith('blob:') || aSrc.startsWith('data:'))) {
      try {
        const assets = document.querySelector('a-assets') || (function(){
          const scn = document.querySelector('a-scene') || document.querySelector('scene, a-scene');
          const a = document.createElement('a-assets');
          if (scn) scn.insertBefore(a, scn.firstChild);
          return a;
        })();
  const assetId = "audio_rt_" + (el.id || ("el_" + Math.random().toString(36).slice(2)));
  let assetEl = assets.querySelector("#" + assetId);
        if (!assetEl) {
          assetEl = document.createElement('audio');
          assetEl.setAttribute('id', assetId);
          assetEl.setAttribute('crossorigin', 'anonymous');
          assets.appendChild(assetEl);
        }
        assetEl.setAttribute('src', aSrc);
  aSrc = "#" + assetId;
      } catch(_) { /* ignore, fallback to direct src */ }
    }
    audioEl.setAttribute("src", aSrc);
    audioEl.setAttribute("autoplay", "false");
    audioEl.setAttribute("loop", "true");
    el.appendChild(audioEl);

    const btn = document.createElement("a-image");
    btn.setAttribute("class", "clickable");
    
    // Use custom play button image if available
    const playImage = CUSTOM_STYLES?.buttonImages?.play || "#play";
    btn.setAttribute("src", playImage);
    
    // Use custom audio button styles
    btn.setAttribute("width", "0.5");
    btn.setAttribute("height", "0.5");
    btn.setAttribute("material", "color: " + CUSTOM_STYLES.audio.buttonColor);
    btn.setAttribute("opacity", CUSTOM_STYLES.audio.buttonOpacity.toString());
    btn.setAttribute("position", "0 0 0.02");
    el.appendChild(btn);

    let isPlaying = false;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (audioEl.components.sound) {
        if (isPlaying) {
          audioEl.components.sound.stopSound();
          const playImage = CUSTOM_STYLES?.buttonImages?.play || "#play";
          btn.setAttribute("src", playImage);
        } else {
          audioEl.components.sound.playSound();
          const pauseImage = CUSTOM_STYLES?.buttonImages?.pause || "#pause";
          btn.setAttribute("src", pauseImage);
        }
        isPlaying = !isPlaying;
      }
    });
  }
});

// Project loader
// Project loader
class HotspotProject {
  constructor() {
    this.scenes = {};
    this.currentScene = 'scene1';
    this.globalSoundEnabled = true;
    this.currentGlobalAudio = null;
    this.isDragging = false;
    this.progressUpdateInterval = null;
  this.crossfadeEl = null; // overlay for crossfade
  this.weblinkOverlay = null;
  this.weblinkFrame = null;
  this.wasInVRBeforeWeblink = false;
    this.loadProject();
  }

  async _ensureVideoPreviewExport(sceneId){
    try {
      if (EXPORTED_VIDEO_THUMB_CACHE.has(sceneId)) return EXPORTED_VIDEO_THUMB_CACHE.get(sceneId);
      const sc = this.scenes[sceneId];
      if (!sc || sc.type !== 'video' || !sc.videoSrc) return null;
      const vid = document.createElement('video');
      vid.preload = 'metadata';
      vid.muted = true;
      vid.playsInline = true;
      vid.crossOrigin = '';
      const run = new Promise((resolve) => {
        let settled = false;
        const cleanup = () => { try { vid.src = ''; vid.load && vid.load(); } catch(_) {} };
        vid.addEventListener('loadedmetadata', () => {
          try {
            const target = Math.min(1, (vid.duration || 1) * 0.1);
            const onSeeked = () => {
              try {
                const w = 512;
                const ratio = (vid.videoHeight || 1) / (vid.videoWidth || 1);
                const h = Math.max(1, Math.round(w * ratio));
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(vid, 0, 0, w, h);
                const url = canvas.toDataURL('image/png');
                EXPORTED_VIDEO_THUMB_CACHE.set(sceneId, url);
                settled = true;
                resolve(url);
              } catch(_) { resolve(null); }
              cleanup();
            };
            try { vid.currentTime = isFinite(target) ? target : 0.1; } catch(_) { vid.currentTime = 0.1; }
            vid.addEventListener('seeked', onSeeked, { once: true });
          } catch(_) { resolve(null); cleanup(); }
        }, { once: true });
        vid.addEventListener('error', () => { if (!settled) resolve(null); cleanup(); }, { once: true });
      });
      vid.src = sc.videoSrc;
      return await run;
    } catch(_) { return null; }
  }

  async loadProject() {
    try {
      const response = await fetch('./config.json');
      const config = await response.json();
      
      console.log('Loaded config:', config);
      
      if (config.scenes) {
        // New format with scenes
        this.scenes = config.scenes;
        this.currentScene = config.currentScene || 'scene1';
        console.log('Using new format with scenes:', this.scenes);
        this.setupScenes();
      } else if (config.hotspots) {
        // Legacy format - single scene
        this.scenes = {
          'scene1': {
            name: 'Scene 1',
            image: './images/scene1.jpg',
            hotspots: config.hotspots
          }
        };
        this.currentScene = 'scene1';
        console.log('Using legacy format, created single scene');
        this.setupScenes();
      }
    } catch (error) {
      console.warn('No config.json found, using empty project');
      this.scenes = {
        'scene1': {
          name: 'Scene 1', 
          image: './images/scene1.jpg',
          hotspots: []
        }
      };
      this.setupScenes();
    }
  }

  setupScenes() {
    // Setup global sound control first
    this.setupGlobalSoundControl();

    // Show loading UI and preload all scene images so nav previews/skyboxes are instant
    this.showLoadingIndicator();
    this.preloadAllSceneImages({ updateUI: true, timeoutMs: 20000 })
      .catch(() => {})
      .finally(() => {
        this.loadScene(this.currentScene);
      });
  }

  loadScene(sceneId) {
    if (!this.scenes[sceneId]) {
      console.warn(\`Scene \${sceneId} not found\`);
      return;
    }
    const scene = this.scenes[sceneId];
    const skybox = document.getElementById('skybox');
    
    console.log(\`Loading scene: \${sceneId}\`, scene);
    
    // Show a loading indicator
    this.showLoadingIndicator();

    // Check if this is a video scene
    if (scene.type === 'video' && scene.videoSrc) {
      // Handle video scene
      this.loadVideoScene(sceneId, scene, skybox);
      return;
    }

    // Ensure any existing videosphere is removed when switching to an image scene
    const existingVideosphere = document.getElementById('current-videosphere');
    if (existingVideosphere && existingVideosphere.parentNode) {
      existingVideosphere.parentNode.removeChild(existingVideosphere);
    }
    // Hide and reset video controls/state for image scenes
    this.hideVideoControls();

    // (runtime) no editor hotspot list or id counter to manage
    
    // Prefer preloaded asset if available for instant swap
    const preloadedId = 'asset-panorama-' + sceneId;
    const preImg = document.getElementById(preloadedId);
    
    // Update scene image (fallback path)
    const imagePath = this.getSceneImagePath(scene.image, sceneId);
  console.log('Setting panorama src to: ' + (preImg ? ('#' + preloadedId) : imagePath));
    
    if (preImg) {
      // Use the preloaded asset without network load
      skybox.setAttribute('visible', 'false');
      setTimeout(() => {
        skybox.setAttribute('src', '#' + preloadedId);
        const loadingEnvironment = document.getElementById('loading-environment');
        if (loadingEnvironment) {
          loadingEnvironment.setAttribute('visible', 'false');
        }
        skybox.setAttribute('visible', 'true');
        
  // (runtime) do not persist scenes to localStorage

        console.log('Skybox texture updated from preloaded asset:', preloadedId);
        
        // Create hotspots after skybox is updated
        const container = document.getElementById('hotspot-container');
        container.innerHTML = '';
        this.createHotspots(scene.hotspots);
        console.log('Hotspots created');
        
        // Apply starting point if available
        setTimeout(() => {
          this.applyStartingPoint(scene);
          
          // Play global sound for this scene
          setTimeout(() => {
            this.playCurrentGlobalSound();
          }, 500);
        }, 100);
        
        // Notify listeners that the scene finished loading (for transitions)
        try { const ev = new CustomEvent('vrhotspots:scene-loaded'); window.dispatchEvent(ev); } catch(e) {}

        // Hide the loading indicator
        this.hideLoadingIndicator();
        
        // Hide video controls for image scenes
        this.hideVideoControls();
      }, 100);
      
      this.currentScene = sceneId;
      return;
    }
    
    // Use a timestamp as a cache buster
    const cacheBuster = Date.now();
    const imagePathWithCache = imagePath + '?t=' + cacheBuster;
    
    // Create a new unique ID for this panorama
    const uniqueId = 'panorama-' + cacheBuster;
    
    // Create a completely new method that's more reliable across browsers
    // First, create a new image element that's not attached to the DOM yet
    const preloadImage = new Image();
    
    // Set up loading handlers before setting src
    preloadImage.onload = () => {
      console.log('New panorama loaded successfully');
      
      // Now we know the image is loaded, create the actual element for A-Frame
      const newPanorama = document.createElement('img');
      newPanorama.id = uniqueId;
      newPanorama.src = imagePathWithCache;
      newPanorama.crossOrigin = 'anonymous'; // Important for some browsers
      
      // Get the assets container
      const assets = document.querySelector('a-assets');
      
      // Add new panorama element to assets
      assets.appendChild(newPanorama);
      
      // Temporarily hide the skybox while changing its texture
      skybox.setAttribute('visible', 'false');
      
      // Force A-Frame to recognize the asset change
      setTimeout(() => {
        // Update to new texture
        skybox.setAttribute('src', '#' + uniqueId);
        
        // Hide loading environment and show the actual scene
        const loadingEnvironment = document.getElementById('loading-environment');
        if (loadingEnvironment) {
          loadingEnvironment.setAttribute('visible', 'false');
        }
        skybox.setAttribute('visible', 'true');
        
        console.log('Skybox texture updated with ID:', uniqueId);
        
        // Create hotspots after skybox is updated
        const container = document.getElementById('hotspot-container');
        container.innerHTML = '';
        this.createHotspots(scene.hotspots);
        console.log('Hotspots created');
        
        // Apply starting point if available
        setTimeout(() => {
          this.applyStartingPoint(scene);
          
          // Play global sound for this scene
          setTimeout(() => {
            this.playCurrentGlobalSound();
          }, 500);
        }, 100);
        
        // Notify listeners that the scene finished loading (for transitions)
        try { const ev = new CustomEvent('vrhotspots:scene-loaded'); window.dispatchEvent(ev); } catch(e) {}

        // Hide the loading indicator
        this.hideLoadingIndicator();
        
        // Hide video controls for image scenes
        this.hideVideoControls();
      }, 100);
    };
    
    // Handle load errors
    preloadImage.onerror = () => {
      console.error(\`Failed to load panorama: \${imagePath}\`);
      this.showErrorMessage(\`Failed to load scene image for "\${scene.name}". Please check if the image exists at \${imagePath}\`);
      
      // Hide loading environment and show fallback
      const loadingEnvironment = document.getElementById('loading-environment');
      if (loadingEnvironment) {
        loadingEnvironment.setAttribute('visible', 'false');
      }
      
      // Fallback to default image
      skybox.setAttribute('src', '#main-panorama');
      skybox.setAttribute('visible', 'true');
      this.hideLoadingIndicator();
    };
    
    // Start loading the image
    preloadImage.src = imagePathWithCache;
    
    // We've replaced this with the preloadImage.onerror handler above
    
    this.currentScene = sceneId;
  }

  loadVideoScene(sceneId, scene, skybox) {
    console.log('Loading video scene:', sceneId, scene.videoSrc);
    
    // Hide skybox, we'll use videosphere instead
    skybox.setAttribute('visible', 'false');
    
    // Remove any existing videosphere
    const existingVideosphere = document.getElementById('current-videosphere');
    if (existingVideosphere) {
      existingVideosphere.parentNode.removeChild(existingVideosphere);
    }
    
    // Get or create video element
    let videoEl = document.getElementById('scene-video-dynamic');
    if (!videoEl) {
      console.warn('Video element not found in assets');
      this.hideLoadingIndicator();
      return;
    }
    
    // Set video source
    videoEl.src = scene.videoSrc;
    videoEl.volume = scene.videoVolume !== undefined ? scene.videoVolume : 0.5;
    videoEl.loop = true;
    videoEl.muted = true; // Start muted for autoplay
    
    // Create videosphere element
  const videosphere = document.createElement('a-videosphere');
    videosphere.id = 'current-videosphere';
    videosphere.setAttribute('src', '#scene-video-dynamic');
  // Align videosphere yaw with expected orientation (match editor behavior)
  videosphere.setAttribute('rotation', '0 -90 0');
    
    // Add to scene
    const aScene = document.querySelector('a-scene');
    aScene.appendChild(videosphere);
    
    // Wait for video to be ready
    const onVideoReady = () => {
      console.log('Video ready to play');
      
      videoEl.play().then(() => {
        console.log('Video playing');
        
        // Hide loading environment
        const loadingEnvironment = document.getElementById('loading-environment');
        if (loadingEnvironment) {
          loadingEnvironment.setAttribute('visible', 'false');
        }
        
        // Create hotspots
        const container = document.getElementById('hotspot-container');
        container.innerHTML = '';
        this.createHotspots(scene.hotspots);
        
        // Apply starting point
        setTimeout(() => {
          this.applyStartingPoint(scene);
          
          // Play global sound for this scene
          setTimeout(() => {
            this.playCurrentGlobalSound();
          }, 500);
        }, 100);
        
        // Notify scene loaded
        try { 
          const ev = new CustomEvent('vrhotspots:scene-loaded'); 
          window.dispatchEvent(ev); 
        } catch(e) {}
        
        // Setup video controls
        this.updateVideoControls();
        
        // Hide loading indicator
        this.hideLoadingIndicator();
      }).catch(err => {
        console.error('Error playing video:', err);
        this.hideLoadingIndicator();
      });
    };
    
    if (videoEl.readyState >= 2) {
      onVideoReady();
    } else {
      videoEl.addEventListener('loadeddata', onVideoReady, { once: true });
    }
    
    this.currentScene = sceneId;
  }

  updateVideoControls() {
    const videoEl = document.getElementById('scene-video-dynamic');
    const videoControls = document.getElementById('video-controls');
    const playPauseBtn = document.getElementById('video-play-pause');
    const muteBtn = document.getElementById('video-mute');
    const progressBar = document.getElementById('video-progress');
    const volumeSlider = document.getElementById('video-volume');
    // HTML uses video-time-current and video-time-total; support both IDs for robustness
    const currentTimeSpan = document.getElementById('video-time-current') || document.getElementById('video-current-time');
    const durationSpan = document.getElementById('video-time-total') || document.getElementById('video-duration');
    
    if (!videoEl || !videoControls) return;
    
    // Show video controls
    videoControls.style.display = 'block';
    
    // Play/Pause button
    if (playPauseBtn) {
      playPauseBtn.onclick = () => {
        if (videoEl.paused) {
          videoEl.play();
          playPauseBtn.textContent = '⏸';
        } else {
          videoEl.pause();
          playPauseBtn.textContent = '▶';
        }
      };
    }
    
    // Mute button
    if (muteBtn) {
      muteBtn.onclick = () => {
        videoEl.muted = !videoEl.muted;
        muteBtn.textContent = videoEl.muted ? '🔇' : '🔊';
      };
      muteBtn.textContent = videoEl.muted ? '🔇' : '🔊';
    }
    
    // Progress bar
    if (progressBar) {
      videoEl.addEventListener('timeupdate', () => {
        if (videoEl.duration) {
          const progress = (videoEl.currentTime / videoEl.duration) * 100;
          progressBar.value = progress;
          
          if (currentTimeSpan) {
            currentTimeSpan.textContent = this.formatTime(videoEl.currentTime);
          }
        }
      });
      
      progressBar.addEventListener('input', (e) => {
        const time = (e.target.value / 100) * videoEl.duration;
        videoEl.currentTime = time;
      });
    }
    
    // Volume slider
    if (volumeSlider) {
      volumeSlider.value = videoEl.volume * 100;
      volumeSlider.addEventListener('input', (e) => {
        videoEl.volume = e.target.value / 100;
        if (videoEl.volume > 0) {
          videoEl.muted = false;
          if (muteBtn) muteBtn.textContent = '🔊';
        }
      });
    }
    
    // Duration display
    if (durationSpan) {
      const updateDuration = () => {
        if (videoEl.duration) {
          durationSpan.textContent = this.formatTime(videoEl.duration);
        }
      };
      if (videoEl.duration) {
        updateDuration();
      } else {
        videoEl.addEventListener('loadedmetadata', updateDuration, { once: true });
      }
    }
  }

  hideVideoControls() {
    const videoControls = document.getElementById('video-controls');
    if (videoControls) {
      videoControls.style.display = 'none';
    }
    
    // Pause and reset video
    const videoEl = document.getElementById('scene-video-dynamic');
    if (videoEl) {
      videoEl.pause();
      videoEl.currentTime = 0;
    }
  }

  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return \`\${mins}:\${secs.toString().padStart(2, '0')}\`;
  }

  getSceneImagePath(imagePath, sceneId) {
    // If it's a URL (http:// or https://), use it directly
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
      return imagePath;
    }
    // If it's already a proper path starting with ./images/, use it directly
    else if (imagePath.startsWith('./images/')) {
      return imagePath;
    } 
    // For uploaded scenes (data URLs in config), look for the saved file
    else if (imagePath.startsWith('data:')) {
      return \`./images/\${sceneId}.jpg\`;
    }
    // Fallback - assume it's a filename and prepend the images path
    else {
      return \`./images/\${imagePath}\`;
    }
  }

  createHotspots(hotspots) {
    const container = document.getElementById('hotspot-container');
    

    hotspots.forEach(hotspot => {
  let hotspotEl;
  let collider = null;
  let ring = null;
      if (hotspot.type === 'navigation' || hotspot.type === 'weblink') {
        hotspotEl = document.createElement('a-entity');
        hotspotEl.setAttribute('face-camera', '');

        // Transparent circle collider for interactions
  collider = document.createElement('a-entity');
        const navStyles = (typeof CUSTOM_STYLES !== 'undefined' && CUSTOM_STYLES.navigation) ? CUSTOM_STYLES.navigation : {};
        const ringOuter = (typeof navStyles.ringOuterRadius === 'number') ? navStyles.ringOuterRadius : 0.6;
  const ringThickness = (typeof navStyles.ringThickness === 'number') ? navStyles.ringThickness : 0.02;
        const ringInner = Math.max(0.001, ringOuter - ringThickness);
        const ringColor = (hotspot.type === 'weblink') ? (navStyles.weblinkRingColor || '#001f5b') : (navStyles.ringColor || 'rgb(0, 85, 0)');
  collider.setAttribute('geometry', 'primitive: circle; radius: ' + ringOuter);
  // Prevent invisible collider from occluding preview due to depth writes
  collider.setAttribute('material', 'opacity: 0; transparent: true; depthWrite: false; side: double');
        collider.classList.add('clickable');
        hotspotEl.appendChild(collider);

  // Thin green border ring (~3px) with transparent center
  ring = document.createElement('a-entity');
  ring.setAttribute('geometry', 'primitive: ring; radiusInner: ' + ringInner + '; radiusOuter: ' + ringOuter);
  ring.setAttribute('material', 'color: ' + ringColor + '; opacity: 1; transparent: true; shader: flat');
  // Bring the ring much closer to the camera so it renders in front of audio/text hotspots
  ring.setAttribute('position', '0 0 0.15');
  ring.classList.add('nav-ring');
  hotspotEl.appendChild(ring);

  // Inline preview circle (hidden by default), shows destination scene image inside the ring
  const preview = document.createElement('a-entity');
  preview.setAttribute('geometry', 'primitive: circle; radius: ' + ringInner);
  preview.setAttribute('material', 'transparent: true; opacity: 1; shader: flat; side: double; alphaTest: 0.01');
  preview.setAttribute('visible', 'false');
  // Keep preview just behind the ring but still well in front of other UI
  preview.setAttribute('position', '0 0 0.14');
  preview.setAttribute('scale', '0.01 0.01 0.01');
  preview.classList.add('nav-preview-circle');
  hotspotEl.appendChild(preview);

  // If this is a weblink with a configured preview, set the texture immediately so the image object exists from the start
  if (hotspot.type === 'weblink') {
    try {
      let src = null;
      if (typeof hotspot.weblinkPreview === 'string' && hotspot.weblinkPreview) src = hotspot.weblinkPreview;
      if (src) {
        console.log('[Weblink][Create][Export]', { id: hotspot.id, srcType: src.startsWith('data:') ? 'dataURL' : 'url', len: src.length });
        preview.setAttribute('material', 'src', src);
        preview.setAttribute('material', 'transparent', true);
        preview.setAttribute('material', 'opacity', 1);
        preview.setAttribute('material', 'shader', 'flat');
        preview.setAttribute('material', 'side', 'double');
        preview.setAttribute('material', 'alphaTest', 0.01);
      }
    } catch(err) { console.warn('[Weblink][Create][Export] failed to set preview', err); }
  }

    // Hover title label above the ring
    const labelGroup = document.createElement('a-entity');
    labelGroup.setAttribute('visible', 'false');
    labelGroup.classList.add('nav-label');
  const labelY = ringOuter + 0.35;
  // Push the label well forward so it clearly appears in front of audio/text hotspots
  labelGroup.setAttribute('position', '0 ' + labelY + ' 0.3');
    const labelBg = document.createElement('a-plane');
    labelBg.setAttribute('width', '1.8');
    labelBg.setAttribute('height', '0.35');
  const lblBG = (navStyles && navStyles.labelBackgroundColor) || '#000';
  const lblOP = (typeof navStyles.labelOpacity === 'number') ? navStyles.labelOpacity : 0.8;
  labelBg.setAttribute('material', 'shader:flat; color: ' + lblBG + '; opacity: ' + lblOP + '; transparent: true');
    labelBg.setAttribute('position', '0 0 0');
    const labelText = document.createElement('a-text');
    labelText.setAttribute('value', '');
    labelText.setAttribute('align', 'center');
  const lblColor = (navStyles && navStyles.labelColor) || '#fff';
  labelText.setAttribute('color', lblColor);
  labelText.setAttribute('width', '5');
    labelText.setAttribute('position', '0 0 0.01');
    labelGroup.appendChild(labelBg);
    labelGroup.appendChild(labelText);
    hotspotEl.appendChild(labelGroup);
      } else {
        // Non-navigation hotspot container without an invisible plane.
        // This prevents an invisible quad from blocking interaction or depth in front of portals.
        hotspotEl = document.createElement('a-entity');
        hotspotEl.setAttribute('face-camera', '');
      }
      hotspotEl.setAttribute('position', hotspot.position);
      // Only navigation/weblink parents may be clickable; non-navigation hotspots rely on child elements
      // (info icon, close button, audio button) which are explicitly marked as .clickable.
      if (hotspot.type === 'navigation' || hotspot.type === 'weblink') {
        hotspotEl.setAttribute('class', 'clickable');
      }
      
      let config = "type:" + hotspot.type;
      
        if (hotspot.type === 'text' || hotspot.type === 'text-audio') {
        const pw = (typeof hotspot.popupWidth === 'number') ? hotspot.popupWidth : 4;
        const ph = (typeof hotspot.popupHeight === 'number') ? hotspot.popupHeight : 2.5;
        config += ";popup:" + hotspot.text + ";popupWidth:" + pw + ";popupHeight:" + ph + ";popupColor:#333333";
      }
      
      if (hotspot.type === 'audio' || hotspot.type === 'text-audio') {
        // Use custom audio URL if available, otherwise use default
        const audioSrc = hotspot.audio || "#default-audio";
        config += ";audio:" + audioSrc;
      }
      
      if (hotspot.type === 'navigation' || hotspot.type === 'weblink') {
        if (hotspot.type === 'navigation') {
          config += ";navigation:" + hotspot.navigationTarget;
        }
        // Add click handler on the collider area
        const previewEl = hotspotEl.querySelector('.nav-preview-circle');
        const labelEl = hotspotEl.querySelector('.nav-label');
  let lastActivation = 0;
  const activationEvents = ['click', 'triggerdown', 'triggerup', 'mouseup', 'touchend', 'mousedown', 'pointerdown', 'pointerup'];

        const handleActivation = (e) => {
          if (e) {
            const type = e.type || '';
            if (!activationEvents.includes(type)) {
              return;
            }
            e.stopPropagation();
            if (e.preventDefault) e.preventDefault();
          }
          const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          if (now - lastActivation < 250) return;
          lastActivation = now;

          if (hotspot.type === 'navigation') {
            this.navigateToScene(hotspot.navigationTarget);
          } else if (hotspot.type === 'weblink') {
            const url = hotspot.weblinkUrl || '';
            if (url) {
              try {
                this.showWeblinkOverlay(url, hotspot.weblinkTitle || 'External Resource');
              } catch (_) {
                const win = window.open(url, '_blank', 'noopener,noreferrer');
                if (!win) window.location.href = url;
              }
            }
          }
        };

        const handleEnter = () => {
          if (previewEl) {
            let src = null;
            if (hotspot.type === 'navigation') {
              src = this._getExportPreviewSrc(hotspot.navigationTarget);
            } else if (hotspot.type === 'weblink') {
              if (typeof hotspot.weblinkPreview === 'string' && hotspot.weblinkPreview) src = hotspot.weblinkPreview;
            }
            if (src === 'VIDEO_ICON' && hotspot.type === 'navigation') {
              try {
                this._ensureVideoPreviewExport(hotspot.navigationTarget).then((thumb) => {
                  if (thumb && previewEl) {
                    previewEl.setAttribute('material', 'src', thumb);
                    previewEl.setAttribute('material', 'transparent', true);
                    previewEl.setAttribute('material', 'opacity', 1);
                    previewEl.setAttribute('material', 'shader', 'flat');
                    previewEl.setAttribute('material', 'side', 'double');
                    previewEl.setAttribute('material', 'alphaTest', 0.01);
                  } else {
                    previewEl.setAttribute('material', 'color', '#000');
                    previewEl.setAttribute('material', 'transparent', true);
                    previewEl.setAttribute('material', 'opacity', 0.15);
                    previewEl.setAttribute('material', 'shader', 'flat');
                    previewEl.setAttribute('material', 'side', 'double');
                  }
                });
              } catch(_) {}
            } else if (src) {
              console.log('[Preview][Hover][Export]', { id: hotspot.id, type: hotspot.type, srcType: src.startsWith('data:') ? 'dataURL' : 'url', len: src.length });
              previewEl.setAttribute('material', 'src', src);
              previewEl.setAttribute('material', 'transparent', true);
              previewEl.setAttribute('material', 'opacity', 1);
              previewEl.setAttribute('material', 'shader', 'flat');
              previewEl.setAttribute('material', 'side', 'double');
              previewEl.setAttribute('material', 'alphaTest', 0.01);
            } else if (hotspot.type === 'weblink') {
              previewEl.setAttribute('material', 'color', '#000');
              previewEl.setAttribute('material', 'transparent', true);
              previewEl.setAttribute('material', 'opacity', 0.15);
              previewEl.setAttribute('material', 'shader', 'flat');
              previewEl.setAttribute('material', 'side', 'double');
            }
            previewEl.setAttribute('visible', 'true');
            previewEl.removeAttribute('animation__shrink');
            previewEl.setAttribute('scale', '0.01 0.01 0.01');
            previewEl.setAttribute('animation__grow', { property: 'scale', to: '1 1 1', dur: 180, easing: 'easeOutCubic' });
            try { console.log('[Preview][MaterialAfterSet][Export]', previewEl.getAttribute('material')); } catch (_) {}
          }
          try {
            const label = labelEl;
            const txt = label && label.querySelector('a-text');
            if (label && txt) {
              if (hotspot.type === 'navigation') {
                const sc = this.scenes[hotspot.navigationTarget];
                txt.setAttribute('value', 'Portal to ' + (sc?.name || hotspot.navigationTarget));
              } else if (hotspot.type === 'weblink') {
                const title = (hotspot.weblinkTitle && hotspot.weblinkTitle.trim()) ? hotspot.weblinkTitle.trim() : 'Open Link';
                txt.setAttribute('value', title);
              }
              try {
                const bg = label.querySelector('a-plane');
                const minW = 1.7;
                const maxW = 10;
                const tW = parseFloat(txt.getAttribute('width') || '0') || minW;
                const val = (txt.getAttribute('value') || '').toString();
                const spaces = (val.match(/\s/g) || []).length;
                const letters = Math.max(0, val.length - spaces);
                const effChars = letters + 0.4 * spaces;
                const est = 0.095 * effChars + 0.25;
                const nextW = Math.min(maxW, Math.max(minW, Math.min(tW, est)));
                if (bg) bg.setAttribute('width', String(nextW));
              } catch (_) {}
              label.setAttribute('visible', 'true');
            }
          } catch (_) {}
        };

        const handleLeave = () => {
          if (previewEl) {
            previewEl.removeAttribute('animation__grow');
            previewEl.setAttribute('animation__shrink', { property: 'scale', to: '0.01 0.01 0.01', dur: 120, easing: 'easeInCubic' });
            setTimeout(() => { previewEl.setAttribute('visible', 'false'); }, 130);
          }
          try {
            const label = labelEl;
            if (label) {
              label.setAttribute('visible', 'false');
              const bg = label.querySelector('a-plane');
              if (bg) bg.setAttribute('width', '1.8');
            }
          } catch (_) {}
        };

        const registerTarget = (element) => {
          if (!element) return;
          element.classList.add('clickable');
          activationEvents.forEach((evt) => {
            element.addEventListener(evt, handleActivation);
          });
          element.addEventListener('mouseenter', handleEnter);
          element.addEventListener('mouseleave', handleLeave);
        };

  registerTarget(hotspotEl);
  if (collider) registerTarget(collider);
  if (ring) registerTarget(ring);
        
        // Optional: subtle pulsing ring effect (guard if ring exists)
        const ringEl = hotspotEl.querySelector('.nav-ring');
        if (ringEl) ringEl.setAttribute('animation__pulse', {
          property: 'scale',
          from: '1 1 1',
          to: '1.03 1.03 1',
          dur: 1200,
          dir: 'alternate',
          loop: true,
          easing: 'easeInOutSine'
        });
      }
      if (hotspot.type === 'image') {
        const scale = (typeof hotspot.imageScale === 'number') ? hotspot.imageScale : (typeof hotspot.imageWidth === 'number' ? hotspot.imageWidth : 1);
        let src = (typeof hotspot.image === 'string' && !hotspot.image.startsWith('FILE:')) ? hotspot.image : '';
        if (src && src.includes(';')) src = encodeURIComponent(src);
        config += ';imageSrc:' + src + ';imageScale:' + scale;
        const ar = (typeof hotspot.imageAspectRatio === 'number' && isFinite(hotspot.imageAspectRatio) && hotspot.imageAspectRatio>0) ? hotspot.imageAspectRatio : ((typeof hotspot._aspectRatio === 'number' && isFinite(hotspot._aspectRatio) && hotspot._aspectRatio>0) ? hotspot._aspectRatio : 0);
        if (ar && ar > 0) config += ';imageAspectRatio:' + ar;
      }
      
      hotspotEl.setAttribute('hotspot', config);
      container.appendChild(hotspotEl);
    });
  }
  
  navigateToScene(sceneId) {
    if (!this.scenes[sceneId]) {
      console.warn(\`Scene \${sceneId} not found\`);
      return;
    }
    
  // Stop current global sound before switching
    this.stopCurrentGlobalSound();
    
    // Show navigation feedback
    this.showNavigationFeedback(this.scenes[sceneId].name);

    const runSceneSwitch = () => {
      if (runSceneSwitch.__executed) {
        return;
      }
      runSceneSwitch.__executed = true;

      // End overlay when scene reports loaded
      const onLoaded = () => {
        window.removeEventListener('vrhotspots:scene-loaded', onLoaded);
        this._endCrossfadeOverlay();
      };
      window.addEventListener('vrhotspots:scene-loaded', onLoaded, { once: true });
      // Safety timeout
      setTimeout(() => {
        window.removeEventListener('vrhotspots:scene-loaded', onLoaded);
        this._endCrossfadeOverlay();
      }, 1500);

      this.loadScene(sceneId);
    };

    // Crossfade transition into next scene
    this._startCrossfadeOverlay(runSceneSwitch);

    // Fallback: ensure we still switch scenes if the overlay callback never fires (Quest safety)
    setTimeout(() => {
      if (!runSceneSwitch.__executed) {
        runSceneSwitch();
      }
    }, 700);
  }
  
  showNavigationFeedback(sceneName) {
    const feedback = document.createElement('div');
    feedback.style.cssText = \`
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: rgba(76, 175, 80, 0.9); color: white; padding: 15px 25px;
      border-radius: 8px; font-weight: bold; z-index: 10001;
      font-family: Arial; animation: fadeInOut 2s ease-in-out;
    \`;
    feedback.innerHTML = \`Navigated to: \${sceneName}\`;
    
    document.body.appendChild(feedback);
    setTimeout(() => {
      if (feedback.parentNode) {
        feedback.parentNode.removeChild(feedback);
      }
    }, 2000);
  }
  showErrorMessage(message) {
    const errorBox = document.createElement("div");
    errorBox.style.cssText = \`
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: rgba(244, 67, 54, 0.9); color: white; padding: 20px 30px;
      border-radius: 8px; font-weight: bold; z-index: 10001;
      font-family: Arial; max-width: 80%;
    \`;
    errorBox.innerHTML = \`<div style="text-align:center">⚠️ Error</div><div style="margin-top:10px">\${message}</div>\`;
    
    // Add a close button
    const closeBtn = document.createElement("button");
    closeBtn.innerText = "Close";
    closeBtn.style.cssText = \`
      background: white; color: #f44336; border: none; padding: 8px 15px;
      border-radius: 4px; margin-top: 15px; cursor: pointer; font-weight: bold;
      display: block; margin-left: auto; margin-right: auto;
    \`;
    
    closeBtn.onclick = () => {
      if (errorBox.parentNode) {
        errorBox.parentNode.removeChild(errorBox);
      }
    };
    
    errorBox.appendChild(closeBtn);
    document.body.appendChild(errorBox);
  }
  
  showLoadingIndicator() {
    // Remove any existing loading indicator
    this.hideLoadingIndicator();
    
    // Create a more immersive loading indicator that matches the 3D environment
    const loadingEl = document.createElement('div');
    loadingEl.id = 'scene-loading-indicator';
    loadingEl.style.cssText = \`
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: linear-gradient(135deg, rgba(26, 26, 46, 0.95), rgba(15, 15, 35, 0.95));
      color: white;
      padding: 30px 50px;
      border-radius: 15px;
      font-family: 'Arial', sans-serif;
      font-size: 16px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(76, 175, 80, 0.3);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    \`;
    
    // Add spinning orb animation (matching the 3D scene)
    const spinner = document.createElement('div');
    spinner.style.cssText = \`
      width: 50px;
      height: 50px;
      margin-bottom: 20px;
      position: relative;
    \`;
    
    // Create multiple spinning rings
    for (let i = 0; i < 3; i++) {
      const ring = document.createElement('div');
      ring.style.cssText = \`
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        border: 3px solid transparent;
        border-top: 3px solid \${i === 0 ? '#4CAF50' : i === 1 ? '#2196F3' : '#FF9800'};
        border-radius: 50%;
        animation: spin-\${i} \${1 + i * 0.3}s linear infinite;
        transform: rotate(\${i * 45}deg);
      \`;
      spinner.appendChild(ring);
    }
    
    // Add enhanced keyframes for spinner animation
    const style = document.createElement('style');
    style.textContent = \`
      @keyframes spin-0 {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      @keyframes spin-1 {
        0% { transform: rotate(45deg); }
        100% { transform: rotate(405deg); }
      }
      @keyframes spin-2 {
        0% { transform: rotate(90deg); }
        100% { transform: rotate(450deg); }
      }
      @keyframes pulse-text {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.7; transform: scale(1.05); }
      }
    \`;
    document.head.appendChild(style);
    
    // Main loading text
    const text = document.createElement('div');
    text.textContent = 'Entering Virtual Reality...';
    text.style.cssText = \`
      font-size: 18px;
      font-weight: bold;
      margin-bottom: 10px;
      color: #4CAF50;
      animation: pulse-text 2s ease-in-out infinite;
    \`;
    
    // Subtitle text
  const subtitle = document.createElement('div');
  subtitle.id = 'scene-loading-subtitle';
    subtitle.textContent = 'Loading immersive experience';
    subtitle.style.cssText = \`
      font-size: 14px;
      color: #cccccc;
      opacity: 0.8;
    \`;
    
    loadingEl.appendChild(spinner);
    loadingEl.appendChild(text);
    loadingEl.appendChild(subtitle);
    document.body.appendChild(loadingEl);
  }
  
  hideLoadingIndicator() {
    const loadingEl = document.getElementById('scene-loading-indicator');
    if (loadingEl && loadingEl.parentNode) {
      loadingEl.parentNode.removeChild(loadingEl);
    }
  }

  // Preload all scenes' images into <a-assets> so skybox changes and portal previews are instant
  preloadAllSceneImages(options = {}) {
    const { updateUI = false, timeoutMs = 15000 } = options;
    const assets = document.querySelector('a-assets');
    if (!assets) return Promise.resolve();

    const ids = Object.keys(this.scenes || {});
    const total = ids.length;
    if (total === 0) return Promise.resolve();

    const updateSubtitle = (done) => {
      if (!updateUI) return;
      const subEl = document.getElementById('scene-loading-subtitle');
      if (subEl) subEl.textContent = 'Preparing scenes (' + done + '/' + total + ')';
    };

    let done = 0;
    updateSubtitle(0);

    const loaders = ids.map((id) => {
      const sc = this.scenes[id];
      // Skip video scenes — they don't need preloaded image assets and would mislead preview logic
      if (sc && sc.type === 'video') {
        done++;
        updateSubtitle(done);
        return Promise.resolve();
      }
      const src = this.getSceneImagePath(sc.image, id);
      const assetId = 'asset-panorama-' + id;
      if (document.getElementById(assetId)) { done++; updateSubtitle(done); return Promise.resolve(); }
      return new Promise((resolve) => {
        const img = document.createElement('img');
        img.id = assetId;
        img.crossOrigin = 'anonymous';
        img.addEventListener('load', () => { done++; updateSubtitle(done); resolve(); });
        img.addEventListener('error', () => { done++; updateSubtitle(done); resolve(); });
        img.src = src; // allow browser cache
        assets.appendChild(img);
      });
    });

    const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
    return Promise.race([Promise.allSettled(loaders), timeout]);
  }

  // ===== Navigation Preview (Export viewer) =====
  _ensureNavPreview() {
    if (!this._navBox) {
      const box = document.createElement('div');
      box.id = 'nav-preview';
      box.style.cssText = 'position:fixed;top:0;left:0;transform:translate(12px,12px);display:none;pointer-events:none;z-index:100001;background:rgba(0,0,0,0.9);color:#fff;border:1px solid #4CAF50;border-radius:8px;overflow:hidden;width:220px;box-shadow:0 8px 24px rgba(0,0,0,0.4);font-family:Arial,sans-serif;backdrop-filter:blur(2px);';
      const img = document.createElement('img');
      img.id = 'nav-preview-img';
      img.style.cssText = 'display:block;width:100%;height:120px;object-fit:cover;background:#111;';
      const cap = document.createElement('div');
      cap.id = 'nav-preview-caption';
      cap.style.cssText = 'padding:8px 10px;font-size:12px;color:#ddd;border-top:1px solid rgba(255,255,255,0.08);';
      box.appendChild(img); box.appendChild(cap);
      document.body.appendChild(box);
      this._navBox = box;
    }
    return this._navBox;
  }

  _positionNavPreview(x,y){
    const box = this._ensureNavPreview();
    const rectW = box.offsetWidth || 220; const rectH = box.offsetHeight || 160; const pad = 12;
    const maxX = window.innerWidth - rectW - pad; const maxY = window.innerHeight - rectH - pad;
    const nx = Math.min(Math.max(x+12, pad), maxX); const ny = Math.min(Math.max(y+12, pad), maxY);
    box.style.left = nx+'px'; box.style.top = ny+'px';
  }

  _getExportPreviewSrc(sceneId){
    // Check scene type first: video scenes should use VIDEO_ICON path (triggers thumbnail generation)
    const sc = this.scenes[sceneId]; if (!sc) return null;
    if (sc.type === 'video') return 'VIDEO_ICON';
    // For image scenes, prefer preloaded <a-assets> image if available
    const preId = 'asset-panorama-' + sceneId;
    const preEl = document.getElementById(preId);
    if (preEl) return '#' + preId;
    const img = sc.image||'';
    if (img.startsWith('http://')||img.startsWith('https://')) return img;
    if (img.startsWith('./images/')) return img;
    if (img.startsWith('data:')) return './images/' + sceneId + '.jpg';
    return './images/' + img;
  }

  _showNavPreview(sceneId){
    const box = this._ensureNavPreview();
    const img = document.getElementById('nav-preview-img');
    const cap = document.getElementById('nav-preview-caption');
    const sc = this.scenes[sceneId]; if (!sc) return;
  const src = this._getExportPreviewSrc(sceneId);
  if (src === 'VIDEO_ICON') {
    try {
      this._ensureVideoPreviewExport(sceneId).then((thumb) => {
        if (thumb) {
          img.src = thumb;
        } else {
          const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="128" height="128"><rect rx="4" ry="4" x="2" y="6" width="14" height="12" fill="#111" stroke="#2ae" stroke-width="2"/><polygon points="16,10 22,7 22,17 16,14" fill="#2ae"/></svg>');
          img.src = 'data:image/svg+xml;charset=UTF-8,' + svg;
        }
      });
    } catch(_) {}
  } else if (src) {
    img.src = src;
  }
  cap.textContent = 'Go to: ' + (sc.name || sceneId);
    box.style.display = 'block';
    if (!this._navMove){ this._navMove = (e)=> this._positionNavPreview((e.clientX||0),(e.clientY||0)); }
    window.addEventListener('mousemove', this._navMove);
  }

  _hideNavPreview(){
    const box = this._ensureNavPreview();
    box.style.display = 'none';
    if (this._navMove){ window.removeEventListener('mousemove', this._navMove); }
  }

  _ensureWeblinkOverlay() {
    if (this.weblinkOverlay && this.weblinkOverlay.isConnected) {
      return this.weblinkOverlay;
    }

    const overlay = document.createElement('div');
    overlay.id = 'weblink-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,10,25,0.92);display:none;z-index:100010;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(6px);';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#101627;border-radius:12px;box-shadow:0 18px 40px rgba(0,0,0,0.45);max-width:1100px;width:100%;max-height:80vh;height:100%;display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(64,179,255,0.25);';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:rgba(9,22,40,0.85);color:#e8f6ff;font-family:Arial, sans-serif;font-size:16px;font-weight:bold;border-bottom:1px solid rgba(64,179,255,0.25);';
    const titleEl = document.createElement('span');
    titleEl.dataset.role = 'weblink-title';
    titleEl.textContent = 'External Resource';
    header.appendChild(titleEl);

    const headerButtons = document.createElement('div');
    headerButtons.style.cssText = 'display:flex;gap:10px;';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = 'Open in New Window';
    openBtn.style.cssText = 'background:#2a7fff;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:13px;cursor:pointer;font-family:Arial, sans-serif;';
    headerButtons.appendChild(openBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.style.cssText = 'background:#233047;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:13px;cursor:pointer;font-family:Arial, sans-serif;';
    headerButtons.appendChild(closeBtn);

    header.appendChild(headerButtons);
    dialog.appendChild(header);

    const frameWrapper = document.createElement('div');
    frameWrapper.style.cssText = 'flex:1;position:relative;background:#000;';
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;height:100%;border:0;';
    iframe.allow = 'accelerometer; gyroscope; autoplay; clipboard-write; encrypted-media; picture-in-picture;';
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    frameWrapper.appendChild(iframe);
    dialog.appendChild(frameWrapper);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        this.hideWeblinkOverlay();
      }
    });
    closeBtn.addEventListener('click', () => this.hideWeblinkOverlay());
    openBtn.addEventListener('click', () => {
      if (this.weblinkFrame && this.weblinkFrame.dataset.src) {
        const targetUrl = this.weblinkFrame.dataset.src;
        let popup = null;
        try {
          popup = window.open(targetUrl, '_blank', 'noopener,noreferrer');
        } catch (_) {}
        if (popup) {
          try {
            popup.opener = null;
          } catch (_) {}
          this.hideWeblinkOverlay();
        }
      }
    });

    this.weblinkOverlay = overlay;
    this.weblinkFrame = iframe;
    overlay._titleEl = titleEl;
    return overlay;
  }

  showWeblinkOverlay(url, title) {
    if (!url) return;

    const overlay = this._ensureWeblinkOverlay();
    if (!overlay || !this.weblinkFrame) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }

    if (overlay._titleEl) {
      overlay._titleEl.textContent = title && title.trim() ? title.trim() : url;
    }

    this.wasInVRBeforeWeblink = false;
    const scene = document.querySelector('a-scene');
    if (scene && scene.is && scene.is('vr-mode') && typeof scene.exitVR === 'function') {
      try {
        scene.exitVR();
        this.wasInVRBeforeWeblink = true;
      } catch (_) {}
    }

    this.weblinkFrame.dataset.src = url;
    this.weblinkFrame.src = url;
    overlay.style.display = 'flex';
  }

  hideWeblinkOverlay() {
    if (!this.weblinkOverlay || !this.weblinkFrame) return;
    this.weblinkOverlay.style.display = 'none';
    delete this.weblinkFrame.dataset.src;
    this.weblinkFrame.src = 'about:blank';

    if (this.wasInVRBeforeWeblink) {
      const scene = document.querySelector('a-scene');
      if (scene && typeof scene.enterVR === 'function') {
        try {
          setTimeout(() => {
            try { scene.enterVR(); } catch (_) {}
          }, 300);
        } catch (_) {}
      }
      this.wasInVRBeforeWeblink = false;
    }
  }

  // ===== Crossfade helpers (Export viewer) =====
  _ensureCrossfadeOverlay() {
    if (!this.crossfadeEl) {
      const overlay = document.createElement('div');
      overlay.id = 'scene-crossfade';
      overlay.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;transition:opacity 300ms ease;z-index:100000;';
      document.body.appendChild(overlay);
      this.crossfadeEl = overlay;
    }
    return this.crossfadeEl;
  }

  _startCrossfadeOverlay(run) {
    const overlay = this._ensureCrossfadeOverlay();
    requestAnimationFrame(() => {
      overlay.style.pointerEvents = 'auto';
      overlay.style.opacity = '1';
      setTimeout(() => {
        try { run && run(); } catch(e) {}
      }, 320);
    });
  }

  _endCrossfadeOverlay() {
    const overlay = this._ensureCrossfadeOverlay();
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.style.pointerEvents = 'none'; }, 320);
  }
  
  applyStartingPoint(scene) {
    if (!scene.startingPoint || !scene.startingPoint.rotation) return;
    
    const camera = document.getElementById('cam');
    const rotation = scene.startingPoint.rotation;
    
    // Temporarily disable look-controls to allow rotation setting
    const lookControls = camera.components['look-controls'];
    if (lookControls) {
      lookControls.pause();
    }
    
    // Apply the stored rotation to the camera
    camera.setAttribute('rotation', \`\${rotation.x} \${rotation.y} \${rotation.z}\`);
    
    // Force the look-controls to sync with the new rotation
    if (lookControls) {
      // Update the look-controls internal state to match our rotation
      lookControls.pitchObject.rotation.x = THREE.MathUtils.degToRad(rotation.x);
      lookControls.yawObject.rotation.y = THREE.MathUtils.degToRad(rotation.y);
      
      // Re-enable look-controls after a short delay
      setTimeout(() => {
        lookControls.play();
      }, 100);
    }
    
    console.log(\`Applied starting point rotation: X:\${rotation.x}° Y:\${rotation.y}° Z:\${rotation.z}°\`);
  }
  
  setupGlobalSoundControl() {
    const soundBtn = document.getElementById('global-sound-toggle');
    if (!soundBtn) return;
    
    soundBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleGlobalSound();
    });
    
    this.setupProgressBar();
    this.updateGlobalSoundButton();
  }
  
  setupProgressBar() {
    const progressBar = document.getElementById('progress-bar');
    const progressHandle = document.getElementById('progress-handle');
    
    if (!progressBar || !progressHandle) return;
    
    // Click on progress bar to seek
    progressBar.addEventListener('click', (e) => {
      if (this.isDragging) return;
      this.seekToPosition(e);
    });
    
    // Drag functionality
    progressHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.isDragging = true;
      document.addEventListener('mousemove', this.handleProgressDrag.bind(this));
      document.addEventListener('mouseup', this.handleProgressDragEnd.bind(this));
    });
    
    // Touch support for mobile
    progressHandle.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.isDragging = true;
      document.addEventListener('touchmove', this.handleProgressTouchDrag.bind(this));
      document.addEventListener('touchend', this.handleProgressDragEnd.bind(this));
    });
  }
  
  handleProgressDrag(e) {
    if (!this.isDragging || !this.currentGlobalAudio) return;
    e.preventDefault();
    this.seekToPosition(e);
  }
  
  handleProgressTouchDrag(e) {
    if (!this.isDragging || !this.currentGlobalAudio) return;
    e.preventDefault();
    const touch = e.touches[0];
    this.seekToPosition(touch);
  }
  
  handleProgressDragEnd() {
    this.isDragging = false;
    document.removeEventListener('mousemove', this.handleProgressDrag);
    document.removeEventListener('mouseup', this.handleProgressDragEnd);
    document.removeEventListener('touchmove', this.handleProgressTouchDrag);
    document.removeEventListener('touchend', this.handleProgressDragEnd);
  }
  
  seekToPosition(e) {
    if (!this.currentGlobalAudio) return;
    
    const progressBar = document.getElementById('progress-bar');
    const rect = progressBar.getBoundingClientRect();
    const clickX = (e.clientX || e.pageX) - rect.left;
    const percentage = Math.max(0, Math.min(1, clickX / rect.width));
    
    const newTime = percentage * this.currentGlobalAudio.duration;
    this.currentGlobalAudio.currentTime = newTime;
    
    this.updateProgressDisplay();
  }
  
  updateProgressDisplay() {
    if (!this.currentGlobalAudio) return;
    
    const progressFill = document.getElementById('progress-fill');
    const progressHandle = document.getElementById('progress-handle');
    const currentTimeEl = document.getElementById('current-time');
    const totalTimeEl = document.getElementById('total-time');
    
    if (!progressFill || !progressHandle || !currentTimeEl || !totalTimeEl) return;
    
    const currentTime = this.currentGlobalAudio.currentTime;
    const duration = this.currentGlobalAudio.duration;
    
    if (isNaN(duration)) return;
    
    const percentage = (currentTime / duration) * 100;
    
    progressFill.style.width = percentage + '%';
    progressHandle.style.left = percentage + '%';
    
    currentTimeEl.textContent = this.formatTime(currentTime);
    totalTimeEl.textContent = this.formatTime(duration);
  }
  
  formatTime(seconds) {
    if (isNaN(seconds)) return '0:00';
    
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return \`\${minutes}:\${remainingSeconds.toString().padStart(2, '0')}\`;
  }
  
  showProgressBar() {
    const container = document.getElementById('audio-progress-container');
    if (container) {
      container.style.display = 'block';
    }
  }
  
  hideProgressBar() {
    const container = document.getElementById('audio-progress-container');
    if (container) {
      container.style.display = 'none';
    }
  }
  
  toggleGlobalSound() {
    this.globalSoundEnabled = !this.globalSoundEnabled;
    
    if (this.globalSoundEnabled) {
      this.playCurrentGlobalSound();
    } else {
      this.stopCurrentGlobalSound();
    }
    
    this.updateGlobalSoundButton();
  }
  
  updateGlobalSoundButton() {
    const soundBtn = document.getElementById('global-sound-toggle');
    if (!soundBtn) return;
    
    if (this.globalSoundEnabled) {
      soundBtn.textContent = '🔊 Sound: ON';
      soundBtn.classList.remove('muted');
    } else {
      soundBtn.textContent = '🔇 Sound: OFF';
      soundBtn.classList.add('muted');
    }
  }
  
  playCurrentGlobalSound() {
    if (!this.globalSoundEnabled) return;
    
    const scene = this.scenes[this.currentScene];
    if (!scene || !scene.globalSound || !scene.globalSound.enabled) {
      this.hideProgressBar();
      return;
    }
    
    this.stopCurrentGlobalSound();
    
    const globalSound = scene.globalSound;
    this.currentGlobalAudio = new Audio();
    this.currentGlobalAudio.src = globalSound.audio;
    this.currentGlobalAudio.loop = true;
    this.currentGlobalAudio.volume = globalSound.volume || 0.5;
    
    // Set up progress tracking
    this.currentGlobalAudio.addEventListener('loadedmetadata', () => {
      this.showProgressBar();
      this.updateProgressDisplay();
      this.startProgressTracking();
    });
    
    this.currentGlobalAudio.addEventListener('timeupdate', () => {
      if (!this.isDragging) {
        this.updateProgressDisplay();
      }
    });
    
    this.currentGlobalAudio.addEventListener('ended', () => {
      // This shouldn't happen with loop=true, but just in case
      this.updateProgressDisplay();
    });
    
    // Try to play audio, handle autoplay restrictions gracefully
    this.currentGlobalAudio.play().catch(e => {
      console.log('Audio autoplay blocked - will start on first user interaction');
      this.hideProgressBar();
      
      // Set up one-time event listener for first user interaction
      const enableAudioOnInteraction = () => {
        this.currentGlobalAudio.play().then(() => {
          console.log('Audio enabled after user interaction');
          this.showProgressBar();
          this.updateProgressDisplay();
          this.startProgressTracking();
        }).catch(e => {
          console.warn('Audio still cannot play:', e);
        });
        
        // Remove the event listener after first use
        document.removeEventListener('click', enableAudioOnInteraction);
        document.removeEventListener('touchstart', enableAudioOnInteraction);
        document.removeEventListener('keydown', enableAudioOnInteraction);
      };
      
      // Listen for any user interaction
      document.addEventListener('click', enableAudioOnInteraction, { once: true });
      document.addEventListener('touchstart', enableAudioOnInteraction, { once: true });
      document.addEventListener('keydown', enableAudioOnInteraction, { once: true });
    });
  }
  
  startProgressTracking() {
    // Clear any existing interval
    if (this.progressUpdateInterval) {
      clearInterval(this.progressUpdateInterval);
    }
    
    // Update progress display every 100ms for smooth animation
    this.progressUpdateInterval = setInterval(() => {
      if (this.currentGlobalAudio && !this.isDragging) {
        this.updateProgressDisplay();
      }
    }, 100);
  }
  
  stopProgressTracking() {
    if (this.progressUpdateInterval) {
      clearInterval(this.progressUpdateInterval);
      this.progressUpdateInterval = null;
    }
  }
  
  stopCurrentGlobalSound() {
    this.stopProgressTracking();
    
    if (this.currentGlobalAudio) {
      this.currentGlobalAudio.pause();
      this.currentGlobalAudio.currentTime = 0;
      this.currentGlobalAudio = null;
    }
    
    this.hideProgressBar();
  }

  getCustomStyles() {
    // For exported projects, return the embedded custom styles
    // This method is needed for compatibility with createHotspots method
    return CUSTOM_STYLES || {
      hotspot: {
        infoButton: {
          backgroundColor: "#4A90E2", // Blue background for i icon
          textColor: "#FFFFFF",
          fontSize: 12, // Larger font for i icon
          opacity: 0.9,
          size: 0.4, // Size of the i icon circle
        },
        popup: {
          backgroundColor: "#333333",
          textColor: "#FFFFFF",
          borderColor: "#555555",
          borderWidth: 0,
          borderRadius: 0,
          opacity: 0.95,
          fontSize: 1,
          padding: 0.2,
        },
        closeButton: {
          size: 0.4,
          opacity: 1.0,
        },
      },
      audio: {
        buttonColor: "#FFFFFF",
        buttonOpacity: 1.0,
      },
      buttonImages: {
        play: "images/play.png",
        pause: "images/pause.png",
      },
    };
  }
}

// Initialize project
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    new HotspotProject();
  }, 1000);
});`;
  }

  async addRealAssets(imagesFolder, audioFolder) {
    try {
      // Warn when running from file:// where fetches will likely fail
      try {
        if (typeof location !== "undefined" && location.protocol === "file:") {
          if (!this._fileProtocolWarned) {
            this._fileProtocolWarned = true;
            console.warn("Export is running from file://. Real icons may not be readable. Export from a server (e.g., http://localhost:3000) to include real icons.");
            try { alert("Export from a server to include real icons. Running from file:// may embed fallback icons."); } catch (_) {}
          }
        }
      } catch (_) {}

      // Fetch real assets from the current project
      const assetsToFetch = [
        { path: "./images/close.png", filename: "close.png" },
        { path: "./images/play.png", filename: "play.png" },
        { path: "./images/pause.png", filename: "pause.png" },
        { path: "./images/scene1.jpg", filename: "scene1.jpg" }, // Default panorama
      ];

      for (const asset of assetsToFetch) {
        try {
          const response = await fetch(asset.path);
          if (response.ok) {
            const blob = await response.blob();
            imagesFolder.file(asset.filename, blob);
          } else {
            // If can't fetch, embed our default PNG for consistency
            await this.addEmbeddedDefaultIcon(imagesFolder, asset.filename);
          }
        } catch (error) {
          console.warn(`Could not fetch ${asset.path}, embedding default icon`);
          await this.addEmbeddedDefaultIcon(imagesFolder, asset.filename);
        }
      }

      // Try to fetch audio
      try {
        const audioResponse = await fetch("./audio/music.mp3");
        if (audioResponse.ok) {
          const audioBlob = await audioResponse.blob();
          audioFolder.file("music.mp3", audioBlob);
        }
      } catch (error) {
        console.warn("Could not fetch audio file");
      }
    } catch (error) {
      console.warn("Error adding assets:", error);
      // Fallback to embedding all defaults
      await this.embedAllDefaultIcons(imagesFolder);
    }
  }

  // Embed deterministic default PNGs (via canvas → blob) so exports are consistent
  async addEmbeddedDefaultIcon(imagesFolder, filename) {
    const blob = await this._makeDefaultIconBlob(filename);
    imagesFolder.file(filename, blob);
  }

  async embedAllDefaultIcons(imagesFolder) {
    const placeholders = ["close.png", "play.png", "pause.png", "scene1.jpg"];
    for (const filename of placeholders) {
      await this.addEmbeddedDefaultIcon(imagesFolder, filename);
    }
  }

  _makeDefaultIconBlob(filename) {
    return new Promise((resolve) => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");

      // Draw defaults to match our shipped icons
      if (filename.includes("close")) {
        ctx.fillStyle = "#f44336"; // red
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 20px Arial";
        ctx.textAlign = "center";
        ctx.fillText("✕", 32, 40);
      } else if (filename.includes("play")) {
        ctx.fillStyle = "#2196F3"; // blue
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 20px Arial";
        ctx.textAlign = "center";
        ctx.fillText("▶", 32, 40);
      } else if (filename.includes("pause")) {
        ctx.fillStyle = "#FF9800"; // orange
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 20px Arial";
        ctx.textAlign = "center";
        ctx.fillText("⏸", 32, 40);
      } else {
        // Generic placeholder for any unexpected image
        ctx.fillStyle = "#9E9E9E";
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 12px Arial";
        ctx.textAlign = "center";
        ctx.fillText("IMG", 32, 40);
      }

      canvas.toBlob((blob) => resolve(blob), "image/png");
    });
  }

  // Enhanced coordinate calculation methods
  calculateSphericalPosition(intersection, camera) {
    // Convert cartesian coordinates to spherical coordinates for better 360° positioning
    const cameraPos = camera.getAttribute("position");

    // Calculate relative position from camera
    const relativePos = {
      x: intersection.point.x - cameraPos.x,
      y: intersection.point.y - cameraPos.y,
      z: intersection.point.z - cameraPos.z,
    };

    // Calculate spherical coordinates
    const radius = 8; // Fixed radius for consistency
    const theta = Math.atan2(relativePos.x, relativePos.z); // Horizontal angle
    const phi = Math.acos(
      relativePos.y /
        Math.sqrt(
          relativePos.x * relativePos.x +
            relativePos.y * relativePos.y +
            relativePos.z * relativePos.z
        )
    ); // Vertical angle

    // Convert back to cartesian with fixed radius
    return {
      x: cameraPos.x + radius * Math.sin(phi) * Math.sin(theta),
      y: cameraPos.y + radius * Math.cos(phi),
      z: cameraPos.z + radius * Math.sin(phi) * Math.cos(theta),
    };
  }

  calculateOptimalPosition(intersection, camera) {
    // This method provides the most optimal positioning for 360° panoramas
    const cameraPos = camera.getAttribute("position");

    // Get the direction vector from camera to intersection
    const direction = new THREE.Vector3(
      intersection.point.x - cameraPos.x,
      intersection.point.y - cameraPos.y,
      intersection.point.z - cameraPos.z
    );

    // Normalize to unit vector
    direction.normalize();

    // Apply optimal distance based on 360° panorama best practices
    const optimalDistance = 7.5; // Sweet spot for visibility and interaction

    return {
      x: cameraPos.x + direction.x * optimalDistance,
      y: cameraPos.y + direction.y * optimalDistance,
      z: cameraPos.z + direction.z * optimalDistance,
    };
  }

  // Scene Management Methods
  setupSceneManagement() {
    this.updateSceneDropdown();
    this.updateNavigationTargets();
    this.updateModeIndicator();
    this.updateStartingPointInfo();
  }

  // Starting Point Management
  setStartingPoint() {
    const camera = document.getElementById("cam");
    const rotation = camera.getAttribute("rotation");

    // Store the current camera rotation as the starting point
    this.scenes[this.currentScene].startingPoint = {
      rotation: {
        x: rotation.x,
        y: rotation.y,
        z: rotation.z,
      },
    };

    this.updateStartingPointInfo();

    // Show feedback
    this.showStartingPointFeedback("Starting point set to current view");
  }

  clearStartingPoint() {
    this.scenes[this.currentScene].startingPoint = null;
    this.updateStartingPointInfo();
    this.showStartingPointFeedback(
      "Starting point cleared - will use default view"
    );
  }

  updateStartingPointInfo() {
    const infoDiv = document.getElementById("starting-point-info");
    const currentScene = this.scenes[this.currentScene];

    if (currentScene.startingPoint) {
      const rotation = currentScene.startingPoint.rotation;
      infoDiv.innerHTML = `📍 Set: X:${rotation.x.toFixed(
        0
      )}° Y:${rotation.y.toFixed(0)}° Z:${rotation.z.toFixed(0)}°`;
      infoDiv.style.background = "#1B5E20";
      infoDiv.style.color = "#4CAF50";
    } else {
      infoDiv.innerHTML = "No starting point set";
      infoDiv.style.background = "#333";
      infoDiv.style.color = "#ccc";
    }
  }

  showStartingPointFeedback(message) {
    const feedback = document.createElement("div");
    feedback.style.cssText = `
      position: fixed; top: 20px; right: 380px; 
      background: rgba(76, 175, 80, 0.9); color: white; padding: 10px 15px;
      border-radius: 6px; font-weight: bold; z-index: 10001;
      font-family: Arial; font-size: 12px;
    `;
    feedback.innerHTML = `📍 ${message}`;

    document.body.appendChild(feedback);
    setTimeout(() => {
      if (feedback.parentNode) {
        feedback.parentNode.removeChild(feedback);
      }
    }, 3000);
  }

  applyStartingPoint() {
    const currentScene = this.scenes[this.currentScene];
    if (!currentScene.startingPoint) return;

    const camera = document.getElementById("cam");
    const rotation = currentScene.startingPoint.rotation;

    // Temporarily disable look-controls to allow rotation setting
    const lookControls = camera.components["look-controls"];
    if (lookControls) {
      lookControls.pause();
    }

    // Apply the stored rotation to the camera
    camera.setAttribute(
      "rotation",
      `${rotation.x} ${rotation.y} ${rotation.z}`
    );

    // Force the look-controls to sync with the new rotation
    if (lookControls) {
      // Update the look-controls internal state to match our rotation
      lookControls.pitchObject.rotation.x = THREE.MathUtils.degToRad(
        rotation.x
      );
      lookControls.yawObject.rotation.y = THREE.MathUtils.degToRad(rotation.y);

      // Re-enable look-controls after a short delay
      setTimeout(() => {
        lookControls.play();
      }, 100);
    }

    console.log(
      `Applied starting point rotation: X:${rotation.x}° Y:${rotation.y}° Z:${rotation.z}°`
    );
  }

  updateSceneDropdown() {
    const dropdown = document.getElementById("current-scene");
    dropdown.innerHTML = "";

    Object.keys(this.scenes).forEach((sceneId) => {
      const option = document.createElement("option");
      option.value = sceneId;
      option.textContent = this.scenes[sceneId].name;
      if (sceneId === this.currentScene) {
        option.selected = true;
      }
      dropdown.appendChild(option);
    });
  }

  updateNavigationTargets() {
    const dropdown = document.getElementById("navigation-target");
    dropdown.innerHTML = '<option value="">Select target scene...</option>';

    Object.keys(this.scenes).forEach((sceneId) => {
      if (sceneId !== this.currentScene) {
        // Don't allow navigation to current scene
        const option = document.createElement("option");
        option.value = sceneId;
        option.textContent = this.scenes[sceneId].name;
        dropdown.appendChild(option);
      }
    });
  }

  // Helper function to get the first scene ID for consistent starting point
  getFirstSceneId() {
    const sceneIds = Object.keys(this.scenes);
    return sceneIds.length > 0 ? sceneIds[0] : "scene1";
  }

  // Global Sound Management
  toggleGlobalSoundControls(enabled) {
    const controls = document.getElementById("global-sound-controls");
    controls.style.display = enabled ? "block" : "none";

    if (!enabled) {
      // Clear global sound when disabled
      this.scenes[this.currentScene].globalSound = null;
      this.stopGlobalSound();
    }
  }

  updateGlobalSound() {
    const enabled = document.getElementById("global-sound-enabled").checked;
    if (!enabled) return;

    const file = document.getElementById("global-sound-file").files[0];
    const url = document.getElementById("global-sound-url").value.trim();
    const volume = parseFloat(
      document.getElementById("global-sound-volume").value
    );

    let audio = null;
    if (url) {
      audio = url;
    } else if (file) {
      audio = file;
    }

    if (audio) {
      // Set the basic structure first
      this.scenes[this.currentScene].globalSound = {
        audio: audio,
        volume: volume,
        enabled: true,
      };

      // If using a File, persist into IndexedDB and switch to blob URL
      if (audio instanceof File) {
        (async () => {
          try {
            const storageKey = this.scenes[this.currentScene].globalSound.audioStorageKey || `audio_global_${this.currentScene}`;
            const saved = await this.saveAudioToIDB(storageKey, audio);
            if (saved) {
              const blobURL = URL.createObjectURL(audio);
              this.scenes[this.currentScene].globalSound.audioStorageKey = storageKey;
              this.scenes[this.currentScene].globalSound.audioFileName = audio.name || null;
              this.scenes[this.currentScene].globalSound.audio = blobURL;
              this.saveScenesData();
            }
          } catch (e) {
            console.warn("[GlobalSound] Failed to save audio to IndexedDB", e);
          }
        })();
      } else if (typeof audio === "string") {
        // If switching to URL-based audio, ensure we clear any stale storage keys
        if (this.scenes[this.currentScene].globalSound) {
          delete this.scenes[this.currentScene].globalSound.audioStorageKey;
          delete this.scenes[this.currentScene].globalSound.audioFileName;
        }
      }
    } else {
      this.scenes[this.currentScene].globalSound = null;
    }
  }

  loadGlobalSoundControls() {
    const scene = this.scenes[this.currentScene];
    const globalSound = scene.globalSound;

    if (globalSound && globalSound.enabled) {
      document.getElementById("global-sound-enabled").checked = true;
      document.getElementById("global-sound-volume").value =
        globalSound.volume || 0.5;
      this.toggleGlobalSoundControls(true);

      // If it's a URL, populate the URL field
      if (typeof globalSound.audio === "string") {
        document.getElementById("global-sound-url").value = globalSound.audio;
        document.getElementById("global-sound-file").value = "";
      } else {
        // It's a File object, we can't restore file input, but show it's set
        document.getElementById("global-sound-url").value = "";
        // Note: Can't restore file input for security reasons
      }
    } else {
      document.getElementById("global-sound-enabled").checked = false;
      document.getElementById("global-sound-url").value = "";
      document.getElementById("global-sound-file").value = "";
      document.getElementById("global-sound-volume").value = 0.5;
      this.toggleGlobalSoundControls(false);
    }

    // Update editor sound button state
    this.updateEditorSoundButton();

    // Sync the visible Global Sound switch visuals to the current checkbox state
    this._syncGlobalSoundToggleUI();
  }

  playGlobalSound() {
    const scene = this.scenes[this.currentScene];
    if (!scene.globalSound || !scene.globalSound.enabled) return;

    this.stopGlobalSound(); // Stop any existing global sound

    const audio = scene.globalSound.audio;
    const volume = scene.globalSound.volume || 0.5;

    // Create global audio element
    this.globalAudioElement = document.createElement("audio");
    this.globalAudioElement.loop = true;
    this.globalAudioElement.volume = volume;

    if (typeof audio === "string") {
      this.globalAudioElement.src = audio;
    } else if (audio instanceof File) {
      this.globalAudioElement.src = URL.createObjectURL(audio);
    }

    this.globalAudioElement.play().catch((e) => {
      console.warn("Could not play global sound:", e);
    });
  }

  stopGlobalSound() {
    if (this.globalAudioElement) {
      this.globalAudioElement.pause();
      this.globalAudioElement.currentTime = 0;
      if (this.globalAudioElement.src.startsWith("blob:")) {
        URL.revokeObjectURL(this.globalAudioElement.src);
      }
      this.globalAudioElement = null;
    }
  }

  // Editor Global Sound Management
  toggleEditorGlobalSound() {
    console.log(
      "🔘 TOGGLE BUTTON CLICKED - Current state:",
      this.editorGlobalSoundEnabled
    );
    this.editorGlobalSoundEnabled = !this.editorGlobalSoundEnabled;
    console.log("🔘 TOGGLE - New state:", this.editorGlobalSoundEnabled);

    if (this.editorGlobalSoundEnabled) {
      console.log("🔘 TOGGLE - Starting audio");
      this.playEditorGlobalSound();
    } else {
      console.log("🔘 TOGGLE - Stopping audio");
      this.stopEditorGlobalSound();
    }

    this.updateEditorSoundButton();
    console.log("🔘 TOGGLE - Button updated");
  }

  updateEditorSoundButton() {
    console.log(
      "🔘 UPDATE BUTTON - State:",
      this.editorGlobalSoundEnabled ? "ENABLED" : "DISABLED"
    );
    const btn = document.getElementById("editor-sound-control");
    if (!btn) {
      console.log("🔘 UPDATE BUTTON - ERROR: Button not found!");
      return;
    }

    if (this.editorGlobalSoundEnabled) {
      btn.textContent = "🎵 Scene Audio: ON";
      btn.classList.remove("muted");
      console.log("🔘 UPDATE BUTTON - Set to ON");
    } else {
      btn.textContent = "🔇 Scene Audio: OFF";
      btn.classList.add("muted");
      console.log("🔘 UPDATE BUTTON - Set to OFF");
    }
  }

  playEditorGlobalSound() {
    console.log(
      "🎵 PLAY - Called, enabled state:",
      this.editorGlobalSoundEnabled
    );
    if (!this.editorGlobalSoundEnabled) {
      console.log("🎵 PLAY - BLOCKED: Editor sound is disabled");
      return;
    }

    const scene = this.scenes[this.currentScene];
    if (!scene || !scene.globalSound || !scene.globalSound.enabled) {
      console.log(
        "🎵 PLAY - BLOCKED: No global sound configured for scene:",
        this.currentScene
      );
      this.hideEditorProgressBar();
      return;
    }

    console.log("🎵 PLAY - Starting audio for scene:", this.currentScene);
    this.stopEditorGlobalSound();

    const globalSound = scene.globalSound;
    this.editorGlobalAudio = document.createElement("audio");
    this.editorGlobalAudio.loop = true;
    this.editorGlobalAudio.volume = globalSound.volume || 0.5;

    if (typeof globalSound.audio === "string") {
      this.editorGlobalAudio.src = globalSound.audio;
    } else if (globalSound.audio instanceof File) {
      this.editorGlobalAudio.src = URL.createObjectURL(globalSound.audio);
    }

    // Set up progress tracking for editor
    this.editorGlobalAudio.addEventListener("loadedmetadata", () => {
      this.showEditorProgressBar();
      this.updateEditorProgressDisplay();
      this.startEditorProgressTracking();
    });

    this.editorGlobalAudio.addEventListener("timeupdate", () => {
      this.updateEditorProgressDisplay();
    });

    this.editorGlobalAudio.play().catch((e) => {
      console.warn("Could not play editor global sound:", e);
      this.hideEditorProgressBar();
    });
  }

  stopEditorGlobalSound() {
    console.log("🎵 STOP: Stopping editor audio");
    this.stopEditorProgressTracking();

    if (this.editorGlobalAudio) {
      console.log("🎵 STOP: Audio element exists, pausing and cleaning up");
      this.editorGlobalAudio.pause();
      this.editorGlobalAudio.currentTime = 0;
      if (
        this.editorGlobalAudio.src &&
        this.editorGlobalAudio.src.startsWith("blob:")
      ) {
        URL.revokeObjectURL(this.editorGlobalAudio.src);
      }
      this.editorGlobalAudio = null;
    } else {
      console.log("🎵 STOP: No audio element to stop");
    }

    this.hideEditorProgressBar();
  }

  setupEditorProgressBar() {
    const progressBar = document.getElementById("editor-progress-bar");
    const progressHandle = document.getElementById("editor-progress-handle");

    if (!progressBar || !progressHandle) return;

    // Click on progress bar to seek
    progressBar.addEventListener("click", (e) => {
      this.seekEditorToPosition(e);
    });

    // Drag functionality for editor
    progressHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.editorIsDragging = true;
      document.addEventListener(
        "mousemove",
        this.handleEditorProgressDrag.bind(this)
      );
      document.addEventListener(
        "mouseup",
        this.handleEditorProgressDragEnd.bind(this)
      );
    });
  }

  handleEditorProgressDrag(e) {
    if (!this.editorIsDragging || !this.editorGlobalAudio) return;
    e.preventDefault();
    this.seekEditorToPosition(e);
  }

  handleEditorProgressDragEnd() {
    this.editorIsDragging = false;
    document.removeEventListener("mousemove", this.handleEditorProgressDrag);
    document.removeEventListener("mouseup", this.handleEditorProgressDragEnd);
  }

  seekEditorToPosition(e) {
    if (!this.editorGlobalAudio) return;

    const progressBar = document.getElementById("editor-progress-bar");
    const rect = progressBar.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, clickX / rect.width));

    const newTime = percentage * this.editorGlobalAudio.duration;
    this.editorGlobalAudio.currentTime = newTime;

    this.updateEditorProgressDisplay();
  }

  updateEditorProgressDisplay() {
    if (!this.editorGlobalAudio) return;

    const progressFill = document.getElementById("editor-progress-fill");
    const progressHandle = document.getElementById("editor-progress-handle");
    const currentTimeEl = document.getElementById("editor-current-time");
    const totalTimeEl = document.getElementById("editor-total-time");

    if (!progressFill || !progressHandle || !currentTimeEl || !totalTimeEl)
      return;

    const currentTime = this.editorGlobalAudio.currentTime;
    const duration = this.editorGlobalAudio.duration;

    if (isNaN(duration)) return;

    const percentage = (currentTime / duration) * 100;

    progressFill.style.width = percentage + "%";
    progressHandle.style.left = percentage + "%";

    currentTimeEl.textContent = this.formatTime(currentTime);
    totalTimeEl.textContent = this.formatTime(duration);
  }

  // Format time helper for editor functions
  formatTime(seconds) {
    if (isNaN(seconds)) return "0:00";

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
  }

  startEditorProgressTracking() {
    if (this.editorProgressInterval) {
      clearInterval(this.editorProgressInterval);
    }

    this.editorProgressInterval = setInterval(() => {
      if (this.editorGlobalAudio && !this.editorIsDragging) {
        this.updateEditorProgressDisplay();
      }
    }, 100);
  }

  stopEditorProgressTracking() {
    if (this.editorProgressInterval) {
      clearInterval(this.editorProgressInterval);
      this.editorProgressInterval = null;
    }
  }

  showEditorProgressBar() {
    const container = document.getElementById("editor-progress-container");
    if (container) {
      container.style.display = "block";
    }
  }

  hideEditorProgressBar() {
    const container = document.getElementById("editor-progress-container");
    if (container) {
      container.style.display = "none";
    }
  }

  updateModeIndicator() {
    const editModeIndicator = document.getElementById("edit-indicator");
    const instructionsContent = document.getElementById("instructions-content");

    if (this.navigationMode) {
      editModeIndicator.style.display = "none";
      if (instructionsContent) {
        instructionsContent.innerHTML =
          '<strong>Navigation Mode:</strong><br>• Click navigation portals (🚪) to move between scenes<br>• Use mouse/touch to look around 360°<br>• Toggle "Edit Mode" to modify hotspots<br><br><strong style="color: #4caf50;">💡 Pro Tip:</strong><br><span style="font-size: 12px;">First scene will be the starting point when you save/export!</span>';
      }

      // Do NOT auto-play global sound - let editor audio button control it
      // The editor audio controls should be the only way to play sound
    } else {
      // In edit mode, stop the navigation sound but keep editor sound if enabled
      this.stopGlobalSound();

      // Edit mode (whether actively placing or not)
      if (this.editMode) {
        editModeIndicator.style.display = "block";
        if (instructionsContent) {
          instructionsContent.innerHTML =
            '<strong>🎯 PLACING HOTSPOT:</strong><br>• Click anywhere on the 360° image to place<br>• Use mouse to rotate view first if needed<br>• Hotspot will appear with selected type<br><br><strong style="color: #2196F3;">ℹ️ Tip:</strong><br><span style="font-size: 12px;">Position carefully - you can move it later with 📍</span>';
        }
      } else {
        editModeIndicator.style.display = "none";
        if (instructionsContent) {
          instructionsContent.innerHTML =
            '<strong>🛠️ Edit Mode:</strong><br>1. 📝 Select hotspot type (Text/Audio/Portal)<br>2. 🎯 Click "Add Hotspot" to start placing<br>3. 📍 Click on 360° image to position<br>4. Use Edit (📝) to modify content<br>5. Use Move (📍) to reposition<br>6. 🧭 Uncheck "Edit Mode" to navigate<br><br><strong style="color: #4caf50;">💡 Pro Tip:</strong><br><span style="font-size: 12px;">First scene will be the starting point on export!</span>';
        }
      }
    }

    // Update visibility of all in-scene edit buttons
    this.updateInSceneEditButtons();
  }

  updateInSceneEditButtons() {
    // Update all hotspot edit button visibility based on current mode
    document
      .querySelectorAll("#hotspot-container [id^='hotspot-']")
      .forEach((hotspotEl) => {
        if (hotspotEl.updateEditButtonVisibility) {
          hotspotEl.updateEditButtonVisibility();
        }
      });
  }

  async loadCurrentScene() {
    const scene = this.scenes[this.currentScene];
    const skybox = document.getElementById("skybox");
    const sceneEl = document.querySelector("a-scene");

    console.log(`Loading scene: ${this.currentScene}`, scene); // Debug log

    // Clear any existing videosphere
    const existingVideosphere = document.getElementById("videosphere");
    if (existingVideosphere) {
      existingVideosphere.remove();
    }

    // Handle video scenes
  if (scene.type === "video" && scene.videoSrc) {
      console.log("Loading video scene:", scene.videoSrc);
      
      // Hide regular skybox
      skybox.setAttribute("visible", "false");
      
      // Create videosphere
      let videosphere = document.createElement("a-videosphere");
      videosphere.id = "videosphere";
      videosphere.setAttribute("rotation", "0 -90 0"); // Adjust rotation if needed
      sceneEl.appendChild(videosphere);

      // Get or create video element
      let videoEl = document.getElementById("scene-video-dynamic");
      if (!videoEl) {
        videoEl = document.createElement("video");
        videoEl.id = "scene-video-dynamic";
        videoEl.loop = true;
        videoEl.muted = true; // Start muted for autoplay
        videoEl.playsInline = true;
        videoEl.setAttribute("webkit-playsinline", "");
        videoEl.style.display = "none";
        document.querySelector("a-assets").appendChild(videoEl);
      }

      // Decide crossorigin based on source to avoid remote CORS playback errors
      const isRemoteVideoSrc = typeof scene.videoSrc === "string" && (scene.videoSrc.startsWith("http://") || scene.videoSrc.startsWith("https://"));
      if (isRemoteVideoSrc) {
        try { videoEl.removeAttribute("crossorigin"); } catch (_) {}
      } else {
        try { videoEl.setAttribute("crossorigin", "anonymous"); } catch (_) {}
      }

      // Load video source
      if (videoEl.src !== scene.videoSrc) {
        videoEl.src = scene.videoSrc;
        videoEl.load();
      }

      // Set videosphere to use this video
      videosphere.setAttribute("src", "#scene-video-dynamic");

      // Attempt autoplay (fallback to play on first user click)
      const playVideo = () => {
        videoEl.play().catch(err => {
          console.log("Autoplay blocked, waiting for user interaction:", err);
          const playOnClick = () => {
            videoEl.play();
            document.removeEventListener("click", playOnClick);
          };
          document.addEventListener("click", playOnClick, { once: true });
        });
      };

      // Video error handler (missing blob, etc.)
      const onError = () => {
        console.warn("Video failed to load:", scene.videoSrc);
        alert("Failed to load the video for this scene. If it was added from a local file, try re-selecting the file or ensure browser storage permissions allow keeping large files.");
        // Cleanup videosphere and show skybox fallback
        try { videosphere.remove(); } catch(_) {}
        skybox.setAttribute("visible", "true");
        this.hideVideoControls();
      };
      videoEl.addEventListener("error", onError, { once: true });

      // Wait for video metadata and then play
      videoEl.addEventListener("loadedmetadata", () => {
        console.log("Video metadata loaded");
        playVideo();
        this.hideSceneLoadingOverlay();
      }, { once: true });

      // If already loaded, play immediately
      if (videoEl.readyState >= 2) {
        playVideo();
        this.hideSceneLoadingOverlay();
      }

      // Update video controls UI
      this.updateVideoControls(videoEl, scene);

    } else if (scene.type === "video" && !scene.videoSrc) {
      // No valid src (likely after refresh without IDB record) – prompt user to reselect file
      const choose = confirm("This video scene needs the original file again. Do you want to select the video file now?");
      if (choose) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'video/mp4,video/webm';
        input.onchange = async (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          if (!file.type.startsWith('video/')) { alert('Please select a valid MP4/WebM video.'); return; }
          const key = scene.videoStorageKey || this.currentScene;
          await this.saveVideoToIDB(key, file);
          try {
            const url = URL.createObjectURL(file);
            scene.type = 'video';
            scene.videoSrc = url;
            scene.videoStorageKey = key;
            scene.videoFileName = file.name;
            scene.videoVolume = scene.videoVolume || 0.5;
            this.saveScenesData();
            // reload scene now that source is available
            this.switchToScene(this.currentScene);
          } catch (_) {}
        };
        input.click();
      } else {
        // User skipped; fallback to image so editor remains usable
        scene.type = 'image';
        this.saveScenesData();
        this.switchToScene(this.currentScene);
      }
      return;
    } else {
      // Handle image scenes (existing logic)
      // Hide video controls for image scenes
      this.hideVideoControls();

      // Create a unique asset ID for this scene load
      const uniqueId = `panorama-${this.currentScene}-${Date.now()}`;

      // Create a new panorama asset element
      const newPanorama = document.createElement("img");
      newPanorama.id = uniqueId;
      newPanorama.crossOrigin = "anonymous"; // Important for URL images

      // Prefer IndexedDB image if available
      let chosenSrc = null;
      try {
        if (scene.imageStorageKey && (!scene.image || typeof scene.image !== 'string' || scene.image.startsWith('blob:'))) {
          const rec = await this.getImageFromIDB(scene.imageStorageKey);
          if (rec && rec.blob) {
            chosenSrc = URL.createObjectURL(rec.blob);
            scene.image = chosenSrc; // cache blob URL
          }
        }
      } catch(_) { /* ignore */ }

      if (!chosenSrc) {
        // Handle both URL and data URL images
        if (
          typeof scene.image === 'string' && (
            scene.image.startsWith("data:") ||
            scene.image.startsWith("http://") ||
            scene.image.startsWith("https://")
          )
        ) {
          chosenSrc = scene.image;
        } else if (typeof scene.image === 'string' && scene.image.length > 0) {
          // For relative paths, ensure proper formatting
          chosenSrc = scene.image.startsWith("./")
            ? scene.image
            : `./${scene.image}`;
        } else {
          // fallback to default panorama
          chosenSrc = '#main-panorama';
        }
      }
      if (chosenSrc.startsWith && chosenSrc.startsWith('#')) {
        // We'll let skybox use asset id later
        newPanorama.src = document.querySelector(chosenSrc)?.src || '';
      } else {
        newPanorama.src = chosenSrc;
      }

      // Get the assets container and add the new panorama
      const assets = document.querySelector("a-assets");

      // Remove any old panorama assets to prevent memory leaks
      const oldPanoramas = assets.querySelectorAll("img[id^='panorama-']");
      oldPanoramas.forEach((img) => {
        if (img.id !== uniqueId) {
          img.remove();
        }
      });

      assets.appendChild(newPanorama);

      // Set up loading handlers
      newPanorama.onload = () => {
        console.log("New panorama loaded successfully:", scene.image);

        // Temporarily hide skybox to avoid flicker
        skybox.setAttribute("visible", "false");

        // Update skybox to use the new asset
        setTimeout(() => {
          skybox.setAttribute("src", `#${uniqueId}`);
          skybox.setAttribute("visible", "true");

          console.log("Skybox updated with new image");

          // Apply starting point after scene loads
          setTimeout(() => {
            this.applyStartingPoint();
            
            // Hide the loading overlay once scene is ready
            this.hideSceneLoadingOverlay();
          }, 200);
        }, 100);
      };

      newPanorama.onerror = () => {
        console.error("Failed to load panorama:", scene.image);
        alert(
          `Failed to load scene image: ${scene.image}\nPlease check if the URL is accessible and is a valid image.`
        );

        // Fallback to default image
        skybox.setAttribute("src", "#main-panorama");
        skybox.setAttribute("visible", "true");
      };

      // If the image is already cached and complete, trigger onload immediately
      if (newPanorama.complete) {
        newPanorama.onload();
      }
    }

    // Clear existing hotspots
    const container = document.getElementById("hotspot-container");
    container.innerHTML = "";

    // Load hotspots for current scene
    // Ensure hotspots array exists (safety check for loaded templates)
    if (!Array.isArray(scene.hotspots)) {
      scene.hotspots = [];
    }
    this.hotspots = [...scene.hotspots];
    scene.hotspots.forEach((hotspot) => {
      this.createHotspotElement(hotspot);
    });

    // Apply custom styles to ensure portal colors and other customizations are maintained
    this.refreshAllHotspotStyles();

    this.updateHotspotList();
    this.updateStartingPointInfo();
    this.updateInSceneEditButtons(); // Update edit button visibility for new scene
    this.loadGlobalSoundControls();

    // Audio is now controlled ONLY by the editor audio button
    // No auto-play in navigation mode

    // Handle editor sound based on current state (independent of navigation mode)
    setTimeout(() => {
      console.log(
        "🎵 SCENE_LOAD: Timeout triggered, checking editor sound state:",
        this.editorGlobalSoundEnabled
      );
      // Double-check the state in case it changed during the delay
      if (this.editorGlobalSoundEnabled) {
        console.log("🎵 SCENE_LOAD: Enabled - playing editor sound");
        this.playEditorGlobalSound();
      } else {
        console.log("🎵 SCENE_LOAD: Disabled - stopping editor sound");
        // If editor sound is disabled, make sure to stop any playing audio
        this.stopEditorGlobalSound();
      }
    }, 500);

    // Notify listeners that the scene finished loading (for transitions)
    try {
      this._dispatchSceneLoaded && this._dispatchSceneLoaded();
    } catch (e) {
      // no-op
    }
  }

  switchToScene(sceneId) {
    console.log(
      "🏠 SWITCH: Switching from",
      this.currentScene,
      "to",
      sceneId,
      "| Editor sound enabled:",
      this.editorGlobalSoundEnabled
    );
    if (!this.scenes[sceneId]) return;
    this._startCrossfadeOverlay()
      .then(() => {
        // Save current scene hotspots and global sound
        this.scenes[this.currentScene].hotspots = [...this.hotspots];
        this.updateGlobalSound(); // Save current global sound settings
        this.saveScenesData(); // Save when switching scenes

        // Stop current global sound and editor sound
        this.stopGlobalSound();
        this.stopEditorGlobalSound();

        // Switch to new scene
        this.currentScene = sceneId;

        // End overlay when scene reports loaded
        const onLoaded = () => {
          window.removeEventListener("vrhotspots:scene-loaded", onLoaded);
          this._endCrossfadeOverlay();
        };
        window.addEventListener("vrhotspots:scene-loaded", onLoaded, {
          once: true,
        });

        // Safety timeout
        setTimeout(() => {
          window.removeEventListener("vrhotspots:scene-loaded", onLoaded);
          this._endCrossfadeOverlay();
        }, 1500);

        this.loadCurrentScene();
        this.updateNavigationTargets();
      })
      .catch(() => {
        // Fallback to direct switch
        this.scenes[this.currentScene].hotspots = [...this.hotspots];
        this.updateGlobalSound();
        this.saveScenesData();
        this.stopGlobalSound();
        this.stopEditorGlobalSound();
        this.currentScene = sceneId;
        this.loadCurrentScene();
        this.updateNavigationTargets();
      });
  }

  navigateToScene(sceneId) {
    if (!this.scenes[sceneId]) return;

    // Update the dropdown to reflect the change
    document.getElementById("current-scene").value = sceneId;
    this.switchToScene(sceneId);

    // Show a brief navigation indicator
    this.showNavigationFeedback(this.scenes[sceneId].name);
  }

  showNavigationFeedback(sceneName) {
    const feedback = document.createElement("div");
    feedback.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: rgba(76, 175, 80, 0.9); color: white; padding: 15px 25px;
      border-radius: 8px; font-weight: bold; z-index: 10001;
      font-family: Arial; animation: fadeInOut 2s ease-in-out;
    `;
    feedback.innerHTML = `Navigated to: ${sceneName}`;

    // Add CSS animation
    const style = document.createElement("style");
    style.textContent = `
      @keyframes fadeInOut {
        0% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
        20% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        80% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
      }
    `;
    document.head.appendChild(style);

    document.body.appendChild(feedback);
    setTimeout(() => {
      if (feedback.parentNode) {
        feedback.parentNode.removeChild(feedback);
      }
      if (style.parentNode) {
        style.parentNode.removeChild(style);
      }
    }, 2000);
  }

  promptForSceneImageChange() {
    // Check if scene1 (first scene) is using the default image
    const scene1 = this.scenes.scene1;
    const defaultImages = [
      "./images/scene1.jpg",
      "images/scene1.jpg",
      "/images/scene1.jpg"
    ];
    
    // Skip prompt if scene1 doesn't exist
    if (!scene1) return;

    // Skip prompt if scene1 is already a video with a URL or local source
    if (scene1.type === "video" && scene1.videoSrc) {
      console.log("ℹ️ Scene 1 already uses a video source, skipping prompt");
      return;
    }

    // Only prompt if scene1 uses the default image
    if (!defaultImages.includes(scene1.image)) {
      console.log("ℹ️ Scene 1 has custom image, skipping prompt");
      return;
    }

    // Show prompt dialog (with a re-check right before rendering to avoid race conditions)
    setTimeout(() => {
      // Re-check current state in case scene1 changed to video or custom image meanwhile
      const recheck = this.scenes.scene1;
      if (!recheck) return;
      if (recheck.type === "video" && recheck.videoSrc) {
        console.log("ℹ️ Skipping welcome prompt: scene1 is video now");
        return;
      }
      if (!defaultImages.includes(recheck.image)) {
        console.log("ℹ️ Skipping welcome prompt: scene1 image customized");
        return;
      }
      const dialog = document.createElement("div");
      dialog.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.85); z-index: 100000; display: flex;
        align-items: center; justify-content: center; font-family: Arial;
        animation: fadeIn 0.3s ease-in;
      `;

      dialog.innerHTML = `
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; border-radius: 16px; color: white; max-width: 500px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); text-align: center;">
          <div style="font-size: 48px; margin-bottom: 20px;">🎬</div>
          <h2 style="margin: 0 0 15px 0; font-size: 28px; font-weight: bold;">Welcome to VR Hotspot Editor!</h2>
          <p style="color: #f0f0f0; margin-bottom: 25px; font-size: 16px; line-height: 1.6;">
            You're currently using the default scene media. Would you like to change it to your own 360° image or 360° video?
          </p>
          
          <div style="display: flex; gap: 15px; justify-content: center; flex-wrap: wrap;">
            <button id="change-scene-image-btn" style="
              background: white; color: #667eea; border: none; padding: 15px 30px;
              border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: bold;
              box-shadow: 0 4px 12px rgba(0,0,0,0.2); transition: transform 0.2s;
            " onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
              📁 Change Image
            </button>
            <button id="change-scene-video-btn" style="
              background: #9C27B0; color: white; border: none; padding: 15px 30px;
              border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: bold;
              box-shadow: 0 4px 12px rgba(0,0,0,0.2); transition: transform 0.2s;
            " onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
              🎥 Use Video File
            </button>
            <button id="change-scene-video-url-btn" style="
              background: #673AB7; color: white; border: none; padding: 15px 30px;
              border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: bold;
              box-shadow: 0 4px 12px rgba(0,0,0,0.2); transition: transform 0.2s;
            " onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
              🔗 Use Video URL
            </button>
            
            <button id="keep-default-btn" style="
              background: rgba(255,255,255,0.2); color: white; border: 2px solid white; padding: 15px 30px;
              border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: bold;
              backdrop-filter: blur(10px); transition: all 0.2s;
            " onmouseover="this.style.background='rgba(255,255,255,0.3)'" onmouseout="this.style.background='rgba(255,255,255,0.2)'">
              ✨ Keep Default
            </button>
          </div>
          
          <p style="color: rgba(255,255,255,0.7); margin-top: 20px; font-size: 13px;">
            💡 You can always change it later from the Scene Manager
          </p>
        </div>
      `;

      // Add animation keyframes
      if (!document.getElementById("prompt-animation-style")) {
        const style = document.createElement("style");
        style.id = "prompt-animation-style";
        style.textContent = `
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
        `;
        document.head.appendChild(style);
      }

      document.body.appendChild(dialog);

      // Change Image button
      document.getElementById("change-scene-image-btn").onclick = () => {
        document.body.removeChild(dialog);
        this.editSceneImage("scene1");
      };

      const videoBtn = document.getElementById("change-scene-video-btn");
      if (videoBtn) {
        videoBtn.onclick = () => {
          document.body.removeChild(dialog);
          // Reuse the addSceneVideoFromFile flow but apply to scene1
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'video/mp4,video/webm';
          input.onchange = async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            if (!file.type.startsWith('video/')) { alert('Please select a valid MP4/WebM video.'); return; }
            const storageKey = 'video_scene1';
            await this.saveVideoToIDB(storageKey, file);
            const url = URL.createObjectURL(file);
            const sc = this.scenes.scene1 || {};
            sc.type = 'video';
            sc.videoSrc = url;
            sc.videoStorageKey = storageKey;
            sc.videoFileName = file.name;
            sc.videoVolume = 0.5;
            this.scenes.scene1 = sc;
            this.saveScenesData();
            this.switchToScene('scene1');
          };
          input.click();
        };
      }

      const videoUrlBtn = document.getElementById("change-scene-video-url-btn");
      if (videoUrlBtn) {
        videoUrlBtn.onclick = async () => {
          document.body.removeChild(dialog);
          const url = prompt(
            `Enter the URL of the 360° video for "${(this.scenes.scene1 && this.scenes.scene1.name) || "Scene 1"}":\n(Direct link to MP4/WebM file)`,
            (this.scenes.scene1 && this.scenes.scene1.videoSrc && this.scenes.scene1.videoSrc.startsWith("http") ? this.scenes.scene1.videoSrc : "https://")
          );
          if (!url || url === "https://") return;
          try { new URL(url); } catch (_) { alert("Please enter a valid URL"); return; }

          const sc = this.scenes.scene1 || {};
          sc.type = 'video';
          sc.videoSrc = url;
          sc.videoFileName = url.split('/').pop();
          sc.videoVolume = sc.videoVolume || 0.5;
          this.scenes.scene1 = sc;
          this.saveScenesData();

          // Auto-download to local with loader and then switch scene
          await this.autoDownloadRemoteVideo('scene1', url);
          this.switchToScene('scene1');
        };
      }

      // Keep Default button
      document.getElementById("keep-default-btn").onclick = () => {
        document.body.removeChild(dialog);
      };
    }, 1000); // Delay by 1 second to let the scene load first
  }

  addNewScene() {
    const name = prompt("Enter scene name:");
    if (!name) return;

    // Show dialog for choosing between file upload or URL
    const dialog = document.createElement("div");
    dialog.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
      background: rgba(0,0,0,0.8); z-index: 10000; display: flex; 
      align-items: center; justify-content: center; font-family: Arial;
    `;

    dialog.innerHTML = `
      <div style="background: #2a2a2a; padding: 30px; border-radius: 10px; color: white; max-width: 550px;">
        <h3 style="margin-top: 0; color: #4CAF50;">Add New Scene</h3>
        <p>Choose media type for "${name}":</p>
        
        <!-- Media Type Selection -->
        <div style="margin: 20px 0;">
          <label style="display: block; margin-bottom: 8px; font-weight: bold; color: #4CAF50;">
            Media Type:
          </label>
          <select id="new-scene-media-type" style="
            width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #555;
            background: #333; color: white; font-size: 14px; cursor: pointer;
          ">
            <option value="image">🖼️ 360° Image</option>
            <option value="video">🎥 360° Video</option>
          </select>
        </div>

        <!-- Image Options -->
        <div id="new-scene-image-options" style="display: block;">
          <div style="margin: 15px 0;">
            <button id="upload-image-file-new" style="
              background: #4CAF50; color: white; border: none; padding: 12px 20px;
              border-radius: 6px; cursor: pointer; width: 100%; font-size: 14px; font-weight: bold;
            ">📁 Upload Image File</button>
            <div style="font-size: 11px; color: #999; margin-top: 5px; text-align: center;">
              Upload a 360° image from your computer
            </div>
          </div>
          <div style="margin: 15px 0;">
            <button id="use-image-url-new" style="
              background: #2196F3; color: white; border: none; padding: 12px 20px;
              border-radius: 6px; cursor: pointer; width: 100%; font-size: 14px; font-weight: bold;
            ">🌐 Use Image URL</button>
            <div style="font-size: 11px; color: #999; margin-top: 5px; text-align: center;">
              Use an image from the internet
            </div>
          </div>
        </div>

        <!-- Video Options -->
        <div id="new-scene-video-options" style="display: none;">
          <div style="margin: 15px 0;">
            <button id="upload-video-file-new" style="
              background: #9C27B0; color: white; border: none; padding: 12px 20px;
              border-radius: 6px; cursor: pointer; width: 100%; font-size: 14px; font-weight: bold;
            ">� Upload Video File</button>
            <div style="font-size: 11px; color: #999; margin-top: 5px; text-align: center;">
              MP4/WebM • 360° equirectangular format
            </div>
          </div>
          <div style="margin: 15px 0;">
            <button id="use-video-url-new" style="
              background: #673AB7; color: white; border: none; padding: 12px 20px;
              border-radius: 6px; cursor: pointer; width: 100%; font-size: 14px; font-weight: bold;
            ">🔗 Use Video URL</button>
            <div style="font-size: 11px; color: #999; margin-top: 5px; text-align: center;">
              Direct link to MP4/WebM file
            </div>
          </div>
        </div>
        
        <button id="cancel-scene" style="
          background: #666; color: white; border: none; padding: 10px 20px;
          border-radius: 4px; cursor: pointer; margin-top: 10px; width: 100%; font-weight: bold;
        ">Cancel</button>
      </div>
    `;

    document.body.appendChild(dialog);

    // Media type toggle
    dialog.querySelector("#new-scene-media-type").addEventListener("change", (e) => {
      const isVideo = e.target.value === "video";
      dialog.querySelector("#new-scene-image-options").style.display = isVideo ? "none" : "block";
      dialog.querySelector("#new-scene-video-options").style.display = isVideo ? "block" : "none";
    });

    // Image upload from file
    document.getElementById("upload-image-file-new").onclick = () => {
      document.body.removeChild(dialog);
      this.addSceneFromFile(name);
    };

    // Image from URL
    document.getElementById("use-image-url-new").onclick = () => {
      document.body.removeChild(dialog);
      this.addSceneFromURL(name);
    };

    // Video upload from file
    document.getElementById("upload-video-file-new").onclick = () => {
      document.body.removeChild(dialog);
      this.addSceneVideoFromFile(name);
    };

    // Video from URL
    document.getElementById("use-video-url-new").onclick = () => {
      document.body.removeChild(dialog);
      this.addSceneVideoFromURL(name);
    };

    document.getElementById("cancel-scene").onclick = () => {
      document.body.removeChild(dialog);
    };
  }

  addSceneFromFile(name) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";

    input.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;

      (async () => {
        try {
          const sceneId = `scene_${Date.now()}`;
          const storageKey = `image_scene_${sceneId}`;
          const saved = await this.saveImageToIDB(storageKey, file);
          if (!saved) {
            alert("Failed to save image locally.");
            return;
          }
          const blobURL = URL.createObjectURL(file);
          this.scenes[sceneId] = {
            name: name,
            type: "image",
            image: blobURL, // runtime blob URL; not persisted in localStorage
            imageStorageKey: storageKey,
            imageFileName: file.name,
            videoSrc: null,
            videoVolume: 0.5,
            hotspots: [],
            startingPoint: null,
            globalSound: null,
          };

          this.finalizeNewScene(sceneId, name);
        } catch (err) {
          console.error("Failed to create scene from file", err);
          alert("Failed to add scene image.");
        }
      })();
    });

    input.click();
  }

  addSceneFromURL(name) {
    const url = prompt(
      "Enter the URL of the 360° image:\n(Make sure it's a direct link to an image file)",
      "https://"
    );
    if (!url || url === "https://") return;

    // Validate URL format
    try {
      new URL(url);
    } catch (e) {
      alert("Please enter a valid URL");
      return;
    }

    // Show loading indicator
    this.showLoadingIndicator("Loading image from URL...");

    // Test if the image loads
    const testImg = new Image();
    testImg.crossOrigin = "anonymous";

    testImg.onload = () => {
      const sceneId = `scene_${Date.now()}`;
      this.scenes[sceneId] = {
        name: name,
        type: "image",
        image: url, // Use URL directly for online images
        videoSrc: null,
        videoVolume: 0.5,
        hotspots: [],
        startingPoint: null,
        globalSound: null,
      };

      // Hide loading indicator
      this.hideLoadingIndicator();

      this.finalizeNewScene(sceneId, name);
    };

    testImg.onerror = () => {
      // Hide loading indicator
      this.hideLoadingIndicator();

      alert(
        "Failed to load image from URL. Please check:\n1. The URL is correct\n2. The image exists\n3. The server allows cross-origin requests"
      );
    };

    testImg.src = url;
  }

  addSceneVideoFromFile(name) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/mp4,video/webm";

    input.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;

      // Validate file type
      if (!file.type.startsWith("video/")) {
        alert("Please select a valid video file (MP4 or WebM).");
        return;
      }

      // Warn if file is large
      if (file.size > 200 * 1024 * 1024) {
        if (!confirm("Warning: This video is very large (>200MB). This may cause slow loading. Continue?")) {
          return;
        }
      }

  const sceneId = `scene_${Date.now()}`;
  // Save file in IndexedDB for persistence across refreshes
  const storageKey = `video_${sceneId}`;
  this.saveVideoToIDB(storageKey, file);

  // Create object URL for immediate playback
  const videoURL = URL.createObjectURL(file);
      this.scenes[sceneId] = {
        name: name,
        type: "video",
        image: "./images/scene1.jpg", // Placeholder image
        videoSrc: videoURL,
  videoStorageKey: storageKey,
        videoFileName: file.name,
        videoVolume: 0.5,
        hotspots: [],
        startingPoint: null,
        globalSound: null,
      };

      this.finalizeNewScene(sceneId, name);
    });

    input.click();
  }

  async addSceneVideoFromURL(name) {
    const url = prompt(
      "Enter the URL of the 360° video:\n(Direct link to MP4/WebM file)",
      "https://"
    );
    if (!url || url === "https://") return;

    // Validate URL format
    try {
      new URL(url);
    } catch (e) {
      alert("Please enter a valid URL");
      return;
    }

    const sceneId = `scene_${Date.now()}`;
    this.scenes[sceneId] = {
      name: name,
      type: "video",
      image: "./images/scene1.jpg", // Placeholder image
      videoSrc: url,
      videoFileName: url.split("/").pop(),
      videoVolume: 0.5,
      hotspots: [],
      startingPoint: null,
      globalSound: null,
    };

    // Automatically download remote video to local storage
    await this.autoDownloadRemoteVideo(sceneId, url);

    this.finalizeNewScene(sceneId, name);
  }

  finalizeNewScene(sceneId, name) {
    this.updateSceneDropdown();
    this.updateNavigationTargets();

    // Save the new scene data
    this.saveScenesData();

    // Switch to new scene with a small delay to ensure UI is updated
    setTimeout(() => {
      document.getElementById("current-scene").value = sceneId;
      this.switchToScene(sceneId);
      alert(`Scene "${name}" added successfully!`);
    }, 100);
  }

  showSceneManager() {
    const dialog = document.createElement("div");
    dialog.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
      background: rgba(0,0,0,0.8); z-index: 10000; display: flex; 
      align-items: center; justify-content: center; font-family: Arial;
    `;

    let sceneListHTML = "";
    Object.keys(this.scenes).forEach((sceneId) => {
      const scene = this.scenes[sceneId];
      const hotspotCount = scene.hotspots.length;
      const sceneType = scene.type === "video" ? "🎥 Video" : "🖼️ Image";
      const isRemoteVideo = scene.type === "video" && scene.videoSrc && (scene.videoSrc.startsWith("http://") || scene.videoSrc.startsWith("https://"));
      const isLocalVideo = scene.type === "video" && scene.videoSrc && scene.videoSrc.startsWith("blob:");
      const isHttp = typeof scene.image === "string" && (scene.image.startsWith("http://") || scene.image.startsWith("https://"));
      const isData = typeof scene.image === "string" && scene.image.startsWith("data:");
      const isBlob = typeof scene.image === "string" && scene.image.startsWith("blob:");
      const hasIDB = !!scene.imageStorageKey;
      const imageSource = scene.type === "video" 
        ? (scene.videoSrc ? (isRemoteVideo ? "Remote URL" : isLocalVideo ? "Local (IDB)" : "File") : "None")
        : ((hasIDB || isBlob) ? "Local (IDB)" : isHttp ? "Online" : isData ? "Uploaded" : "File");
      
      sceneListHTML += `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px; margin: 5px 0; background: #333; border-radius: 6px;">
          <div style="flex: 1;">
            <strong>${scene.name}</strong><br>
            <small style="color: #ccc;">${hotspotCount} hotspot(s) • ${sceneType} (${imageSource})</small>
          </div>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <button onclick="window.hotspotEditor.editSceneMedia('${sceneId}')" style="
              background: #2196F3; color: white; border: none; padding: 6px 12px;
              border-radius: 4px; cursor: pointer; font-size: 12px;" title="Change scene media">
              ${scene.type === "video" ? "🎥" : "🖼️"} Edit Media
            </button>
            <button onclick="window.hotspotEditor.deleteScene('${sceneId}')" style="
              background: #f44336; color: white; border: none; padding: 6px 12px;
              border-radius: 4px; cursor: pointer; font-size: 12px;" title="${
                sceneId === "scene1"
                  ? "Cannot delete default scene - click to edit instead"
                  : "Delete this scene"
              }">
              🗑️ Delete
            </button>
          </div>
        </div>
      `;
    });

    dialog.innerHTML = `
      <div style="background: #2a2a2a; padding: 30px; border-radius: 10px; color: white; max-width: 600px; max-height: 80vh; overflow-y: auto;">
        <h3 style="margin-top: 0; color: #4CAF50;">🎬 Scene Manager</h3>
        <p style="margin: 0 0 20px; color: #ccc; font-size: 14px;">Manage your 360° scenes and images</p>
        <div style="margin: 20px 0;">
          ${sceneListHTML}
        </div>
        <button onclick="this.parentElement.parentElement.remove()" style="
          background: #666; color: white; border: none; padding: 12px 20px;
          border-radius: 6px; cursor: pointer; width: 100%; font-weight: bold;
        ">Close Manager</button>
      </div>
    `;

    document.body.appendChild(dialog);
  }

  editSceneImage(sceneId) {
    const scene = this.scenes[sceneId];
    if (!scene) return;

    // Close current scene manager
    document.querySelectorAll("div").forEach((div) => {
      if (div.style.position === "fixed" && div.style.zIndex === "10000") {
        div.remove();
      }
    });

    const dialog = document.createElement("div");
    dialog.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
      background: rgba(0,0,0,0.8); z-index: 10000; display: flex; 
      align-items: center; justify-content: center; font-family: Arial;
    `;

    dialog.innerHTML = `
      <div style="background: #2a2a2a; padding: 30px; border-radius: 10px; color: white; max-width: 500px;">
        <h3 style="margin-top: 0; color: #4CAF50;">🖼️ Change Scene Image</h3>
        <p style="color: #ccc;">Update the 360° image for "${scene.name}":</p>
        
        <div style="margin: 20px 0;">
          <button id="upload-new-file" style="
            background: #4CAF50; color: white; border: none; padding: 15px 25px;
            border-radius: 6px; cursor: pointer; margin: 5px; width: 200px;
            font-size: 14px; font-weight: bold;
          ">📁 Upload New Image</button>
          <div style="font-size: 12px; color: #ccc; margin-left: 5px;">
            Upload a new image from your computer
          </div>
        </div>
        
        <div style="margin: 20px 0;">
          <button id="use-new-url" style="
            background: #2196F3; color: white; border: none; padding: 15px 25px;
            border-radius: 6px; cursor: pointer; margin: 5px; width: 200px;
            font-size: 14px; font-weight: bold;
          ">🌐 Use Image URL</button>
          <div style="font-size: 12px; color: #ccc; margin-left: 5px;">
            Use an image from the internet
          </div>
        </div>
        
        <div style="display: flex; gap: 8px; margin-top: 20px;">
          <button id="cancel-edit" style="
            background: #666; color: white; border: none; padding: 10px 20px;
            border-radius: 4px; cursor: pointer; flex: 1;
          ">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    const close = () => {
      if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
      // Reopen scene manager
      setTimeout(() => this.showSceneManager(), 100);
    };

    dialog.querySelector("#cancel-edit").onclick = close;

    dialog.querySelector("#upload-new-file").onclick = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        (async () => {
          try {
            // Persist image in IDB
            const storageKey = scene.imageStorageKey || `image_scene_${sceneId}`;
            const saved = await this.saveImageToIDB(storageKey, file);
            if (saved) {
              const blobURL = URL.createObjectURL(file);
              scene.type = 'image';
              scene.imageStorageKey = storageKey;
              scene.imageFileName = file.name;
              scene.image = blobURL; // immediate use
              scene.videoSrc = null;
              this.saveScenesData();
              if (sceneId === this.currentScene) {
                this.loadCurrentScene();
              }
              close();
              this.showStartingPointFeedback(`Updated image for "${scene.name}"`);
            } else {
              alert('Failed to save image locally.');
            }
          } catch (err) {
            console.error('Failed to store image', err);
            alert('Failed to store image.');
          }
        })();
      };
      input.click();
    };

    dialog.querySelector("#use-new-url").onclick = () => {
      const url = prompt(
        `Enter the URL of the new 360° image for "${scene.name}":\n(Make sure it's a direct link to an image file)`,
        scene.image.startsWith("http") ? scene.image : "https://"
      );
      if (!url || url === "https://") return;

      try {
        new URL(url);
      } catch (e) {
        alert("Please enter a valid URL");
        return;
      }

      // Show loading indicator
      this.showLoadingIndicator("Loading new image...");

      const testImg = new Image();
      testImg.crossOrigin = "anonymous";
      testImg.onload = () => {
        scene.image = url;
        delete scene.imageStorageKey;
        delete scene.imageFileName;
        this.saveScenesData(); // Save to localStorage
        if (sceneId === this.currentScene) {
          this.loadCurrentScene();
        }

        // Hide loading indicator
        this.hideLoadingIndicator();

        close();
        this.showStartingPointFeedback(`Updated image for "${scene.name}"`);
      };
      testImg.onerror = () => {
        // Hide loading indicator
        this.hideLoadingIndicator();

        alert(
          "Failed to load image from URL. Please check the URL is correct and accessible."
        );
      };
      testImg.src = url;
    };
  }

  editSceneMedia(sceneId) {
    const scene = this.scenes[sceneId];
    if (!scene) return;

    // Close current scene manager
    document.querySelectorAll("div").forEach((div) => {
      if (div.style.position === "fixed" && div.style.zIndex === "10000") {
        div.remove();
      }
    });

    const dialog = document.createElement("div");
    dialog.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
      background: rgba(0,0,0,0.8); z-index: 10000; display: flex; 
      align-items: center; justify-content: center; font-family: Arial;
    `;

    dialog.innerHTML = `
      <div style="background: #2a2a2a; padding: 30px; border-radius: 10px; color: white; max-width: 550px;">
        <h3 style="margin-top: 0; color: #4CAF50;">🎬 Change Scene Media</h3>
        <p style="color: #ccc;">Update "${scene.name}" with image or video:</p>
        
        <!-- Media Type Selection -->
        <div style="margin: 20px 0;">
          <label style="display: block; margin-bottom: 8px; font-weight: bold; color: #4CAF50;">
            Media Type:
          </label>
          <select id="media-type-select" style="
            width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #555;
            background: #333; color: white; font-size: 14px; cursor: pointer;
          ">
            <option value="image" ${scene.type !== "video" ? "selected" : ""}>🖼️ 360° Image</option>
            <option value="video" ${scene.type === "video" ? "selected" : ""}>🎥 360° Video</option>
          </select>
        </div>

        <!-- Image Upload Options -->
        <div id="image-options" style="display: ${scene.type === "video" ? "none" : "block"};">
          <div style="margin: 15px 0;">
            <button id="upload-image-file" style="
              background: #4CAF50; color: white; border: none; padding: 12px 20px;
              border-radius: 6px; cursor: pointer; width: 100%; font-size: 14px; font-weight: bold;
            ">📁 Upload Image File</button>
          </div>
          <div style="margin: 15px 0;">
            <button id="use-image-url" style="
              background: #2196F3; color: white; border: none; padding: 12px 20px;
              border-radius: 6px; cursor: pointer; width: 100%; font-size: 14px; font-weight: bold;
            ">🌐 Use Image URL</button>
          </div>
        </div>

        <!-- Video Upload Options -->
        <div id="video-options" style="display: ${scene.type === "video" ? "block" : "none"};">
          <div style="margin: 15px 0;">
            <button id="upload-video-file" style="
              background: #9C27B0; color: white; border: none; padding: 12px 20px;
              border-radius: 6px; cursor: pointer; width: 100%; font-size: 14px; font-weight: bold;
            ">🎥 Upload Video File</button>
            <div style="font-size: 11px; color: #999; margin-top: 5px; text-align: center;">
              MP4/WebM • 360° equirectangular format
            </div>
          </div>
          <div style="margin: 15px 0;">
            <button id="use-video-url" style="
              background: #673AB7; color: white; border: none; padding: 12px 20px;
              border-radius: 6px; cursor: pointer; width: 100%; font-size: 14px; font-weight: bold;
            ">🔗 Use Video URL</button>
          </div>
        </div>
        
        <div style="display: flex; gap: 8px; margin-top: 25px;">
          <button id="cancel-edit-media" style="
            background: #666; color: white; border: none; padding: 10px 20px;
            border-radius: 4px; cursor: pointer; flex: 1; font-weight: bold;
          ">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    const close = () => {
      if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
      setTimeout(() => this.showSceneManager(), 100);
    };

    // Media type toggle
    dialog.querySelector("#media-type-select").addEventListener("change", (e) => {
      const isVideo = e.target.value === "video";
      dialog.querySelector("#image-options").style.display = isVideo ? "none" : "block";
      dialog.querySelector("#video-options").style.display = isVideo ? "block" : "none";
    });

    dialog.querySelector("#cancel-edit-media").onclick = close;

    // Image upload from file
    dialog.querySelector("#upload-image-file").onclick = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        (async () => {
          try {
            const storageKey = scene.imageStorageKey || `image_scene_${sceneId}`;
            const saved = await this.saveImageToIDB(storageKey, file);
            if (saved) {
              const blobURL = URL.createObjectURL(file);
              scene.type = 'image';
              scene.imageStorageKey = storageKey;
              scene.imageFileName = file.name;
              scene.image = blobURL;
              scene.videoSrc = null;
              this.saveScenesData();
              if (sceneId === this.currentScene) {
                this.loadCurrentScene();
              }
              close();
              this.showStartingPointFeedback(`Updated to image for "${scene.name}"`);
            } else {
              alert('Failed to save image locally.');
            }
          } catch (err) {
            console.error('Failed to store image', err);
            alert('Failed to store image.');
          }
        })();
      };
      input.click();
    };

    // Image from URL
    dialog.querySelector("#use-image-url").onclick = () => {
      const url = prompt(
        `Enter the URL of the 360° image for "${scene.name}":\n(Make sure it's a direct link to an image file)`,
        scene.image && scene.image.startsWith("http") ? scene.image : "https://"
      );
      if (!url || url === "https://") return;

      try {
        new URL(url);
      } catch (e) {
        alert("Please enter a valid URL");
        return;
      }

      this.showLoadingIndicator("Loading image...");

      const testImg = new Image();
      testImg.crossOrigin = "anonymous";
      testImg.onload = () => {
        scene.type = "image";
        scene.image = url;
        scene.videoSrc = null;
        delete scene.imageStorageKey;
        delete scene.imageFileName;
        this.saveScenesData();
        if (sceneId === this.currentScene) {
          this.loadCurrentScene();
        }
        this.hideLoadingIndicator();
        close();
        this.showStartingPointFeedback(`Updated to image for "${scene.name}"`);
      };
      testImg.onerror = () => {
        this.hideLoadingIndicator();
        alert("Failed to load image from URL. Please check the URL and try again.");
      };
      testImg.src = url;
    };

    // Video upload from file
    dialog.querySelector("#upload-video-file").onclick = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "video/mp4,video/webm";
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Validate file type - check both MIME type and extension
        const validVideoTypes = ["video/mp4", "video/webm"];
        const validExtensions = [".mp4", ".webm"];
        const fileExtension = file.name.toLowerCase().substring(file.name.lastIndexOf("."));
        
        if (!file.type.startsWith("video/") || !validVideoTypes.includes(file.type.toLowerCase())) {
          alert("❌ Can't be selected as it is not a video file.\n\nPlease select a valid video file (MP4 or WebM only).");
          return;
        }

        if (!validExtensions.includes(fileExtension)) {
          alert("❌ Can't be selected as it is not a video file.\n\nOnly MP4 and WebM formats are supported.");
          return;
        }

        // Warn if file is large
        if (file.size > 200 * 1024 * 1024) {
          if (!confirm("Warning: This video is very large (>200MB). This may cause slow loading. Continue?")) {
            return;
          }
        }

        // Create object URL for the video
        const videoURL = URL.createObjectURL(file);

        scene.type = "video";
        scene.videoSrc = videoURL;
        scene.videoFileName = file.name;
        scene.videoVolume = scene.videoVolume || 0.5;
        this.saveScenesData();

        if (sceneId === this.currentScene) {
          this.loadCurrentScene();
        }

        close();
        this.showStartingPointFeedback(`Video "${file.name}" loaded successfully!`);
      };
      input.click();
    };

    // Video from URL
    dialog.querySelector("#use-video-url").onclick = async () => {
      const url = prompt(
        `Enter the URL of the 360° video for "${scene.name}":\n(Direct link to MP4/WebM file)`,
        scene.videoSrc && scene.videoSrc.startsWith("http") ? scene.videoSrc : "https://"
      );
      if (!url || url === "https://") return;

      try {
        new URL(url);
      } catch (e) {
        alert("Please enter a valid URL");
        return;
      }

      // Validate URL extension
      const urlLower = url.toLowerCase();
      const validVideoExtensions = [".mp4", ".webm"];
      const hasValidExtension = validVideoExtensions.some(ext => urlLower.includes(ext));
      
      if (!hasValidExtension) {
        alert("❌ Can't be loaded as it is not a video file.\n\nURL must point to an MP4 or WebM file.\n\nExample: https://example.com/video.mp4");
        return;
      }

      // Additional check: warn if URL looks like audio
      const audioExtensions = [".mp3", ".wav", ".ogg", ".m4a", ".aac"];
      const looksLikeAudio = audioExtensions.some(ext => urlLower.includes(ext));
      
      if (looksLikeAudio) {
        alert("❌ Can't be loaded as it is not a video file.\n\nThis URL appears to be an audio file (MP3, WAV, etc.).\n\nPlease provide a video URL (MP4 or WebM).");
        return;
      }

      // Try to verify content type via HEAD request (optional, may fail due to CORS)
      try {
        this.showLoadingIndicator("Verifying video URL...");
        const response = await fetch(url, { method: "HEAD" });
        const contentType = response.headers.get("content-type");
        
        if (contentType && !contentType.startsWith("video/")) {
          this.hideLoadingIndicator();
          alert(`❌ Can't be loaded as it is not a video file.\n\nServer reports content type: ${contentType}\n\nOnly video/mp4 and video/webm are supported.`);
          return;
        }
        this.hideLoadingIndicator();
      } catch (e) {
        // CORS or network error - continue anyway (user might have valid URL)
        this.hideLoadingIndicator();
        console.warn("Could not verify content type (CORS?), proceeding anyway:", e);
      }

      // Set to video with temporary remote URL, then auto-download to local
      scene.type = "video";
      scene.videoSrc = url;
      scene.videoFileName = url.split("/").pop();
      scene.videoVolume = scene.videoVolume || 0.5;
      this.saveScenesData();

      // Begin auto-download with loader
      await this.autoDownloadRemoteVideo(sceneId, url);

      if (sceneId === this.currentScene) {
        this.loadCurrentScene();
      }

      close();
      this.showStartingPointFeedback(`Video URL set for "${scene.name}"`);
    };
  }

  deleteScene(sceneId) {
    if (sceneId === "scene1") {
      // Show a styled popup explaining they can't delete but can edit
      const dialog = document.createElement("div");
      dialog.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.85); z-index: 100000; display: flex;
        align-items: center; justify-content: center; font-family: Arial;
        animation: fadeIn 0.3s ease-in;
      `;

      dialog.innerHTML = `
        <div style="background: linear-gradient(135deg, #f44336 0%, #e91e63 100%); padding: 40px; border-radius: 16px; color: white; max-width: 500px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); text-align: center;">
          <div style="font-size: 48px; margin-bottom: 20px;">🚫</div>
          <h2 style="margin: 0 0 15px 0; font-size: 28px; font-weight: bold;">Cannot Delete Scene 1</h2>
          <p style="color: #f0f0f0; margin-bottom: 25px; font-size: 16px; line-height: 1.6;">
            Scene 1 is the default scene and cannot be deleted.<br>
            However, you can <strong>edit its image</strong> to customize it!
          </p>
          
          <div style="display: flex; gap: 15px; justify-content: center; flex-wrap: wrap;">
            <button id="edit-scene1-image-btn" style="
              background: white; color: #f44336; border: none; padding: 15px 30px;
              border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: bold;
              box-shadow: 0 4px 12px rgba(0,0,0,0.2); transition: transform 0.2s;
            " onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
              🖼️ Edit Scene 1 Image
            </button>
            
            <button id="close-delete-warning-btn" style="
              background: rgba(255,255,255,0.2); color: white; border: 2px solid white; padding: 15px 30px;
              border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: bold;
              backdrop-filter: blur(10px); transition: all 0.2s;
            " onmouseover="this.style.background='rgba(255,255,255,0.3)'" onmouseout="this.style.background='rgba(255,255,255,0.2)'">
              ✓ Got It
            </button>
          </div>
        </div>
      `;

      // Add animation keyframes if not already present
      if (!document.getElementById("prompt-animation-style")) {
        const style = document.createElement("style");
        style.id = "prompt-animation-style";
        style.textContent = `
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
        `;
        document.head.appendChild(style);
      }

      document.body.appendChild(dialog);

      // Edit Image button - close this dialog and open edit scene image
      document.getElementById("edit-scene1-image-btn").onclick = () => {
        document.body.removeChild(dialog);
        this.editSceneImage("scene1");
      };

      // Close button
      document.getElementById("close-delete-warning-btn").onclick = () => {
        document.body.removeChild(dialog);
      };

      return;
    }

    if (!confirm(`Delete scene "${this.scenes[sceneId].name}"?`)) return;

    delete this.scenes[sceneId];

    // Track if we switched scenes
    let switchedScenes = false;

    // If we're currently on the deleted scene, switch to scene1 first
    if (this.currentScene === sceneId) {
      this.currentScene = "scene1";
      document.getElementById("current-scene").value = "scene1";
      this.loadCurrentScene();
      switchedScenes = true;
    }

    // Clean up navigation hotspots that pointed to the deleted scene (after scene switch)
    this.cleanupOrphanedNavigationHotspots();

    // If we didn't switch scenes, refresh the current scene to remove stale portals
    if (!switchedScenes) {
      console.log(
        "🔄 Refreshing current scene to remove stale navigation portals"
      );
      this.loadCurrentScene();
    }

    this.updateSceneDropdown();
    this.updateNavigationTargets();

    // Close and reopen scene manager to refresh the list
    document.querySelectorAll("div").forEach((div) => {
      if (div.style.position === "fixed" && div.style.zIndex === "10000") {
        div.remove();
      }
    });
    this.showSceneManager();
  }
}

// Modified spot component for editor
AFRAME.registerComponent("editor-spot", {
  schema: {
    label: { type: "string", default: "" },
    audio: { type: "string", default: "" },
    labelBackground: { type: "color", default: "#333333" },
    labelPadding: { type: "number", default: 0.2 },
    popup: { type: "string", default: "" },
    popupWidth: { type: "number", default: 3 },
    popupHeight: { type: "number", default: 2 },
    popupColor: { type: "color", default: "#333333" },
    navigation: { type: "string", default: "" },
    imageSrc: { type: "string", default: "" },
    imageScale: { type: "number", default: 1 },
    imageAspectRatio: { type: "number", default: 0 },
  },

  init: function () {
    const data = this.data;
    const el = this.el;

  // Don't override the src - let createHotspotElement set the appropriate icon
    el.setAttribute("class", "clickable");

    // Add highlight animation
    el.setAttribute("animation__highlight", {
      property: "scale",
      from: "1 1 1",
      to: "1.5 1.5 1.5",
      dur: 500,
      easing: "easeInOutQuad",
      startEvents: "highlight",
      autoplay: false,
      loop: 2,
      dir: "alternate",
    });

    // REMOVED: Main element hover animations to prevent inheritance by popup children

    /******************  STATIC IMAGE  ******************/
    if (data.imageSrc) {
      const img = document.createElement("a-image");
      let _src = data.imageSrc;
      if (_src && _src.includes("%")) {
        try {
          _src = decodeURIComponent(_src);
        } catch (e) {}
      }
      img.setAttribute("src", _src);
      img.setAttribute("crossorigin", "anonymous");
      if (!img.getAttribute("material"))
        img.setAttribute("material", "transparent:true; side:double");
      const scl = data.imageScale || 1;
      // Unit base geometry; scale for size to reduce texture rebuild flicker
      // Use any persisted aspect ratio immediately to avoid square flash
      const knownAR =
        typeof data.imageAspectRatio === "number" &&
        isFinite(data.imageAspectRatio) &&
        data.imageAspectRatio > 0
          ? data.imageAspectRatio
          : typeof data._aspectRatio === "number" &&
            isFinite(data._aspectRatio) &&
            data._aspectRatio > 0
          ? data._aspectRatio
          : null;
      const initAR =
        typeof knownAR === "number" && isFinite(knownAR) && knownAR > 0
          ? knownAR
          : 1;
      if (initAR !== 1) img.dataset.aspectRatio = String(initAR);
      img.setAttribute("width", 1);
      img.setAttribute("height", initAR);
      img.setAttribute("scale", `${scl} ${scl} 1`);
      img.setAttribute("position", `0 ${(initAR / 2) * scl} 0.05`);
      try {
        console.log(
          `[ImageHotspot][Init] id=${
            el.id
          } knownAR=${knownAR} initAR=${initAR} scale=${scl} -> w=1 h=${initAR} y=${
            (initAR / 2) * scl
          }`
        );
      } catch (_) {}
      img.classList.add("static-image-hotspot");
      // Apply global image styles if available
      const editor = window.hotspotEditor;
      if (editor && editor.customStyles && editor.customStyles.image) {
        const istyle = editor.customStyles.image;
        const opacity =
          typeof istyle.opacity === "number" ? istyle.opacity : 1.0;
        img.setAttribute(
          "material",
          `opacity: ${opacity}; transparent: ${
            opacity < 1 ? "true" : "false"
          }; side: double`
        );
        // Border: only add frame if no rounding (runtime also relies on masking for rounded). Rounding decided later when mask runs.
        const numericRadius = parseFloat(istyle.borderRadius) || 0;
        if (numericRadius === 0 && istyle.borderWidth > 0) {
          const frame = document.createElement("a-plane");
          frame.setAttribute("width", 1 * scl + istyle.borderWidth * 2);
          frame.setAttribute("height", 1 * scl + istyle.borderWidth * 2); // temporary until ratio known
          frame.setAttribute("position", `0 ${0.5 * scl} 0.0`);
          frame.setAttribute(
            "material",
            `shader:flat; color:${
              istyle.borderColor || "#FFFFFF"
            }; opacity:${opacity}; transparent:${
              opacity < 1 ? "true" : "false"
            }; side: double`
          );
          frame.classList.add("static-image-border");
          el.appendChild(frame);
          img.setAttribute("position", `0 ${0.5 * scl} 0.05`); // bring image forward
          try {
            console.log(
              `[ImageHotspot][FrameInit] id=${
                el.id
              } temporary frame size -> w=${
                1 * scl + istyle.borderWidth * 2
              } h=${1 * scl + istyle.borderWidth * 2}`
            );
          } catch (_) {}
        }
      }
      img.addEventListener("load", () => {
        try {
          const nW = img.naturalWidth || 0;
          const nH = img.naturalHeight || 0;
          const ratio =
            nH && nW ? nH / nW : parseFloat(img.dataset.aspectRatio || "") || 1;
          try {
            console.log(
              `[ImageHotspot][Load] id=${el.id} natural=${nW}x${nH} ratio=${ratio} scale=${scl}`
            );
          } catch (_) {}
          if (ratio && isFinite(ratio) && ratio > 0) {
            // persist on model and dataset
            try {
              const editor = window.hotspotEditor;
              const compData = this.data || data;
              const idStr = this.el && this.el.id ? this.el.id : "";
              const id = idStr.startsWith("hotspot-")
                ? parseInt(idStr.slice(8), 10)
                : NaN;
              if (editor && !isNaN(id))
                editor._persistImageAspectRatio(id, ratio);
            } catch (_) {}
            img.dataset.aspectRatio = String(ratio);
          }
          img.setAttribute("width", 1);
          img.setAttribute("height", ratio);
          img.setAttribute("scale", `${scl} ${scl} 1`);
          img.setAttribute("position", `0 ${(ratio / 2) * scl} 0.05`);
          try {
            console.log(
              `[ImageHotspot][Load-Apply] id=${el.id} -> w=1 h=${ratio} y=${
                (ratio / 2) * scl
              }`
            );
          } catch (_) {}
          const frame = el.querySelector(".static-image-border");
          if (frame) {
            const editor2 = window.hotspotEditor;
            const istyle2 = editor2?.customStyles?.image;
            const bw = istyle2?.borderWidth || 0.02;
            frame.setAttribute("width", 1 * scl + bw * 2);
            frame.setAttribute("height", ratio * scl + bw * 2);
            frame.setAttribute("position", `0 ${(ratio / 2) * scl} 0.0`);
          }
        } catch (e) {}
      });
      // Also wait for A-Frame texture to be ready (some drivers fill later)
      const onTex = () => {
        try {
          const mesh = img.getObject3D("mesh");
          const texImg =
            mesh &&
            mesh.material &&
            mesh.material.map &&
            mesh.material.map.image;
          const nW = texImg?.naturalWidth || texImg?.width || 0;
          const nH = texImg?.naturalHeight || texImg?.height || 0;
          const ratio = nW > 0 && nH > 0 ? nH / nW : 0;
          if (ratio && isFinite(ratio) && ratio > 0) {
            img.dataset.aspectRatio = String(ratio);
            img.setAttribute("width", 1);
            img.setAttribute("height", ratio);
            img.setAttribute("position", `0 ${(ratio / 2) * scl} 0.05`);
            console.log(
              `[ImageHotspot][TexReady] id=${el.id} tex=${nW}x${nH} ratio=${ratio} -> w=1 h=${ratio}`
            );
            // persist
            try {
              const idStr = el.id || "";
              const id = idStr.startsWith("hotspot-")
                ? parseInt(idStr.slice(8), 10)
                : NaN;
              if (!isNaN(id) && window.hotspotEditor)
                window.hotspotEditor._persistImageAspectRatio(id, ratio);
            } catch (_) {}
          }
        } catch (_) {}
      };
      img.addEventListener("materialtextureloaded", onTex, { once: true });
      // Polling fallback in case event is missed
      setTimeout(() => {
        try {
          onTex();
        } catch (_) {}
      }, 250);
      setTimeout(() => {
        try {
          onTex();
        } catch (_) {}
      }, 800);
      el.appendChild(img);
    }

    /******************  POPUP  ******************/
    if (data.popup) {
      // Get custom styles from the editor instance
      const editor = window.hotspotEditor;
      const styles = editor ? editor.customStyles : null;

      /* info icon */
      const infoIcon = document.createElement("a-entity");
      // Create circular info icon instead of banner
      const iconSize = styles ? styles.hotspot.infoButton.size : 0.4;
      infoIcon.setAttribute(
        "geometry",
        "primitive: circle; radius: " + iconSize
      );

      // Use custom styles if available
      const infoBgColor = styles
        ? styles.hotspot.infoButton.backgroundColor
        : "#4A90E2";
      const infoTextColor = styles
        ? styles.hotspot.infoButton.textColor
        : "#FFFFFF";
      const infoOpacity = styles ? styles.hotspot.infoButton.opacity : 0.9;
      const infoFontSize = styles ? styles.hotspot.infoButton.fontSize : 12;

      infoIcon.setAttribute(
        "material",
        "color: " + infoBgColor + "; opacity: " + infoOpacity
      );
      infoIcon.setAttribute(
        "text",
        "value: i; align: center; color: " +
          infoTextColor +
          "; width: " +
          infoFontSize +
          "; font: roboto"
      );
      infoIcon.setAttribute("position", "0 0.8 0");
      infoIcon.classList.add("clickable");
      // Add hover animations specifically to info icon only (not inherited by popup)
      infoIcon.setAttribute("animation__hover_in", {
        property: "scale",
        to: "1.1 1.1 1",
        dur: 200,
        easing: "easeOutQuad",
        startEvents: "mouseenter",
      });

      infoIcon.setAttribute("animation__hover_out", {
        property: "scale",
        to: "1 1 1",
        dur: 200,
        easing: "easeOutQuad",
        startEvents: "mouseleave",
      });
      el.appendChild(infoIcon);

      /* popup container */
      const popup = document.createElement("a-entity");
      popup.setAttribute("visible", "false");
      popup.classList.add("popup-container");
      // Move popup significantly forward on z-axis to avoid z-fighting with info icon
      popup.setAttribute("position", "0 1.5 0.2");
      popup.setAttribute("look-at", "#cam");
      // REMOVED: Popup scale animations to prevent conflicts with close button interactions

      /* background */
      const background = document.createElement("a-plane");

      // Use custom styles if available
      const popupBgColor = styles
        ? styles.hotspot.popup.backgroundColor
        : data.popupColor;
      const popupOpacity = styles ? styles.hotspot.popup.opacity : 1;

      background.setAttribute("color", popupBgColor);
      background.setAttribute("opacity", popupOpacity);
      background.setAttribute("width", data.popupWidth);
      background.setAttribute("height", data.popupHeight);
      background.classList.add("popup-bg");
      popup.appendChild(background);

      /* text */
      const text = document.createElement("a-text");

      // Use custom text color if available
      const popupTextColor = styles ? styles.hotspot.popup.textColor : "white";

      text.setAttribute("value", data.popup);
      text.setAttribute("wrap-count", Math.floor(data.popupWidth * 8)); // Dynamic wrap based on popup width
      text.setAttribute("color", popupTextColor);
      text.setAttribute("position", "0 0 0.05"); // Increased z-spacing to prevent z-fighting
      text.setAttribute("align", "center");
      text.setAttribute("width", (data.popupWidth - 0.4).toString()); // Constrain to popup width with padding
      text.setAttribute("font", "roboto");
      text.classList.add("popup-text");
      popup.appendChild(text);

      /* close button */
      const closeButton = document.createElement("a-image");
      const margin = 0.3;
      closeButton.setAttribute(
        "position",
        `${data.popupWidth / 2 - margin} ${data.popupHeight / 2 - margin} 0.1` // Increased z-spacing
      );
      closeButton.setAttribute("src", "#close");
      closeButton.setAttribute("width", "0.4");
      closeButton.setAttribute("height", "0.4");
      closeButton.classList.add("clickable");
      closeButton.classList.add("popup-close");

      // Add hover animations to close button for better UX
      closeButton.setAttribute("animation__hover_in", {
        property: "scale",
        to: "1.2 1.2 1",
        dur: 200,
        easing: "easeOutQuad",
        startEvents: "mouseenter",
      });

      closeButton.setAttribute("animation__hover_out", {
        property: "scale",
        to: "1 1 1",
        dur: 200,
        easing: "easeOutQuad",
        startEvents: "mouseleave",
      });

      popup.appendChild(closeButton);

      /* event wiring */
      infoIcon.addEventListener("click", function (e) {
        e.stopPropagation();
        popup.setAttribute("visible", true);
        infoIcon.setAttribute("visible", false); // Hide info icon when popup is open
      });

      // REMOVED: Close button hover animations to prevent conflicts with popup scaling
      closeButton.addEventListener("click", (e) => {
        e.stopPropagation();
        popup.setAttribute("visible", false);
        infoIcon.setAttribute("visible", true); // Show info icon when popup is closed
      });

      el.appendChild(popup);
    }

    /******************  AUDIO  ******************/
    if (data.audio) {
      const audioEl = document.createElement("a-sound");
      // Stabilize blob/data audio by routing through <a-assets>
      let initSrc = data.audio;
      if (typeof initSrc === "string" && (initSrc.startsWith("blob:") || initSrc.startsWith("data:"))) {
        try {
          const assets = document.querySelector('a-assets') || (function(){
            const scn = document.querySelector('a-scene') || document.querySelector('scene, a-scene');
            const a = document.createElement('a-assets');
            if (scn) scn.insertBefore(a, scn.firstChild);
            return a;
          })();
          const assetId = "audio_ed_" + (el.id || ("el_" + Math.random().toString(36).slice(2)));
          let assetEl = assets.querySelector("#" + assetId);
          if (!assetEl) {
            assetEl = document.createElement('audio');
            assetEl.setAttribute('id', assetId);
            assetEl.setAttribute('crossorigin', 'anonymous');
            assets.appendChild(assetEl);
          }
          assetEl.setAttribute('src', initSrc);
          initSrc = "#" + assetId;
        } catch(_) { /* ignore, fallback to direct */ }
      }
      audioEl.setAttribute("src", initSrc);
      audioEl.setAttribute("autoplay", "false");
      audioEl.setAttribute("loop", "true");
      el.appendChild(audioEl);

      const btn = document.createElement("a-image");
      btn.setAttribute("class", "clickable audio-control");

      // Use custom styles if available
      const editor = window.hotspotEditor;
      const styles = editor ? editor.customStyles : null;
      const playImage = styles?.buttonImages?.play || "#play";
      const pauseImage = styles?.buttonImages?.pause || "#pause";
      btn.setAttribute("src", playImage);

      const buttonColor = styles ? styles.audio.buttonColor : "#FFFFFF";
      const buttonOpacity = styles ? styles.audio.buttonOpacity : 1.0;

      btn.setAttribute("width", "0.5");
      btn.setAttribute("height", "0.5");
      btn.setAttribute("material", `color: ${buttonColor}`);
      btn.setAttribute("opacity", buttonOpacity.toString());
      // Position the audio control near the hotspot center
      btn.setAttribute("position", "0 0 0.02");
      el.appendChild(btn);

      let audioReady = false;
      let isPlaying = false;

      const toggleAudio = () => {
        if (!audioReady) return;

        if (isPlaying) {
          audioEl.components.sound.stopSound();
          btn.emit("fadeout");
          setTimeout(() => {
            btn.setAttribute("src", playImage);
            btn.emit("fadein");
          }, 200);
        } else {
          audioEl.components.sound.playSound();
          btn.emit("fadeout");
          setTimeout(() => {
            btn.setAttribute("src", pauseImage);
            btn.emit("fadein");
          }, 200);
        }

        isPlaying = !isPlaying;
      };

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!audioEl.components.sound) return;
        toggleAudio();
      });

      btn.addEventListener("triggerdown", (e) => {
        e.stopPropagation();
        if (!audioEl.components.sound) return;
        toggleAudio();
      });

      btn.setAttribute("animation__hover_in", {
        property: "scale",
        to: "1.2 1.2 1",
        dur: 200,
        easing: "easeOutQuad",
        startEvents: "mouseenter",
      });

      btn.setAttribute("animation__hover_out", {
        property: "scale",
        to: "1 1 1",
        dur: 200,
        easing: "easeOutQuad",
        startEvents: "mouseleave",
      });

      btn.setAttribute("animation__fadeout", {
        property: "material.opacity",
        to: 0,
        dur: 200,
        easing: "easeInQuad",
        startEvents: "fadeout",
      });

      btn.setAttribute("animation__fadein", {
        property: "material.opacity",
        to: 1,
        dur: 200,
        easing: "easeOutQuad",
        startEvents: "fadein",
      });

      audioEl.addEventListener("sound-loaded", () => {
        audioReady = true;
        audioEl.components.sound.stopSound();
      });
    }

    /******************  NAVIGATION  ******************/
    if (data.navigation) {
      // Ensure no rotation/pulse is applied to the entire hotspot entity
      // so in‑scene Edit/Move controls don't inherit rotations.
      try {
        el.removeAttribute("animation__portal_rotate");
        el.removeAttribute("animation__portal_pulse");
      } catch (_) {}

      // Apply a subtle pulse only to the visible ring for feedback
      const ringEl = el.querySelector(".nav-ring");
      if (ringEl) {
        ringEl.setAttribute("animation__pulse", {
          property: "scale",
          from: "1 1 1",
          to: "1.03 1.03 1",
          dur: 1200,
          dir: "alternate",
          loop: true,
          easing: "easeInOutSine",
        });
      }
    }
  },
});

// Student submission functionality
class StudentSubmission {
  static showSubmissionDialog() {
    const dialog = document.createElement("div");
    dialog.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
      background: rgba(0,0,0,0.8); z-index: 10000; display: flex; 
      align-items: center; justify-content: center; font-family: Arial;
    `;

    dialog.innerHTML = `
      <div style="background: #2a2a2a; padding: 30px; border-radius: 10px; color: white; max-width: 500px;">
        <h3 style="margin-top: 0; color: #4CAF50;">📤 Submit Your VR Project</h3>
        <p style="color: #ccc;">Submit your VR hotspot project to the admin:</p>
        
        <div style="margin: 20px 0;">
          <label style="display: block; margin-bottom: 5px; color: #ccc;">Student Name:</label>
          <input type="text" id="student-name" style="
            width: 100%; padding: 10px; border: 1px solid #555; 
            background: #333; color: white; border-radius: 4px;
          " placeholder="Enter your full name">
        </div>
        
        <div style="margin: 25px 0; text-align: center;">
          <button id="submit-project-btn" style="
            background: #4CAF50; color: white; border: none; padding: 15px 25px;
            border-radius: 6px; cursor: pointer; margin: 5px; font-weight: bold;
          ">📤 Submit Project</button>
          <button id="cancel-submission-btn" style="
            background: #666; color: white; border: none; padding: 15px 25px;
            border-radius: 6px; cursor: pointer; margin: 5px;
          ">Cancel</button>
        </div>
        
        <div id="submission-status" style="margin-top: 20px; text-align: center;"></div>
      </div>
    `;

    document.body.appendChild(dialog);

    // Add event listeners
    document
      .getElementById("submit-project-btn")
      .addEventListener("click", () => {
        StudentSubmission.submitProject(
          document.getElementById("student-name").value
        );
      });

    document
      .getElementById("cancel-submission-btn")
      .addEventListener("click", () => {
        dialog.remove();
      });
  }

  static async submitProject(studentName) {
    if (!studentName || !studentName.trim()) {
      alert("Please enter your name!");
      return;
    }

    const statusDiv = document.getElementById("submission-status");
    statusDiv.innerHTML =
      '<p style="color: #4CAF50;">📦 Generating project...</p>';

    try {
      // Generate the complete project using existing export functionality
      if (!window.hotspotEditor) {
        throw new Error("Editor not initialized");
      }

      // Create a simple project name from student name and timestamp
      const projectName = `${studentName.replace(
        /[^a-zA-Z0-9]/g,
        "_"
      )}_VR_Project`;

      // Create the project zip using the existing method
      const JSZip = window.JSZip || (await window.hotspotEditor.loadJSZip());
      const zip = new JSZip();

      // Get current skybox image
      const skyboxImg = document.querySelector("#main-panorama");
      const skyboxSrc = skyboxImg ? skyboxImg.src : "";

      // Add files to zip using existing method
      await window.hotspotEditor.addFilesToZip(zip, projectName, skyboxSrc);

      // Generate blob
      const content = await zip.generateAsync({ type: "blob" });

      // Create form data
      const formData = new FormData();
      formData.append("project", content, `${projectName}.zip`);
      formData.append("studentName", studentName);
      formData.append("projectName", projectName);

      statusDiv.innerHTML =
        '<p style="color: #4CAF50;">📤 Submitting to server...</p>';

      // Submit to server
      const response = await fetch("/submit-project", {
        method: "POST",
        body: formData,
      });

      const result = await response.json();

      if (result.success) {
        statusDiv.innerHTML = `
          <p style="color: #4CAF50;">✅ Project submitted successfully!</p>
          <p style="color: #ccc; font-size: 0.9em;">File: ${result.fileName}</p>
          <button id="close-submission-dialog" style="
            background: #4CAF50; color: white; border: none; padding: 10px 20px;
            border-radius: 4px; cursor: pointer; margin-top: 10px;
          ">Close</button>
        `;

        // Add event listener for the close button
        document
          .getElementById("close-submission-dialog")
          .addEventListener("click", function () {
            // Find and remove the submission dialog
            const dialog = this.closest('[style*="position: fixed"]');
            if (dialog) dialog.remove();
          });
      } else {
        throw new Error(result.message || "Submission failed");
      }
    } catch (error) {
      console.error("Submission error:", error);
      statusDiv.innerHTML = `
        <p style="color: #f44336;">❌ Submission failed</p>
        <p style="color: #ccc; font-size: 0.9em;">${error.message}</p>
        <p style="color: #ccc; font-size: 0.8em;">Make sure the server is running!</p>
      `;
    }
  }
}

// Clear localStorage function
async function clearLocalStorage() {
  try {
    // Clear VR Hotspots specific data from localStorage
    localStorage.removeItem("vr-hotspot-scenes-data");
    localStorage.removeItem("vr-hotspot-css-styles");
    console.log("✅ Cleared VR Hotspots localStorage data");

    // Also clear IndexedDB stores for videos, images and audio
    try {
      if (window.hotspotEditor && typeof window.hotspotEditor.clearAllVideosFromIDB === 'function') {
        await window.hotspotEditor.clearAllVideosFromIDB();
      }
      if (window.hotspotEditor && typeof window.hotspotEditor.clearAllImagesFromIDB === 'function') {
        await window.hotspotEditor.clearAllImagesFromIDB();
      }
      if (window.hotspotEditor && typeof window.hotspotEditor.clearAllAudiosFromIDB === 'function') {
        await window.hotspotEditor.clearAllAudiosFromIDB();
      }
      console.log("✅ Cleared IndexedDB videos, images, and audio");
    } catch (e) {
      console.warn("Warning: Failed to clear some IndexedDB stores", e);
    }

    // Show notification to user
    alert("Data cleared! The page will reload with fresh data.");
    window.location.reload();
  } catch (error) {
    console.error("Failed to clear localStorage:", error);
  }
}

// Initialize the editor when the page loads
document.addEventListener("DOMContentLoaded", () => {
  // Wait for A-Frame to be ready
  setTimeout(() => {
    window.hotspotEditor = new HotspotEditor();
  }, 1000);
});
