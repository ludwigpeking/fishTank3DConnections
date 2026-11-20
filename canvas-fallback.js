/* Canvas fallback uses the same 3D trail geometry and camera translation. */
(function () {
  'use strict';
  class CanvasVolumeRenderer extends VolumeScene {
    constructor(canvas, simulation) {
      super(canvas, simulation);
      this.context = canvas.getContext('2d');
      if (!this.context) throw new Error('Neither WebGL2 nor Canvas2D is available.');
      this.sprites = new Map();
    }
    resize() {
      this.pixelRatio = Math.min(1.5, window.devicePixelRatio || 1);
      this.width = Math.max(1, Math.floor(this.canvas.clientWidth * this.pixelRatio));
      this.height = Math.max(1, Math.floor(this.canvas.clientHeight * this.pixelRatio));
      if (this.canvas.width !== this.width || this.canvas.height !== this.height) {
        this.canvas.width = this.width; this.canvas.height = this.height;
      }
    }
    project(position, matrix) {
      const depth = matrix[3] * position[0] + matrix[7] * position[1] + matrix[11] * position[2] + matrix[15];
      if (depth < .04) return null;
      const horizontal = (matrix[0] * position[0] + matrix[4] * position[1] + matrix[8] * position[2] + matrix[12]) / depth;
      const vertical = (matrix[1] * position[0] + matrix[5] * position[1] + matrix[9] * position[2] + matrix[13]) / depth;
      if (Math.abs(horizontal) > 1.2 || Math.abs(vertical) > 1.2) return null;
      return [(horizontal * .5 + .5) * this.width, (-vertical * .5 + .5) * this.height, depth];
    }
    sprite(red, green, blue, radialFalloff) {
      const color = [red, green, blue].map(function (component) { return Math.min(255, Math.round(component * 16) * 16); }).join(',');
      const spriteKey = color + ':' + radialFalloff;
      if (this.sprites.has(spriteKey)) return this.sprites.get(spriteKey);
      const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
      const context = canvas.getContext('2d'), gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
      for (let stopIndex = 0; stopIndex <= 10; stopIndex++) {
        const radiusFactor = stopIndex / 10;
        const edgeFraction = Math.max(0, Math.min(1, (radiusFactor - .7) / .3));
        const opacity = Math.exp(-radiusFactor * radiusFactor * radialFalloff) * (1 - edgeFraction * edgeFraction * (3 - 2 * edgeFraction));
        gradient.addColorStop(radiusFactor, 'rgba(' + color + ',' + opacity + ')');
      }
      context.fillStyle = gradient; context.fillRect(0, 0, 128, 128);
      this.sprites.set(spriteKey, canvas); return canvas;
    }
    drawCloud(vertices, matrix, pointSize, opacity, maximumPoints, radialFalloff = 5, maximumPointDiameter = 96) {
      const stride = Math.max(1, Math.ceil(vertices.length / 7 / maximumPoints)) * 7;
      for (let vertexIndex = 0; vertexIndex < vertices.length; vertexIndex += stride) {
        const position = this.project(vertices.subarray(vertexIndex, vertexIndex + 3), matrix);
        if (!position) continue;
        const diameter = Math.min(maximumPointDiameter, pointSize * this.pixelRatio * 32 / position[2]);
        this.context.globalAlpha = Math.min(1, vertices[vertexIndex + 6] * opacity * Math.exp(-position[2] * .018));
        this.context.drawImage(this.sprite(vertices[vertexIndex + 3], vertices[vertexIndex + 4], vertices[vertexIndex + 5], radialFalloff), position[0] - diameter / 2, position[1] - diameter / 2, diameter, diameter);
      }
    }
    render(timestamp) {
      this.advance(timestamp); this.resize();
      const context = this.context, matrix = this.cameraMatrix();
      context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
      context.fillStyle = '#030609'; context.fillRect(0, 0, this.width, this.height);
      this.drawCloud(this.terrainVertices, matrix, 60, .50, 8000, 2.5, 320);
      context.globalCompositeOperation = 'lighter';
      this.drawCloud(this.trailVertices, matrix, 12, .24, 11000);
      this.drawCloud(this.trailVertices, matrix, 4.5, .80, 11000);
      context.globalAlpha = 1;
    }
    destroy() { this.sprites.clear(); }
  }
  window.CanvasVolumeRenderer = CanvasVolumeRenderer;
})();
