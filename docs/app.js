(function () {
  "use strict";

  // ===== DOM References =====
  var startScreen = document.getElementById("startScreen");
  var startBtn = document.getElementById("startBtn");
  var cameraScreen = document.getElementById("cameraScreen");
  var cameraVideo = document.getElementById("cameraVideo");
  var previewCanvas = document.getElementById("previewCanvas");
  var ctx = previewCanvas.getContext("2d");
  var viewport = document.getElementById("viewport");
  var horizonRect = document.getElementById("horizonRect");
  var focusSquare = document.getElementById("focusSquare");
  var modeLabel = document.getElementById("modeLabel");
  var recIndicator = document.getElementById("recIndicator");
  var recordBtn = document.getElementById("recordBtn");
  var recordBtnInner = document.getElementById("recordBtnInner");
  var thumbBtn = document.getElementById("thumbBtn");
  var thumbContent = document.getElementById("thumbContent");
  var galleryBtn = document.getElementById("galleryBtn");
  var normalBtn = document.getElementById("normalBtn");
  var actionBtn = document.getElementById("actionBtn");
  var toggleKnob = document.getElementById("toggleKnob");
  var galleryScreen = document.getElementById("galleryScreen");
  var galleryBack = document.getElementById("galleryBack");
  var galleryGrid = document.getElementById("galleryGrid");
  var galleryEmpty = document.getElementById("galleryEmpty");
  var playbackScreen = document.getElementById("playbackScreen");
  var playbackClose = document.getElementById("playbackClose");
  var playbackVideo = document.getElementById("playbackVideo");
  var downloadLink = document.getElementById("downloadLink");
  var flipBtn = document.getElementById("flipBtn");

  // ===== State =====
  var actionMode = false;
  var isRecording = false;
  var mediaRecorder = null;
  var recordedChunks = [];
  var recordings = []; // Array of { blob, url, date, mode }
  var stream = null;
  var animFrameId = null;
  var motionStarted = false;
  var currentFacingMode = "environment";

  // ===== Motion State (ported from MotionManager.swift) =====
  var roll = 0;
  var offsetX = 0;
  var offsetY = 0;
  var previousRawRoll = 0;
  var rollUnwrapped = 0;
  var velX = 0;
  var velY = 0;

  // Tuning constants — matching iOS app exactly
  var DT = 1 / 60; // Web typically runs at 60Hz
  var VELOCITY_DECAY = 0.82;
  var POSITION_DECAY = 0.992;
  var SENSITIVITY = 0.035;
  var ACCEL_DEAD_ZONE = 0.02;

  // Screen orientation tracking
  var prevScreenAngle = 0;

  // Smoothing (from CameraManager.swift)
  var smoothedRoll = 0;
  var smoothedNormX = 0;
  var smoothedNormY = 0;
  var ROLL_SMOOTHING = 0.25;
  var TRANSLATION_SMOOTHING = 0.10;

  // Crop geometry (from CameraManager.swift cropFraction).
  // 3/5 = base crop ratio within the sensor, × 0.90 leaves 10% extra buffer = 0.54.
  var CROP_FRACTION = (3 / 5) * 0.90;
  var CROP_ASPECT_W = 3;
  var CROP_ASPECT_H = 4;

  // ===== Start Button =====
  startBtn.addEventListener("click", function () {
    initCamera();
  });

  // ===== Camera Flip =====
  flipBtn.addEventListener("click", function () {
    switchCamera();
  });

  // ===== Camera Initialisation =====
  function initCamera(facingMode) {
    facingMode = facingMode || "environment";

    // Stop any active recording before tearing down the stream
    if (isRecording) stopRecording();

    // Stop existing stream tracks when switching cameras
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }

    // Only request motion permission on first launch
    var motionPromise = motionStarted ? Promise.resolve() : requestMotionPermission();

    motionPromise
      .then(function () {
        return navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1920 },
            height: { ideal: 1440 }
          },
          audio: true
        });
      })
      .then(function (mediaStream) {
        stream = mediaStream;
        currentFacingMode = facingMode;

        // Show camera screen BEFORE attaching the stream.
        // iOS/iPadOS Safari shows a black frame if the video element
        // sits inside a hidden container when srcObject is first set.
        startScreen.style.display = "none";
        cameraScreen.style.display = "flex";

        cameraVideo.srcObject = stream;

        return cameraVideo.play().catch(function (e) {
          // AbortError can fire when play() is interrupted by a new call
          if (e.name !== "AbortError") throw e;
        });
      })
      .then(function () {
        startMotionTracking();
        if (!animFrameId) startRenderLoop();
      })
      .catch(function (err) {
        console.error("Init error:", err);
        var msg = "Could not start camera.";
        if (err.name === "NotAllowedError") {
          msg = "Camera permission denied. Please allow camera access and reload.";
        } else if (err.name === "NotFoundError") {
          msg = "No camera found on this device.";
        }
        alert(msg);
      });
  }

  function switchCamera() {
    var newMode = currentFacingMode === "environment" ? "user" : "environment";
    initCamera(newMode);
  }

  // ===== Motion Permission (iOS requires explicit permission request) =====
  function requestMotionPermission() {
    if (
      typeof DeviceMotionEvent !== "undefined" &&
      typeof DeviceMotionEvent.requestPermission === "function"
    ) {
      return DeviceMotionEvent.requestPermission().then(function (state) {
        if (state !== "granted") {
          // Camera still works without motion — stabilisation is simply unavailable
          console.warn("Motion permission not granted — Action Mode stabilisation will be unavailable");
        }
      }).catch(function (err) {
        console.warn("Motion permission request failed:", err);
      });
    }
    return Promise.resolve();
  }

  // ===== Screen orientation helper =====
  function getScreenAngleRad() {
    if (typeof window.orientation === "number") {
      return window.orientation * Math.PI / 180;
    }
    if (screen.orientation && typeof screen.orientation.angle === "number") {
      var a = screen.orientation.angle;
      if (a > 180) a -= 360; // 270 → -90
      return a * Math.PI / 180;
    }
    return 0;
  }

  // ===== Motion Tracking (ported from MotionManager.swift) =====
  function startMotionTracking() {
    if (motionStarted) return;
    motionStarted = true;

    prevScreenAngle = getScreenAngleRad();

    // DeviceMotion gives us both gravity (for roll) and acceleration (for translation)
    window.addEventListener("devicemotion", handleMotion, true);

    // Reset roll state when screen orientation changes
    var onOrientationChange = function () {
      prevScreenAngle = getScreenAngleRad();
      previousRawRoll = 0;
      rollUnwrapped = 0;
      roll = 0;
      smoothedRoll = 0;
    };
    window.addEventListener("orientationchange", onOrientationChange, false);
    if (screen.orientation) {
      screen.orientation.addEventListener("change", onOrientationChange, false);
    }
  }

  function handleMotion(e) {
    var aig = e.accelerationIncludingGravity;
    var acc = e.acceleration;

    // ── Roll from gravity (replaces DeviceOrientation for full 360°) ──
    // Derive gravity vector: accelerationIncludingGravity minus user acceleration
    var gx = 0;
    var gy = 0;
    if (aig && aig.x != null && aig.y != null) {
      if (acc && acc.x != null && acc.y != null) {
        gx = aig.x - acc.x;
        gy = aig.y - acc.y;
      } else {
        gx = aig.x;
        gy = aig.y;
      }
    }

    // Only update roll if gravity signal is strong enough
    var gMag = Math.sqrt(gx * gx + gy * gy);
    if (gMag > 0.5) {
      // roll = atan2(gravity.x, -gravity.y) — matches iOS CoreMotion
      var rawRoll = Math.atan2(gx, -gy);

      // Adjust for current screen orientation so stabilisation is
      // relative to the screen, not absolute device portrait.
      var screenAngle = getScreenAngleRad();
      rawRoll -= screenAngle;

      // Normalize to (-π, π]
      while (rawRoll > Math.PI) rawRoll -= 2 * Math.PI;
      while (rawRoll < -Math.PI) rawRoll += 2 * Math.PI;

      // Continuous unwrapping (from MotionManager.swift)
      var delta = rawRoll - previousRawRoll;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      previousRawRoll = rawRoll;
      rollUnwrapped += delta;
      roll = rollUnwrapped;
    }

    // ── Translation (X/Y shift from user acceleration) ──
    var ax = 0;
    var ay = 0;

    if (acc && acc.x != null) {
      ax = acc.x;
      ay = acc.y;
    }

    // Dead-zone
    if (Math.abs(ax) < ACCEL_DEAD_ZONE) ax = 0;
    if (Math.abs(ay) < ACCEL_DEAD_ZONE) ay = 0;

    // Use event interval if available for more accurate integration
    var dt = (e.interval ? e.interval / 1000 : DT);
    if (dt <= 0 || dt > 0.1) dt = DT;

    // Integrate acceleration → velocity, then decay
    velX = (velX + ax * dt) * VELOCITY_DECAY;
    velY = (velY + ay * dt) * VELOCITY_DECAY;

    // Integrate velocity → offset, then decay toward centre
    offsetX = (offsetX - velX * SENSITIVITY) * POSITION_DECAY;
    offsetY = (offsetY - velY * SENSITIVITY) * POSITION_DECAY;

    // Clamp to ±1
    offsetX = Math.max(-1, Math.min(1, offsetX));
    offsetY = Math.max(-1, Math.min(1, offsetY));
  }

  // ===== Render Loop =====
  function startRenderLoop() {
    function render() {
      animFrameId = requestAnimationFrame(render);

      if (!cameraVideo.videoWidth) return;

      if (actionMode) {
        renderActionMode();
      }
      // Normal mode: the <video> element shows itself directly
    }
    animFrameId = requestAnimationFrame(render);
  }

  // ===== Action Mode Rendering (ported from CameraManager.processVideoFrame) =====
  function renderActionMode() {
    var vw = cameraVideo.videoWidth;
    var vh = cameraVideo.videoHeight;
    if (!vw || !vh) return;

    // Apply smoothing
    smoothedRoll += ROLL_SMOOTHING * (roll - smoothedRoll);
    smoothedNormX += TRANSLATION_SMOOTHING * (offsetX - smoothedNormX);
    smoothedNormY += TRANSLATION_SMOOTHING * (offsetY - smoothedNormY);

    // Compute crop dimensions
    var shorter = Math.min(vw, vh);
    var cropW = shorter * CROP_FRACTION;
    var cropH = cropW * (CROP_ASPECT_H / CROP_ASPECT_W);

    // Set canvas size to match crop
    if (previewCanvas.width !== Math.round(cropW) || previewCanvas.height !== Math.round(cropH)) {
      previewCanvas.width = Math.round(cropW);
      previewCanvas.height = Math.round(cropH);
    }

    var angle = -smoothedRoll;
    var cx = vw / 2;
    var cy = vh / 2;

    // Compute translation shift in rotated coordinates
    var cosA = Math.cos(angle);
    var sinA = Math.sin(angle);
    var marginX = Math.max(0, (vw - cropW) / 2);
    var marginY = Math.max(0, (vh - cropH) / 2);
    var rotNormX = smoothedNormX * cosA - smoothedNormY * sinA;
    var rotNormY = smoothedNormX * sinA + smoothedNormY * cosA;
    var shiftX = rotNormX * marginX * 0.9;
    var shiftY = rotNormY * marginY * 0.9;

    // Draw stabilised crop
    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    ctx.save();

    // Translate to centre of crop output
    ctx.translate(previewCanvas.width / 2, previewCanvas.height / 2);

    // The source centre after rotation and shift
    var srcCX = cx + shiftX;
    var srcCY = cy - shiftY;

    // Rotate the source around the crop centre
    ctx.rotate(angle);

    // Draw the video centred at the source location
    // drawImage(source, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
    ctx.drawImage(
      cameraVideo,
      srcCX - vw / 2, srcCY - vh / 2, vw, vh, // source rect
      -vw / 2, -vh / 2, vw, vh                 // destination rect
    );

    ctx.restore();
  }

  // ===== Horizon Rectangle Overlay (ported from HorizonRectangleView.swift) =====
  function updateHorizonRect() {
    if (!actionMode) {
      horizonRect.style.display = "none";
      return;
    }

    var vpW = viewport.clientWidth;
    var vpH = viewport.clientHeight;

    var rectW = Math.min(vpW, vpH) * (3 / 5) * 0.90;
    var rectH = rectW * (4 / 3);

    var angle = -roll; // Counter-rotate so rectangle stays upright

    var marginX = (vpW - rectW) / 2;
    var marginY = (vpH - rectH) / 2;
    var shiftX = offsetX * marginX * 0.9;
    var shiftY = offsetY * marginY * 0.9;

    horizonRect.style.display = "block";
    horizonRect.style.width = rectW + "px";
    horizonRect.style.height = rectH + "px";
    horizonRect.style.left = (vpW / 2 - rectW / 2 + shiftX) + "px";
    horizonRect.style.top = (vpH / 2 - rectH / 2 - shiftY) + "px";
    horizonRect.style.transform = "rotate(" + angle + "rad)";
  }

  // ===== Mode Toggle =====
  function setMode(mode) {
    actionMode = mode === "action";

    if (actionMode) {
      cameraScreen.classList.add("action-mode");
      toggleKnob.classList.add("action");
      normalBtn.classList.remove("active");
      actionBtn.classList.add("active");
      modeLabel.textContent = "Action Mode — Horizon Lock";
      horizonRect.style.display = "none";
    } else {
      cameraScreen.classList.remove("action-mode");
      toggleKnob.classList.remove("action");
      normalBtn.classList.add("active");
      actionBtn.classList.remove("active");
      modeLabel.textContent = "Normal Mode";
      horizonRect.style.display = "none";

      // Reset smoothing
      smoothedRoll = 0;
      smoothedNormX = 0;
      smoothedNormY = 0;
    }
  }

  normalBtn.addEventListener("click", function () { setMode("normal"); });
  actionBtn.addEventListener("click", function () { setMode("action"); });

  // ===== Recording =====
  recordBtn.addEventListener("click", function () {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  function startRecording() {
    if (!stream) return;

    recordedChunks = [];

    var source;
    if (actionMode) {
      // Record from canvas in action mode
      source = previewCanvas.captureStream(30);
      // Add audio tracks from the camera stream
      var audioTracks = stream.getAudioTracks();
      audioTracks.forEach(function (track) {
        source.addTrack(track);
      });
    } else {
      // Record camera stream directly in normal mode
      source = stream;
    }

    // Try video/webm first, fall back to video/mp4
    var mimeType = "video/webm;codecs=vp9,opus";
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = "video/webm;codecs=vp8,opus";
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = "video/webm";
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = "video/mp4";
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = "";
    }

    try {
      var options = { mimeType: mimeType };
      if (!mimeType) options = {};
      mediaRecorder = new MediaRecorder(source, options);
    } catch (err) {
      console.error("MediaRecorder error:", err);
      alert("Recording is not supported on this browser.");
      return;
    }

    mediaRecorder.ondataavailable = function (e) {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = function () {
      var blob = new Blob(recordedChunks, {
        type: mediaRecorder.mimeType || "video/webm"
      });
      var url = URL.createObjectURL(blob);
      var recording = {
        blob: blob,
        url: url,
        date: new Date(),
        mode: actionMode ? "Action" : "Normal"
      };
      recordings.push(recording);
      updateThumbnail(recording);
      recordedChunks = [];
    };

    mediaRecorder.start(100); // Collect data every 100ms
    isRecording = true;
    recordBtnInner.classList.add("recording");
    recIndicator.style.display = "flex";
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    isRecording = false;
    recordBtnInner.classList.remove("recording");
    recIndicator.style.display = "none";
  }

  // ===== Thumbnail =====
  function updateThumbnail(recording) {
    thumbContent.innerHTML = "";
    var vid = document.createElement("video");
    vid.src = recording.url;
    vid.muted = true;
    vid.playsInline = true;
    vid.preload = "metadata";
    vid.currentTime = 0.1;
    thumbContent.appendChild(vid);
    thumbContent.classList.remove("thumb-placeholder");
  }

  // ===== Thumbnail Click → Playback =====
  thumbBtn.addEventListener("click", function () {
    if (recordings.length === 0) return;
    var last = recordings[recordings.length - 1];
    openPlayback(last);
  });

  // ===== Gallery =====
  galleryBtn.addEventListener("click", function () {
    showGallery();
  });

  galleryBack.addEventListener("click", function () {
    galleryScreen.style.display = "none";
  });

  function showGallery() {
    galleryGrid.innerHTML = "";

    if (recordings.length === 0) {
      var emptyP = document.createElement("p");
      emptyP.className = "gallery-empty";
      emptyP.innerHTML = "No recordings yet.<br/>Record a video to see it here.";
      galleryGrid.appendChild(emptyP);
    } else {
      recordings.forEach(function (rec, i) {
        var item = document.createElement("div");
        item.className = "gallery-item";

        var vid = document.createElement("video");
        vid.src = rec.url;
        vid.muted = true;
        vid.playsInline = true;
        vid.preload = "metadata";
        vid.currentTime = 0.1;
        item.appendChild(vid);

        var label = document.createElement("div");
        label.className = "gallery-item-label";
        label.textContent = rec.mode + " · " + formatTime(rec.date);
        item.appendChild(label);

        item.addEventListener("click", function () {
          galleryScreen.style.display = "none";
          openPlayback(rec);
        });

        galleryGrid.appendChild(item);
      });
    }

    galleryScreen.style.display = "flex";
  }

  function formatTime(d) {
    var h = d.getHours().toString().padStart(2, "0");
    var m = d.getMinutes().toString().padStart(2, "0");
    var s = d.getSeconds().toString().padStart(2, "0");
    return h + ":" + m + ":" + s;
  }

  // ===== Playback =====
  function openPlayback(recording) {
    playbackVideo.src = recording.url;
    downloadLink.href = recording.url;

    var mimeType = recording.blob.type || "";
    var ext = mimeType.includes("mp4") ? "mp4" : "webm";
    downloadLink.download = "stable-action-" + recording.date.getTime() + "." + ext;

    playbackScreen.style.display = "flex";
    playbackVideo.play();
  }

  playbackClose.addEventListener("click", function () {
    playbackVideo.pause();
    playbackScreen.style.display = "none";
  });

  // ===== Tap to Focus =====
  viewport.addEventListener("click", function (e) {
    var rect = viewport.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;

    // Show focus square
    focusSquare.style.left = x + "px";
    focusSquare.style.top = y + "px";
    focusSquare.classList.remove("show");
    // Force reflow to restart animation
    void focusSquare.offsetWidth;
    focusSquare.style.display = "block";
    focusSquare.classList.add("show");

    // Hide after animation
    setTimeout(function () {
      focusSquare.style.display = "none";
      focusSquare.classList.remove("show");
    }, 1500);

    // Try to apply focus constraints if supported
    var videoTrack = stream && stream.getVideoTracks()[0];
    if (videoTrack) {
      var capabilities = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
      if (capabilities.focusMode) {
        var normX = x / rect.width;
        var normY = y / rect.height;
        var constraints = { advanced: [{ focusMode: "manual" }] };
        if (capabilities.pointsOfInterest) {
          constraints.advanced[0].pointsOfInterest = [{ x: normX, y: normY }];
        }
        videoTrack.applyConstraints(constraints).catch(function () {
          // Focus constraints not supported on this device — visual feedback is still shown
        });

        // Return to auto-focus after 1.5s
        setTimeout(function () {
          if (capabilities.focusMode) {
            videoTrack.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(function () {});
          }
        }, 1500);
      }
    }
  });
})();
