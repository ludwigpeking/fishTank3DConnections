/* Shared spatial geometry and camera behavior for WebGL and Canvas renderers. */
(function () {
  'use strict';
  function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
  function randomFactor(seed) {
    let mixedSeed = Math.imul(seed ^ 1597334677, 2246822519);
    mixedSeed = Math.imul(mixedSeed ^ (mixedSeed >>> 13), 3266489917);
    return ((mixedSeed ^ (mixedSeed >>> 16)) >>> 0) / 4294967296;
  }
  function normalize(vector) {
    const length = Math.hypot(...vector) || 1;
    return vector.map(function (coordinate) { return coordinate / length; });
  }
  function cross(left, right) {
    return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
  }
  function dot(left, right) { return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]; }
  function multiplyMatrices(left, right) {
    const result = new Float32Array(16);
    for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
      result[column * 4 + row] = left[row] * right[column * 4] + left[4 + row] * right[column * 4 + 1] + left[8 + row] * right[column * 4 + 2] + left[12 + row] * right[column * 4 + 3];
    }
    return result;
  }
  function perspective(fieldOfViewRadians, aspectRatio) {
    const focalFactor = 1 / Math.tan(fieldOfViewRadians / 2), nearDistance = .04, farDistance = 180;
    const depthFactor = 1 / (nearDistance - farDistance);
    return new Float32Array([focalFactor / aspectRatio, 0, 0, 0, 0, focalFactor, 0, 0, 0, 0, (farDistance + nearDistance) * depthFactor, -1, 0, 0, 2 * farDistance * nearDistance * depthFactor, 0]);
  }
  function lookAt(eye, target) {
    const backward = normalize(eye.map(function (coordinate, axis) { return coordinate - target[axis]; }));
    const right = normalize(cross([0, 0, 1], backward)), upward = cross(backward, right);
    return new Float32Array([right[0], upward[0], backward[0], 0, right[1], upward[1], backward[1], 0, right[2], upward[2], backward[2], 0, -dot(right, eye), -dot(upward, eye), -dot(backward, eye), 1]);
  }
  function cameraPose(scene) {
    const head = scene.headCurrent;
    const tracking = scene.head.active;
    const orbitTracking = tracking && scene.head.mode === 'orbit';
    const yawRadians = scene.yaw + (orbitTracking ? head.x * .13 : 0);
    const pitchRadians = clamp(scene.pitch + (orbitTracking ? head.y * .11 : 0), -1.48, 1.48);
    // Actual camera translation, with constant perspective and constant world scale.
    // At half the calibrated face distance the eye can enter the volume.
    const distanceFactor = tracking ? Math.pow(clamp(head.d / 25, .45, 2), 3.2) : 1;
    const cameraDistance = clamp(scene.radius * distanceFactor, 1.2, 95);
    const backward = [Math.cos(pitchRadians) * Math.cos(yawRadians), Math.cos(pitchRadians) * Math.sin(yawRadians), Math.sin(pitchRadians)];
    const right = [-Math.sin(yawRadians), Math.cos(yawRadians), 0];
    const upward = cross(backward, right);
    const lateralOffset = tracking && !orbitTracking ? right.map(function (coordinate, axis) { return coordinate * head.x + upward[axis] * head.y; }) : [0, 0, 0];
    const target = scene.target.map(function (coordinate, axis) { return coordinate + lateralOffset[axis]; });
    const eye = target.map(function (coordinate, axis) { return coordinate + backward[axis] * cameraDistance; });
    return {eye: eye, target: target, distance: cameraDistance};
  }
  function appendVertex(vertices, position, color, opacity) {
    vertices.push(position[0], position[1], position[2], color[0], color[1], color[2], opacity);
  }
  function smoothRoute(simulation, path) {
    const coordinates = path.map(function (nodeIndex) { return simulation.xyzPosition(nodeIndex); });
    if (coordinates.length < 2) return coordinates;
    const samples = [coordinates[0]];
    for (let segmentIndex = 0; segmentIndex < coordinates.length - 1; segmentIndex++) {
      const before = coordinates[Math.max(0, segmentIndex - 1)], start = coordinates[segmentIndex];
      const end = coordinates[segmentIndex + 1], after = coordinates[Math.min(coordinates.length - 1, segmentIndex + 2)];
      const sampleCount = Math.max(3, Math.ceil(Math.hypot(...end.map(function (coordinate, axis) { return coordinate - start[axis]; })) / .10));
      for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex++) {
        const fraction = sampleIndex / sampleCount;
        samples.push(start.map(function (coordinate, axis) {
          return .5 * (2 * coordinate + (-before[axis] + end[axis]) * fraction + (2 * before[axis] - 5 * coordinate + 4 * end[axis] - after[axis]) * fraction ** 2 + (-before[axis] + 3 * coordinate - 3 * end[axis] + after[axis]) * fraction ** 3);
        }));
      }
    }
    return samples;
  }
  function terrainDensity(simulation, nodeIndex) {
    const memoryFactor = .20 + .80 * Math.exp(-simulation.learning * simulation.traffic[nodeIndex] * .64);
    const effectiveResistance = simulation.base[nodeIndex] * memoryFactor;
    const resistanceSpan = Math.max(.001, simulation.maxResistance - simulation.minResistance);
    return simulation.solid[nodeIndex] ? 1 : clamp((effectiveResistance - simulation.minResistance) / resistanceSpan, 0, 1);
  }
  class VolumeScene {
    constructor(canvas, simulation) {
      this.canvas = canvas; this.sim = simulation;
      this.routes = []; this.terrainVertices = new Float32Array();
      this.trailVertices = new Float32Array(); this.filamentVertices = new Float32Array();
      this.yaw = -.94; this.pitch = .52; this.radius = 22; this.target = [0, 0, 0];
      this.head = {active: false, mode: 'window', x: 0, y: 0, d: 25};
      this.headCurrent = {x: 0, y: 0, d: 25};
      this.width = 1; this.height = 1; this.pointer = null;
      this.sceneTime = 0; this.animationPlaying = true; this.previousTimestamp = null;
      this.lastTrailUpdate = -Infinity; this.terrainRevision = 0; this.trailRevision = 0;
      this.attachMouse(); this.rebuild();
    }
    attachMouse() {
      const scene = this, canvas = this.canvas;
      canvas.addEventListener('pointerdown', function (event) {
        scene.pointer = {x: event.clientX, y: event.clientY, button: event.button};
        canvas.setPointerCapture(event.pointerId);
      });
      canvas.addEventListener('pointermove', function (event) {
        if (!scene.pointer) return;
        const horizontalPixels = event.clientX - scene.pointer.x, verticalPixels = event.clientY - scene.pointer.y;
        scene.pointer.x = event.clientX; scene.pointer.y = event.clientY;
        if (scene.pointer.button === 2 || event.ctrlKey || event.shiftKey) {
          const worldDistancePerPixel = .017 * scene.radius / 28;
          scene.target[0] += horizontalPixels * worldDistancePerPixel * Math.sin(scene.yaw);
          scene.target[1] -= horizontalPixels * worldDistancePerPixel * Math.cos(scene.yaw);
          scene.target[2] += verticalPixels * worldDistancePerPixel;
        } else { scene.yaw -= horizontalPixels * .006; scene.pitch = clamp(scene.pitch + verticalPixels * .006, -1.48, 1.48); }
      });
      function releasePointer() { scene.pointer = null; }
      canvas.addEventListener('pointerup', releasePointer);
      canvas.addEventListener('pointercancel', releasePointer);
      canvas.addEventListener('wheel', function (event) {
        event.preventDefault(); scene.radius = clamp(scene.radius * Math.exp(event.deltaY * .001), 1.2, 85);
      }, {passive: false});
      canvas.addEventListener('contextmenu', function (event) { event.preventDefault(); });
    }
    rebuild() {
      this.routes = []; this.sceneTime = 0; this.previousTimestamp = null;
      this.updateMemory(); this.updateRoutes();
    }
    updateMemory() {
      const vertices = [], simulation = this.sim;
      const voxelWidth = 14 / (simulation.n - 1);
      const stride = Math.max(1, Math.ceil(simulation.count / 26000));
      for (let nodeIndex = 0; nodeIndex < simulation.count; nodeIndex += stride) {
        const density = terrainDensity(simulation, nodeIndex);
        const seed = nodeIndex ^ simulation.seed;
        // More resistant voxels occupy more of the colored volume, with greater opacity.
        if (randomFactor(seed) > .035 + .90 * density ** 1.35) continue;
        const position = simulation.xyzPosition(nodeIndex).map(function (coordinate, axis) {
          return coordinate + (randomFactor(seed + axis * 7963 + 101) - .5) * voxelWidth * .85;
        });
        appendVertex(vertices, position, [.60 + .18 * density, .25 + .07 * density, .57 + .20 * density], .025 + .16 * density ** 1.5);
      }
      this.terrainVertices = new Float32Array(vertices);
      this.terrainRevision++;
    }
    addRoute(route) {
      if (!route) return;
      const samples = smoothRoute(this.sim, route.path);
      if (samples.length < 2) return;
      const travelTimes = [0];
      const speed = 1.3 + randomFactor(route.start + route.target) * 1.5;
      for (let sampleIndex = 1; sampleIndex < samples.length; sampleIndex++) {
        const distance = Math.hypot(...samples[sampleIndex].map(function (coordinate, axis) { return coordinate - samples[sampleIndex - 1][axis]; }));
        travelTimes.push(travelTimes[sampleIndex - 1] + distance / speed);
      }
      this.routes.push({samples: samples, travelTimes: travelTimes, born: this.sceneTime, seed: route.start * 113 + route.target, color: randomFactor(route.target) < .28 ? [1, .68, .32] : [.31, .94, .78]});
      if (this.routes.length > 180) this.routes.shift();
      this.lastTrailUpdate = -Infinity;
    }
    updateRoutes() {
      this.trailVertices = new Float32Array(); this.filamentVertices = new Float32Array();
      this.lastTrailUpdate = -Infinity; this.trailRevision++;
    }
    buildTrails() {
      const vertices = [], filaments = [], sceneTime = this.sceneTime;
      this.routes = this.routes.filter(function (route) { return sceneTime - route.born < route.travelTimes.at(-1) + 32; });
      const totalSampleCount = this.routes.reduce(function (count, route) { return count + route.samples.length; }, 0);
      const sampleStride = Math.max(1, Math.ceil(totalSampleCount * 3 / 42000));
      for (const route of this.routes) {
        for (let sampleIndex = 0; sampleIndex < route.samples.length; sampleIndex += sampleStride) {
          const ageSeconds = sceneTime - route.born - route.travelTimes[sampleIndex];
          if (ageSeconds < 0 || ageSeconds > 32) continue;
          const fadeFactor = Math.exp(-ageSeconds / 9) * Math.min(1, (32 - ageSeconds) / 3);
          const spreadDistance = .025 + Math.min(.34, ageSeconds * .015);
          const center = route.samples[sampleIndex];
          for (let particleIndex = 0; particleIndex < 3; particleIndex++) {
            const seed = route.seed + sampleIndex * 43 + particleIndex * 131;
            const position = center.map(function (coordinate, axis) {
              const phase = randomFactor(seed + axis * 101) * Math.PI * 2;
              return coordinate + Math.sin(phase) * spreadDistance + Math.sin(phase + ageSeconds * .36) * spreadDistance * .35;
            });
            appendVertex(vertices, position, route.color, fadeFactor * .26);
          }
          if (sampleIndex > 0 && ageSeconds < 7) {
            appendVertex(filaments, route.samples[Math.max(0, sampleIndex - sampleStride)], route.color, fadeFactor * .13);
            appendVertex(filaments, center, route.color, fadeFactor * .13);
          }
        }
      }
      this.trailVertices = new Float32Array(vertices); this.filamentVertices = new Float32Array(filaments);
      this.trailRevision++;
    }
    advance(timestamp) {
      const elapsedSeconds = this.previousTimestamp === null ? 0 : clamp((timestamp - this.previousTimestamp) / 1000, 0, .1);
      this.previousTimestamp = timestamp;
      if (this.animationPlaying) this.sceneTime += elapsedSeconds;
      if (this.head.active) {
        const smoothingFactor = 1 - Math.exp(-elapsedSeconds * 9);
        for (const axis of ['x', 'y', 'd']) this.headCurrent[axis] += (this.head[axis] - this.headCurrent[axis]) * smoothingFactor;
      }
      if (this.sceneTime - this.lastTrailUpdate >= 1 / 30) {
        this.lastTrailUpdate = this.sceneTime; this.buildTrails();
      }
    }
    cameraMatrix() {
      const aspectRatio = this.width / this.height;
      const fieldOfViewRadians = 2 * Math.atan(Math.tan(.75 / 2) / Math.min(1, aspectRatio));
      const pose = cameraPose(this);
      return multiplyMatrices(perspective(fieldOfViewRadians, aspectRatio), lookAt(pose.eye, pose.target));
    }
  }
  window.VolumeScene = VolumeScene;
  window.VolumeVisuals = {cameraPose: cameraPose, terrainDensity: terrainDensity, clamp: clamp};
  window.smoothVolumeRoute = smoothRoute;
})();
