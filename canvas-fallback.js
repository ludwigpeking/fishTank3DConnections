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
    sprite(red, green, blue) {
      const color = [red, green, blue].map(function (component) { return Math.min(255, Math.round(component * 16) * 16); }).join(',');
      if (this.sprites.has(color)) return this.sprites.get(color);
      const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 48;
      const context = canvas.getContext('2d'), gradient = context.createRadialGradient(24, 24, 0, 24, 24, 24);
      gradient.addColorStop(0, 'rgba(' + color + ',1)'); gradient.addColorStop(.45, 'rgba(' + color + ',.3)'); gradient.addColorStop(1, 'rgba(' + color + ',0)');
      context.fillStyle = gradient; context.fillRect(0, 0, 48, 48);
      this.sprites.set(color, canvas); return canvas;
    }
    drawCloud(vertices, matrix, pointSize, opacity, maximumPoints) {
      const stride = Math.max(1, Math.ceil(vertices.length / 7 / maximumPoints)) * 7;
      for (let vertexIndex = 0; vertexIndex < vertices.length; vertexIndex += stride) {
        const position = this.project(vertices.subarray(vertexIndex, vertexIndex + 3), matrix);
        if (!position) continue;
        const diameter = Math.min(96, pointSize * this.pixelRatio * 32 / position[2]);
        this.context.globalAlpha = Math.min(1, vertices[vertexIndex + 6] * opacity * Math.exp(-position[2] * .018));
        this.context.drawImage(this.sprite(vertices[vertexIndex + 3], vertices[vertexIndex + 4], vertices[vertexIndex + 5]), position[0] - diameter / 2, position[1] - diameter / 2, diameter, diameter);
      }
    }
    render(timestamp) {
      this.advance(timestamp); this.resize();
      const context = this.context, matrix = this.cameraMatrix();
      context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
      context.fillStyle = '#030609'; context.fillRect(0, 0, this.width, this.height);
      context.globalCompositeOperation = 'lighter';
      this.drawCloud(this.terrainVertices, matrix, 11, .85, 8000);
      this.drawCloud(this.trailVertices, matrix, 12, .24, 11000);
      this.drawCloud(this.trailVertices, matrix, 4.5, .80, 11000);
      context.globalAlpha = 1;
    }
    destroy() { this.sprites.clear(); }
  }
  window.CanvasVolumeRenderer = CanvasVolumeRenderer;
})();
