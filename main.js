(function () {
  'use strict';
  function element(identifier) { return document.getElementById(identifier); }
  let simulation = null, renderer = null, gpuDiffuser = null, tracker = null;
  let playing = true, rebuilding = false, pendingStep = false;
  let cameraWasActive = false;
  let diffusionJob = null, generation = 0, memoryRevision = 0;
  let lastFrameTime = performance.now(), lastDiffusionTime = 0, lastStatisticsTime = 0;
  let tripAccumulator = 0, framesPerSecond = 60, memoryNeedsUpdate = false, toastTimer = null;
  const memoryRetentionFactor = 0.97;
  const tripGenerationRate = 4;
  const options = {n: 40, connectivity: 50, roughness: .65, barriers: .18, climb: 2, learning: .8, hubBias: .65, fast: true};

  function toast(message) {
    element('toast').textContent = message;
    element('toast').classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { element('toast').classList.remove('visible'); }, 5500);
  }
  function formatInteger(value) { return Math.round(value).toLocaleString('en-US'); }
  function updateComputeBadge() {
    element('computeBadge').textContent = gpuDiffuser ? 'WEBGPU FIELD · CPU A*' : 'CPU FIELD · CPU A*';
    element('computeBadge').title = (renderer instanceof CanvasVolumeRenderer ? 'Canvas 2D projection' : 'WebGL2 rendering') +
      (gpuDiffuser ? ' · WebGPU diffusion · CPU pathfinding' : ' · CPU diffusion and pathfinding');
  }
  function updateMetrics() {
    if (!simulation || element('dataPanel').hidden) return;
    element('nodesMetric').textContent = formatInteger(simulation.count);
    element('routesMetric').textContent = formatInteger(simulation.tripCount);
    element('coverageMetric').textContent = (simulation.coverage() * 100).toFixed(1) + '%';
    element('searchMetric').textContent = simulation.lastVisited ? formatInteger(simulation.lastVisited) + ' nodes' : '—';
    element('footerNodeInfo').textContent = simulation.connectivity + ' IMPLICIT EDGES / INTERIOR NODE';
    element('footerProgress').textContent = (simulation.solidCount / simulation.count * 100).toFixed(1) +
      '% BLOCKED · ' + formatInteger(simulation.attempts) + ' TRIPS ATTEMPTED';
    element('annotation').textContent = simulation.n + '³ independent nodes · ' + simulation.connectivity + ' move vectors · fading trail cloud';
  }
  function setPlaying(value) {
    playing = value;
    if (renderer) renderer.animationPlaying = playing;
    element('runButton').innerHTML = playing ? '<span aria-hidden="true">Ⅱ</span> Pause' : '<span aria-hidden="true">▷</span> Resume';
    element('runButton').setAttribute('aria-pressed', String(playing));
    element('simulationStatus').textContent = playing ? 'TRACES IN MOTION' : 'PAUSED';
    element('livePulse').classList.toggle('paused', !playing);
  }
  async function initializeGpu(currentSimulation, currentGeneration) {
    const candidate = await VolumeGpuDiffuser.create(currentSimulation.n, currentSimulation.solid, function (error, failedDiffuser) {
      if (gpuDiffuser !== failedDiffuser) return;
      gpuDiffuser = null;
      failedDiffuser.destroy();
      updateComputeBadge();
      toast('WebGPU interrupted. Simulation continues on the CPU.');
    });
    if (currentGeneration !== generation || simulation !== currentSimulation) {
      candidate?.destroy();
      return;
    }
    gpuDiffuser = candidate;
    updateComputeBadge();
  }
  function applyViewSettings() {
    renderer.head.mode = element('viewMode').value;
    renderer.animationPlaying = playing;
  }
  function rebuild(settings = {}) {
    const currentGeneration = ++generation;
    rebuilding = true;
    pendingStep = false;
    diffusionJob = null;
    const previousDiffuser = gpuDiffuser;
    gpuDiffuser = null;
    previousDiffuser?.destroy();
    if (settings.newSeed) options.seed = Math.floor(Math.random() * 0x7fffffff);
    const overlay = element('loading');
    overlay.classList.remove('hidden');
    element('stepButton').disabled = true;
    requestAnimationFrame(function () {
      setTimeout(function () {
        if (currentGeneration !== generation) return;
        try {
          simulation = new VolumeSimulation({...options, seed: options.seed || 726133});
          if (!renderer) renderer = new VolumeRenderer(element('scene'), simulation);
          else { renderer.sim = simulation; renderer.rebuild(); }
          applyViewSettings();
          tripAccumulator = 0;
          lastDiffusionTime = performance.now();
          memoryNeedsUpdate = true;
          updateMetrics();
          overlay.classList.add('hidden');
          element('computeBadge').textContent = 'CHECKING WEBGPU…';
          initializeGpu(simulation, currentGeneration);

        } catch (error) {
          overlay.textContent = 'Unable to initialize the volume: ' + error.message;
          console.error(error);
        } finally {
          rebuilding = false;
          element('stepButton').disabled = !renderer;
        }
      }, 20);
    });
  }
  function generateTrip() {
    if (!simulation || !renderer || rebuilding || diffusionJob) return;
    const route = simulation.step();
    if (route) { renderer.addRoute(route); memoryNeedsUpdate = true; }
  }
  async function diffuse() {
    if (diffusionJob || !simulation || rebuilding) return;
    const currentSimulation = simulation;
    const currentDiffuser = gpuDiffuser;
    const currentRevision = memoryRevision;
    const job = {};
    diffusionJob = job;
    const retentionFactor = memoryRetentionFactor;
    try {
      if (currentDiffuser) {
        const result = await currentDiffuser.diffuse(currentSimulation.traffic, retentionFactor, .09);
        if (simulation === currentSimulation && currentRevision === memoryRevision) {
          currentSimulation.traffic = result;
          memoryNeedsUpdate = true;
        }
      } else {
        currentSimulation.diffuseCPU(retentionFactor, .09);
        memoryNeedsUpdate = true;
      }
    } catch (error) {
      // A retired device must never overwrite or dispose the replacement field/device.
      if (simulation === currentSimulation && !rebuilding) {
        if (gpuDiffuser === currentDiffuser) {
          gpuDiffuser = null;
          currentDiffuser?.destroy();
          updateComputeBadge();
          console.warn('GPU diffusion failed; using CPU diffusion.', error);
        }
        if (currentRevision === memoryRevision) {
          currentSimulation.diffuseCPU(retentionFactor, .09);
          memoryNeedsUpdate = true;
        }
      }
    } finally {
      if (diffusionJob === job) diffusionJob = null;
    }
  }
  function frame(timestamp) {
    const elapsedSeconds = Math.min(.2, (timestamp - lastFrameTime) / 1000);
    lastFrameTime = timestamp;
    framesPerSecond += (1 / Math.max(elapsedSeconds, .001) - framesPerSecond) * .025;
    tracker?.tick(timestamp);
    if (simulation && renderer && !rebuilding) {
      if (pendingStep && !diffusionJob) {
        pendingStep = false; generateTrip();
        renderer.sceneTime += .6;
        updateMetrics();
      }
      if (playing && !diffusionJob) {
        tripAccumulator += elapsedSeconds * tripGenerationRate;
        let generatedTripCount = 0;
        while (tripAccumulator >= 1 && generatedTripCount < 2) {
          generateTrip(); tripAccumulator--; generatedTripCount++;
        }
        tripAccumulator = Math.min(3, tripAccumulator);
        if (timestamp - lastDiffusionTime > 1150) { lastDiffusionTime = timestamp; diffuse(); }
      }
      if (memoryNeedsUpdate && timestamp - lastStatisticsTime > 500) {
        renderer.updateMemory(); memoryNeedsUpdate = false;
      }
      if (timestamp - lastStatisticsTime > 750) {
        updateMetrics(); element('fpsBadge').textContent = Math.round(framesPerSecond) + ' FPS'; lastStatisticsTime = timestamp;
      }
    }
    if (renderer) renderer.render(timestamp);
    requestAnimationFrame(frame);
  }
  function resetView() {
    if (!renderer) return;
    renderer.yaw = -.94; renderer.pitch = .52; renderer.radius = 30; renderer.target = [0, 0, 0];
    if (tracker.active) tracker.recalibrate();
  }
  function clearMemory() {
    if (!simulation || rebuilding) return;
    ++memoryRevision;
    pendingStep = false;
    simulation.traffic.fill(0); simulation.scratch.fill(0);
    simulation.tripCount = 0; simulation.attempts = 0; simulation.lastVisited = 0;
    simulation.lastPath = null; simulation.lastCost = 0;
    renderer.routes = []; renderer.updateRoutes(); renderer.updateMemory();
    updateMetrics();
    toast('Travel memory and route history cleared');
  }
  function setImmersive(enabled) {
    const interfaceElement = element('interface');
    interfaceElement.hidden = enabled;
    interfaceElement.inert = enabled;
    document.body.classList.toggle('immersive', enabled);
    if (enabled) {
      element('dataPanel').hidden = true;
      element('dataToggle').setAttribute('aria-expanded', 'false');
      element('toast').classList.remove('visible');
      element('scene').focus({preventScroll: true});
    }
  }
  function synchronizeCameraState() {
    element('hideInterface').hidden = !tracker.active;
    if (tracker.active && !cameraWasActive) setImmersive(true);
    if (!tracker.active && cameraWasActive) setImmersive(false);
    cameraWasActive = tracker.active;
  }
  function bindInterface() {
    element('dataToggle').addEventListener('click', function () {
      const panel = element('dataPanel');
      panel.hidden = !panel.hidden;
      element('dataToggle').setAttribute('aria-expanded', String(!panel.hidden));
      updateMetrics();
    });
    element('closeData').addEventListener('click', function () {
      element('dataPanel').hidden = true;
      element('dataToggle').setAttribute('aria-expanded', 'false');
      element('dataToggle').focus();
    });
    element('hideInterface').addEventListener('click', function () { if (tracker.active) setImmersive(true); });
    let pointerStart = null;
    element('scene').addEventListener('pointerdown', function (event) {
      pointerStart = {horizontal: event.clientX, vertical: event.clientY, identifier: event.pointerId, button: event.button};
    });
    element('scene').addEventListener('pointerup', function (event) {
      if (tracker.active && pointerStart && pointerStart.button === 0 && pointerStart.identifier === event.pointerId &&
          Math.hypot(event.clientX - pointerStart.horizontal, event.clientY - pointerStart.vertical) < 6) {
        setImmersive(!element('interface').hidden);
      }
      pointerStart = null;
    });
    element('scene').addEventListener('pointercancel', function () { pointerStart = null; });
  }
  function bindFullscreen() {
    element('fullscreenButton').hidden = !document.fullscreenEnabled;
    element('fullscreenButton').addEventListener('click', async function () {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch (error) { toast('Full screen is unavailable in this browser window.'); }
    });
    document.addEventListener('fullscreenchange', function () {
      const label = document.fullscreenElement ? 'Exit full screen' : 'Enter full screen';
      element('fullscreenButton').setAttribute('aria-label', label);
      element('fullscreenButton').title = label;
    });
  }
  function bind() {
    element('runButton').addEventListener('click', function () { setPlaying(!playing); });
    element('stepButton').addEventListener('click', function () { setPlaying(false); pendingStep = true; });
    element('newWorld').addEventListener('click', function () { rebuild({newSeed: true}); });
    element('clearMemory').addEventListener('click', clearMemory);
    element('resetView').addEventListener('click', resetView);
    element('viewMode').addEventListener('change', function (event) { if (renderer) renderer.head.mode = event.target.value; });
    element('calibrate').addEventListener('click', function () { tracker.recalibrate(); });
    tracker = new FaceViewTracker(element('cameraVideo'), function (pose) {
      if (!renderer) return;
      if (pose) renderer.head.active = true;
      else if (!tracker.active) renderer.head.active = false;
      if (pose) { renderer.head.x = pose.x; renderer.head.y = pose.y; renderer.head.d = pose.d; }
    }, function (message, active) {
      element('cameraStatus').textContent = message;
      element('cameraStatus').classList.toggle('on', active);
      element('headControls').classList.toggle('tracking', active);
      element('cameraToggle').setAttribute('aria-pressed', String(tracker.active));
      element('calibrate').disabled = !tracker.active;
      if (!tracker.starting) element('cameraToggle').textContent = tracker.active ? 'Disable webcam' : 'Enable webcam';
      synchronizeCameraState();
    });
    element('cameraToggle').addEventListener('click', async function () {
      if (tracker.active) { tracker.stop(); return; }
      const button = element('cameraToggle');
      button.disabled = true; button.textContent = 'Connecting…';
      button.setAttribute('aria-busy', 'true');
      try {
        await tracker.start();
        synchronizeCameraState();
      } catch (error) { toast(error.message); }
      finally {
        button.disabled = false;
        button.setAttribute('aria-busy', 'false');
        button.setAttribute('aria-pressed', String(tracker.active));
        button.textContent = tracker.active ? 'Disable webcam' : 'Enable webcam';
        element('calibrate').disabled = !tracker.active;
        synchronizeCameraState();
      }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (tracker.active) setImmersive(!element('interface').hidden);
        else { element('dataPanel').hidden = true; element('dataToggle').setAttribute('aria-expanded', 'false'); }
        return;
      }
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.target.isContentEditable ||
          ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(event.target.tagName)) return;
      if (event.code === 'Space') { event.preventDefault(); setPlaying(!playing); }
      else if (event.key.toLowerCase() === 'n') rebuild({newSeed: true});
      else if (event.key.toLowerCase() === 'c' && tracker.active) tracker.recalibrate();
    });
    window.addEventListener('pagehide', function () { ++generation; tracker.stop(); gpuDiffuser?.destroy(); gpuDiffuser = null; });
    window.addEventListener('pageshow', function (event) { if (event.persisted && simulation) initializeGpu(simulation, generation); });
    bindFullscreen();
    bindInterface();
  }
  bind(); rebuild(); requestAnimationFrame(frame);
})();
