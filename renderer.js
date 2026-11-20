/* Soft volumetric density and motion trails. No boundary frame or mover markers. */
(function () {
  'use strict';
  function compileShader(context, type, source) {
    const shader = context.createShader(type);
    context.shaderSource(shader, source); context.compileShader(shader);
    if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
      const message = context.getShaderInfoLog(shader); context.deleteShader(shader); throw new Error(message);
    }
    return shader;
  }
  function createProgram(context, pointSprites) {
    const vertexShader = compileShader(context, context.VERTEX_SHADER, `#version 300 es
      precision highp float;
      layout(location=0) in vec3 position;
      layout(location=1) in vec4 color;
      uniform mat4 cameraMatrix;
      uniform float pointSize;
      uniform float maximumPointDiameter;
      uniform float opacity;
      out vec4 particleColor;
      void main() {
        vec4 projected = cameraMatrix * vec4(position, 1.0);
        gl_Position = projected;
        gl_PointSize = clamp(pointSize * 32.0 / max(projected.w, .1), 1.0, maximumPointDiameter);
        float depthFade = exp(-max(projected.w, 0.0) * .018);
        particleColor = vec4(color.rgb, color.a * opacity * depthFade);
      }`);
    const fragmentShader = compileShader(context, context.FRAGMENT_SHADER, `#version 300 es
      precision mediump float;
      in vec4 particleColor;
      uniform float radialFalloff;
      out vec4 outputColor;
      void main() {
        ${pointSprites ? 'float radius = length(gl_PointCoord - vec2(.5)) * 2.0; if (radius > 1.0) discard; float softness = exp(-radius * radius * radialFalloff) * (1.0 - smoothstep(.7, 1.0, radius)); outputColor = vec4(particleColor.rgb, particleColor.a * softness);' : 'outputColor = particleColor;'}
      }`);
    const program = context.createProgram();
    context.attachShader(program, vertexShader); context.attachShader(program, fragmentShader); context.linkProgram(program);
    context.deleteShader(vertexShader); context.deleteShader(fragmentShader);
    if (!context.getProgramParameter(program, context.LINK_STATUS)) throw new Error(context.getProgramInfoLog(program));
    return {program: program, cameraMatrix: context.getUniformLocation(program, 'cameraMatrix'), pointSize: context.getUniformLocation(program, 'pointSize'), opacity: context.getUniformLocation(program, 'opacity'), radialFalloff: context.getUniformLocation(program, 'radialFalloff'), maximumPointDiameter: context.getUniformLocation(program, 'maximumPointDiameter')};
  }
  class VolumeRenderer extends VolumeScene {
    constructor(canvas, simulation) {
      const context = canvas.getContext('webgl2', {antialias: true, alpha: false, powerPreference: 'high-performance'});
      if (!context) return new window.CanvasVolumeRenderer(canvas, simulation);
      super(canvas, simulation);
      this.context = context;
      this.pointsProgram = createProgram(context, true); this.linesProgram = createProgram(context, false);
      this.terrainMesh = this.createMesh(); this.trailMesh = this.createMesh(); this.filamentMesh = this.createMesh();
      this.uploadedTerrainRevision = -1; this.uploadedTrailRevision = -1;
      context.enable(context.BLEND); context.blendFunc(context.SRC_ALPHA, context.ONE);
      context.disable(context.DEPTH_TEST);
      const renderer = this;
      canvas.addEventListener('webglcontextlost', function (event) { event.preventDefault(); renderer.contextLost = true; });
      canvas.addEventListener('webglcontextrestored', function () {
        renderer.pointsProgram = createProgram(context, true); renderer.linesProgram = createProgram(context, false);
        renderer.terrainMesh = renderer.createMesh(); renderer.trailMesh = renderer.createMesh(); renderer.filamentMesh = renderer.createMesh();
        renderer.uploadedTerrainRevision = -1; renderer.uploadedTrailRevision = -1;
        context.enable(context.BLEND); context.blendFunc(context.SRC_ALPHA, context.ONE); context.disable(context.DEPTH_TEST);
        renderer.contextLost = false;
      });
    }
    createMesh() { return {buffer: this.context.createBuffer(), count: 0}; }
    upload(mesh, vertices) {
      mesh.count = vertices.length / 7;
      this.context.bindBuffer(this.context.ARRAY_BUFFER, mesh.buffer);
      this.context.bufferData(this.context.ARRAY_BUFFER, vertices, this.context.DYNAMIC_DRAW);
    }
    resize() {
      this.pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      this.width = Math.max(1, Math.floor(this.canvas.clientWidth * this.pixelRatio));
      this.height = Math.max(1, Math.floor(this.canvas.clientHeight * this.pixelRatio));
      if (this.canvas.width !== this.width || this.canvas.height !== this.height) {
        this.canvas.width = this.width; this.canvas.height = this.height;
      }
      this.context.viewport(0, 0, this.width, this.height);
    }
    draw(mesh, program, mode, cameraMatrix, pointSize, opacity, radialFalloff = 5, maximumPointDiameter = 96) {
      if (!mesh.count) return;
      const context = this.context;
      context.useProgram(program.program);
      context.uniformMatrix4fv(program.cameraMatrix, false, cameraMatrix);
      context.uniform1f(program.pointSize, pointSize * this.pixelRatio);
      context.uniform1f(program.opacity, opacity);
      context.uniform1f(program.radialFalloff, radialFalloff);
      context.uniform1f(program.maximumPointDiameter, maximumPointDiameter);
      context.bindBuffer(context.ARRAY_BUFFER, mesh.buffer);
      context.enableVertexAttribArray(0); context.enableVertexAttribArray(1);
      context.vertexAttribPointer(0, 3, context.FLOAT, false, 28, 0);
      context.vertexAttribPointer(1, 4, context.FLOAT, false, 28, 12);
      context.drawArrays(mode, 0, mesh.count);
    }
    render(timestamp) {
      this.advance(timestamp);
      if (this.contextLost) return;
      this.resize();
      const context = this.context, cameraMatrix = this.cameraMatrix();
      context.clearColor(.012, .024, .037, 1); context.clear(context.COLOR_BUFFER_BIT);
      if (this.uploadedTerrainRevision !== this.terrainRevision) {
        this.upload(this.terrainMesh, this.terrainVertices); this.uploadedTerrainRevision = this.terrainRevision;
      }
      if (this.uploadedTrailRevision !== this.trailRevision) {
        this.upload(this.trailMesh, this.trailVertices); this.upload(this.filamentMesh, this.filamentVertices);
        this.uploadedTrailRevision = this.trailRevision;
      }
      // Broad, overlapping fog kernels accumulate color without bleaching to white.
      context.blendFunc(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA);
      this.draw(this.terrainMesh, this.pointsProgram, context.POINTS, cameraMatrix, 60, .38, 2.5, 320);
      context.blendFunc(context.SRC_ALPHA, context.ONE);
      this.draw(this.trailMesh, this.pointsProgram, context.POINTS, cameraMatrix, 13, .18);
      this.draw(this.trailMesh, this.pointsProgram, context.POINTS, cameraMatrix, 4.5, .70);
      this.draw(this.filamentMesh, this.linesProgram, context.LINES, cameraMatrix, 1, .65);
    }
    destroy() {
      for (const mesh of [this.terrainMesh, this.trailMesh, this.filamentMesh]) this.context.deleteBuffer(mesh.buffer);
      this.context.deleteProgram(this.pointsProgram.program); this.context.deleteProgram(this.linesProgram.program);
    }
  }
  window.VolumeRenderer = VolumeRenderer;
})();
