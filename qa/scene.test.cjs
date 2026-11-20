'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const filesystem = require('node:fs');
const path = require('node:path');
const virtualMachine = require('node:vm');

function source(filename) { return filesystem.readFileSync(path.join(__dirname, '..', filename), 'utf8'); }
function createScene() {
  const context = virtualMachine.createContext({window: {}, performance: performance});
  virtualMachine.runInContext(source('volume.js'), context);
  virtualMachine.runInContext(source('scene.js'), context);
  const simulation = new context.window.VolumeSimulation({n: 8, barriers: 0, connectivity: 50});
  const canvas = {addEventListener: function () {}};
  return {scene: new context.window.VolumeScene(canvas, simulation), simulation: simulation, visuals: context.window.VolumeVisuals};
}

test('head depth translates the eye inside the volume without scaling world coordinates or perspective', function () {
  const fixture = createScene(), scene = fixture.scene;
  scene.width = 1280; scene.height = 720; scene.head.active = true;
  const geometryBefore = Array.from(scene.terrainVertices);
  const neutralPose = fixture.visuals.cameraPose(scene), neutralMatrix = scene.cameraMatrix();
  scene.headCurrent.d = 13;
  const closePose = fixture.visuals.cameraPose(scene), closeMatrix = scene.cameraMatrix();
  assert.ok(closePose.distance < neutralPose.distance);
  assert.ok(closePose.eye.every(function (coordinate) { return Math.abs(coordinate) < 7; }), 'Close head position must enter the 14-unit volume');
  scene.headCurrent.d = 35;
  assert.ok(fixture.visuals.cameraPose(scene).distance > neutralPose.distance);
  assert.deepEqual(Array.from(closeMatrix.slice(0, 12)), Array.from(neutralMatrix.slice(0, 12)), 'Only camera translation changes');
  assert.deepEqual(Array.from(scene.terrainVertices), geometryBefore);
  for (const mode of ['window', 'orbit']) {
    scene.head.mode = mode; scene.headCurrent.x = 3; scene.headCurrent.y = -2;
    assert.ok(Array.from(scene.cameraMatrix()).every(Number.isFinite));
  }
});

test('higher resistance produces denser colored terrain and traffic reduces it', function () {
  const fixture = createScene(), simulation = fixture.simulation;
  simulation.minResistance = 1; simulation.maxResistance = 10;
  simulation.solid.fill(0); simulation.traffic.fill(0); simulation.base.fill(2);
  fixture.scene.updateMemory();
  const sparseVertices = Array.from(fixture.scene.terrainVertices);
  const sparseDensity = fixture.visuals.terrainDensity(simulation, 0);
  simulation.base.fill(9);
  fixture.scene.updateMemory();
  assert.ok(fixture.scene.terrainVertices.length > sparseVertices.length);
  assert.ok(fixture.visuals.terrainDensity(simulation, 0) > sparseDensity);
  const denseOpacity = fixture.scene.terrainVertices[6];
  assert.ok(denseOpacity > sparseVertices[6]);
  simulation.traffic.fill(10);
  fixture.scene.updateMemory();
  assert.ok(fixture.scene.terrainVertices.length < sparseVertices.length);
  simulation.solid[0] = 1;
  assert.equal(fixture.visuals.terrainDensity(simulation, 0), 1);
});

test('traces deposit progressively, spread, fade, expire and pause with simulation time', function () {
  const fixture = createScene(), scene = fixture.scene, simulation = fixture.simulation;
  const route = {start: simulation.index(1, 1, 1), target: simulation.index(6, 6, 6)};
  route.path = [route.start, route.target];
  scene.addRoute(route);
  scene.buildTrails();
  const initialLength = scene.trailVertices.length, initialOpacity = scene.trailVertices[6];
  const initialPosition = Array.from(scene.trailVertices.slice(0, 3));
  scene.sceneTime = 2; scene.buildTrails();
  assert.ok(scene.trailVertices.length > initialLength);
  assert.ok(scene.trailVertices[6] < initialOpacity);
  assert.notDeepEqual(Array.from(scene.trailVertices.slice(0, 3)), initialPosition);
  assert.ok(Array.from(scene.trailVertices).every(Number.isFinite));
  scene.animationPlaying = false; scene.advance(1000); scene.advance(1100);
  assert.equal(scene.sceneTime, 2);
  scene.animationPlaying = true; scene.advance(1200);
  assert.ok(scene.sceneTime > 2);
  scene.sceneTime = scene.routes[0].travelTimes.at(-1) + 33;
  scene.buildTrails();
  assert.equal(scene.routes.length, 0);
  assert.equal(scene.trailVertices.length, 0);
  assert.equal(scene.filamentVertices.length, 0);
});

function createInterface() {
  const elements = new Map(), documentListeners = new Map();
  for (const match of source('index.html').matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const listeners = new Map(), attributes = new Map(), classes = new Set();
    elements.set(match[1], {
      hidden: /\shidden(?:\s|>)/.test(match[0]), value: match[1] === 'viewMode' ? 'window' : '',
      style: {}, listeners: listeners, attributes: attributes,
      addEventListener: function (name, listener) { listeners.set(name, listener); },
      setAttribute: function (name, value) { attributes.set(name, value); },
      focus: function () {},
      classList: {add: function (name) { classes.add(name); }, remove: function (name) { classes.delete(name); }, toggle: function (name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }}
    });
  }
  const fixture = {elements: elements, documentListeners: documentListeners};
  function FaceViewTracker(video, onPose, onStatus) {
    fixture.tracker = this; this.active = false; this.onStatus = onStatus;
    this.start = async function () { this.active = true; onStatus('Connected', true); };
    this.stop = function () { this.active = false; onPose(null); onStatus('Disconnected', false); };
    this.recalibrate = function () {};
  }
  const context = virtualMachine.createContext({
    window: {addEventListener: function () {}},
    document: {getElementById: function (identifier) { return elements.get(identifier); },
      body: {classList: {toggle: function () {}}},
      addEventListener: function (name, listener) { documentListeners.set(name, listener); }},
    FaceViewTracker: FaceViewTracker, performance: performance, requestAnimationFrame: function () {},
    setTimeout: function () {}, clearTimeout: function () {}, console: console
  });
  fixture.document = context.document;
  virtualMachine.runInContext(source('main.js'), context);
  fixture.click = async function (identifier) { await elements.get(identifier).listeners.get('click')(); };
  fixture.escape = function () { documentListeners.get('keydown')({key: 'Escape', preventDefault: function () {}}); };
  return fixture;
}

test('data is hidden initially and webcam hides all interface until explicitly recalled', async function () {
  const fixture = createInterface(), elements = fixture.elements;
  assert.equal(elements.get('dataPanel').hidden, true);
  assert.equal(elements.get('interface').hidden, false);
  await fixture.click('dataToggle');
  assert.equal(elements.get('dataPanel').hidden, false);
  await fixture.click('cameraToggle');
  assert.equal(elements.get('interface').hidden, true);
  assert.equal(elements.get('interface').inert, true);
  assert.equal(elements.get('dataPanel').hidden, true);
  fixture.escape();
  assert.equal(elements.get('interface').hidden, false);
  fixture.tracker.onStatus('Tracking', true);
  assert.equal(elements.get('interface').hidden, false, 'Status updates must not dismiss recalled controls');
  await fixture.click('hideInterface');
  assert.equal(elements.get('interface').hidden, true);
  fixture.tracker.stop();
  assert.equal(elements.get('interface').hidden, false);
  assert.equal(elements.get('interface').inert, false);
});

test('scene tap recalls controls, while orbit dragging keeps the view immersive', async function () {
  const fixture = createInterface();
  await fixture.click('cameraToggle');
  const listeners = fixture.elements.get('scene').listeners;
  listeners.get('pointerdown')({clientX: 100, clientY: 100, pointerId: 1, button: 0});
  listeners.get('pointerup')({clientX: 140, clientY: 100, pointerId: 1});
  assert.equal(fixture.elements.get('interface').hidden, true);
  listeners.get('pointerdown')({clientX: 100, clientY: 100, pointerId: 2, button: 0});
  listeners.get('pointerup')({clientX: 102, clientY: 101, pointerId: 2});
  assert.equal(fixture.elements.get('interface').hidden, false);
});

test('failed webcam startup leaves controls available for retry', async function () {
  const fixture = createInterface();
  fixture.tracker.start = async function () { throw new Error('Camera unavailable'); };
  await fixture.click('cameraToggle');
  assert.equal(fixture.elements.get('interface').hidden, false);
  assert.equal(fixture.elements.get('cameraToggle').disabled, false);
  assert.equal(fixture.elements.get('toast').textContent, 'Camera unavailable');
});

test('webcam requests fullscreen before asynchronous startup and restores controls on fullscreen exit', async function () {
  const fixture = createInterface(), calls = [];
  fixture.document.fullscreenEnabled = true;
  fixture.document.documentElement = {requestFullscreen: async function () { calls.push('fullscreen'); }};
  const startCamera = fixture.tracker.start;
  fixture.tracker.start = async function () { calls.push('camera'); await startCamera.call(fixture.tracker); };
  await fixture.click('cameraToggle');
  assert.deepEqual(calls, ['fullscreen', 'camera']);
  assert.equal(fixture.elements.get('interface').hidden, true);
  fixture.document.fullscreenElement = null;
  fixture.documentListeners.get('fullscreenchange')();
  assert.equal(fixture.elements.get('interface').hidden, false);
});

test('fullscreen rejection does not interrupt webcam startup', async function () {
  const fixture = createInterface();
  fixture.document.fullscreenEnabled = true;
  fixture.document.documentElement = {requestFullscreen: async function () { throw new Error('Fullscreen denied'); }};
  await fixture.click('cameraToggle');
  assert.equal(fixture.tracker.active, true);
  assert.equal(fixture.elements.get('interface').hidden, true);
  assert.equal(fixture.elements.get('cameraToggle').disabled, false);
});
