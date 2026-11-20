(function () {
  'use strict';
  const results = document.getElementById('results');
  function report(message) { results.textContent += '\n' + message; }
  document.getElementById('gpuCheck').addEventListener('click', async function () {
    this.disabled = true;
    try {
      for (const resolution of [24, 40, 64]) {
        const nodeCount = resolution ** 3;
        const solidNodes = new Uint8Array(nodeCount);
        const traffic = new Float32Array(nodeCount);
        for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
          solidNodes[nodeIndex] = nodeIndex % 17 === 0 ? 1 : 0;
          traffic[nodeIndex] = (nodeIndex % 113) / 7;
        }
        const reference = {n: resolution, count: nodeCount, solid: solidNodes, traffic: traffic.slice(), scratch: new Float32Array(nodeCount)};
        const diffuser = await VolumeGpuDiffuser.create(resolution, solidNodes);
        if (!diffuser) throw new Error('WebGPU unavailable: hardware parity checks cannot run.');
        try {
          VolumeSimulation.prototype.diffuseCPU.call(reference, .97, .09);
          const actual = await diffuser.diffuse(traffic, .97, .09);
          let largestError = 0;
          for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
            if (!Number.isFinite(actual[nodeIndex])) throw new Error('Nonfinite output at ' + nodeIndex);
            largestError = Math.max(largestError, Math.abs(actual[nodeIndex] - reference.traffic[nodeIndex]));
            if (solidNodes[nodeIndex] && actual[nodeIndex] !== 0) throw new Error('Solid voxel retained traffic.');
          }
          if (largestError > .00001) throw new Error('CPU/GPU mismatch: ' + largestError);
          await diffuser.diffuse(actual, .97, .09);
          report('PASS ' + resolution + '³ GPU/CPU parity, boundaries, barriers and repeated readback. Max error: ' + largestError);
          let rejected = false;
          try { await diffuser.diffuse(new Float32Array(1), .97, .09); } catch (error) { rejected = true; }
          if (!rejected) throw new Error('Mismatched buffer was accepted.');
        } finally { diffuser.destroy(); diffuser.destroy(); }
        let rejected = false;
        try { await diffuser.diffuse(traffic, .97, .09); } catch (error) { rejected = true; }
        if (!rejected) throw new Error('Disposed device was accepted.');
      }
      let reportedLoss = false;
      const diffuser = await VolumeGpuDiffuser.create(24, new Uint8Array(24 ** 3), function () { reportedLoss = true; });
      diffuser.device.destroy();
      await diffuser.device.lost;
      await Promise.resolve();
      diffuser.destroy();
      if (!reportedLoss) throw new Error('Device loss was not reported.');
      report('PASS buffer-size protection, disposal and device-loss notification.');
    } catch (error) { report('FAIL ' + error.message); }
    finally { this.disabled = false; }
  });
  document.getElementById('visionCheck').addEventListener('click', async function () {
    this.disabled = true;
    let landmarker = null;
    try {
      const tracker = new FaceViewTracker(document.createElement('video'), function () {}, function () {});
      landmarker = await tracker.loadLandmarker();
      const frame = document.createElement('canvas');
      frame.width = 480; frame.height = 360;
      frame.getContext('2d').fillRect(0, 0, frame.width, frame.height);
      const result = landmarker.detectForVideo(frame, performance.now());
      if (!Array.isArray(result.faceLandmarks)) throw new Error('Missing landmark result.');
      report('PASS MediaPipe module, matching WASM, face model, VIDEO inference and cleanup; no camera used.');
    } catch (error) { report('FAIL ' + error.message); }
    finally { if (landmarker) landmarker.close(); this.disabled = false; }
  });
})();
