/* WebGPU accelerates field diffusion only; A* remains on the CPU. */
(function () {
  'use strict';
  const diffusionShader = `
    struct Parameters {
      resolution: u32,
      nodeCount: u32,
      retentionFactor: f32,
      diffusionFactor: f32,
    }
    @group(0) @binding(0) var<storage, read> inputValues: array<f32>;
    @group(0) @binding(1) var<storage, read_write> outputValues: array<f32>;
    @group(0) @binding(2) var<storage, read> solidNodes: array<u32>;
    @group(0) @binding(3) var<uniform> parameters: Parameters;
    @compute @workgroup_size(256)
    fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
      let nodeIndex = invocation.x;
      if (nodeIndex >= parameters.nodeCount) { return; }
      if (solidNodes[nodeIndex] != 0u) { outputValues[nodeIndex] = 0.0; return; }
      let resolution = parameters.resolution;
      let planeSize = resolution * resolution;
      let positionX = nodeIndex % resolution;
      let positionY = (nodeIndex / resolution) % resolution;
      let positionZ = nodeIndex / planeSize;
      var neighborSum = 0.0;
      var neighborCount = 0.0;
      if (positionX > 0u && solidNodes[nodeIndex - 1u] == 0u) {
        neighborSum += inputValues[nodeIndex - 1u]; neighborCount += 1.0;
      }
      if (positionX + 1u < resolution && solidNodes[nodeIndex + 1u] == 0u) {
        neighborSum += inputValues[nodeIndex + 1u]; neighborCount += 1.0;
      }
      if (positionY > 0u && solidNodes[nodeIndex - resolution] == 0u) {
        neighborSum += inputValues[nodeIndex - resolution]; neighborCount += 1.0;
      }
      if (positionY + 1u < resolution && solidNodes[nodeIndex + resolution] == 0u) {
        neighborSum += inputValues[nodeIndex + resolution]; neighborCount += 1.0;
      }
      if (positionZ > 0u && solidNodes[nodeIndex - planeSize] == 0u) {
        neighborSum += inputValues[nodeIndex - planeSize]; neighborCount += 1.0;
      }
      if (positionZ + 1u < resolution && solidNodes[nodeIndex + planeSize] == 0u) {
        neighborSum += inputValues[nodeIndex + planeSize]; neighborCount += 1.0;
      }
      let centerValue = inputValues[nodeIndex];
      outputValues[nodeIndex] = max(0.0, centerValue * parameters.retentionFactor +
        parameters.diffusionFactor * (neighborSum - neighborCount * centerValue));
    }
  `;
  class VolumeGpuDiffuser {
    constructor(device, resolution, onFailure) {
      this.device = device;
      this.resolution = resolution;
      this.nodeCount = resolution ** 3;
      this.byteLength = this.nodeCount * 4;
      this.buffers = [];
      this.destroyed = false;
      this.busy = false;
      this.failure = null;
      const diffuser = this;
      device.lost.then(function (information) {
        if (!diffuser.destroyed) diffuser.fail(new Error(information.message || 'WebGPU device lost.'), onFailure);
      });
      device.addEventListener('uncapturederror', function (event) {
        event.preventDefault();
        if (!diffuser.destroyed) diffuser.fail(event.error, onFailure);
      });
    }
    fail(error, onFailure) {
      if (this.failure) return;
      this.failure = error;
      if (onFailure) onFailure(error, this);
    }
    createBuffer(label, size, usage) {
      const buffer = this.device.createBuffer({label: label, size: size, usage: usage});
      this.buffers.push(buffer);
      return buffer;
    }
    async initialize(solidNodes) {
      const device = this.device;
      device.pushErrorScope('validation');
      try {
        this.input = this.createBuffer('Traffic input', this.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
        this.output = this.createBuffer('Diffused traffic', this.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        this.barriers = this.createBuffer('Solid voxels', this.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
        this.uniform = this.createBuffer('Diffusion parameters', 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        this.readback = this.createBuffer('Traffic readback', this.byteLength, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
        device.queue.writeBuffer(this.barriers, 0, Uint32Array.from(solidNodes));
        const shader = device.createShaderModule({label: 'Six-neighbor volumetric diffusion', code: diffusionShader});
        const compilation = await shader.getCompilationInfo();
        const errors = compilation.messages.filter(function (message) { return message.type === 'error'; });
        if (errors.length) throw new Error(errors.map(function (message) { return message.message; }).join('\n'));
        this.pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module: shader, entryPoint: 'main'}});
        this.bindGroup = device.createBindGroup({layout: this.pipeline.getBindGroupLayout(0), entries: [
          {binding: 0, resource: {buffer: this.input}}, {binding: 1, resource: {buffer: this.output}},
          {binding: 2, resource: {buffer: this.barriers}}, {binding: 3, resource: {buffer: this.uniform}}
        ]});
      } finally {
        const validationError = await device.popErrorScope();
        if (validationError) throw new Error(validationError.message);
      }
      if (this.failure) throw this.failure;
    }
    async diffuse(traffic, retentionFactor, diffusionFactor) {
      if (this.destroyed || this.failure) throw this.failure || new Error('WebGPU diffuser has been disposed.');
      if (this.busy) throw new Error('A diffusion pass is already in progress.');
      if (traffic.length !== this.nodeCount) throw new Error('Traffic grid does not match GPU buffer size.');
      this.busy = true;
      const device = this.device;
      device.pushErrorScope('validation');
      try {
        device.queue.writeBuffer(this.input, 0, traffic);
        const parameters = new ArrayBuffer(16);
        const parameterView = new DataView(parameters);
        parameterView.setUint32(0, this.resolution, true);
        parameterView.setUint32(4, this.nodeCount, true);
        parameterView.setFloat32(8, retentionFactor, true);
        parameterView.setFloat32(12, diffusionFactor, true);
        device.queue.writeBuffer(this.uniform, 0, parameters);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.dispatchWorkgroups(Math.ceil(this.nodeCount / 256));
        pass.end();
        encoder.copyBufferToBuffer(this.output, 0, this.readback, 0, this.byteLength);
        device.queue.submit([encoder.finish()]);
        await this.readback.mapAsync(GPUMapMode.READ);
        return new Float32Array(this.readback.getMappedRange().slice(0));
      } finally {
        if (this.readback.mapState === 'mapped') this.readback.unmap();
        this.busy = false;
        const validationError = await device.popErrorScope();
        if (validationError) throw new Error(validationError.message);
      }
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      for (const buffer of this.buffers) buffer.destroy();
      this.device.destroy();
    }
    static async create(resolution, solidNodes, onFailure) {
      if (!navigator.gpu || !window.isSecureContext) return null;
      let diffuser = null;
      try {
        const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
        if (!adapter) return null;
        const device = await adapter.requestDevice();
        diffuser = new VolumeGpuDiffuser(device, resolution, onFailure);
        await diffuser.initialize(solidNodes);
        return diffuser;
      } catch (error) {
        if (diffuser) diffuser.destroy();
        console.warn('WebGPU unavailable; continuing with CPU diffusion.', error);
        return null;
      }
    }
  }
  window.VolumeGpuDiffuser = VolumeGpuDiffuser;
})();
