'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const filesystem = require('node:fs');
const path = require('node:path');
const virtualMachine = require('node:vm');
const trackerSource = filesystem.readFileSync(path.join(__dirname, '../head.js'), 'utf8');

function createFixture() {
  const fixture = {stoppedTrackCount: 0, closedModelCount: 0, detectionCount: 0, poses: [], statuses: []};
  const track = {stop: function () { fixture.stoppedTrackCount++; }, addEventListener: function (name, listener) { fixture.ended = listener; }};
  fixture.stream = {getTracks: function () { return [track]; }, getVideoTracks: function () { return [track]; }};
  fixture.video = {style: {}, readyState: 2, videoWidth: 480, videoHeight: 360, currentTime: 0,
    play: async function () {}, pause: function () {}, srcObject: null};
  fixture.landmarks = Array.from({length: 478}, function () { return {x: .5, y: .5}; });
  fixture.landmarks[234].x = .3;
  fixture.landmarks[454].x = .7;
  fixture.model = {
    close: function () { fixture.closedModelCount++; },
    detectForVideo: function () { fixture.detectionCount++; return {faceLandmarks: [fixture.landmarks]}; }
  };
  fixture.context = virtualMachine.createContext({
    window: {isSecureContext: true}, navigator: {mediaDevices: {getUserMedia: async function () { return fixture.stream; }}},
    performance: {now: function () { return 0; }}, console: {warn: function () {}}
  });
  virtualMachine.runInContext(trackerSource, fixture.context);
  fixture.tracker = new fixture.context.window.FaceViewTracker(fixture.video,
    function (pose) { fixture.poses.push(pose); },
    function (message, active) { fixture.statuses.push({message: message, active: active}); });
  fixture.tracker.loadLandmarker = async function () { return fixture.model; };
  return fixture;
}

test('video playback failure releases the camera and allows retry', async function () {
  const fixture = createFixture();
  fixture.video.play = async function () { throw new Error('Playback failed'); };
  await assert.rejects(fixture.tracker.start(), /Playback failed/);
  assert.equal(fixture.stoppedTrackCount, 1);
  assert.equal(fixture.video.srcObject, null);
  assert.equal(fixture.tracker.starting, false);
  fixture.video.play = async function () {};
  await fixture.tracker.start();
  assert.equal(fixture.tracker.active, true);
  fixture.tracker.stop();
});
test('model loading failure releases every acquired resource', async function () {
  const fixture = createFixture();
  fixture.tracker.loadLandmarker = async function () { throw new Error('Model offline'); };
  await assert.rejects(fixture.tracker.start(), /Model offline/);
  assert.equal(fixture.stoppedTrackCount, 1);
  assert.equal(fixture.video.srcObject, null);
  assert.equal(fixture.tracker.active, false);
});
test('stop during pending permission disposes the late stream', async function () {
  const fixture = createFixture();
  let grantPermission;
  fixture.context.navigator.mediaDevices.getUserMedia = function () { return new Promise(function (resolve) { grantPermission = resolve; }); };
  const startup = fixture.tracker.start();
  fixture.tracker.stop();
  grantPermission(fixture.stream);
  await startup;
  assert.equal(fixture.stoppedTrackCount, 1);
  assert.equal(fixture.video.srcObject, null);
  assert.equal(fixture.tracker.active, false);
});
test('stop during model loading closes the late model', async function () {
  const fixture = createFixture();
  let finishLoading;
  let signalLoading;
  const loadingStarted = new Promise(function (resolve) { signalLoading = resolve; });
  fixture.tracker.loadLandmarker = function () {
    signalLoading();
    return new Promise(function (resolve) { finishLoading = resolve; });
  };
  const startup = fixture.tracker.start();
  await loadingStarted;
  fixture.tracker.stop();
  finishLoading(fixture.model);
  await startup;
  assert.equal(fixture.closedModelCount, 1);
  assert.equal(fixture.stoppedTrackCount, 1);
  assert.equal(fixture.tracker.active, false);
});
test('decoded-frame gating, face loss and restart timestamps', async function () {
  const fixture = createFixture();
  await fixture.tracker.start();
  fixture.tracker.tick(100);
  fixture.tracker.tick(200);
  assert.equal(fixture.detectionCount, 1, 'Duplicate decoded frame should not run inference');
  assert.equal(fixture.poses.at(-1).d, 25);
  fixture.tracker.tick(1700);
  assert.equal(fixture.poses.at(-1), null, 'Frozen video should restore manual orbit');
  fixture.video.currentTime = .1;
  fixture.tracker.tick(1800);
  assert.equal(fixture.detectionCount, 2);
  assert.notEqual(fixture.poses.at(-1), null);
  fixture.tracker.stop();
  await fixture.tracker.start();
  fixture.tracker.tick(50);
  assert.equal(fixture.detectionCount, 3, 'A new session should reset timestamps');
  fixture.tracker.stop();
});
test('repeated detection failures stop tracking and release camera', async function () {
  const fixture = createFixture();
  fixture.model.detectForVideo = function () { throw new Error('Detector failed'); };
  await fixture.tracker.start();
  for (let frameIndex = 1; frameIndex <= 3; frameIndex++) {
    fixture.video.currentTime = frameIndex / 10;
    fixture.tracker.tick(frameIndex * 100);
  }
  assert.equal(fixture.tracker.active, false);
  assert.equal(fixture.stoppedTrackCount, 1);
  assert.equal(fixture.closedModelCount, 1);
  assert.match(fixture.statuses.at(-1).message, /Enable webcam to retry/);
});
test('camera disconnection restores manual view', async function () {
  const fixture = createFixture();
  await fixture.tracker.start();
  fixture.ended();
  assert.equal(fixture.tracker.active, false);
  assert.equal(fixture.poses.at(-1), null);
  assert.match(fixture.statuses.at(-1).message, /disconnected/);
});
test('3D graph retains all knight moves and vertical routing', function () {
  const context = virtualMachine.createContext({window: {}, performance: performance});
  virtualMachine.runInContext(filesystem.readFileSync(path.join(__dirname, '../volume.js'), 'utf8'), context);
  for (const connectivity of [6, 26, 50]) {
    const moves = context.window.build3DMoves(connectivity);
    assert.equal(moves.length, connectivity);
    if (connectivity === 50) assert.equal(moves.filter(function (move) { return move.knight; }).length, 24);
    const simulation = new context.window.VolumeSimulation({n: 8, barriers: 0, connectivity: connectivity, fast: false});
    const route = simulation.findPath(simulation.index(1, 1, 1), simulation.index(6, 6, 6));
    assert.ok(route && route.path.length > 1);
    for (let pathIndex = 1; pathIndex < route.path.length; pathIndex++) {
      const before = simulation.xyz(route.path[pathIndex - 1]), after = simulation.xyz(route.path[pathIndex]);
      assert.ok(moves.some(function (move) { return move.dx === after[0] - before[0] && move.dy === after[1] - before[1] && move.dz === after[2] - before[2]; }));
    }
  }
});
