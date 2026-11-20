/* Opt-in, local MediaPipe head tracking. All runtime assets use one pinned version. */
(function () {
  'use strict';
  const visionBaseUrl = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
  const modelUrl = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
  function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
  function cameraErrorMessage(error) {
    if (error.name === 'NotAllowedError') return 'Camera permission was denied. Allow camera access in your browser, then try again.';
    if (error.name === 'NotFoundError') return 'No camera found. Connect a webcam, then try again.';
    if (error.name === 'NotReadableError') return 'The camera is busy or unavailable. Close other camera apps, then try again.';
    return error.message || 'Unable to initialize face tracking.';
  }
  class FaceViewTracker {
    constructor(video, onPose, onStatus) {
      this.video = video;
      this.onPose = onPose;
      this.onStatus = onStatus;
      this.active = false;
      this.starting = false;
      this.session = 0;
      this.landmarker = null;
      this.stream = null;
      this.reference = null;
      this.lastTimestamp = -Infinity;
      this.lastVideoTime = -1;
      this.lastFaceTimestamp = 0;
      this.failedFrameCount = 0;
      this.statusText = '';
      this.statusActive = false;
    }
    status(message, active) {
      if (message === this.statusText && active === this.statusActive) return;
      this.statusText = message;
      this.statusActive = active;
      this.onStatus(message, active);
    }
    async loadLandmarker() {
      try {
        const vision = await import(visionBaseUrl + '/vision_bundle.mjs');
        const fileset = await vision.FilesetResolver.forVisionTasks(visionBaseUrl + '/wasm');
        return await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {modelAssetPath: modelUrl, delegate: 'CPU'},
          runningMode: 'VIDEO', numFaces: 1,
          outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false
        });
      } catch (error) {
        throw new Error('Could not load the face model. Check your connection and access to jsDelivr and Google Storage. ' + (error.message || ''));
      }
    }
    async start() {
      if (this.active || this.starting) return;
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('Webcam requires HTTPS or localhost and a browser with camera support.');
      }
      const session = ++this.session;
      this.starting = true;
      try {
        this.status('Requesting camera access…', false);
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {width: {ideal: 480}, height: {ideal: 360}, facingMode: 'user'}, audio: false
        });
        if (session !== this.session) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        this.stream = stream;
        this.video.srcObject = stream;
        this.video.style.display = 'block';
        const tracker = this;
        for (const track of stream.getVideoTracks()) track.addEventListener('ended', function () {
          if (session !== tracker.session) return;
          tracker.stop();
          tracker.status('Camera disconnected. Reconnect it and enable webcam again.', false);
        }, {once: true});
        await this.video.play();
        if (session !== this.session) return;
        this.status('Loading facial landmark model…', false);
        const landmarker = await this.loadLandmarker();
        if (session !== this.session) { landmarker.close(); return; }
        this.landmarker = landmarker;
        this.reference = null;
        this.lastTimestamp = -Infinity;
        this.lastVideoTime = -1;
        this.lastFaceTimestamp = performance.now();
        this.failedFrameCount = 0;
        this.active = true;
        this.status('Looking for a face · video stays on this device', false);
      } catch (error) {
        if (session !== this.session) return;
        this.stop();
        const message = cameraErrorMessage(error);
        this.status(message, false);
        throw new Error(message);
      } finally {
        if (session === this.session) this.starting = false;
      }
    }
    recalibrate() {
      this.reference = null;
      this.onPose(null);
      this.status('Look at the screen to set a neutral position…', false);
    }
    tick(timestamp) {
      if (!this.active || !this.landmarker || timestamp - this.lastTimestamp < 95 ||
          this.video.readyState < 2 || !this.video.videoWidth || !this.video.videoHeight ||
          this.video.currentTime === this.lastVideoTime) {
        if (this.active && timestamp - this.lastFaceTimestamp > 1400) this.loseFace();
        return;
      }
      this.lastTimestamp = timestamp;
      this.lastVideoTime = this.video.currentTime;
      try {
        const faces = this.landmarker.detectForVideo(this.video, timestamp).faceLandmarks;
        this.failedFrameCount = 0;
        if (!faces?.length) {
          if (timestamp - this.lastFaceTimestamp > 1400) this.loseFace();
          return;
        }
        const landmarks = faces[0];
        const leftEye = landmarks[33], rightEye = landmarks[263];
        const leftCheek = landmarks[234], rightCheek = landmarks[454];
        if (!leftEye || !rightEye || !leftCheek || !rightCheek) return;
        const eyeCenterX = (leftEye.x + rightEye.x) / 2;
        const eyeCenterY = (leftEye.y + rightEye.y) / 2;
        const faceWidth = Math.hypot(leftCheek.x - rightCheek.x, leftCheek.y - rightCheek.y);
        if (!(faceWidth > 0.025)) return;
        this.lastFaceTimestamp = timestamp;
        if (!this.reference) this.reference = {eyeCenterX: eyeCenterX, eyeCenterY: eyeCenterY, faceWidth: faceWidth};
        const reference = this.reference;
        const distanceFactor = clamp(reference.faceWidth / faceWidth, 0.52, 1.85);
        this.onPose({
          x: clamp((reference.eyeCenterX - eyeCenterX) * 20, -5.5, 5.5),
          y: clamp((reference.eyeCenterY - eyeCenterY) * 14, -4, 4),
          d: 25 * distanceFactor
        });
        this.status('Tracking face · approximate 3D head pose', true);
      } catch (error) {
        this.failedFrameCount++;
        this.onPose(null);
        if (this.failedFrameCount >= 3) {
          this.stop();
          this.status('Face detection stopped. Enable webcam to retry.', false);
          console.warn('MediaPipe stopped after repeated detection failures.', error);
        } else this.status('Face detection interrupted; retrying…', false);
      }
    }
    loseFace() {
      this.onPose(null);
      this.status('Looking for a face · manual orbit available', false);
    }
    stop() {
      ++this.session;
      this.active = false;
      this.starting = false;
      if (this.landmarker) {
        try { this.landmarker.close(); } catch (error) { /* Already released by the runtime. */ }
      }
      this.landmarker = null;
      if (this.stream) for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
      this.video.pause();
      this.video.srcObject = null;
      this.video.style.display = 'none';
      this.reference = null;
      this.onPose(null);
      this.status('Manual orbit active', false);
    }
  }
  window.FaceViewTracker = FaceViewTracker;
})();
